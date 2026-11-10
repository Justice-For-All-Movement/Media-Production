import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DomainError } from '../src/contracts.ts';
import * as kit from '../src/service-kit.ts';
import { SCHEMA, manifest, migrate } from '../src/engine/index.ts';
import { CAPS, LICENSE, ctx, eventsOfType, finish, ledgerPage, needsPg, withEngine } from './helpers.ts';

const fails = (code: string, match?: RegExp) => (e: unknown): boolean => { assert.ok(e instanceof DomainError, `expected DomainError, got ${String(e)}`); assert.equal(e.code, code, e.message); if (match) assert.match(e.message, match); return true; };
const E09 = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'e09-exports.json'), 'utf8'));
const PERM = 'E11:permission:perm-ledger';
const page = (h: { engine: any; root: string }, c = ctx(), over: any = {}) => h.engine.importAsset(c, { name: 'Ledger page 14', filename: 'ledger.png', bytes: ledgerPage(h.root), rights: { kind: 'permission', ref: PERM, attribution: 'Larkmoor council archive' }, provenance: { sourceRefs: ['E05:evidence_version:ev-ledger@1'] }, ...over });
const card = (assetId: string): any => ({ title: 'Ledger card', canvas: { width: 640, height: 360, background: '#22223b' }, export: { formats: ['png'] }, sources: ['E07:claim:c-ledger@2'], layers: [{ id: 'img', type: 'image', assetId, x: 20, y: 20, width: 300, height: 320 }, { id: 't', type: 'text', text: 'No receipt', x: 340, y: 150, width: 280, size: 40, color: '#ffffff' }] });

test('manifest and migrations', needsPg, async () => {
  await withEngine(async ({ engine, sql }) => {
    assert.equal(manifest.id, 'E10'); assert.equal(SCHEMA, 'e10_production'); assert.equal(manifest.kit, kit.SERVICE_KIT_VERSION);
    assert.deepEqual(await migrate(sql), []);                                                // idempotent
    const h = await engine.health(); assert.equal(h.ok, true); assert.match(String((h.detail as any).tools.ffmpeg), /ffmpeg version/);
  });
});

test('projects are built from real E09 exports and carry disclosures into every medium', needsPg, async () => {
  await withEngine(async (h) => {
    const { engine } = h; const c = ctx(); const asset = await page(h);
    // written work from an article export
    const w = await engine.createProjectFromEditorial(c, { kind: 'written', editorial: E09.article });
    assert.equal(w.editorialRef, E09.article.manifest.document); assert.match(w.editorialRef!, /^E09:document:[0-9a-f-]+@1$/); assert.ok(w.sources.includes('E07:claim:c-ledger@2'));
    const wr = await finish(engine, c, await engine.requestRender(c, { productionId: w.id, profile: 'preview' }));
    const html = Buffer.from((await engine.getRenderOutput(c, wr.id, wr.outputs[0]!.name)).bytes).toString();
    assert.match(html, /RECONSTRUCTION<\/strong> — This scene is reconstructed from committee minutes/); assert.match(html, /Mirela Novak, shopkeeper/); assert.match(html, /<h1>The ledger<\/h1>/); assert.match(html, /Written by Ines Varga/);
    assert.equal(((await engine.getRenderManifest(c, wr.id)) as any).disclosures[0].blockId, 'a2');
    // song from a lyrics export: key, tempo, sections and disclosures come from the lyric blocks
    const s = await engine.createProjectFromEditorial(c, { kind: 'audio', editorial: E09.lyrics });
    const song = (await engine.getRevision(c, s.id)).doc as any;
    assert.deepEqual(song.key, { tonic: 'D', mode: 'minor' }); assert.equal(song.tempo, 108); assert.deepEqual(song.sections.map((x: any) => [x.id, x.type, x.basis]), [['v1', 'verse', 'reconstruction'], ['c1', 'chorus', 'invention']]);
    assert.match(song.sections[1].disclosure, /songwriters/); assert.ok(song.tracks[0].notes.length > 40);
    // timeline from a script export: scene panels → clips, narration/dialogue → speech, asset refs bound to library assets
    const v = await engine.createProjectFromEditorial(c, { kind: 'video', editorial: E09.script, options: { assets: { 'E05:evidence_version:ev-ledger': asset.id }, width: 640, height: 360, fps: 12 } });
    const tl = (await engine.getRevision(c, v.id)).doc as any;
    assert.deepEqual(tl.scenes.map((x: any) => [x.id, x.visual.type, x.duration, x.basis]), [['s1-p1', 'image', 5, 'verified_fact'], ['s2-p1', 'title', 4, 'reconstruction']]);
    assert.equal(tl.scenes[0].narration.text, 'One transfer of thirty one thousand has no receipt.'); assert.equal(tl.scenes[0].overlays[0].text, '31,000 unaccounted');
    assert.equal(tl.scenes[1].narration.text, 'Shopkeeper: We were told the fund was full.'); assert.equal(tl.scenes[1].overlays[0].type, 'lowerThird');
    assert.ok((await engine.validateProject(c, v.id)).problems.some((p) => /storyboard placeholder/.test(p.message)));
    const vr = await finish(engine, c, await engine.requestRender(c, { productionId: v.id, profile: 'preview' }));
    assert.equal(vr.state, 'done', vr.error ?? '');
    const srt = Buffer.from((await engine.getRenderOutput(c, vr.id, vr.outputs.find((o) => o.name.endsWith('.srt'))!.name)).bytes).toString();
    assert.match(srt, /\[RECONSTRUCTION\] Staged reconstruction of the night at the pump house\./); assert.match(srt, /We were told the fund was full/);
    const vm = await engine.getRenderManifest(c, vr.id) as any; assert.ok(vm.credits.includes('Written by Ines Varga') || vm.details.timeline.some((x: any) => x.kind === 'credits'));
    assert.deepEqual(vm.details.timeline.map((x: any) => x.kind), ['scene', 'disclosure', 'scene', 'credits']);
    // interactive work from an interactive_story export
    const i = await engine.createProjectFromEditorial(c, { kind: 'interactive', editorial: E09.interactive });
    const graph = (await engine.getRevision(c, i.id)).doc as any;
    assert.equal(graph.start, 'start'); assert.deepEqual(graph.variables, { sawLedger: false }); assert.equal(graph.nodes[2].choices[0].condition.var, 'sawLedger'); assert.equal(graph.nodes[3].attribution, 'Tomas Brandt, treasurer');
    assert.equal((await engine.validateProject(c, i.id)).ok, true);
    const preview = await engine.previewInteractive(c, i.id); assert.match(preview, /This meeting is reconstructed from committee minutes/); assert.match(preview, /This ending is invented to close the path/);
    // quote card from one block
    const q = await engine.createProjectFromEditorial(c, { kind: 'image', editorial: E09.article, options: { blockId: 'a2', width: 800, height: 450 } });
    assert.equal(((await engine.getRevision(c, q.id)).doc as any).basis, 'reconstruction');
    // an export whose reconstruction block lost its disclosure is refused
    const broken = structuredClone(E09.article); delete broken.document.blocks[1].disclosure; broken.document.disclosures = [];
    await assert.rejects(engine.createProjectFromEditorial(c, { kind: 'written', editorial: broken }), fails('invalid_input', /carries no disclosure/));
    await assert.rejects(engine.createProjectFromEditorial(c, { kind: 'written', editorial: { blocks: [] } }), fails('invalid_input'));
  });
});

