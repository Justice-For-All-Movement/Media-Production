import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/contracts.ts';
import { httpUseDecisionPort } from '../src/engine/serve.ts';
import type { ServiceContext } from '../src/service-kit.ts';
const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({ tenantId:'t1', projectId:'p1', purpose:'production', requestId:'fixture-request', now:'2026-01-01T00:00:00.000Z', actor:{id:'fixture-human',kind:'human',roles:[]}, capabilities:[],compartments:[],...over });
const token = (over = {}) => `header.${Buffer.from(JSON.stringify({ tid: 't1', pid: 'p1', purpose: 'production', kind: 'service', cmp: [], ...over })).toString('base64url')}.signature`;
const request = () => ({ subjects: ['E06:segment:example@1'], action: 'adapt' as const, purpose: 'production' });
const decision = (value = 'allow') => ({ decision: value, reasons: [], permissionRefs: ['E11:permission:example@1'], restrictions: [], decidedAt: '2026-01-01T00:00:00.000Z' });
const unavailable = (e: unknown) => e instanceof DomainError && e.code === 'unavailable';
test('real E11 POST path, exact captured request and one scope-checked credential; no cached decision', async () => {
  const input = request(), expected = request(); let credentials = 0; let calls = 0;
  const port = httpUseDecisionPort({ baseUrl: 'https://example.invalid', token: () => { credentials++; input.subjects[0] = 'E06:segment:changed@1'; return token(); },
    fetch: async (url, init) => { calls++; assert.equal(String(url), 'https://example.invalid/v1/use-decisions'); assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), expected); return Response.json(decision(calls === 1 ? 'allow' : 'deny')); } });
  assert.equal((await port.decide(ctx(), input)).decision, 'allow');
  assert.equal((await port.decide(ctx(), expected)).decision, 'deny'); assert.equal(calls, 2); assert.equal(credentials, 2);
});
test('foreign scope, purpose and broader compartments deny before transport', async () => {
  let calls = 0;
  for (const over of [{ tid: 'other' }, { pid: 'other' }, { purpose: 'other' }, { cmp: ['vault'] }, { kind: 'human' }]) {
    await assert.rejects(httpUseDecisionPort({ baseUrl: 'https://example.invalid', token: token(over), fetch: async () => { calls++; return Response.json(decision()); } }).decide(ctx(), request()), unavailable);
  }
  assert.equal(calls, 0);
});
test('invalid request fields, purpose mismatch and byte bounds precede credential work', async () => {
  let credentials = 0;
  const port = httpUseDecisionPort({ baseUrl: 'https://example.invalid', token: () => { credentials++; return token(); }, fetch: async () => Response.json(decision()) });
  for (const input of [{ ...request(), purpose: 'other' }, { ...request(), override: true }, { ...request(), subjects: [] },
    { ...request(), subjects: Array.from({ length: 200 }, (_, i) => `E06:segment:${'x'.repeat(400)}${i}@1`) }]) await assert.rejects(port.decide(ctx(), input));
  assert.equal(credentials, 0);
});
test('deny and review are preserved; absent restrictions, bad time and failures never become allow', async () => {
  for (const value of ['deny', 'review']) assert.equal((await httpUseDecisionPort({ baseUrl: 'https://example.invalid', token: token(), fetch: async () => Response.json(decision(value)) }).decide(ctx(), request())).decision, value);
  for (const d of [{ ...decision(), restrictions: undefined }, { ...decision(), decidedAt: 'invalid' }, { ...decision(), decision: true }, { ...decision(), permissionRefs: [3] }])
    await assert.rejects(httpUseDecisionPort({ baseUrl: 'https://example.invalid', token: token(), fetch: async () => Response.json(d) }).decide(ctx(), request()), unavailable);
  for (const status of [401, 403, 404, 500]) await assert.rejects(httpUseDecisionPort({ baseUrl: 'https://example.invalid', token: token(), fetch: async () => Response.json(decision(), { status }) }).decide(ctx(), request()), unavailable);
});
test('bounded UTF8 response and monotonic deadline, with closed signals and sanitized callback diagnostics', async () => {
  for (const mode of ['bytes', 'utf8', 'late', 'throw']) {
    let signal: AbortSignal | null = null;
    const port = httpUseDecisionPort({ baseUrl: 'https://example.invalid', token: token(), timeoutMs: 100, fetch: async (_url, init) => {
      signal = init?.signal ?? null;
      if (mode === 'throw') throw new DomainError('scope_denied', 'SYNTHETIC_SECRET');
      if (mode === 'late') { const end = performance.now() + 140; while (performance.now() < end) {} }
      return mode === 'utf8' ? new Response(new Uint8Array([255])) : new Response(JSON.stringify(decision()) + (mode === 'bytes' ? ' '.repeat(512 * 1024) : ''));
    } });
    await assert.rejects(port.decide(ctx(), request()), e => unavailable(e) && !String(e).includes('SYNTHETIC_SECRET')); assert.equal((signal as AbortSignal | null)?.aborted, true);
  }
});
test('producer Buffer reuse cannot rewrite accepted bytes; uncooperative body cancellation cannot hold the port open', async () => {
  const expected=decision();const bytes=Buffer.from(JSON.stringify(expected));let pulls=0;
  const body=new ReadableStream<Uint8Array>({pull(controller){pulls++;if(pulls===1)controller.enqueue(bytes);else{bytes.fill(0);controller.close();}}},{highWaterMark:0});
  const port=httpUseDecisionPort({baseUrl:'https://example.invalid',token:token(),fetch:async()=>new Response(body)});
  assert.deepEqual(await port.decide(ctx(),request()),expected);assert.equal(pulls,2);
  let cancelled=false;let signal:AbortSignal|null=null;
  const blocked=new ReadableStream<Uint8Array>({cancel(){cancelled=true;return new Promise<void>(()=>{});}},{highWaterMark:0});
  const rejecting=httpUseDecisionPort({baseUrl:'https://example.invalid',token:token(),timeoutMs:100,fetch:async(_url,init)=>{signal=init?.signal??null;return new Response(blocked,{headers:{'content-length':String(512*1024+1)}});}});
  await Promise.race([assert.rejects(rejecting.decide(ctx(),request()),unavailable),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('port awaited an uncooperative cancel hook')),300);timer.unref();})]);
  assert.equal(cancelled,true);assert.equal((signal as AbortSignal|null)?.aborted,true);
});
