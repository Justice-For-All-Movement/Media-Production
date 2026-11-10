import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LICENSE, ctx, finish, needsPg, withEngine } from './helpers.ts';

const tool = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
/** A fictional ledger page drawn with ImageMagick: stands in for a scanned evidence page. */
export function ledgerPage(dir: string): Uint8Array {
  const p = join(dir, 'ledger.png');
  tool('convert', ['-size', '1000x1400', 'xc:#fbf8ef', '-font', 'DejaVu-Sans', '-fill', '#222222', '-pointsize', '38', '-annotate', '+70+120', 'LARKMOOR COUNCIL LEDGER', '-pointsize', '30',
    '-annotate', '+70+300', 'Pumps and hoses           12,400', '-annotate', '+70+380', 'Shelter hall               8,150', '-annotate', '+70+460', 'Unexplained transfer   31,000', '-annotate', '+70+540', 'Account 4471-889-ZQ', '-annotate', '+70+900', 'Signed: T. Brandt, treasurer', p]);
  return new Uint8Array(readFileSync(p));
}
const pixel = (file: string, x: number, y: number): string => tool('convert', [file, '-crop', `1x1+${x}+${y}`, '-depth', '8', 'txt:-']).split('\n')[1]!.match(/#([0-9A-F]{6})/)![1]!;

test('still image: compose from an evidence excerpt, edit layers, export PNG/JPEG/WebP/SVG, version', needsPg, async () => {
  await withEngine(async ({ engine, root }) => {
    const c = ctx();
    const page = await engine.importAsset(c, { name: 'Ledger page 14', filename: 'ledger page 14.png', bytes: ledgerPage(root), rights: { kind: 'permission', ref: 'E11:permission:perm-ledger', attribution: 'Larkmoor council archive' }, provenance: { sourceRefs: ['E05:evidence_version:ev-ledger@1'] } });
    assert.equal(page.versions[0]!.mediaType, 'image/png'); assert.equal((page.versions[0]!.mediaInfo as any).width, 1000); assert.match(page.versions[0]!.sha256, /^[0-9a-f]{64}$/);
    await assert.rejects(engine.importAsset(c, { name: 'empty', filename: 'x.png', bytes: new Uint8Array(), rights: LICENSE }), /empty file/);
    await assert.rejects(engine.importAsset(c, { name: 'exe', filename: 'x.png', bytes: new TextEncoder().encode('MZ not an image'), rights: LICENSE }), (e: any) => e.code === 'unsupported_media_type');
    await assert.rejects(engine.importAsset(c, { name: 'no rights', filename: 'x.png', bytes: ledgerPage(root), rights: undefined as any }), /rights are required/);

    const project = await engine.createProject(c, { kind: 'image', title: 'Ledger excerpt card', doc: { title: 'Ledger excerpt card', canvas: { width: 1200, height: 675, background: '#22223b' }, layers: [], sources: ['E07:claim:c-ledger@2'] } });
    await engine.applyOperations(c, { productionId: project.id, operations: [
      { op: 'generate', generator: 'documentExcerpt', group: 'excerpt', params: { assetId: page.id, region: { x: 40, y: 250, width: 720, height: 330 }, title: 'From the council ledger', caption: 'One transfer of 31,000 has no receipt.', sourceRef: 'E05:evidence_version:ev-ledger@1', highlight: { x: 60, y: 420, width: 660, height: 60 }, redactions: [{ x: 60, y: 505, width: 420, height: 50, label: 'ACCOUNT' }] } },
      { op: 'addLayer', layer: { id: 'badge', type: 'shape', shape: 'ellipse', x: 1040, y: 30, width: 120, height: 120, fill: '#2a9d8f' } },
      { op: 'addLayer', layer: { id: 'stamp', type: 'text', text: 'UNVERIFIED COPY', x: 700, y: 600, width: 460, size: 28, color: '#ffd60a', bold: true, align: 'right' } },
    ] });
    assert.deepEqual((await engine.validateProject(c, project.id)).problems.map((p) => p.level), ['warning']); // asset not yet approved
    const r1 = await finish(engine, c, await engine.requestRender(c, { productionId: project.id }));
    assert.equal(r1.state, 'done', r1.error ?? '');
    const save = async (renderId: string, name: string): Promise<string> => { const f = await engine.getRenderOutput(c, renderId, name); const p = join(root, `${renderId.slice(0, 6)}-${name}`); writeFileSync(p, f.bytes); return p; };
    const png1 = await save(r1.id, 'Ledger-excerpt-card.png');
    assert.equal(tool('identify', ['-format', '%w %h %m', png1]), '1200 675 PNG');
    assert.equal(tool('identify', ['-format', '%w %h %m', await save(r1.id, 'Ledger-excerpt-card.jpg')]), '1200 675 JPEG');
    assert.equal(tool('identify', ['-format', '%w %h %m', await save(r1.id, 'Ledger-excerpt-card.webp')]), '1200 675 WEBP');
    // the excerpt really is the cropped evidence page: OCR reads the ledger line, and the redacted account number is gone
    const ocr = tool('tesseract', [png1, '-', '--psm', '6']).replace(/\s+/g, ' ');
    assert.match(ocr, /Unexplained transfer/); assert.match(ocr, /31,000/); assert.doesNotMatch(ocr, /4471/);
    const svg = readFileSync(await save(r1.id, 'Ledger-excerpt-card.svg'), 'utf8');
    assert.match(svg, /UNVERIFIED COPY/);                         // layers above the redaction stay vector
    assert.doesNotMatch(svg, /From the council ledger/);          // everything under it was flattened to pixels
    const flat = join(root, 'svg.png'); tool('rsvg-convert', ['-o', flat, join(root, `${r1.id.slice(0, 6)}-Ledger-excerpt-card.svg`)]);
    assert.doesNotMatch(tool('tesseract', [flat, '-', '--psm', '6']), /4471/);
    // metadata stripped
    assert.doesNotMatch(tool('exiftool', ['-a', '-G1', png1]), /date:create|Software|Comment/i);
    assert.equal(pixel(png1, 1100, 90), '2A9D8F');
    const man = await engine.getRenderManifest(c, r1.id) as any;
    assert.equal(man.inputs.length, 1); assert.equal(man.inputs[0].sha256, page.versions[0]!.sha256); assert.equal(man.inputs[0].rights.ref, 'E11:permission:perm-ledger');
    assert.deepEqual(man.inputs[0].provenance.sourceRefs, ['E05:evidence_version:ev-ledger@1']);
    assert.ok(man.sources.includes('E11:permission:perm-ledger') && man.sources.includes('E05:evidence_version:ev-ledger@1') && man.sources.includes('E07:claim:c-ledger@2'));
    assert.equal(man.parameters.redactionsFlattened, true); assert.equal(man.generated[0].generator, 'documentExcerpt');
    assert.ok(man.decisions.some((d: any) => d.subjects.includes('E11:permission:perm-ledger')));

    // edit a layer → the pixels change in exactly that region; reorder and remove work; old render is retained
    await engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'updateLayer', layerId: 'badge', set: { fill: '#e63946' } }, { op: 'reorderLayer', layerId: 'stamp', to: 0 }, { op: 'reorderLayer', layerId: 'stamp', to: 99 }] });
    const r2 = await finish(engine, c, await engine.requestRender(c, { productionId: project.id }));
    const png2 = await save(r2.id, 'Ledger-excerpt-card.png');
    assert.equal(pixel(png2, 1100, 90), 'E63946'); assert.equal(pixel(png2, 20, 20), pixel(png1, 20, 20));
    assert.notEqual(r2.outputs[0]!.sha256, r1.outputs[0]!.sha256);
    assert.equal((await engine.getRenderOutput(c, r1.id, 'Ledger-excerpt-card.png')).sha256, r1.outputs.find((o) => o.name.endsWith('.png'))!.sha256);
    await engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'removeLayer', layerId: 'badge' }] });
    const prev = await finish(engine, c, await engine.requestRender(c, { productionId: project.id, profile: 'preview' }));
    assert.equal(tool('identify', ['-format', '%w %h', await save(prev.id, prev.outputs[0]!.name)]), '480 270');
    // a new asset version does not change renders bound to the old one
    const v2 = await engine.addAssetVersion(c, { assetId: page.id, name: 'Ledger page 14', filename: 'ledger.png', bytes: new Uint8Array(readFileSync(png2)), rights: { kind: 'permission', ref: 'E11:permission:perm-ledger' } });
    assert.equal(v2.headVersion, 2); assert.equal(v2.versions.length, 2); assert.equal((await engine.getAssetBytes(c, page.id, 1)).sha256, page.versions[0]!.sha256);
  });
});

