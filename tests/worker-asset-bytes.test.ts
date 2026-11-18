// Actual owning PostgreSQL and image worker. Filesystem interception below is a deterministic
// producer-mutation fixture at the write boundary, not an isolated sandbox or live rights test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ObjectStore } from '../src/service-kit.ts';
import { sha256 } from '../src/engine/tools.ts';
import { ctx, finish, ledgerPage, needsPg, withEngine } from './helpers.ts';
const entry = process.env.MEDIA_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.MEDIA_PACKAGE_ROOT, 'package.json')).resolve('@accountability/media-production/engine');
const { createEngine } = await import(pathToFileURL(entry).href);
async function fixture(h: Parameters<Parameters<typeof withEngine>[0]>[0]) {
  const c = ctx();
  const asset = await h.engine.importAsset(c, { name: 'Fictional private worker page', filename: 'page.png', bytes: ledgerPage(h.root),
    rights: { kind: 'permission', ref: 'E11:permission:fictional-worker' }, sources: ['E05:evidence_version:fictional-worker@1'] });
  const project = await h.engine.createProject(c, { kind: 'image', title: 'Fictional worker byte fixture', doc: {
    title: 'Private worker fixture', canvas: { width: 320, height: 180, background: '#ffffff' }, export: { formats: ['png'] },
    layers: [{ id: 'page', type: 'image', assetId: asset.id, assetVersion: 1, x: 0, y: 0, width: 320, height: 180, fit: 'contain' }],
  } });
  return { c, asset, project };
}
function objects(h: Parameters<Parameters<typeof withEngine>[0]>[0], get: ObjectStore['get']): ObjectStore {
  return { get, put: h.objects.put.bind(h.objects), head: h.objects.head.bind(h.objects), delete: h.objects.delete.bind(h.objects), list: h.objects.list.bind(h.objects) };
}
test('worker rejects inconsistent or unsafe recorded asset sizes without output or history removal', needsPg, async () => withEngine(async h => {
  const { c, asset, project } = await fixture(h);
  const original = asset.versions[0]!;
  // Deliberate SQL fixture corruption, not an engine metadata-edit/admin API.
  for (const size of [String(original.size - 1), String(original.size + 1), '-1', '9007199254740993']) {
    await h.sql.query('update e10_production.asset_versions set size=$2 where asset_id=$1 and version=1', [asset.id, size]);
    const request = await h.engine.requestRender(c, { productionId: project.id });
    const result = await finish(h.engine, c, request);
    assert.equal(result.state, 'failed', `size ${size} must not materialize an asset`);
    assert.match(result.error ?? '', /integrity_failed/);
    assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
    assert.equal((await h.engine.getAsset(c, asset.id)).versions.length, 1);
    assert.equal((await h.engine.getRender(c, request.id)).state, 'failed');
    assert.deepEqual(await h.objects.list(`${c.tenantId}/${c.projectId}/renders/${request.id}`), []);
  }
}));
test('worker still rejects equal-count corrupted bytes before render output', needsPg, async () => withEngine(async h => {
  const { c, asset, project } = await fixture(h);
  const worker = createEngine({ sql: h.sql, config: { workRoot: h.root }, ports: { useDecisions: h.port },
    objects: objects(h, async key => { const bytes = new Uint8Array(await h.objects.get(key)); bytes[0] = bytes[0]! ^ 255; return bytes; }) });
  const result = await finish(worker, c, await worker.requestRender(c, { productionId: project.id }));
  assert.equal(result.state, 'failed'); assert.match(result.error ?? '', /integrity_failed/);
  assert.deepEqual(result.outputs, []); assert.equal((await h.engine.getAsset(c, asset.id)).versions[0]!.sha256, asset.versions[0]!.sha256);
}));
test('worker owns producer Buffer before filesystem admission and renders the exact recorded edition', needsPg, async () => withEngine(async h => {
  const { c, asset, project } = await fixture(h);
  let producer: Buffer | undefined, writes = 0;
  const worker = createEngine({ sql: h.sql, config: { workRoot: h.root }, ports: { useDecisions: h.port },
    objects: objects(h, async key => { producer = Buffer.from(await h.objects.get(key)); return producer; }) });
  const original = fs.writeFile;
  fs.writeFile = (async (...args: Parameters<typeof original>) => {
    if (String(args[0]).includes(`asset-${asset.id.slice(0, 8)}-v1-`)) {
      writes++; assert.ok(producer); producer.fill(0);
      assert.ok(args[1] instanceof Uint8Array);
      assert.equal(sha256(args[1]), asset.versions[0]!.sha256, 'producer mutation cannot change admitted file bytes');
      assert.equal(args[1].byteLength, asset.versions[0]!.size);
    }
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const result = await finish(worker, c, await worker.requestRender(c, { productionId: project.id }));
    assert.equal(result.state, 'done', result.error ?? ''); assert.equal(writes, 1);
    const manifest = await worker.getRenderManifest(c, result.id) as { inputs: { ref: string; sha256: string; size: number }[] };
    assert.equal(manifest.inputs.length, 1); assert.equal(manifest.inputs[0]!.ref, asset.versions[0]!.ref);
    assert.equal(manifest.inputs[0]!.sha256, asset.versions[0]!.sha256); assert.equal(manifest.inputs[0]!.size, asset.versions[0]!.size);
  } finally { fs.writeFile = original; syncBuiltinESMExports(); }
}));
