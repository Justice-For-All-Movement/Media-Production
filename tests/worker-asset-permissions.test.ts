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
for (const change of ['withdrawal', 'rights-basis'] as const) test(`worker withholds materialization after ${change} during asset retrieval`, needsPg, async () => withEngine(async h => {
  const { c, asset, project } = await fixture(h); let reads = 0;
  const worker = createEngine({ sql: h.sql, config: { workRoot: h.root }, ports: { useDecisions: h.port },
    objects: objects(h, async key => { reads++; const bytes = await h.objects.get(key);
      if (change === 'withdrawal') h.port.deny.add(permission);
      else await h.engine.setAssetRights(c, { assetId: asset.id, rights: { kind: 'permission', ref: 'E11:permission:fictional-new-basis' } });
      return bytes;
    }) });
  const request = await worker.requestRender(c, { productionId: project.id });
  const result = await finish(worker, c, request);
  assert.equal(result.state, 'blocked', result.error ?? ''); assert.equal(reads, 1);
  assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
  assert.equal((await h.engine.getAsset(c, asset.id)).versions.length, change === 'withdrawal' ? 1 : 2);
  assert.equal((await worker.getRender(c, request.id)).state, 'blocked');
  assert.deepEqual(await h.objects.list(`${c.tenantId}/${c.projectId}/renders/${request.id}`), []);
}));
test('worker rechecks permission before reusing an already materialized asset', needsPg, async () => withEngine(async h => {
  const { c, asset, project } = await fixture(h); let writes = 0;
  const original = fs.writeFile;
  fs.writeFile = (async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (String(args[0]).includes(`asset-${asset.id.slice(0, 8)}-v1-`)) { writes++; h.port.deny.add(permission); }
    return result;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const request = await h.engine.requestRender(c, { productionId: project.id });
    const result = await finish(h.engine, c, request);
    assert.equal(writes, 1); assert.equal(result.state, 'blocked', result.error ?? '');
    assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
    assert.equal((await h.engine.getAsset(c, asset.id)).versions.length, 1);
  } finally { fs.writeFile = original; syncBuiltinESMExports(); }
}));
