// Owning PostgreSQL/public writers and a fictional image worker, not independent session contention or current-human proof.
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
for (const mode of ['sources-at-put', 'sources-at-final-host', 'editorial-at-final-host', 'head-at-put', 'unchanged'] as const) {
  test(`worker completion keeps its complete selected project basis: ${mode}`, needsPg, () => withEngine(async h => {
    const c = ctx(); let productionId = '', changed = false, puts = 0, calls = 0;
    const added = 'E05:evidence:fictional-new-obligation@1'; h.port.deny.add(added);
    const doc = { title: 'Fictional selected image', canvas: { width: 320, height: 180, background: '#ffffff' }, export: { formats: ['png'] },
      layers: [{ id: 'private', type: 'text', text: 'Fictional private draft', x: 10, y: 20, width: 300, size: 16 }] };
    const change = async () => {
      if (changed || mode === 'unchanged') return;
      changed = true;
      if (mode === 'head-at-put') await engine.saveRevision(c, { productionId, baseRevision: 1, doc: { ...doc, title: 'Fictional next image' }, summary: 'New private edition' });
      else if (mode === 'editorial-at-final-host') await engine.updateProjectLinks(c, { productionId, editorialRef: added });
      else await engine.updateProjectLinks(c, { productionId, sources: [added] });
    };
    const objects: ObjectStore = {
      async put(key, bytes) { puts++; const result = await h.objects.put(key, bytes);
        if (mode.endsWith('at-put')) await change();
        return result;
      }, get: h.objects.get.bind(h.objects), head: h.objects.head.bind(h.objects), list: h.objects.list.bind(h.objects),
      delete: async () => { throw Error('retained bytes must not be deleted'); },
    };
    const engine = createEngine({ sql: h.sql, objects, config: { workRoot: h.root }, ports: { useDecisions: h.port,
      authorization: { async authorize() { calls++; if (calls === 2 && mode.endsWith('final-host')) await change();
        return { allowed: true, reason: 'Fictional host check', policyVersion: 'fixture' }; } },
    } });
    const project = await engine.createProject(c, { kind: 'image', title: 'Fictional project continuity', sources: ['E07:claim:fictional-original@1'], doc });
    productionId = project.id;
    const request = await engine.requestRender(c, { productionId, profile: 'preview' });
    const result = await finish(engine, c, request);
    assert.equal(calls, 2); assert.ok(puts > 0); assert.equal(changed, mode !== 'unchanged');
    assert.equal(result.state, mode === 'unchanged' ? 'done' : 'blocked');
    const completed = await h.sql.query("select count(*)::integer as n from e10_production._audit where action='production.render_completed'");
    assert.deepEqual(completed, [{ n: mode === 'unchanged' ? 1 : 0 }]);
    assert.equal((await engine.listRenders(c, { productionId })).length, 1);
    assert.equal((await engine.listRevisions(c, productionId)).length, mode === 'head-at-put' ? 2 : 1);
    assert.ok((await h.objects.list(`${c.tenantId}/${c.projectId}/renders/${request.id}`)).length > 0);
    if (mode !== 'unchanged') {
      assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
      await assert.rejects(engine.getRenderManifest(c, request.id));
      assert.deepEqual((await engine.getRevision(c, productionId, 1)).doc, doc);
      const current = await engine.getProject(c, productionId);
      if (mode.startsWith('sources')) assert.deepEqual(current.sources, [added]);
      if (mode.startsWith('editorial')) assert.equal(current.editorialRef, added);
      if (mode.startsWith('head')) assert.equal(current.headRevision, 2);
    } else { assert.ok(result.outputs.length > 0); assert.ok(result.manifestDigest); }
  }));
}