test('still image: procedural generators and mandatory disclosure strip', needsPg, async () => {
  await withEngine(async ({ engine, root }) => {
    const c = ctx();
    const cases: [string, any, RegExp][] = [
      ['timeline', { title: 'Larkmoor relief fund', events: [{ date: '2031-03-04', label: 'River Ost floods' }, { date: '2031-03-20', label: 'Fund opens' }, { date: '2031-06-01', label: 'Transfer of 31,000' }, { date: '2031-09-15', label: 'Audit requested' }] }, /Fund opens/],
      ['quoteCard', { quote: 'We were told the fund was full.', attribution: 'Mirela Novak, shopkeeper' }, /fund was full/],
      ['locationCard', { place: 'Larkmoor Pump House', region: 'Ost valley (fictional)', caption: 'Where the sandbags were counted' }, /Pump House/],
      ['coverArt', { title: 'The Larkmoor Fund', subtitle: 'Where the money went', author: 'Ines Varga' }, /Larkmoor/],
    ];
    const digests = new Set<string>();
    for (const [generator, params, expect] of cases) {
      const p = await engine.createProject(c, { kind: 'image', title: `Pilot ${generator}`, doc: { title: `Pilot ${generator}`, canvas: generator === 'coverArt' ? { width: 1000, height: 1500 } : { width: 1280, height: 720 }, layers: [], export: { formats: ['png'] }, ...(generator === 'quoteCard' ? { basis: 'reconstruction', disclosure: 'Wording reconstructed from meeting notes.' } : {}) } });
      await engine.applyOperations(c, { productionId: p.id, operations: [{ op: 'generate', generator, params, group: 'g' }] });
      const r = await finish(engine, c, await engine.requestRender(c, { productionId: p.id }));
      assert.equal(r.state, 'done', r.error ?? '');
      const file = join(root, `${generator}.png`); writeFileSync(file, (await engine.getRenderOutput(c, r.id, r.outputs[0]!.name)).bytes);
      assert.ok(Number(tool('identify', ['-format', '%[fx:standard_deviation]', file])) > 0.05, `${generator} is not a flat image`);
      const ocr = tool('tesseract', [file, '-', '--psm', '11']).replace(/\s+/g, ' ');
      assert.match(ocr, expect, `${generator}: ${ocr}`);
      if (generator === 'quoteCard') { assert.match(ocr, /RECONSTRUCTION/); const man = await engine.getRenderManifest(c, r.id) as any; assert.equal(man.disclosures[0].basis, 'reconstruction'); }
      digests.add(r.outputs[0]!.sha256);
      // regenerating the same group with new content replaces its layers
      if (generator === 'coverArt') { const rev = await engine.applyOperations(c, { productionId: p.id, operations: [{ op: 'generate', generator, params: { ...params, title: 'Receipts' }, group: 'g' }] }); assert.ok(rev.diff.length > 0); assert.equal(((await engine.getRevision(c, p.id)).doc as any).generated.length, 1); }
    }
    assert.equal(digests.size, 4);
  });
});
