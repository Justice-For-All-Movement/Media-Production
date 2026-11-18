// Actual pinned E11 HTTP plus a separate owning Media DB and private image render; no providers/publication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { generateSigningKey, signAccessToken, withDisposableDatabase, FsObjectStore } from '../src/service-kit.ts';
import type { ServiceContext } from '../src/service-kit.ts';
import { httpUseDecisionPort } from '../src/engine/serve.ts';
import { createRequire } from 'node:module';

test('Actual Consent withdrawal during retained Media read withholds private bytes without event flags', async () => {
 const directory=process.env.E11_DIR, admin=process.env.TEST_DATABASE_URL;
 assert.ok(directory && admin, 'E11_DIR and disposable TEST_DATABASE_URL are required; no silent skip');
 const mediaEntry = process.env.MEDIA_PACKAGE_ROOT
   ? createRequire(resolve(process.env.MEDIA_PACKAGE_ROOT, 'package.json')).resolve('@accountability/media-production/engine')
   : resolve('src/engine/index.ts');
 const { createEngine, migrate } = await import(pathToFileURL(mediaEntry).href);
 const consent=await import(pathToFileURL(resolve(directory,'src/engine/index.ts')).href);
 const kit=await import(pathToFileURL(resolve(directory,'src/service-kit.ts')).href);
 await withDisposableDatabase(pg,admin,async(_url,sql)=>{
  await consent.migrate(sql);const engine=consent.createEngine({sql});
  const key=generateSigningKey('fixture'),now=Math.floor(Date.now()/1000);
  const signed=(kind:'human'|'service',caps:readonly string[])=>signAccessToken({iss:'iap',sub:`fictional-${kind}`,kind,tid:'tenant-a',pid:'project-a',purpose:'production',cmp:[],caps,roles:[],pv:'1',iat:now,exp:now+600,jti:randomUUID()},key);
  const service=signed('service',['consent:decide']),staff=signed('human',['consent:write','consent:withdraw']);
  const handler=kit.createHttpHandler({name:consent.manifest.name,version:consent.manifest.version,routes:consent.routes(engine),verify:kit.createTokenVerifier({publicKeys:{fixture:key.publicKeyPem},issuer:'iap'}),health:()=>engine.health()});
  let requests=0;const server=createServer((req,res)=>{requests++;void handler(req,res);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address==='object');const baseUrl=`http://127.0.0.1:${address.port}`;
  const ctx:ServiceContext={tenantId:'tenant-a',projectId:'project-a',purpose:'production',requestId:'fixture-request',now:new Date().toISOString(),actor:{id:'fictional-human',kind:'human',roles:[]},capabilities:[],compartments:[]};
  const subject='E05:evidence:fictional-source@1';const request={subjects:[subject],action:'adapt' as const,purpose:ctx.purpose};
  const send=async(path:string,body:unknown)=>{const res=await fetch(baseUrl+path,{method:'POST',headers:{authorization:`Bearer ${staff}`,'content-type':'application/json'},body:JSON.stringify(body)});const json=await res.json() as any;assert.ok(res.ok,`${res.status}: ${JSON.stringify(json)}`);return json;};
  try {
   const port=httpUseDecisionPort({baseUrl,token:service});
   assert.equal((await port.decide(ctx,request)).decision,'review');
   const before=requests;await assert.rejects(port.decide({...ctx,tenantId:'foreign'},request));assert.equal(requests,before);
   const holder=await send('/v1/holders',{ref:'pseudonym:fictional-producer',kind:'participant'});
   const permission=await send('/v1/permissions',{holderId:holder.id,scope:{type:'subject',value:subject},actions:['adapt','reproduce'],purposes:['production'],audiences:['private-review'],provenance:{method:'other',note:'Fictional controlled integration grant; no real research or contact.'}});
   assert.equal((await port.decide(ctx,request)).decision,'allow');
   await withDisposableDatabase(pg,admin,async(_mediaUrl,ownSql)=>{
    await migrate(ownSql);
    const folder=await mkdtemp(join(tmpdir(),'media-consent-reads-'));
    try {
     const store=new FsObjectStore(join(folder,'objects'));let objectReads=0;let withdrawDuringRead=false;let assetWithdrawal:string|undefined;
     const objects={put:store.put.bind(store),head:store.head.bind(store),delete:store.delete.bind(store),list:store.list.bind(store),get:async(key:string)=>{objectReads++;const bytes=await store.get(key);if(assetWithdrawal!==undefined){const id=assetWithdrawal;assetWithdrawal=undefined;await send(`/v1/permissions/${id}/withdraw`,{reason:'Fictional asset withdrawal during retrieval'});}if(withdrawDuringRead){withdrawDuringRead=false;await send(`/v1/permissions/${permission.id}/withdraw`,{reason:'Fictional withdrawal during object read'});}return bytes;}};
     const media=createEngine({sql:ownSql,objects,ports:{useDecisions:port},config:{workRoot:folder}});
     const operator={...ctx,capabilities:['production:read','production:write','production:render','production:approve','production:export']};
     const project=await media.createProject(operator,{kind:'image',title:'Fictional private render',sources:[subject],doc:{title:'Fictional private render',canvas:{width:320,height:180,background:'#ffffff'},export:{formats:['png']},layers:[{id:'text',type:'text',text:'Fictional controlled output',x:12,y:12,width:290,size:18,color:'#111111'}]}});
     const queued=await media.requestRender(operator,{productionId:project.id});
     assert.equal(queued.state,'queued',queued.error??'');
     await media.runJobs({worker:'fixture-worker'});
     const render=await media.getRender(operator,queued.id);assert.equal(render.state,'done',render.error??'');
     const exported=await media.createExport(operator,{renderId:render.id,audience:'private-review',destination:'internal-workspace'});
     const output=await media.getRenderOutput(operator,render.id,render.outputs[0]!.name);assert.ok(output.bytes.byteLength>0);
     assert.ok((await media.getRenderOutput(operator,render.id,'manifest.json')).bytes.byteLength>0);
     assert.ok((await media.getExportBytes(operator,exported.id)).bytes.byteLength>0);
     const privateAsset=await media.importAsset(operator,{name:'Controlled private asset',filename:'fixture.png',bytes:output.bytes,rights:{kind:'license',license:'Fictional test fixture only',attribution:'Controlled fixture'}});
     const beforeAsset=objectReads;
     await assert.rejects(media.getAssetBytes(operator,privateAsset.id),(e:any)=>e.code==='consent_denied');
     assert.equal(objectReads,beforeAsset,'unknown asset permission is review, not byte-read authority');
     const assetPermission=await send('/v1/permissions',{holderId:holder.id,scope:{type:'subject',value:privateAsset.versions[0].ref},actions:['reproduce'],purposes:['production'],provenance:{method:'other',note:'Controlled fictional asset-byte grant; no source truth claim.'}});
     assert.equal((await media.getAssetBytes(operator,privateAsset.id,1)).sha256,privateAsset.versions[0].sha256);
     const beforeAssetWithdrawal=objectReads;assetWithdrawal=assetPermission.id;
     await assert.rejects(media.getAssetBytes(operator,privateAsset.id,1),(e:any)=>e.code==='consent_denied');
     assert.equal(objectReads,beforeAssetWithdrawal+1);
     const beforeAssetRetry=objectReads;await assert.rejects(media.getAssetBytes(operator,privateAsset.id,1),(e:any)=>e.code==='consent_denied');assert.equal(objectReads,beforeAssetRetry);
     const retainedAsset=await media.getAsset(operator,privateAsset.id);assert.equal(retainedAsset.blocked,false);assert.equal(retainedAsset.versions.length,1);assert.equal(retainedAsset.versions[0].sha256,privateAsset.versions[0].sha256);
     const beforeWithdrawal=objectReads;withdrawDuringRead=true;
     await assert.rejects(media.getRenderOutput(operator,render.id,render.outputs[0]!.name),(e:any)=>e.code==='consent_denied');
     assert.equal(objectReads,beforeWithdrawal+1,'one object read occurred before real E11 withdrawal; no retry');
     const beforeReads=objectReads;
     for(const read of [()=>media.getRenderOutput(operator,render.id,render.outputs[0]!.name),()=>media.getRenderOutput(operator,render.id,'manifest.json'),()=>media.getExportBytes(operator,exported.id)])await assert.rejects(read(),(e:any)=>e.code==='consent_denied');
     assert.equal(objectReads,beforeReads,'withdrawal denies before object I/O without event delivery');
     const retained=await media.getRender(operator,render.id);assert.equal(retained.blocked,false);assert.equal(retained.manifestDigest,render.manifestDigest);assert.deepEqual(retained.outputs,render.outputs);
     assert.equal((await media.getExport(operator,exported.id)).blocked,false);assert.equal((await media.listExports(operator,{renderId:render.id})).length,1);
    } finally {await rm(folder,{recursive:true,force:true});}
   });
   assert.equal((await port.decide(ctx,request)).decision,'deny');
   const segments=service.split('.');const forged=`${segments[0]}.${segments[1]}.invalid-signature`;
   await assert.rejects(httpUseDecisionPort({baseUrl,token:forged}).decide(ctx,request),'decoded matching scope does not authenticate the credential');
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 });
});
