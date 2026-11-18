// Actual pinned E11 SQL/public HTTP; no Media render, worker or live provider is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { generateSigningKey, signAccessToken, withDisposableDatabase } from '../src/service-kit.ts';
import type { ServiceContext } from '../src/service-kit.ts';
import { httpUseDecisionPort } from '../src/engine/serve.ts';

test('Media port uses actual signed Consent HTTP and observes grant withdrawal with no replay or foreign-scope transport', async () => {
 const directory=process.env.E11_DIR, admin=process.env.TEST_DATABASE_URL;
 assert.ok(directory && admin, 'E11_DIR and disposable TEST_DATABASE_URL are required; no silent skip');
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
   const permission=await send('/v1/permissions',{holderId:holder.id,scope:{type:'subject',value:subject},actions:['adapt'],purposes:['production'],provenance:{method:'other',note:'Fictional controlled integration grant; no real research or contact.'}});
   assert.equal((await port.decide(ctx,request)).decision,'allow');
   await send(`/v1/permissions/${permission.id}/withdraw`,{reason:'Fictional withdrawal fixture'});
   assert.equal((await port.decide(ctx,request)).decision,'deny');
   const segments=service.split('.');const forged=`${segments[0]}.${segments[1]}.invalid-signature`;
   await assert.rejects(httpUseDecisionPort({baseUrl,token:forged}).decide(ctx,request),'decoded matching scope does not authenticate the credential');
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 });
});
