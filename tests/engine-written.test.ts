import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctx, finish, needsPg, withEngine } from './helpers.ts';

const DOC = {
  title: 'The Larkmoor Flood Relief Fund', subtitle: 'Where the money went', authors: ['Ines Varga'], language: 'en',
  layout: { pageSize: 'A5', bodyFont: 'DejaVu Serif', headingFont: 'DejaVu Sans', fontSizePt: 10, margins: { top: 18, bottom: 18, left: 16, right: 16 } },
  sourceNotes: { 'E07:claim:c-ledger@2': 'Larkmoor council ledger, spring quarter', 'E05:evidence_version:ev-minutes@1': 'Relief committee minutes' },
  chapters: [
    { id: 'c1', title: 'The water rises', blocks: [
      { id: 'b1', type: 'paragraph', text: 'In the invented town of Larkmoor the river Ost broke its banks on a Tuesday.', basis: 'verified_fact', sources: ['E07:claim:c-ledger@2'] },
      { id: 'b2', type: 'paragraph', text: 'Tomas Brandt stood at the pump house door and counted the sandbags twice.', basis: 'reconstruction', disclosure: 'This scene is reconstructed from committee minutes; the dialogue and gestures are approximations.', sources: ['E05:evidence_version:ev-minutes@1'] },
      { id: 'b3', type: 'quote', text: 'We were told the fund was full.', attribution: 'Mirela Novak, shopkeeper', basis: 'attributed_testimony', sources: ['E05:evidence_version:ev-minutes@1'] },
    ] },
    { id: 'c2', title: 'The ledger', blocks: [
      { id: 'b4', type: 'heading', level: 2, text: 'Three payments' },
      { id: 'b5', type: 'list', ordered: true, items: ['Pumps: 12,400', 'Shelter: 8,150', 'Unexplained: 31,000'] },
    ] },
  ],
};
const tool = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

