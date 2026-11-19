// Actual owning PostgreSQL image worker; synthetic Consent, not source truth/current-human proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ObjectStore, UseDecisionPort } from '../src/service-kit.ts';
import { ctx, finish, needsPg, withEngine } from './helpers.ts';
const entry = process.env.MEDIA_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
  : createRequire(resolve(process.env.MEDIA_PACKAGE_ROOT, 'package.json')).resolve('@accountability/media-production/engine');
const { createEngine } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
for (const mode of ['deny', 'review', 'unknown', 'remove', 'throw'] as const) {
  test(`worker project-source reproduction handles ${mode} after storage without completion`, needsPg, () => withEngine(async h => {
    const c = ctx(); let stored = false, puts = 0, reproductions = 0;
    const subjects = ['E05:evidence:fictional-project@1', 'E07:claim:fictional-project@2'];
    const selected = { async decide(current: any, request: any): Promise<any> {
      if (request.action === 'reproduce') {
        reproductions++; assert.equal(this, selected); assert.ok(Object.isFrozen(current));
        assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.subjects));
        assert.deepEqual(request, { subjects, action: 'reproduce', purpose: c.purpose });
        if (stored && mode === 'throw') throw Error('SYNTHETIC_PRIVATE_PROJECT_POLICY');
      }
      const ordinary = await h.port.decide(current, request);
      return { ...ordinary, decision: stored ? mode === 'unknown' ? 'not_checked' : mode === 'review' ? 'review' : 'deny' : 'allow' };
    } };
    const ports: { useDecisions?: UseDecisionPort } = { useDecisions: selected };
    const objects: ObjectStore = {
      async put(key, bytes) { puts++; const result = await h.objects.put(key, bytes); stored = true;
        if (mode === 'remove') delete ports.useDecisions;
        return result;
      }, get: h.objects.get.bind(h.objects), head: h.objects.head.bind(h.objects), list: h.objects.list.bind(h.objects),
      delete: async () => { throw Error('retained bytes must not be deleted'); },
    };
    const engine = createEngine({ sql: h.sql, objects, config: { workRoot: h.root, standalone: { useDecisions: 'declared-rights' } }, ports });
    const project = await engine.createProject(c, { kind: 'image', title: 'Fictional private project use', sources: subjects,
      doc: { title: 'Fictional private draft', canvas: { width: 320, height: 180, background: '#ffffff' }, export: { formats: ['png'] },
        layers: [{ id: 'private', type: 'text', text: 'Fictional private draft', x: 10, y: 20, width: 300, size: 16 }] } });
    const request = await engine.requestRender(c, { productionId: project.id, profile: 'preview' });
    const result = await finish(engine, c, request);
    assert.equal(result.state, 'blocked'); assert.equal(reproductions, 1);
    assert.ok(puts > 0); assert.ok((await h.objects.list(`${c.tenantId}/${c.projectId}/renders/${request.id}`)).length > 0);
    assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_PROJECT_POLICY'));
    await assert.rejects(engine.getRenderManifest(c, request.id));
    assert.deepEqual(await h.sql.query("select count(*)::integer as n from e10_production._audit where action='production.render_completed'"), [{ n: 0 }]);
    assert.equal((await engine.listRenders(c, { productionId: project.id })).length, 1);
  }));
}
