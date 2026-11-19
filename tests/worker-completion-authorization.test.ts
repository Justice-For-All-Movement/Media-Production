// Real owning PostgreSQL worker with synthetic host authorization; not current-human proof.
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
for (const mode of ['deny', 'remove', 'throw'] as const) {
  test(`worker completion rechecks captured authorization after ${mode} during storage`, needsPg, () => withEngine(async h => {
    const c = ctx(); let stored = false, puts = 0, calls = 0;
    const selected = { async authorize(current: any, request: any): Promise<any> {
      assert.equal(this, selected); assert.ok(Object.isFrozen(current));
      assert.equal(request.capability, 'production:render'); calls++;
      if (stored && mode === 'throw') throw Error('SYNTHETIC_PRIVATE_COMPLETION');
      return { allowed: !stored, reason: 'SYNTHETIC_PRIVATE_COMPLETION', policyVersion: 'fixture' };
    } };
    const ports: any = { authorization: selected, useDecisions: h.port };
    const objects: ObjectStore = {
      async put(key, bytes) {
        puts++; const result = await h.objects.put(key, bytes); stored = true;
        if (mode === 'remove') delete ports.authorization;
        return result;
      }, get: h.objects.get.bind(h.objects), head: h.objects.head.bind(h.objects),
      list: h.objects.list.bind(h.objects), delete: async () => { throw Error('retained output must not be deleted'); },
    };
    const engine = createEngine({ sql: h.sql, objects, config: { workRoot: h.root }, ports });
    const project = await engine.createProject(c, { kind: 'image', title: 'Fictional private completion', doc: {
      title: 'Fictional private draft', canvas: { width: 320, height: 180, background: '#ffffff' }, export: { formats: ['png'] },
      layers: [{ id: 'private', type: 'text', text: 'Fictional private draft', x: 10, y: 20, width: 300, size: 16 }],
    } });
    const request = await engine.requestRender(c, { productionId: project.id, profile: 'preview' });
    const result = await finish(engine, c, request);
    assert.equal(result.state, 'failed'); assert.equal(calls, 2);
    assert.ok(puts > 0); assert.ok((await h.objects.list(`${c.tenantId}/${c.projectId}/renders/${request.id}`)).length > 0, 'written bytes remain retained as uncertainty');
    assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_COMPLETION'));
    await assert.rejects(engine.getRenderManifest(c, request.id));
    const completed = await h.sql.query("select count(*)::integer as n from e10_production._audit where action='production.render_completed'");
    assert.deepEqual(completed, [{ n: 0 }]);
    assert.equal((await engine.listRenders(c, { productionId: project.id })).length, 1);
  }));
}
