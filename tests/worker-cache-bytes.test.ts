// Own PostgreSQL and real FFmpeg; corrupted cache metadata fixture is not an administrative API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ctx, finish, needsPg, withEngine } from './helpers.ts';
const entry = process.env.MEDIA_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
 : createRequire(resolve(process.env.MEDIA_PACKAGE_ROOT, 'package.json')).resolve('@accountability/media-production/engine');
const { createEngine } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
for (const kind of ['negative', 'mismatch'] as const) {
 test('worker skips unusable cache byte counts: ' + kind, needsPg, () => withEngine(async h => {
  const c = ctx(); const engine = createEngine({ sql: h.sql, objects: h.objects, config: { workRoot: h.root }, ports: { useDecisions: h.port } });
  const project = await engine.createProject(c, { kind: 'video', title: 'Fictional cache byte budget', doc: {
   title: 'Fictional private clip', width: 160, height: 90, fps: 12, credits: { enabled: false },
   scenes: [{ id: 'one', duration: 1, visual: { type: 'color', color: '#202020' }, captions: [{ start: 0, end: 1, text: 'Fictional private clip' }] }],
  } });
  const seed = await finish(engine, c, await engine.requestRender(c, { productionId: project.id, profile: 'preview' }));
  assert.equal(seed.state, 'done', seed.error ?? '');
  const hit = await finish(engine, c, await engine.requestRender(c, { productionId: project.id, profile: 'preview' }));
  assert.equal(hit.state, 'done', hit.error ?? '');
  assert.equal(((await engine.getRenderManifest(c, hit.id)) as any).parameters.segmentCache.hits, 1);
  const before = await h.sql.query<{ hash: string; size: string }>('select hash, size from e10_production.render_cache where tenant_id=$1 and project_id=$2', [c.tenantId,c.projectId]);
  assert.equal(before.length, 1);
  // Controlled owning-SQL corruption; never delete/evict to bypass a guard.
  const invalid = kind === 'negative' ? '-1' : String(Number(before[0]!.size) + 1);
  await h.sql.query('update e10_production.render_cache set size=$1 where tenant_id=$2 and project_id=$3', [invalid,c.tenantId,c.projectId]);
  const result = await finish(engine, c, await engine.requestRender(c, { productionId: project.id, profile: 'preview' }));
  assert.equal(result.state, 'done', result.error ?? '');
  assert.equal(((await engine.getRenderManifest(c, result.id)) as any).parameters.segmentCache.hits, 0, 'invalid cache count must not be admitted as a hit');
  const after = await h.sql.query<{ hash: string; size: string }>('select hash, size from e10_production.render_cache where tenant_id=$1 and project_id=$2', [c.tenantId,c.projectId]);
  assert.equal(after.length, 1); assert.equal(after[0]!.hash,before[0]!.hash); assert.equal(String(after[0]!.size),invalid);
  assert.equal((await engine.listRenders(c, { productionId: project.id })).length,3);
 }));
}