test('consent gate: deny blocks renders and exports with reasons; decisions are recorded', needsPg, async () => {
  await withEngine(async (h) => {
    const { engine, port } = h; const c = ctx(); const asset = await page(h);
    const p = await engine.createProject(c, { kind: 'image', title: 'Ledger card', doc: card(asset.id) });
    port.deny.add(PERM);
    const blocked = await engine.requestRender(c, { productionId: p.id });
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.blocked, true); assert.equal(blocked.jobId, null);
    assert.match(blocked.error!, /Use of asset "Ledger page 14" for "adapt" was denied: permission withdrawn for E11:permission:perm-ledger/);
    assert.equal(blocked.decisions[0]!.decision, 'deny'); assert.equal(await engine.runJobs(), 0);
    assert.equal((await eventsOfType(engine, c, 'production.render_blocked')).length, 1);
    await assert.rejects(engine.getRenderManifest(c, blocked.id), fails('invalid_state'));
    assert.deepEqual(port.calls[0], { subjects: [asset.versions[0]!.ref, PERM, 'E05:evidence_version:ev-ledger@1'], action: 'adapt' });   // every asset and source is asked about
    assert.deepEqual(port.calls[1], { subjects: ['E07:claim:c-ledger@2'], action: 'adapt' });
    port.deny.clear(); port.review.add(PERM);                                                  // "review": previews may proceed, finals may not
    assert.equal((await finish(engine, c, await engine.requestRender(c, { productionId: p.id, profile: 'preview' }))).state, 'done');
    assert.match((await engine.requestRender(c, { productionId: p.id })).error!, /needs rights review/);
    port.review.clear();
    const queued = await engine.requestRender(c, { productionId: p.id });
    port.deny.add(PERM);                                                                       // withdrawn after the request, before the worker runs
    const late = await finish(engine, c, queued); assert.equal(late.state, 'blocked'); assert.equal(late.outputs.length, 0);
    port.deny.clear();
    const done = await finish(engine, c, await engine.requestRender(c, { productionId: p.id })); assert.equal(done.state, 'done', done.error ?? '');
    const man = await engine.getRenderManifest(c, done.id) as any;
    assert.deepEqual(man.decisions.map((d: any) => [d.action, d.decision, d.by]), [['adapt', 'allow', 'use-decision-port'], ['adapt', 'allow', 'use-decision-port']]);
    assert.deepEqual(man.decisions[0].permissionRefs, [PERM]);
    // export: sensitive capability, approved assets, and its own "reproduce" decision
    await assert.rejects(engine.createExport(ctx({ capabilities: ['production:*'] }), { renderId: done.id }), fails('forbidden'));
    await assert.rejects(engine.createExport(c, { renderId: done.id }), fails('approval_invalid', /Ledger page 14/));
    await assert.rejects(engine.setAssetApproval(ctx({ capabilities: ['production:*'] }), { assetId: asset.id, approval: 'approved' }), fails('forbidden'));
    assert.equal((await engine.setAssetApproval(c, { assetId: asset.id, approval: 'approved', note: 'cleared by rights desk' })).approval, 'approved');
    port.deny.add(PERM); await assert.rejects(engine.createExport(c, { renderId: done.id }), fails('consent_denied', /"reproduce" was denied/)); port.deny.clear();
    const ex = await engine.createExport(c, { renderId: done.id, audience: 'public', destination: 'web', idempotencyKey: 'ex-1' });
    assert.ok(port.calls.some((x) => x.action === 'reproduce' && x.subjects.includes(PERM)));
    assert.equal((await engine.createExport(c, { renderId: done.id, audience: 'public', destination: 'web', idempotencyKey: 'ex-1' })).id, ex.id);
    const file = await engine.getExportBytes(c, ex.id); const zip = join(h.root, 'export.zip'); (await import('node:fs')).writeFileSync(zip, file.bytes);
    const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(names, ['CREDITS.txt', 'Ledger-card.png', 'Ledger-card.png.provenance.json', 'export.json', 'manifest.json']);
    const side = JSON.parse(execFileSync('unzip', ['-p', zip, 'Ledger-card.png.provenance.json'], { encoding: 'utf8' }));
    assert.equal(side.sha256, done.outputs[0]!.sha256); assert.equal(side.inputs[0].rights.ref, PERM); assert.equal(side.manifestDigest, done.manifestDigest);
    assert.match(execFileSync('unzip', ['-p', zip, 'CREDITS.txt'], { encoding: 'utf8' }), /Ledger page 14 — Larkmoor council archive \(permission E11:permission:perm-ledger\)/);
    assert.equal((ex.manifest as any).decisions[0].action, 'reproduce'); assert.equal((ex.manifest as any).export.audience, 'public');
    await assert.rejects(engine.createExport(c, { renderId: blocked.id }), fails('invalid_state'));
    // a rejected asset stops rendering
    await engine.setAssetApproval(c, { assetId: asset.id, approval: 'rejected' });
    assert.match((await engine.requestRender(c, { productionId: p.id })).error!, /was rejected in review/);
  });
  // no port: deny unless the deployment explicitly selects the documented standalone mode
  await withEngine(async (h) => {
    const c = ctx(); const asset = await page(h, c, { rights: LICENSE }); const p = await h.engine.createProject(c, { kind: 'image', title: 'Ledger card', doc: card(asset.id) });
    const r = await h.engine.requestRender(c, { productionId: p.id }); assert.equal(r.state, 'blocked'); assert.match(r.error!, /No use-decision port is configured/);
  }, { noPort: true });
  await withEngine(async (h) => {
    const c = ctx(); const asset = await page(h, c, { rights: LICENSE }); const p = await h.engine.createProject(c, { kind: 'image', title: 'Ledger card', doc: card(asset.id) });
    const r = await finish(h.engine, c, await h.engine.requestRender(c, { productionId: p.id })); assert.equal(r.state, 'done', r.error ?? '');
    assert.equal(r.decisions[0]!.by, 'standalone-declared-rights'); assert.match(r.decisions[0]!.reasons[0]!, /not verified/);
  }, { noPort: true, config: { standalone: { useDecisions: 'declared-rights' } } });
});

