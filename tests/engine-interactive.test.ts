import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ctx, finish, ledgerPage, needsPg, withEngine } from './helpers.ts';

let playwright: any = null;
for (const base of [import.meta.url, 'file:///opt/node-tools/']) { try { playwright = createRequire(base)('playwright'); break; } catch { /* try the next location */ } }
const tool = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
export const STORY = (assetId: string): any => ({
  title: 'Follow the Larkmoor Money', language: 'en', intro: 'An interactive walk through the relief fund records.', start: 'start', variables: { sawLedger: false },
  sourceNotes: { 'E07:claim:c-ledger@2': 'Larkmoor council ledger, spring quarter' },
  nodes: [
    { id: 'start', title: 'The town hall', text: 'The relief fund collected sixty thousand after the flood.\n\nYou have one afternoon in the archive.', basis: 'verified_fact', sources: ['E07:claim:c-ledger@2'],
      choices: [{ id: 'ledger', label: 'Open the ledger', target: 'ledger', set: { sawLedger: true } }, { id: 'ask', label: 'Ask the treasurer', target: 'treasurer' }] },
    { id: 'ledger', title: 'The ledger', text: 'One transfer of 31,000 has no receipt.', media: [{ assetId, alt: 'A ledger page listing three payments', caption: 'Ledger page 14' }], sources: ['E07:claim:c-ledger@2'], sourceNote: 'Figures are quoted from page 14.',
      choices: [{ id: 'ask', label: 'Ask the treasurer about it', target: 'treasurer' }] },
    { id: 'treasurer', title: 'The pump house', text: 'Tomas Brandt counts the sandbags twice before he answers.', basis: 'reconstruction', disclosure: 'This meeting is reconstructed from committee minutes; the wording is approximate.',
      choices: [{ id: 'press', label: 'Show him the ledger entry', target: 'answer', condition: { var: 'sawLedger', op: 'eq', value: true } }, { id: 'leave', label: 'Thank him and leave', target: 'open' }] },
    { id: 'answer', title: 'An answer, of sorts', text: 'He says the receipt was lost in the flood.', ending: 'You have a claim to verify.' },
    { id: 'open', title: 'An open question', text: 'Without the ledger you have nothing to ask.', ending: 'The question stays open.' },
  ],
});

