// Owning PostgreSQL/private fictional image; synthetic storage errors are not authentication or crash proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ObjectStore } from '../src/service-kit.ts';
import { ctx, finish, ledgerPage, needsPg, withEngine } from './helpers.ts';
const entry = process.env.MEDIA_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.MEDIA_PACKAGE_ROOT, 'package.json')).resolve('@accountability/media-production/engine');
const { createEngine } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
for (const mode of ['reject', 'getter'] as const) {
  test('worker source-read privacy: ' + mode, needsPg, () => withEngine(async h => {
    const c = ctx(), marker = 'SYNTHETIC_PRIVATE_SOURCE_STORAGE'; let reads = 0, puts = 0;
    const asset = await h.engine.importAsset(c, { name: 'Fictional private page', filename: 'page.png', bytes: ledgerPage(h.root),
      rights: { kind: 'permission', ref: 'E11:permission:fictional-source-reader' } });
    const project = await h.engine.createProject(c, { kind: 'image', title: 'Fictional source read', doc: {
      title: 'Private draft', canvas: { width: 320, height: 180, background: '#ffffff' }, export: { formats: ['png'] },
      layers: [{ id: 'page', type: 'image', assetId: asset.id, assetVersion: 1, x: 0, y: 0, width: 320, height: 180, fit: 'contain' }],
    } });
    const objects: ObjectStore = { async get() { reads++; assert.equal(this, objects); throw Error(marker); },
      async put(key, bytes) { puts++; return h.objects.put(key, bytes); },
      head: h.objects.head.bind(h.objects), list: h.objects.list.bind(h.objects),
      delete: async () => { throw Error('retained history must not be deleted'); } };
    if (mode === 'getter') Object.defineProperty(objects, 'get', { get() { throw Error(marker); } });
    const worker = createEngine({ sql: h.sql, objects, config: { workRoot: h.root }, ports: { useDecisions: h.port } });
    const request = await worker.requestRender(c, { productionId: project.id, profile: 'preview' });
    const result = await finish(worker, c, request);
    assert.equal(result.state, 'failed'); assert.ok(!JSON.stringify(result).includes(marker));
    assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null); assert.equal(puts, 0);
    assert.equal(reads, mode === 'getter' ? 0 : 1);
    const audit = await worker.audit(c, { limit: 1000 });
    assert.ok(!JSON.stringify(audit).includes(marker)); assert.ok(!audit.some(row => row.action === 'production.render_completed'));
    assert.ok(!JSON.stringify(await worker.events(c, { limit: 1000 })).includes(marker));
    assert.equal((await h.engine.getAsset(c, asset.id)).versions[0]!.sha256, asset.versions[0]!.sha256);
    assert.equal((await worker.listRenders(c, { productionId: project.id })).length, 1);
    assert.equal(await worker.runJobs(), 0); assert.equal(puts, 0);
  }));
}
