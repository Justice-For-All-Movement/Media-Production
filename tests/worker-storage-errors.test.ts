// Owning PostgreSQL/private image worker, with synthetic lost ObjectStore acknowledgements; no crash/no-output proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ObjectStore } from '../src/service-kit.ts';
import { ctx, finish, needsPg, withEngine } from './helpers.ts';
const entry = process.env.MEDIA_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.MEDIA_PACKAGE_ROOT, 'package.json')).resolve('@accountability/media-production/engine');
const { createEngine } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
for (const mode of ['output-lost-ack', 'manifest-lost-ack', 'write-getter'] as const) {
  test(`worker sanitizes object storage ${mode} and retains uncertainty`, needsPg, () => withEngine(async h => {
    const c = ctx(); const marker = 'SYNTHETIC_PRIVATE_STORAGE_DIAGNOSTIC'; let writes = 0;
    const objects: ObjectStore = { async put(key, bytes) {
      writes++; const ack = await h.objects.put(key, bytes);
      if (mode === 'output-lost-ack' || (mode === 'manifest-lost-ack' && key.endsWith('/manifest.json'))) throw Error(marker);
      return ack;
    }, get: h.objects.get.bind(h.objects), head: h.objects.head.bind(h.objects), list: h.objects.list.bind(h.objects),
      delete: async () => { throw Error('unknown stored state must not be deleted'); } };
    if (mode === 'write-getter') Object.defineProperty(objects, 'put', { get() { throw Error(marker); } });
    const engine = createEngine({ sql: h.sql, objects, config: { workRoot: h.root }, ports: { useDecisions: h.port } });
    const project = await engine.createProject(c, { kind: 'image', title: 'Fictional storage uncertainty', doc: {
      title: 'Fictional private draft', canvas: { width: 320, height: 180, background: '#ffffff' }, export: { formats: ['png'] },
      layers: [{ id: 'private', type: 'text', text: 'Fictional private draft', x: 10, y: 20, width: 300, size: 16 }],
    } });
    const request = await engine.requestRender(c, { productionId: project.id, profile: 'preview' });
    const result = await finish(engine, c, request);
    assert.equal(result.state, 'failed'); assert.ok(!JSON.stringify(result).includes(marker));
    assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
    const audit = await engine.audit(c, { limit: 1000 }); assert.ok(!JSON.stringify(audit).includes(marker));
    const events = await engine.events(c, { limit: 1000 }); assert.ok(!JSON.stringify(events).includes(marker));
    assert.ok(!audit.some(row => row.action === 'production.render_completed'));
    await assert.rejects(engine.getRenderManifest(c, request.id));
    const stored = await h.objects.list(`${c.tenantId}/${c.projectId}/renders/${request.id}`);
    if (mode === 'write-getter') assert.equal(writes, 0);
    else { assert.ok(writes > 0); assert.ok(stored.length > 0); }
    const count = writes; assert.equal(await engine.runJobs(), 0); assert.equal(writes, count);
    assert.equal((await engine.listRenders(c, { productionId: project.id })).length, 1);
  }));
}