test('upstream changes mark projects, renders and exports stale or blocked; nothing is deleted', needsPg, async () => {
  await withEngine(async (h) => {
    const { engine, objects } = h; const c = ctx(); const asset = await page(h); await engine.setAssetApproval(c, { assetId: asset.id, approval: 'approved' });
    const p = await engine.createProject(c, { kind: 'image', title: 'Ledger card', doc: card(asset.id), editorialRef: 'E09:document:doc-flood@3' });
    const other = await engine.createProject(c, { kind: 'written', title: 'Unrelated', doc: { title: 'Unrelated', chapters: [{ id: 'c1', title: 'One', blocks: [{ id: 'b1', type: 'paragraph', text: 'Nothing to do with the ledger.' }] }] } });
    const r1 = await finish(engine, c, await engine.requestRender(c, { productionId: p.id })); const ro = await finish(engine, c, await engine.requestRender(c, { productionId: other.id, profile: 'preview' }));
    const ex = await engine.createExport(c, { renderId: r1.id });
    await assert.rejects(engine.applyUpstreamChange(ctx({ capabilities: ['production:*'] }), { eventId: 'e0', kind: 'content_changed', refs: ['E09:document:doc-flood@4'], reason: 'x' }), fails('forbidden'));
    // the same revision the project is pinned to is not a change for it
    assert.deepEqual((await engine.applyUpstreamChange(c, { eventId: 'ev-same', kind: 'content_changed', refs: ['E09:document:doc-flood@3'], reason: 'republished' })).affected, []);
    const change = { eventId: 'ev-41', kind: 'content_changed' as const, refs: ['E09:document:doc-flood@4'], reason: 'Editorial revision 4 corrects the transfer amount' };
    const res = await engine.applyUpstreamChange(c, change);
    assert.deepEqual(res.affected, [`E10:project:${p.id}@1`, r1.ref, ex.ref]);
    assert.deepEqual((await engine.applyUpstreamChange(c, change)).affected, res.affected);       // idempotent by eventId
    assert.equal((await eventsOfType(engine, c, 'production.render_stale')).length, 1);
    const ev = (await eventsOfType(engine, c, 'production.render_stale'))[0]!; assert.equal(ev.subject, r1.ref); assert.deepEqual(ev.payload, { reason: change.reason, cause: 'ev-41', changeKind: 'content_changed', productionId: p.id, revision: 1 });
    assert.equal((await eventsOfType(engine, c, 'production.project_stale')).length, 1); assert.equal((await eventsOfType(engine, c, 'production.export_stale')).length, 1);
    const insp = (await engine.inspect(c, r1.ref))!; assert.equal(insp.stale, true); assert.equal(insp.state, 'stale'); assert.deepEqual(insp.staleReasons, [change.reason]); assert.deepEqual(insp.dependents, [ex.ref]);
    assert.ok(insp.sources.includes('E09:document:doc-flood@3') && insp.sources.includes(asset.versions[0]!.ref));
    assert.equal((await engine.inspect(c, `E10:project:${p.id}`))!.stale, true); assert.equal((await engine.inspect(c, ro.ref))!.stale, false); assert.equal((await engine.getProject(c, other.id)).stale, false);
    assert.equal((await engine.getRenderOutput(c, r1.id, 'Ledger-card.png')).sha256, r1.outputs[0]!.sha256);   // stale bytes are retained and readable
    assert.equal(((await engine.getRenderManifest(c, r1.id)) as any).status.stale, true);
    await assert.rejects(engine.createExport(c, { renderId: r1.id }), fails('stale', /re-rendered/));
    // re-link to the new editorial revision, re-render: a new, current version next to the old one
    assert.equal((await engine.updateProjectLinks(c, { productionId: p.id, editorialRef: 'E09:document:doc-flood@4', resolveStale: true })).stale, false);
    const r2 = await finish(engine, c, await engine.requestRender(c, { productionId: p.id })); assert.equal(r2.stale, false); assert.equal((await engine.getRender(c, r1.id)).stale, true);
    assert.equal((await engine.listRenders(c, { productionId: p.id })).length, 2);
    // a corrected source cited in a document block
    const src = await engine.applyUpstreamChange(c, { eventId: 'ev-42', kind: 'claim_changed', refs: ['E07:claim:c-ledger@3'], reason: 'Claim revised' });
    assert.ok(src.affected.includes(r2.ref) && src.affected.includes(`E10:project:${p.id}@1`));
    // permission withdrawn: asset, project, renders and exports are blocked for future use; bytes stay
    const w = await engine.applyUpstreamChange(c, { eventId: 'ev-43', kind: 'permission_withdrawn', refs: [PERM], reason: 'The archive withdrew permission' });
    assert.deepEqual(w.affected.slice(0, 2), [`E10:asset:${asset.id}`, `E10:project:${p.id}@1`]); assert.ok(w.affected.includes(r1.ref) && w.affected.includes(r2.ref) && w.affected.includes(ex.ref));
    assert.equal((await eventsOfType(engine, c, 'production.render_blocked', 2)).length, 2); assert.equal((await eventsOfType(engine, c, 'production.asset_blocked')).length, 1);
    assert.equal((await engine.getAsset(c, asset.id)).blocked, true); assert.equal((await engine.inspect(c, r2.ref))!.blocked, true); assert.equal((await engine.inspect(c, r2.ref))!.state, 'blocked');
    await assert.rejects(engine.getRenderOutput(c, r2.id, 'Ledger-card.png'), fails('consent_denied')); await assert.rejects(engine.getExportBytes(c, ex.id), fails('consent_denied')); await assert.rejects(engine.getAssetBytes(c, asset.id), fails('consent_denied'));
    assert.ok((await objects.head(`tenant-a/floodfund/renders/${r2.id}/Ledger-card.png`))!.size > 0);            // retained, not deleted
    assert.ok((await objects.head(`tenant-a/floodfund/renders/${r1.id}/Ledger-card.png`))!.size > 0);
    assert.equal((await engine.getRender(c, r2.id)).state, 'done'); assert.equal((await engine.listRevisions(c, p.id)).length, 1);
    const again = await engine.requestRender(c, { productionId: p.id }); assert.equal(again.state, 'blocked'); assert.match(again.error!, /is blocked: The archive withdrew permission/);
    await assert.rejects(engine.setAssetApproval(c, { assetId: asset.id, approval: 'approved' }), fails('invalid_state'));
    assert.equal((await engine.getProject(c, other.id)).blocked, false);
    // new rights on record unblock the asset for new work; earlier renders stay blocked
    const fixed = await engine.setAssetRights(c, { assetId: asset.id, rights: { kind: 'permission', ref: 'E11:permission:perm-ledger-2', attribution: 'Larkmoor council archive' }, note: 'new agreement' });
    assert.equal(fixed.blocked, false); assert.equal(fixed.headVersion, 2); assert.equal(fixed.versions[1]!.sha256, fixed.versions[0]!.sha256); assert.equal(fixed.approval, 'pending');
    const r3 = await finish(engine, c, await engine.requestRender(c, { productionId: p.id })); assert.equal(r3.state, 'done', r3.error ?? '');
    assert.equal(((await engine.getRenderManifest(c, r3.id)) as any).inputs[0].rights.ref, 'E11:permission:perm-ledger-2'); assert.equal((await engine.getRender(c, r2.id)).blocked, true);
    await assert.rejects(engine.applyUpstreamChange(c, { eventId: '', kind: 'content_changed', refs: [], reason: '' }), fails('invalid_input'));
    const audit = await engine.audit(c, { limit: 1000 }); assert.ok(kit.verifyAuditChain(audit)); assert.ok(audit.some((a) => a.action === 'production.render_blocked' && a.subject === r2.ref));
  });
});