test('written work: create, edit, render PDF/EPUB/DOCX/HTML, revise, re-render, reopen revision', needsPg, async () => {
  await withEngine(async ({ engine, root }) => {
    const c = ctx();
    const project = await engine.createProject(c, { kind: 'written', title: DOC.title, doc: DOC, editorialRef: 'E09:document:doc-flood@3' });
    assert.equal(project.headRevision, 1);
    // structured edit: change one sentence, add a block, change the layout
    const rev2 = await engine.applyOperations(c, { productionId: project.id, operations: [
      { op: 'set', path: '/chapters/id=c1/blocks/id=b1/text', value: 'In the invented town of Larkmoor the river Ost broke its banks on a Thursday in spring.' },
      { op: 'insertBlock', after: 'b5', block: { id: 'b6', type: 'paragraph', text: 'The third payment has no receipt in the record.', basis: 'inference', sources: ['E07:claim:c-ledger@2'] } },
    ], summary: 'Fix weekday; add finding' });
    assert.equal(rev2.revision, 2); assert.ok(rev2.diff.some((d) => d.path.includes('b1/text')) && rev2.diff.some((d) => d.change === 'added'));

    const preview = await finish(engine, c, await engine.requestRender(c, { productionId: project.id, profile: 'preview' }));
    assert.equal(preview.state, 'done', preview.error ?? ''); assert.deepEqual(preview.outputs.map((o) => o.role), ['preview']);

    const r1 = await finish(engine, c, await engine.requestRender(c, { productionId: project.id }));
    assert.equal(r1.state, 'done', r1.error ?? '');
    const names = r1.outputs.map((o) => o.name); const base = names.find((x) => x.endsWith('.pdf'))!.slice(0, -4);
    for (const ext of ['html', 'pdf', 'epub', 'docx']) assert.ok(names.includes(`${base}.${ext}`), `missing ${ext}`);
    const save = async (renderId: string, name: string): Promise<string> => { const f = await engine.getRenderOutput(c, renderId, name); const p = join(root, `${renderId}-${name}`); writeFileSync(p, f.bytes); return p; };
    const pdf1 = await save(r1.id, `${base}.pdf`);
    const text1 = tool('pdftotext', [pdf1, '-']).replace(/\s+/g, ' ');
    assert.match(text1, /broke its banks on a Thursday in spring/);            // the edited sentence
    assert.match(text1, /RECONSTRUCTION/); assert.match(text1, /reconstructed from committee minutes/); // disclosure carried into print
    assert.match(text1, /Larkmoor council ledger, spring quarter/);             // footnote generated from the source uref
    assert.match(text1, /Source companion/); assert.match(text1, /E07:claim:c-ledger@2/);
    assert.match(tool('pdfinfo', [pdf1]), /Page size:\s+419\.\d+ x 595\.\d+ pts/); // A5 from the layout settings
    assert.match(tool('pdffonts', [pdf1]), /DejaVuSerif/);
    tool('unzip', ['-tqq', await save(r1.id, `${base}.epub`)]); tool('unzip', ['-tqq', await save(r1.id, `${base}.docx`)]);
    assert.match(tool('unzip', ['-p', join(root, `${r1.id}-${base}.docx`), 'word/footnotes.xml']), /Larkmoor council ledger/);
    const html = Buffer.from((await engine.getRenderOutput(c, r1.id, `${base}.html`)).bytes).toString('utf8');
    assert.match(html, /@page \{ size: 148mm 210mm/); assert.match(html, /role="doc-noteref"/);

    const man = await engine.getRenderManifest(c, r1.id) as any;
    assert.equal(man.project.ref, `E10:project:${project.id}@2`); assert.equal(man.project.editorialRef, 'E09:document:doc-flood@3');
    assert.ok(man.sources.includes('E07:claim:c-ledger@2') && man.sources.includes('E09:document:doc-flood@3'));
    assert.ok(man.tools.some((t: any) => t.name === 'pandoc' && /pandoc/.test(t.version)) && man.tools.some((t: any) => t.name === 'soffice'));
    assert.equal(man.disclosures.length, 1); assert.equal(man.disclosures[0].basis, 'reconstruction');
    assert.equal(man.outputs.find((o: any) => o.name === `${base}.pdf`).sha256, r1.outputs.find((o) => o.name === `${base}.pdf`)!.sha256);
    assert.ok(man.decisions.length >= 1 && man.decisions.every((d: any) => d.decision === 'allow' && d.action === 'adapt'));
    assert.equal((r1.qc as any).ok, true, JSON.stringify(r1.qc));

    // revise → new render version; the old one is retained byte for byte
    await engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'updateBlock', blockId: 'b6', set: { text: 'The third payment, of 31,000, has no receipt anywhere in the record.' } }, { op: 'setLayout', layout: { pageSize: 'Letter' } }] });
    const r2 = await finish(engine, c, await engine.requestRender(c, { productionId: project.id }));
    assert.equal(r2.state, 'done', r2.error ?? ''); assert.equal(r2.revision, 3); assert.ok(r2.seq > r1.seq);
    const pdf2 = await save(r2.id, `${base}.pdf`);
    assert.match(tool('pdftotext', [pdf2, '-']).replace(/\s+/g, ' '), /has no receipt anywhere in the record/);
    assert.match(tool('pdfinfo', [pdf2]), /Page size:\s+612 x 792 pts/);
    const again = await engine.getRenderOutput(c, r1.id, `${base}.pdf`);
    assert.equal(again.sha256, r1.outputs.find((o) => o.name === `${base}.pdf`)!.sha256);
    assert.doesNotMatch(text1, /anywhere in the record/);

    // reopen a saved revision, diff, restore as new
    const old = await engine.getRevision(c, project.id, 1);
    assert.match((old.doc as any).chapters[0].blocks[0].text, /on a Tuesday\./);
    const diff = await engine.diffRevisions(c, project.id, 1, 3); assert.ok(diff.summary.changed >= 2 && diff.summary.added >= 1);
    const restored = await engine.restoreRevision(c, { productionId: project.id, revision: 1 });
    assert.equal(restored.revision, 4); assert.equal(restored.restoredFrom, 1);
    assert.equal((await engine.getRevision(c, project.id)).digest, old.digest);
    assert.equal((await engine.listRevisions(c, project.id)).length, 4);
  });
});
