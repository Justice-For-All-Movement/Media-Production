// Actual owning PostgreSQL/FFmpeg with a synthetic committed cache write and lost acknowledgement.
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
test('worker retains unknown cache write without leaking storage diagnostics or replaying', needsPg, () => withEngine(async h => {
  const c = ctx(); const marker = 'SYNTHETIC_PRIVATE_CACHE_WRITE_DIAGNOSTIC';
  const keys: string[] = [];
  const objects: ObjectStore = {
    async put(key, bytes) {
      assert.equal(this, objects);
      keys.push(key);
      await h.objects.put(key, bytes);
      assert.ok(key.includes('/cache/'), 'first write must be the actual segment cache');
      throw Error(marker);
    },
    get: h.objects.get.bind(h.objects), head: h.objects.head.bind(h.objects), list: h.objects.list.bind(h.objects),
    delete: async () => { throw Error('unknown cache state must be retained'); },
  };
  const engine = createEngine({ sql: h.sql, objects, config: { workRoot: h.root }, ports: { useDecisions: h.port } });
  const project = await engine.createProject(c, { kind: 'video', title: 'Fictional cache uncertainty', doc: {
    title: 'Fictional private clip', width: 160, height: 90, fps: 12, credits: { enabled: false },
    scenes: [{ id: 'one', duration: 1, visual: { type: 'color', color: '#202020' },
      captions: [{ start: 0, end: 1, text: 'Fictional private clip' }] }],
  } });
  const request = await engine.requestRender(c, { productionId: project.id, profile: 'preview' });
  const result = await finish(engine, c, request);
  assert.equal(result.state, 'failed'); assert.equal(keys.length, 1);
  assert.ok(!JSON.stringify(result).includes(marker));
  assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
  const retained = await h.objects.get(keys[0]!);
  assert.ok(retained.byteLength > 0, 'cache bytes were actually stored before acknowledgement loss');
  const rows = await h.sql.query('select hash from e10_production.render_cache where tenant_id=$1 and project_id=$2', [c.tenantId, c.projectId]);
  assert.equal(rows.length, 0, 'unknown write is not committed as reusable cache metadata');
  const audit = await engine.audit(c, { limit: 1000 });
  const events = await engine.events(c, { limit: 1000 });
  assert.ok(!JSON.stringify(audit).includes(marker)); assert.ok(!JSON.stringify(events).includes(marker));
  assert.ok(!audit.some(row => row.action === 'production.render_completed'));
  await assert.rejects(engine.getRenderManifest(c, request.id));
  assert.equal(await engine.runJobs(), 0); assert.equal(keys.length, 1);
  assert.equal((await engine.listRenders(c, { productionId: project.id })).length, 1);
  assert.ok((await h.objects.get(keys[0]!)).byteLength > 0);
}));