test('render jobs: cancellation kills the running tool, progress comes from the tools, budget is reserved', needsPg, async () => {
  const budget = { reserved: [] as any[], committed: [] as any[], released: [] as any[], limit: 1000,
    async reserve(_c: any, r: any) { if (r.amount > budget.limit) throw new DomainError('budget_exhausted', 'Render budget exhausted'); budget.reserved.push(r); return { reservationId: `res-${budget.reserved.length}` }; },
    async commit(_c: any, id: string, a: any) { budget.committed.push([id, a.amount]); }, async release(_c: any, id: string, reason: string) { budget.released.push([id, reason]); } };
  await withEngine(async (h) => {
    const { engine, root } = h; const c = ctx();
    const chapters = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, title: `Chapter ${i + 1}`, blocks: Array.from({ length: 40 }, (_, j) => ({ id: `b${i}-${j}`, type: 'paragraph', text: `Paragraph ${j + 1} of the Larkmoor account. `.repeat(12), sources: ['E07:claim:c-ledger@2'] })) }));
    const p = await engine.createProject(c, { kind: 'written', title: 'Long report', doc: { title: 'Long report', chapters } });
    const r = await engine.requestRender(c, { productionId: p.id });
    assert.equal(budget.reserved[0].category, 'render_compute'); assert.equal(budget.reserved[0].unit, 'compute_second'); assert.equal(budget.reserved[0].subject, r.ref);
    const worker = engine.runJobs();
    let seen = ''; for (let i = 0; i < 400; i++) { const cur = await engine.getRender(c, r.id); seen = cur.stage; if (cur.state === 'running' && /pdf|epub|docx/.test(cur.stage)) break; await new Promise((x) => setTimeout(x, 50)); }
    assert.match(seen, /docx|epub|pdf/, 'progress stage reported while running');
    const t0 = Date.now(); const cancelled = await engine.cancelRender(c, r.id); await worker;
    assert.equal(cancelled.state, 'cancelled'); assert.ok(Date.now() - t0 < 5000, 'cancel returns promptly');
    const after = await engine.getRender(c, r.id); assert.equal(after.state, 'cancelled'); assert.equal(after.outputs.length, 0); assert.equal(after.manifestDigest, null);
    await new Promise((x) => setTimeout(x, 300));
    const procs = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(root) && /soffice|pandoc/.test(l));
    assert.deepEqual(procs, [], 'no render subprocess survives cancellation');
    assert.deepEqual(budget.released.map((x) => x[1]), ['cancelled', 'cancelled'].slice(0, budget.released.length)); assert.ok(budget.released.length >= 1);
    assert.equal((await kit.getJob(h.sql, SCHEMA, c, r.jobId!))!.state, 'cancelled');
    await assert.rejects(engine.cancelRender(c, r.id), fails('invalid_state'));
    assert.equal((await eventsOfType(engine, c, 'production.render_cancelled')).length, 1);
    // cancel before any worker picked it up
    const q = await engine.requestRender(c, { productionId: p.id, profile: 'preview' }); await engine.cancelRender(c, q.id); assert.equal(await engine.runJobs(), 0); assert.equal((await engine.getRender(c, q.id)).state, 'cancelled');
    // a completed render commits its reservation; an exhausted budget refuses gracefully and queues nothing
    const ok = await finish(engine, c, await engine.requestRender(c, { productionId: p.id, profile: 'preview' })); assert.equal(ok.state, 'done'); assert.equal(ok.progress, 1); assert.equal(budget.committed.length, 1);
    budget.limit = 0; const before = (await engine.listRenders(c)).length;
    await assert.rejects(engine.requestRender(c, { productionId: p.id }), fails('budget_exhausted')); assert.equal((await engine.listRenders(c)).length, before);
    // a failing tool is reported as a failed render, with an event, not as success
    budget.limit = 1000; const bad = await engine.createProject(c, { kind: 'audio', title: 'Broken', doc: { mode: 'program', title: 'Broken', clips: [{ id: 'x', source: { type: 'tts', text: 'hello' }, trimStart: 500 }] } });
    const failed = await finish(engine, c, await engine.requestRender(c, { productionId: bad.id, profile: 'preview' }));
    assert.equal(failed.state, 'failed'); assert.match(failed.error!, /trimmed to nothing/); assert.equal((await eventsOfType(engine, c, 'production.render_failed')).length, 1);
  }, { ports: { budget } });
});

