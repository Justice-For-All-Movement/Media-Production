import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { httpUseDecisionPort } from '../src/engine/serve.ts';
import type { ServiceContext } from '../src/service-kit.ts';
const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({ tenantId:'tenant-a', projectId:'project-a', purpose:'production', requestId:'fixture-request', now:'2026-01-01T00:00:00.000Z', actor:{id:'fixture-human',kind:'human',roles:[]}, capabilities:[],compartments:[],...over });
const token = `header.${Buffer.from(JSON.stringify({tid:'tenant-a',pid:'project-a',purpose:'production',kind:'service',cmp:[]})).toString('base64url')}.signature`;
const request = {subjects:['E05:evidence:fiction@1'],action:'adapt' as const,purpose:'production'};
async function fixture(body: object, fn:(baseUrl:string,calls:()=>number)=>Promise<void>):Promise<void> {
 let calls=0;const server=createServer((_req,res)=>{calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify(body));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {await fn(`http://127.0.0.1:${(server.address() as {port:number}).port}`,()=>calls);} finally {await new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});}
}
test('HTTP service credential cannot be used for a foreign caller scope',async()=>{
 await fixture({decision:'allow',reasons:[],permissionRefs:[],restrictions:[],decidedAt:'2026-01-01T00:00:00.000Z'},async(baseUrl,calls)=>{
  await assert.rejects(httpUseDecisionPort({baseUrl,token}).decide(ctx({tenantId:'foreign'}),request));assert.equal(calls(),0);
 });
});
test('HTTP decision cannot invent missing restrictions and decision time',async()=>{
 await fixture({decision:'allow'},async(baseUrl)=>{await assert.rejects(httpUseDecisionPort({baseUrl,token}).decide(ctx(),request));});
});
