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
for (const mode of ['truthy', 'false', 'throw', 'getter', 'allow'] as const) {
  test(`worker entry authorizer handles ${mode} without leaking host diagnostics`, needsPg, () => withEngine(async h => {
    const c = ctx(); let armed = false, puts = 0, calls = 0;
    const marker = 'SYNTHETIC_PRIVATE_WORKER_AUTHORIZATION';
    const selected = { async authorize(current: any, request: any): Promise<any> {
      assert.equal(this, selected);
      if (!armed) return { allowed: true, reason: 'fixture', policyVersion: 'fixture' };
      calls++; assert.ok(Object.isFrozen(current)); assert.equal(request.capability, 'production:render');
      assert.equal(current.tenantId, c.tenantId); assert.equal(current.projectId, c.projectId); assert.equal(current.actor.id, c.actor.id);
      if (mode === 'throw') throw Error(marker);
      if (mode === 'getter') return { get allowed() { throw Error(marker); } };
      return { allowed: mode === 'truthy' ? 'yes' : mode === 'allow', reason: marker, policyVersion: 'fixture' };
    } };
    const objects: ObjectStore = {
      async put(key, bytes) { puts++; return h.objects.put(key, bytes); },
      get: h.objects.get.bind(h.objects), head: h.objects.head.bind(h.objects),
      list: h.objects.list.bind(h.objects), delete: h.objects.delete.bind(h.objects),
    };
    const engine = createEngine({ sql: h.sql, objects, config: { workRoot: h.root }, ports: { authorization: selected, useDecisions: h.port } });
    const project = await engine.createProject(c, { kind: 'image', title: 'Fictional private worker entry', doc: {
      title: 'Fictional private draft', canvas: { width: 320, height: 180, background: '#ffffff' }, export: { formats: ['png'] },
      layers: [{ id: 'private', type: 'text', text: 'Fictional private draft', x: 10, y: 20, width: 300, size: 16 }],
    } });
    const request = await engine.requestRender(c, { productionId: project.id, profile: 'preview' });
    armed = true;
    const result = await finish(engine, c, request);
    assert.equal(calls, mode === 'allow' ? 2 : 1, 'literal allow is rechecked before completion; initial denial never reaches storage');
    if (mode === 'allow') {
      assert.equal(result.state, 'done', result.error ?? ''); assert.ok(puts > 0); assert.ok(result.outputs.length > 0);
    } else {
      assert.equal(result.state, 'failed', result.error ?? ''); assert.equal(puts, 0);
      assert.deepEqual(result.outputs, []); assert.equal(result.manifestDigest, null);
      assert.ok(!JSON.stringify(result).includes(marker));
      const recorded = await h.sql.query(`select row_to_json(r) as record from e10_production.renders r where id=$1`, [request.id]);
      const audits = await h.sql.query('select row_to_json(a) as record from e10_production._audit a');
      const events = await h.sql.query('select row_to_json(e) as record from e10_production._events e');
      assert.ok(!JSON.stringify({ recorded, audits, events }).includes(marker), 'private host diagnostics never enter retained failure records');
      assert.deepEqual(await h.objects.list(`${c.tenantId}/${c.projectId}/renders/${request.id}`), []);
    }
    assert.equal((await engine.listRenders(c, { productionId: project.id })).length, 1, 'history remains, no second job');
  }));
}