test('tenant isolation, fail-closed authorization, idempotent replay, search and inspect', needsPg, async () => {
  await withEngine(async (h) => {
    const { engine, objects } = h; const a = ctx(); const asset = await page(h, a, { idempotencyKey: 'asset-1' });
    assert.equal((await page(h, a, { idempotencyKey: 'asset-1' })).id, asset.id);                       // replay returns the same asset
    await assert.rejects(page(h, a, { idempotencyKey: 'asset-1', name: 'Other name' }), fails('idempotency_conflict'));
    const p = await engine.createProject(a, { kind: 'image', title: 'Ledger card', doc: card(asset.id), idempotencyKey: 'proj-1' });
    assert.equal((await engine.createProject(a, { kind: 'image', title: 'Ledger card', doc: card(asset.id), idempotencyKey: 'proj-1' })).id, p.id);
    const req = await engine.requestRender(a, { productionId: p.id, idempotencyKey: 'render-1' });
    assert.equal((await engine.requestRender(a, { productionId: p.id, idempotencyKey: 'render-1' })).id, req.id); assert.equal((await engine.listRenders(a)).length, 1);
    const r = await finish(engine, a, req); await engine.setAssetApproval(a, { assetId: asset.id, approval: 'approved' }); const ex = await engine.createExport(a, { renderId: r.id });
    const rev = await engine.applyOperations(a, { productionId: p.id, operations: [{ op: 'updateLayer', layerId: 't', set: { text: 'Receipt missing' } }], idempotencyKey: 'op-1' });
    assert.equal((await engine.applyOperations(a, { productionId: p.id, operations: [{ op: 'updateLayer', layerId: 't', set: { text: 'Receipt missing' } }], idempotencyKey: 'op-1' })).revision, rev.revision);
    await assert.rejects(engine.saveRevision(a, { productionId: p.id, doc: card(asset.id), baseRevision: 1 }), fails('revision_conflict'));
    await assert.rejects(engine.saveRevision(a, { productionId: p.id, doc: (await engine.getRevision(a, p.id)).doc }), fails('invalid_input', /unchanged/));
    // every object key is under tenant/project
    const keys = await objects.list(''); assert.ok(keys.length >= 4); assert.ok(keys.every((k) => k.startsWith('tenant-a/floodfund/')), keys.join('\n'));
    // search and inspect in scope
    assert.deepEqual((await engine.search(a, { q: 'receipt missing' })).map((x) => x.ref), [`E10:project:${p.id}`]); assert.deepEqual((await engine.search(a, { q: 'ledger page' })).map((x) => x.kind), ['asset']);
    assert.deepEqual((await engine.search(a, { q: '100%_' })), []);
    const ai = (await engine.inspect(a, asset.ref))!; assert.equal(ai.kind, 'asset'); assert.ok(ai.sources.includes(PERM)); assert.ok(ai.dependents.includes(`E10:project:${p.id}`) && ai.dependents.includes(r.ref));
    assert.equal((await engine.inspect(a, ex.ref))!.kind, 'export'); assert.equal((await engine.inspect(a, `E10:project:${p.id}`))!.versions.length, 2);

    // a second tenant, and a second project of the same tenant, see nothing through any method
    for (const b of [ctx({ tenantId: 'tenant-b' }), ctx({ projectId: 'other-project' })]) {
      for (const call of [() => engine.getProject(b, p.id), () => engine.getRevision(b, p.id), () => engine.listRevisions(b, p.id), () => engine.diffRevisions(b, p.id, 1, 2), () => engine.validateProject(b, p.id), () => engine.getAsset(b, asset.id), () => engine.getAssetBytes(b, asset.id),
        () => engine.getRender(b, r.id), () => engine.getRenderManifest(b, r.id), () => engine.getRenderOutput(b, r.id, 'Ledger-card.png'), () => engine.cancelRender(b, r.id), () => engine.runQc(b, r.id), () => engine.getExport(b, ex.id), () => engine.getExportBytes(b, ex.id), () => engine.createExport(b, { renderId: r.id }),
        () => engine.requestRender(b, { productionId: p.id }), () => engine.saveRevision(b, { productionId: p.id, doc: {} }), () => engine.applyOperations(b, { productionId: p.id, operations: [{ op: 'removeLayer', layerId: 't' }] }), () => engine.restoreRevision(b, { productionId: p.id, revision: 1 }),
        () => engine.setAssetApproval(b, { assetId: asset.id, approval: 'approved' }), () => engine.setAssetRights(b, { assetId: asset.id, rights: LICENSE }), () => engine.addAssetVersion(b, { assetId: asset.id, name: 'x', filename: 'x.png', bytes: ledgerPage(h.root), rights: LICENSE }),
        () => engine.importRenderOutput(b, { renderId: r.id, output: 'Ledger-card.png' }), () => engine.updateProjectLinks(b, { productionId: p.id, resolveStale: true }), () => engine.previewInteractive(b, p.id)]) await assert.rejects(call(), fails('not_found'));
      assert.deepEqual(await engine.listProjects(b), []); assert.deepEqual(await engine.listAssets(b), []); assert.deepEqual(await engine.listRenders(b), []); assert.deepEqual(await engine.listExports(b), []);
      assert.deepEqual(await engine.search(b, { q: 'ledger' }), []); assert.deepEqual(await engine.audit(b), []);
      for (const ref of [`E10:project:${p.id}`, asset.ref, r.ref, ex.ref]) assert.equal(await engine.inspect(b, ref), null);
      assert.deepEqual((await engine.applyUpstreamChange(b, { eventId: 'x-1', kind: 'permission_withdrawn', refs: [PERM], reason: 'other scope' })).affected, []);
      await assert.rejects(engine.createProject(b, { kind: 'image', title: 'Steal', doc: card(asset.id) }), fails('invalid_input', /unknown asset/));   // foreign asset ids are indistinguishable from missing ones
      assert.equal((await kit.getJob(h.sql, SCHEMA, b, r.jobId!)), null);
    }
    assert.deepEqual(await engine.events(ctx({ tenantId: 'tenant-b' })), []); assert.equal((await engine.getAsset(a, asset.id)).blocked, false);
    // compartments hide objects from members without them
    const secret = await engine.createProject(ctx({ compartments: ['source-protection'] }), { kind: 'written', title: 'Protected draft', compartment: 'source-protection' });
    await assert.rejects(engine.getProject(a, secret.id), fails('not_found')); assert.equal((await engine.listProjects(a)).some((x) => x.id === secret.id), false); assert.deepEqual(await engine.search(a, { q: 'Protected' }), []); assert.equal(await engine.inspect(a, secret.ref), null);
    await assert.rejects(engine.createProject(a, { kind: 'written', title: 'x', compartment: 'source-protection' }), fails('not_found'));

    // authorization fails closed
    const none = ctx({ capabilities: [] }), reader = ctx({ capabilities: ['production:read'] }), wild = ctx({ capabilities: ['production:*'] });
    for (const call of [() => engine.getProject(none, p.id), () => engine.listAssets(none), () => engine.search(none, { q: 'x' }), () => engine.inspect(none, r.ref), () => engine.createProject(reader, { kind: 'written', title: 'x' }), () => engine.importAsset(reader, { name: 'x', filename: 'x.png', bytes: ledgerPage(h.root), rights: LICENSE }),
      () => engine.requestRender(reader, { productionId: p.id }), () => engine.cancelRender(reader, r.id), () => engine.applyOperations(reader, { productionId: p.id, operations: [{ op: 'removeLayer', layerId: 't' }] }), () => engine.audit(reader), () => engine.events(wild), () => engine.createExport(wild, { renderId: r.id }), () => engine.getExportBytes(wild, ex.id),
      () => engine.generateAsset(wild, { provider: 'image', name: 'x', params: { prompt: 'x' } }), () => engine.setAssetApproval(wild, { assetId: asset.id, approval: 'rejected' }), () => engine.applyUpstreamChange(wild, { eventId: 'z', kind: 'content_changed', refs: [], reason: '' })]) await assert.rejects(call(), fails('forbidden'));
    await assert.rejects(engine.getProject(undefined as any, p.id), fails('unauthenticated')); await assert.rejects(engine.listProjects({ ...a, tenantId: '' }), fails('unauthenticated'));
    assert.equal((await engine.getProject(wild, p.id)).id, p.id);
    // QC re-verifies stored bytes against the manifest
    assert.equal((await engine.runQc(a, r.id)).ok, true);
    await objects.put(`tenant-a/floodfund/renders/${r.id}/Ledger-card.png`, new TextEncoder().encode('tampered'));
    const qc = await engine.runQc(a, r.id); assert.equal(qc.ok, false); assert.ok(qc.checks.some((x: any) => x.check === 'digest:Ledger-card.png' && x.ok === false));
    await assert.rejects(engine.getRenderOutput(a, r.id, 'Ledger-card.png'), fails('integrity_failed')); assert.equal((await eventsOfType(engine, a, 'production.qc_failed')).length, 1);
  });
});

