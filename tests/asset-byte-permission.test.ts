// Real own PostgreSQL and private fixture bytes; synthetic host policy is not live E11 qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from '../src/engine/tools.ts';
import { ctx, ledgerPage, needsPg, withEngine } from './helpers.ts';
import type { ObjectStore } from '../src/service-kit.ts';
const entry = process.env.MEDIA_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.MEDIA_PACKAGE_ROOT, 'package.json')).resolve('@accountability/media-production/engine');
const { createEngine } = await import(pathToFileURL(entry).href);
const permission = 'E11:permission:fictional-asset';
const denied = (e: any) => e?.code === 'consent_denied';
const asset = (h: any) => h.engine.importAsset(ctx(), { name: 'Fictional private page', filename: 'page.png', bytes: ledgerPage(h.root), rights: { kind: 'permission', ref: permission }, sources: ['E05:evidence_version:fictional-page@1'] });
function store(h: any, read: (key: string) => Promise<Uint8Array>): ObjectStore {
  return { get: read, put: h.objects.put.bind(h.objects), head: h.objects.head.bind(h.objects), delete: h.objects.delete.bind(h.objects), list: h.objects.list.bind(h.objects) };
}
test('asset read requires fresh permission before storage and withholds withdrawal during retrieval', needsPg, async () => withEngine(async h => {
  const a = await asset(h); let reads = 0, withdraw = false;
  const reader = createEngine({ sql: h.sql, ports: { useDecisions: h.port }, objects: store(h, async key => { reads++; const bytes = await h.objects.get(key); if (withdraw) h.port.deny.add(permission); return bytes; }) });
  h.port.deny.add(permission); await assert.rejects(reader.getAssetBytes(ctx(), a.id), denied); assert.equal(reads, 0);
  h.port.deny.clear(); h.port.review.add(permission); await assert.rejects(reader.getAssetBytes(ctx(), a.id), denied); assert.equal(reads, 0);
  h.port.review.clear(); withdraw = true; await assert.rejects(reader.getAssetBytes(ctx(), a.id), denied); assert.equal(reads, 1);
  assert.equal((await h.engine.getAsset(ctx(), a.id)).blocked, false); assert.equal((await h.engine.getAsset(ctx(), a.id)).versions.length, 1);
}));
test('historical asset reads use newest rights and reject rights changes during I/O', needsPg, async () => withEngine(async h => {
  const a = await asset(h); let change = false;
  const updated = 'E11:permission:fictional-corrected';
  const reader = createEngine({ sql: h.sql, ports: { useDecisions: h.port }, objects: store(h, async key => {
    const bytes = await h.objects.get(key); if (change) await h.engine.setAssetRights(ctx(), { assetId: a.id, rights: { kind: 'permission', ref: updated } }); return bytes;
  }) });
  change = true; await assert.rejects(reader.getAssetBytes(ctx(), a.id, 1), denied);
  change = false; h.port.deny.add(updated); await assert.rejects(reader.getAssetBytes(ctx(), a.id, 1), denied);
  assert.equal((await h.engine.getAsset(ctx(), a.id)).versions.length, 2);
}));
test('asset read verifies actual byte integrity and owns producer buffers across later callbacks', needsPg, async () => withEngine(async h => {
  const a = await asset(h); let producer: Buffer | undefined, corrupt = false;
  const objects = store(h, async key => { producer = Buffer.from(await h.objects.get(key)); if (corrupt) producer[0] = 0; return producer; });
  const reader = createEngine({ sql: h.sql, objects, ports: { useDecisions: { async decide(c: any, r: any) { producer?.fill(0); return h.port.decide(c, r); } } } });
  const result = await reader.getAssetBytes(ctx(), a.id, 1); assert.equal(sha256(result.bytes), a.versions[0].sha256); assert.ok(producer?.every(x => x === 0));
  producer = undefined; corrupt = true; await assert.rejects(reader.getAssetBytes(ctx(), a.id, 1), (e: any) => e?.code === 'integrity_failed');
}));
test('asset reads recheck optional host authorization after I/O without leaking errors', needsPg, async () => withEngine(async h => {
  const a = await asset(h); let allowed = true;
  const reader = createEngine({ sql: h.sql, objects: store(h, async key => { const bytes = await h.objects.get(key); allowed = false; return bytes; }), ports: {
    useDecisions: h.port, authorization: { async authorize() { if (!allowed) throw new Error('SYNTHETIC_PRIVATE_MARKER'); return { allowed: true, reason: 'fixture', policyVersion: 'fixture' }; } },
  } });
  await assert.rejects(reader.getAssetBytes(ctx(), a.id), (e: any) => e?.code === 'forbidden' && !String(e).includes('SYNTHETIC_PRIVATE_MARKER'));
}));
