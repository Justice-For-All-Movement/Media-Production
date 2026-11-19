// Actual owning PostgreSQL worker. Upstream flag records are metadata, not authenticated event/source truth.
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
const doc = { title: 'Fictional recorded withdrawal', canvas: { width: 320, height: 180, background: '#ffffff' }, export: { formats: ['png'] },
  layers: [{ id: 'private', type: 'text', text: 'Fictional private image', x: 10, y: 20, width: 300, size: 16 }] };
for (const timing of ['before-queue', 'after-queue'] as const) for (const profile of ['preview', 'final'] as const) {
  test(`worker honors recorded upstream block ${timing} for ${profile} despite allowing port`, needsPg, () => withEngine(async h => {
    const c = ctx(); let puts = 0;
    const objects: ObjectStore = { async put(key, bytes) { puts++; return h.objects.put(key, bytes); },
      get: h.objects.get.bind(h.objects), head: h.objects.head.bind(h.objects), list: h.objects.list.bind(h.objects),
      delete: async () => { throw Error('worker must retain existing state'); } };
    const engine = createEngine({ sql: h.sql, objects, config: { workRoot: h.root }, ports: { useDecisions: h.port } });
    const source = 'E05:evidence:fictional-recorded-withdrawal@1';
    const project = await engine.createProject(c, { kind: 'image', title: 'Fictional recorded project block', sources: [source], doc });
    const change = () => engine.applyUpstreamChange(c, { eventId: `fictional-${timing}-${profile}`, kind: 'permission_withdrawn', refs: [source], reason: 'Fictional recorded withdrawal' });
    if (timing === 'before-queue') await change();
    const request = await engine.requestRender(c, { productionId: project.id, profile });
    if (timing === 'after-queue') await change();
    assert.equal((await engine.getProject(c, project.id)).blocked, true);
    h.port.calls.length = 0;
    const result = await finish(engine, c, request);
    assert.equal(result.state, 'blocked'); assert.equal(puts, 0); assert.deepEqual(h.port.calls, []);
    assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
    assert.equal((await engine.listRevisions(c, project.id)).length, 1);
    assert.equal((await engine.listRenders(c, { productionId: project.id })).length, 1);
    await assert.rejects(engine.getRenderManifest(c, request.id));
    assert.deepEqual(await h.sql.query("select count(*)::integer as n from e10_production._audit where action='production.render_completed'"), [{ n: 0 }]);
    assert.equal((await engine.getProject(c, project.id)).blocked, true);
  }));
}

test('worker retains stored bytes when its own render is flagged during the final host callback', needsPg, () => withEngine(async h => {
  const c = ctx(); let renderId = '', calls = 0;
  const engine = createEngine({ sql: h.sql, objects: h.objects, config: { workRoot: h.root }, ports: { useDecisions: h.port,
    authorization: { async authorize() { calls++;
      // Owning SQL fixture, NOT an authenticated administrative API or independent concurrent session.
      if (calls === 2) await h.sql.query('update e10_production.renders set blocked=true where id=$1 and tenant_id=$2 and project_id=$3', [renderId, c.tenantId, c.projectId]);
      return { allowed: true, reason: 'Fictional host check', policyVersion: 'fixture' }; } },
  } });
  const project = await engine.createProject(c, { kind: 'image', title: 'Fictional render-record block', doc });
  const request = await engine.requestRender(c, { productionId: project.id, profile: 'preview' }); renderId = request.id;
  const result = await finish(engine, c, request);
  assert.equal(result.state, 'blocked'); assert.equal(calls, 2); assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
  assert.ok((await h.objects.list(`${c.tenantId}/${c.projectId}/renders/${renderId}`)).length > 0);
  assert.equal((await engine.getProject(c, project.id)).blocked, false);
  assert.equal((await engine.listRenders(c, { productionId: project.id })).length, 1);
  assert.deepEqual(await h.sql.query("select count(*)::integer as n from e10_production._audit where action='production.render_completed'"), [{ n: 0 }]);
}));