test('provider adapters: unavailable without configuration; exercised against a controlled local server', needsPg, async () => {
  const png = ledgerPage((await import('node:os')).tmpdir()); const seen: { url: string; auth: string; body: any }[] = []; let polls = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (d) => chunks.push(d)); req.on('end', () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : null; seen.push({ url: req.url!, auth: String(req.headers.authorization), body });
      const json = (status: number, v: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
      if (req.headers.authorization !== 'Bearer sk-test-secret-123') return json(401, { error: 'bad key sk-test-secret-123' });
      if (req.url === '/v1/images/generations') return body.prompt === 'elsewhere' ? json(200, { data: [{ url: 'http://example.org/x.png' }] }) : json(200, { data: [{ b64_json: Buffer.from(png).toString('base64') }] });
      if (req.url === '/v1/audio/speech') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=0.5:c=pink:a=0.2', '-f', 'wav', '-'])); }
      if (req.url === '/v1/generations') return json(200, { id: 'job-7', status: 'queued' });
      if (req.url === '/v1/generations/job-7') return ++polls < 2 ? json(200, { id: 'job-7', status: 'running' }) : json(200, { id: 'job-7', status: 'succeeded', audio_url: '/v1/files/job-7.wav' });
      if (req.url === '/v1/files/job-7.wav') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=330:d=1', '-f', 'wav', '-'])); }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    await withEngine(async ({ engine }) => { await assert.rejects(engine.generateAsset(ctx(), { provider: 'image', name: 'x', params: { prompt: 'a ledger' } }), fails('unavailable', /No image generation provider is configured/)); assert.equal(((await engine.providers(ctx())) as any).image.configured, false); });
    await withEngine(async ({ engine }) => {
      const c = ctx(); const e = { baseUrl, apiKey: 'sk-test-secret-123', model: 'pilot-model' };
      const img = await engine.generateAsset(c, { provider: 'image', name: 'Generated cover', params: { prompt: 'an abstract river', size: '512x512' }, sources: ['E09:document:doc-flood@3'] });
      assert.equal(img.class, 'image'); const v = img.versions[0]!; assert.equal(v.provenance.synthetic, true); assert.equal(v.provenance.toolVersion, 'pilot-model'); assert.deepEqual(v.provenance.params, { prompt: 'an abstract river', size: '512x512' }); assert.equal(v.rights.kind, 'generated');
      assert.deepEqual(seen[0]!.body, { model: 'pilot-model', prompt: 'an abstract river', size: '512x512', n: 1, response_format: 'b64_json' });
      const speech = await engine.generateAsset(c, { provider: 'tts', name: 'Voice', params: { text: 'Hello Larkmoor' } }); assert.equal(speech.versions[0]!.mediaType, 'audio/wav');
      const music = await engine.generateAsset(c, { provider: 'music', name: 'Theme', params: { prompt: 'slow piano', durationSeconds: 5 } }); assert.equal(music.class, 'audio'); assert.ok(polls >= 2);
      await assert.rejects(engine.generateAsset(c, { provider: 'image', name: 'x', params: { prompt: 'elsewhere' } }), fails('provider_unavailable', /different origin/));   // result links off the provider's origin are not fetched
      const status = await engine.providers(c) as any; assert.equal(status.image.configured, true); assert.match(status.image.verification, /not verified against a live provider/);
      assert.doesNotMatch(JSON.stringify([img, speech, music, status, await engine.audit(c)]), /sk-test-secret/);                         // the secret never reaches stored data
      void e;
    }, { config: { providers: { image: { baseUrl, apiKey: 'sk-test-secret-123', model: 'pilot-model' }, tts: { baseUrl, apiKey: 'sk-test-secret-123' }, music: { baseUrl, apiKey: 'sk-test-secret-123' }, pollIntervalMs: 10 } } });
    await withEngine(async ({ engine }) => {
      await assert.rejects(engine.generateAsset(ctx(), { provider: 'image', name: 'x', params: { prompt: 'x' } }), (e: any) => e.code === 'provider_unavailable' && /rejected the configured credentials/.test(e.message) && !/sk-/.test(e.message));
    }, { config: { providers: { image: { baseUrl, apiKey: 'sk-wrong' } } } });
  } finally { server.close(); }
});

