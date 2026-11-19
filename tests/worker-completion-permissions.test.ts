// Actual owning PostgreSQL/image worker; synthetic decisions are not live E11/current-human proof.
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
const permission = 'E11:permission:fictional-worker';
for (const change of ['withdrawal', 'rights-basis'] as const) test(`worker withholds completion after ${change} during output storage and retains bytes`, needsPg, async () => withEngine(async h => {
  const { c, asset, project } = await fixture(h); let changed = false, puts = 0;
  const worker = createEngine({ sql: h.sql, config: { workRoot: h.root }, ports: { useDecisions: h.port }, objects: {
    get: h.objects.get.bind(h.objects), head: h.objects.head.bind(h.objects), list: h.objects.list.bind(h.objects),
    async delete() { throw Error('retained output must not be deleted'); },
    async put(key: string, bytes: Uint8Array) {
      const result = await h.objects.put(key, bytes); puts++;
      if (!changed && key.includes('/renders/')) {
        changed = true;
        if (change === 'withdrawal') h.port.deny.add(permission);
        else await h.engine.setAssetRights(c, { assetId: asset.id, rights: { kind: 'permission', ref: 'E11:permission:fictional-completion-correction' } });
      }
      return result;
    },
  } });
  const request = await worker.requestRender(c, { productionId: project.id }); const result = await finish(worker, c, request);
  assert.ok(changed); assert.ok(puts > 0); assert.equal(result.state, 'blocked', result.error ?? '');
  assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
  const retained = await h.objects.list(`${c.tenantId}/${c.projectId}/renders/${request.id}`); assert.ok(retained.length > 0);
  await assert.rejects(worker.getRenderOutput(c, request.id, 'manifest.json'));
  assert.equal((await h.engine.getAsset(c, asset.id)).versions.length, change === 'withdrawal' ? 1 : 2);
  assert.deepEqual(await h.objects.list(`${c.tenantId}/${c.projectId}/renders/${request.id}`), retained);
}));

test('worker rechecks asset permission after pipeline use before storing any render output', needsPg, async () => withEngine(async h => {
  const { c, asset, project } = await fixture(h); let reads = 0, puts = 0;
  const worker = createEngine({ sql: h.sql, config: { workRoot: h.root }, ports: { useDecisions: h.port }, objects: {
    get: h.objects.get.bind(h.objects), head: h.objects.head.bind(h.objects), list: h.objects.list.bind(h.objects), delete: h.objects.delete.bind(h.objects),
    async put(key: string, bytes: Uint8Array) { puts++; return h.objects.put(key, bytes); },
  } });
  const original = fs.readFile;
  fs.readFile = (async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (/[/]img-[a-f0-9]{20}[.]png$/.test(String(args[0]))) { reads++; h.port.deny.add(permission); }
    return result;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const request = await worker.requestRender(c, { productionId: project.id }); const result = await finish(worker, c, request);
    assert.equal(reads, 1); assert.equal(result.state, 'blocked', result.error ?? ''); assert.equal(puts, 0);
    assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
    assert.deepEqual(await h.objects.list(`${c.tenantId}/${c.projectId}/renders/${request.id}`), []);
  } finally { fs.readFile = original; syncBuiltinESMExports(); }
}));