test('interactive work: validate graph, edit, preview, export an offline package that plays by keyboard', needsPg, async (t) => {
  await withEngine(async ({ engine, root }) => {
    const c = ctx();
    const page = await engine.importAsset(c, { name: 'Ledger page 14', filename: 'ledger.png', bytes: ledgerPage(root), rights: { kind: 'permission', ref: 'E11:permission:perm-ledger', attribution: 'Larkmoor council archive' } });
    const project = await engine.createProject(c, { kind: 'interactive', title: 'Follow the Larkmoor Money', doc: STORY(page.id) });
    assert.deepEqual((await engine.validateProject(c, project.id)).problems.filter((p) => p.level === 'error'), []);
    // graph validation: unreachable node, dead end, unknown target, missing asset
    const bad = await engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'addNode', node: { id: 'orphan', title: 'Orphan', text: 'Nobody gets here.' } }, { op: 'addChoice', nodeId: 'start', choice: { id: 'x', label: 'Go nowhere', target: 'missing' } }] });
    const v = await engine.validateProject(c, project.id);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /dead end/.test(p.message) && p.at === 'orphan')); assert.ok(v.problems.some((p) => /cannot be reached/.test(p.message))); assert.ok(v.problems.some((p) => /unknown node "missing"/.test(p.message)));
    await assert.rejects(engine.requestRender(c, { productionId: project.id }), /problems that stop a final render/);
    await assert.rejects(engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'addMedia', nodeId: 'start', media: { assetId: '00000000-0000-4000-8000-000000000000', alt: 'x' } }] }), /Unknown asset/);
    await engine.restoreRevision(c, { productionId: project.id, revision: 1 });
    await engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'updateNode', nodeId: 'open', set: { text: 'Without the ledger entry you have nothing specific to ask.' } }] });
    assert.equal(bad.revision, 2);

    const preview = await engine.previewInteractive(c, project.id);
    assert.match(preview, /<html lang="en">/); assert.match(preview, /data:image\/png;base64,/); assert.match(preview, /nothing specific to ask/);
    assert.match(await engine.previewInteractive(c, project.id, 1), /Without the ledger you have nothing to ask\./);   // any saved revision can be previewed

    const r = await finish(engine, c, await engine.requestRender(c, { productionId: project.id }));
    assert.equal(r.state, 'done', r.error ?? '');
    const zip = join(root, 'story.zip'); writeFileSync(zip, (await engine.getRenderOutput(c, r.id, 'Follow-the-Larkmoor-Money.zip')).bytes);
    const site = join(root, 'site'); mkdirSync(site); tool('unzip', ['-q', zip, '-d', site]);
    const listing = tool('unzip', ['-Z1', zip]).trim().split('\n').sort();
    assert.ok(listing.includes('index.html') && listing.includes('sources.html') && listing.some((f) => /^assets\/.+ledger\.png$/.test(f)));
    const index = readFileSync(join(site, 'index.html'), 'utf8'), sources = readFileSync(join(site, 'sources.html'), 'utf8');
    assert.doesNotMatch(index + sources, /https?:\/\//);                                   // no network dependencies
    assert.match(index, /<main id="main">/); assert.match(index, /role="status" aria-live="polite"/); assert.match(index, /class="skip"/); assert.match(index, /<noscript>/);
    assert.match(sources, /RECONSTRUCTION/); assert.match(sources, /reconstructed from committee minutes/); assert.match(sources, /E07:claim:c-ledger@2/); assert.match(sources, /Larkmoor council archive/);
    const man = await engine.getRenderManifest(c, r.id) as any;
    assert.equal(man.disclosures.length, 1); assert.equal(man.inputs[0].rights.ref, 'E11:permission:perm-ledger'); assert.ok(man.sources.includes('E07:claim:c-ledger@2'));
    assert.equal((r.qc as any).ok, true);

    if (playwright === null) { t.diagnostic('playwright is not installed; browser play-through not executed'); return; }
    const browser = await playwright.chromium.launch();
    try {
      const context = await browser.newContext(); const pageB = await context.newPage(); const requests: string[] = []; const errors: string[] = [];
      pageB.on('request', (q: any) => requests.push(q.url())); pageB.on('pageerror', (e: any) => errors.push(String(e))); pageB.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()); });
      await pageB.goto(`file://${join(site, 'index.html')}`);
      assert.equal(await pageB.textContent('#node-title'), 'The town hall');
      assert.equal(await pageB.locator('ol.choices button').count(), 2);
      // keyboard only: skip link, then Tab to the first choice and press Enter
      await pageB.keyboard.press('Tab'); assert.equal(await pageB.evaluate('document.activeElement.className'), 'skip');
      await pageB.keyboard.press('Tab'); assert.match(await pageB.evaluate('document.activeElement.textContent'), /Open the ledger/);
      await pageB.keyboard.press('Enter');
      assert.equal(await pageB.textContent('#node-title'), 'The ledger');
      assert.equal(await pageB.evaluate('document.activeElement.id'), 'node-title');           // focus moves to the new passage
      assert.equal(await pageB.evaluate('document.querySelector("figure img").naturalWidth'), 1000); // bundled media loads offline
      assert.equal(await pageB.getAttribute('figure img', 'alt'), 'A ledger page listing three payments');
      assert.match(await pageB.textContent('#status'), /The ledger/);
      // progress is saved: reload resumes here
      await pageB.reload(); assert.equal(await pageB.textContent('#node-title'), 'The ledger');
      await pageB.keyboard.press('1');                                                         // number keys choose too
      assert.equal(await pageB.textContent('#node-title'), 'The pump house');
      assert.match(await pageB.textContent('.disclosure'), /RECONSTRUCTION\s+This meeting is reconstructed/);
      assert.equal(await pageB.locator('ol.choices button').count(), 2);                       // the conditional choice is offered because the ledger was seen
      await pageB.keyboard.press('Tab'); await pageB.keyboard.press('Enter');
      assert.equal(await pageB.textContent('#node-title'), 'An answer, of sorts');
      assert.match(await pageB.textContent('.ending'), /The end: You have a claim to verify\./);
      // restart, take the other path: the conditional choice is hidden
      await pageB.focus('#restart'); await pageB.keyboard.press('Enter');
      assert.equal(await pageB.textContent('#node-title'), 'The town hall');
      await pageB.keyboard.press('2'); assert.equal(await pageB.locator('ol.choices button').count(), 1);
      await pageB.keyboard.press('1'); assert.match(await pageB.textContent('.ending'), /The question stays open/);
      await pageB.click('footer a'); assert.match(await pageB.textContent('h1'), /sources and disclosures/);
      assert.ok(requests.every((u) => u.startsWith('file://')), `network requests: ${requests.filter((u) => !u.startsWith('file://')).join(', ')}`);
      assert.deepEqual(errors, []);
      // storage unavailable (guarded): the story still plays
      const strict = await browser.newContext(); await strict.addInitScript('Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); } })');
      const p2 = await strict.newPage(); const e2: string[] = []; p2.on('pageerror', (e: any) => e2.push(String(e)));
      await p2.goto(`file://${join(site, 'index.html')}`); await p2.keyboard.press('2');
      assert.equal(await p2.textContent('#node-title'), 'The pump house'); assert.deepEqual(e2, []);
      // the single-file export plays as well
      const single = join(root, 'single.html'); writeFileSync(single, (await engine.getRenderOutput(c, r.id, 'Follow-the-Larkmoor-Money.html')).bytes);
      const p3 = await (await browser.newContext()).newPage(); await p3.goto(`file://${single}`); await p3.keyboard.press('1'); assert.equal(await p3.evaluate('document.querySelector("figure img").naturalWidth'), 1000);
      assert.ok(existsSync(single));
    } finally { await browser.close(); }
  });
});