test('HTTP end to end: projects, assets, operations, renders, manifest, preview, exports', needsPg, async () => {
  await withEngine(async (h) => {
    const { engine, root } = h; const { routes } = await import('../src/engine/index.ts');
    const key = kit.generateSigningKey('k1'); const now = Math.floor(Date.now() / 1000);
    const token = (caps: string[], over: Partial<kit.TokenClaims> = {}): string => kit.signAccessToken({ iss: 'iap', sub: 'editor-1', kind: 'human', tid: 'tenant-a', pid: 'floodfund', roles: [], caps, cmp: [], purpose: 'production', pv: '1', iat: now, exp: now + 600, jti: 'j', ...over }, key);
    const server = await kit.serve(kit.createHttpHandler({ name: 'production', version: manifest.version, routes: routes(engine), verify: kit.createTokenVerifier({ publicKeys: { k1: key.publicKeyPem }, issuer: 'iap' }), health: () => engine.health() }), 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown, t = token(CAPS)): Promise<{ status: number; json: any; bytes: Buffer; headers: Headers }> => { const r = await fetch(base + path, { method, headers: { ...(t === '' ? {} : { authorization: `Bearer ${t}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const bytes = Buffer.from(await r.arrayBuffer()); let json: any = null; try { json = JSON.parse(bytes.toString()); } catch { /* binary */ } return { status: r.status, json, bytes, headers: r.headers }; };
    try {
      assert.equal((await call('GET', '/healthz', undefined, '')).json.ok, true); assert.equal((await call('GET', '/v1/manifest', undefined, '')).json.id, 'E10');
      assert.equal((await call('GET', '/v1/production/projects', undefined, '')).status, 401);
      assert.equal((await call('POST', '/v1/production/projects', { kind: 'image', title: 'x' }, token(['production:read']))).status, 403);
      const up = await call('POST', '/v1/assets', { name: 'Ledger page 14', filename: 'ledger.png', bytesBase64: Buffer.from(ledgerPage(root)).toString('base64'), rights: { kind: 'permission', ref: PERM, attribution: 'Larkmoor council archive' } });
      assert.equal(up.status, 201); const assetId = up.json.id;
      assert.equal((await call('POST', '/v1/assets', { name: 'x', filename: 'x.bin', bytesBase64: Buffer.from('nope').toString('base64'), rights: LICENSE })).status, 415);
      const created = await call('POST', '/v1/production/projects', { kind: 'image', title: 'Ledger card', doc: card(assetId) }); assert.equal(created.status, 201); const id = created.json.id;
      const op = await call('POST', `/v1/production/projects/${id}/operations`, { operations: [{ op: 'updateLayer', layerId: 't', set: { text: 'Receipt missing', color: '#ffd60a' } }], baseRevision: 1 }); assert.equal(op.status, 201); assert.equal(op.json.revision, 2);
      assert.equal((await call('POST', `/v1/production/projects/${id}/operations`, { operations: [{ op: 'nonsense' }] })).status, 400);
      assert.equal((await call('POST', `/v1/production/projects/${id}/operations`, { operations: [{ op: 'removeLayer', layerId: 't' }], baseRevision: 1 })).status, 409);
      assert.equal((await call('GET', `/v1/production/projects/${id}/revisions/1`)).json.doc.layers[1].text, 'No receipt'); assert.equal((await call('GET', `/v1/production/projects/${id}/revisions/head`)).json.revision, 2);
      assert.equal((await call('GET', `/v1/production/projects/${id}/diff?from=1&to=2`)).json.summary.changed, 2); assert.equal((await call('GET', `/v1/production/projects/${id}/validate`)).json.ok, true);
      const rq = await call('POST', '/v1/renders', { productionId: id }); assert.equal(rq.status, 202); assert.equal(rq.json.state, 'queued');
      await engine.runJobs();
      const done = await call('GET', `/v1/renders/${rq.json.id}`); assert.equal(done.json.state, 'done'); assert.equal(done.json.progress, 1);
      const man = await call('GET', `/v1/renders/${rq.json.id}/manifest`); assert.equal(man.json.schema, 'production.manifest/v1'); assert.equal(man.json.project.revision, 2); assert.equal(man.json.inputs[0].assetId, assetId);
      const out = await call('GET', `/v1/renders/${rq.json.id}/outputs/Ledger-card.png`); assert.equal(out.status, 200); assert.equal(out.headers.get('content-type'), 'image/png'); assert.equal(out.headers.get('x-content-sha256'), done.json.outputs[0].sha256); assert.equal(out.bytes.subarray(1, 4).toString(), 'PNG');
      assert.equal((await call('POST', `/v1/production/${rq.json.id}/qc`)).json.ok, true);
      assert.equal((await call('GET', `/v1/inspect?ref=${encodeURIComponent(done.json.ref)}`)).json.kind, 'render'); assert.equal((await call('GET', '/v1/search?q=receipt')).json[0].kind, 'project');
      assert.equal((await call('POST', '/v1/exports', { renderId: rq.json.id })).status, 409);                                    // asset not approved yet
      assert.equal((await call('POST', `/v1/assets/${assetId}/approval`, { approval: 'approved' })).json.approval, 'approved');
      const ex = await call('POST', '/v1/exports', { renderId: rq.json.id }); assert.equal(ex.status, 201); const zip = await call('GET', `/v1/exports/${ex.json.id}/bytes`); assert.equal(zip.bytes.subarray(0, 2).toString(), 'PK');
      assert.equal((await call('POST', '/v1/assets/generate', { provider: 'image', name: 'x', params: { prompt: 'x' } })).status, 503);  // unavailable is reported as such, not as a generic 500
      assert.equal((await call('POST', '/v1/assets/generate', { provider: 'image', name: 'x', params: { prompt: 'x' } })).json.error.code, 'unavailable');
      // interactive preview route
      const story = await call('POST', '/v1/production/projects', { kind: 'interactive', title: 'Story', doc: { title: 'Story', start: 'a', nodes: [{ id: 'a', title: 'Start', text: 'Begin.', choices: [{ label: 'Go', target: 'b' }] }, { id: 'b', title: 'End', text: 'Done.', ending: 'Fin' }] } });
      const pv = await call('GET', `/v1/production/projects/${story.json.id}/preview`); assert.equal(pv.status, 200); assert.match(pv.headers.get('content-type')!, /text\/html/); assert.match(pv.bytes.toString(), /<main id="main">/); assert.match(pv.headers.get('content-security-policy')!, /default-src 'none'/);
      // other tenants and unknown ids get an indistinguishable 404
      const foreign = token(CAPS, { tid: 'tenant-b' });
      for (const path of [`/v1/production/projects/${id}`, `/v1/renders/${rq.json.id}`, `/v1/renders/${rq.json.id}/manifest`, `/v1/renders/${rq.json.id}/outputs/Ledger-card.png`, `/v1/assets/${assetId}/bytes`, `/v1/exports/${ex.json.id}/bytes`, `/v1/inspect?ref=${encodeURIComponent(done.json.ref)}`]) { const r = await call('GET', path, undefined, foreign); assert.equal(r.status, 404, path); assert.deepEqual(r.json.error.code, 'not_found'); }
      assert.equal((await call('GET', '/v1/renders/not-a-uuid')).status, 404); assert.deepEqual((await call('GET', '/v1/production/projects', undefined, foreign)).json, []);
      assert.equal((await call('POST', '/v1/upstream-changes', { eventId: 'h-1', kind: 'permission_withdrawn', refs: [PERM], reason: 'withdrawn' })).json.affected.length, 4);
      assert.equal((await call('GET', `/v1/renders/${rq.json.id}/outputs/Ledger-card.png`)).status, 403);
      assert.ok((await call('GET', '/v1/events')).status === 200); assert.equal((await call('GET', '/v1/events', undefined, token(['production:*']))).status, 403);
    } finally { server.close(); }
  });
});
