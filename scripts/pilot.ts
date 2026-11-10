// Pilot: produces a complete fictional production (the invented town of Larkmoor and its flood-relief fund) across
// all five pipelines against a real database — create → edit → render → revise → re-render → export — and writes
// every artifact, manifest and project revision to an output directory.
//
//   npm run pilot -- --out <dir>
//
// Database: DATABASE_URL (used as is; the engine schema is migrated in it) or TEST_DATABASE_URL (a disposable database
// is created and dropped). No consent engine is involved: the pilot runs in the documented standalone mode where
// declared asset rights are accepted and recorded as unverified. All names, places, figures and documents are invented.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as kit from '../src/service-kit.ts';
import { createEngine, migrate } from '../src/engine/index.ts';
import type { Doc, ProductionEngine, Project, Render } from '../src/engine/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2); const outArg = args.indexOf('--out');
if (outArg < 0 || args[outArg + 1] === undefined) { console.error('usage: npm run pilot -- --out <dir> [--quick]'); process.exit(2); }
const OUT = resolve(args[outArg + 1] as string); const QUICK = args.includes('--quick');
const CLAIM = 'E07:claim:c-ledger@2', MINUTES = 'E05:evidence_version:ev-minutes@1', LEDGER = 'E05:evidence_version:ev-ledger@1';
const ctx = (): kit.ServiceContext => ({ tenantId: 'pilot', projectId: 'larkmoor', purpose: 'pilot production', requestId: `pilot-${Date.now()}`, now: new Date().toISOString(), actor: { id: 'pilot-producer', kind: 'human', roles: ['producer'] }, capabilities: ['production:read', 'production:write', 'production:render', 'production:approve', 'production:export', 'production:audit'], compartments: [] });
const log = (m: string): void => console.log(`[pilot] ${m}`);
const report: Doc = { title: 'Larkmoor flood-relief fund pilot', startedAt: new Date().toISOString(), fictional: true, works: [] };

async function run(engine: ProductionEngine): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'e10-pilot-'));
  /** Renders, waits, writes every output + manifest under <out>/<dir>, and returns the finished render. */
  async function produce(project: Project, dir: string, profile: 'final' | 'preview' = 'final'): Promise<Render> {
    let r = await engine.requestRender(ctx(), { productionId: project.id, profile });
    if (r.state === 'blocked') throw new Error(`render blocked: ${r.error ?? ''}`);
    let last = '';
    const watch = setInterval(() => { void engine.getRender(ctx(), r.id).then((x) => { if (x.stage !== last) { last = x.stage; log(`  ${project.title}: ${Math.round(x.progress * 100)}% ${x.stage}`); } }).catch(() => undefined); }, 1500);
    try { while (['queued', 'running'].includes(r.state)) { await engine.runJobs({ worker: 'pilot' }); r = await engine.getRender(ctx(), r.id); } } finally { clearInterval(watch); }
    if (r.state !== 'done') throw new Error(`render of "${project.title}" ${r.state}: ${r.error ?? ''}`);
    const target = join(OUT, dir); await mkdir(target, { recursive: true });
    for (const o of r.outputs) await writeFile(join(target, o.name), (await engine.getRenderOutput(ctx(), r.id, o.name)).bytes);
    await writeFile(join(target, 'manifest.json'), JSON.stringify(await engine.getRenderManifest(ctx(), r.id), null, 2));
    (report.works as Doc[]).push({ work: project.title, kind: project.kind, dir, profile, render: r.ref, projectRevision: r.revision, renderSeq: r.seq, manifestDigest: r.manifestDigest, qc: (r.qc as Doc | null)?.ok ?? null, outputs: r.outputs.map((o) => ({ name: o.name, bytes: o.size, sha256: o.sha256, mediaType: o.mediaType, role: o.role })) });
    log(`${project.title} → ${dir} (${r.outputs.length} files, revision ${r.revision}, render #${r.seq})`);
    return r;
  }
  async function saveRevisions(project: Project, dir: string): Promise<void> {
    const revs = await engine.listRevisions(ctx(), project.id); const target = join(OUT, dir); await mkdir(target, { recursive: true });
    for (const rev of revs) await writeFile(join(target, `project-revision-${rev.revision}.json`), JSON.stringify((await engine.getRevision(ctx(), project.id, rev.revision)), null, 2));
  }
  async function approveAndExport(render: Render, dir: string, assetIds: string[]): Promise<void> {
    for (const id of assetIds) if ((await engine.getAsset(ctx(), id)).approval !== 'approved') await engine.setAssetApproval(ctx(), { assetId: id, approval: 'approved', note: 'Pilot fixture approved by the pilot producer' });
    const ex = await engine.createExport(ctx(), { renderId: render.id, audience: 'pilot reviewers', destination: 'local review' });
    const file = await engine.getExportBytes(ctx(), ex.id); await writeFile(join(OUT, dir, file.filename.replace(/\.zip$/, '.export.zip')), file.bytes);
  }
  const asAsset = async (render: Render, output: string, name: string): Promise<string> => { const a = await engine.importRenderOutput(ctx(), { renderId: render.id, output, name }); await engine.setAssetApproval(ctx(), { assetId: a.id, approval: 'approved', note: 'Produced in the pilot' }); return a.id; };
  const E09 = JSON.parse(await readFile(join(here, '..', 'tests', 'fixtures', 'e09-exports.json'), 'utf8')) as Record<string, unknown>;

  // ── source material: an invented ledger page standing in for a scanned evidence page ──
  const ledgerPng = join(work, 'ledger.png');
  execFileSync('convert', ['-size', '1000x1400', 'xc:#fbf8ef', '-font', 'DejaVu-Sans', '-fill', '#222222', '-pointsize', '38', '-annotate', '+70+120', 'LARKMOOR COUNCIL LEDGER', '-pointsize', '24', '-annotate', '+70+170', 'Relief fund account, spring quarter (page 14)', '-pointsize', '30',
    '-annotate', '+70+300', 'Pumps and hoses           12,400', '-annotate', '+70+380', 'Shelter hall               8,150', '-annotate', '+70+460', 'Unexplained transfer   31,000', '-annotate', '+70+540', 'Account 4471-889-ZQ', '-annotate', '+70+620', 'Balance carried forward    8,450', '-annotate', '+70+900', 'Signed: T. Brandt, treasurer', ledgerPng]);
  const ledger = await engine.importAsset(ctx(), { name: 'Ledger page 14 (invented pilot document)', filename: 'ledger-page-14.png', bytes: await readFile(ledgerPng), rights: { kind: 'permission', ref: 'E11:permission:perm-ledger', attribution: 'Larkmoor council archive (fictional)' }, provenance: { sourceRefs: [LEDGER], tool: 'ImageMagick', note: 'Invented page drawn for the pilot; stands in for a scanned record.' }, sources: [LEDGER] });
  await engine.setAssetApproval(ctx(), { assetId: ledger.id, approval: 'approved', note: 'Pilot fixture' });

  // ── 1. written work, from the E09 article export ──
  log('written work');
  const written = await engine.createProjectFromEditorial(ctx(), { kind: 'written', editorial: E09.article });
  await engine.applyOperations(ctx(), { productionId: written.id, summary: 'Subtitle, author, layout, source labels, ledger figure', operations: [
    { op: 'set', path: '/subtitle', value: 'Where the money went' }, { op: 'set', path: '/authors', value: ['Ines Varga'] },
    { op: 'setLayout', layout: { pageSize: 'A5', fontSizePt: 10, margins: { top: 18, bottom: 18, left: 16, right: 16 }, copyright: 'A fictional pilot. Larkmoor, its people and its ledger are invented.' } },
    { op: 'set', path: '/sourceNotes', value: { [CLAIM]: 'Larkmoor council ledger, spring quarter', [MINUTES]: 'Relief committee minutes', 'E06:segment:seg-novak-3@1': 'Interview with Mirela Novak, segment 3' } },
    { op: 'insertBlock', after: 'a4', block: { id: 'fig1', type: 'image', assetId: ledger.id, caption: 'Ledger page 14, showing the transfer without a receipt.', alt: 'A ledger page listing payments for pumps, a shelter hall and one unexplained transfer.', sources: [LEDGER] } },
  ] });
  await produce(await engine.getProject(ctx(), written.id), 'written/v1');
  await engine.applyOperations(ctx(), { productionId: written.id, summary: 'Editorial correction to the opening; A4 layout', operations: [
    { op: 'updateBlock', blockId: 'a1', set: { text: 'After the river Ost flooded the invented town of Larkmoor in early spring, the relief fund collected sixty thousand within a month.' } }, { op: 'setLayout', layout: { pageSize: 'A4', fontSizePt: 11 } } ] });
  const w2 = await produce(await engine.getProject(ctx(), written.id), 'written/v2'); await saveRevisions(written, 'written'); await approveAndExport(w2, 'written/v2', [ledger.id]);

  // ── 2. still images ──
  log('still images');
  const image = async (title: string, canvas: Doc, generator: string, params: Doc, extra: Doc = {}): Promise<{ project: Project; render: Render }> => {
    const p = await engine.createProject(ctx(), { kind: 'image', title, doc: { title, canvas, layers: [], sources: [CLAIM], ...extra } });
    await engine.applyOperations(ctx(), { productionId: p.id, operations: [{ op: 'generate', generator, params, group: 'main' }] });
    return { project: p, render: await produce(await engine.getProject(ctx(), p.id), `images/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/v1`) };
  };
  const excerpt = await image('Ledger excerpt card', { width: 1600, height: 900 }, 'documentExcerpt', { assetId: ledger.id, region: { x: 40, y: 250, width: 760, height: 420 }, title: 'From the council ledger', caption: 'One transfer of 31,000 has no receipt. The account number is redacted.', sourceRef: LEDGER, highlight: { x: 60, y: 420, width: 700, height: 60 }, redactions: [{ x: 60, y: 505, width: 430, height: 50, label: 'ACCOUNT' }] });
  await engine.applyOperations(ctx(), { productionId: excerpt.project.id, summary: 'Add an "unverified copy" stamp', operations: [{ op: 'addLayer', layer: { id: 'stamp', type: 'text', text: 'PILOT — INVENTED DOCUMENT', x: 980, y: 40, width: 580, size: 26, color: '#ffd60a', bold: true, align: 'right' } }] });
  const excerpt2 = await produce(await engine.getProject(ctx(), excerpt.project.id), 'images/ledger-excerpt-card/v2'); await saveRevisions(excerpt.project, 'images/ledger-excerpt-card'); await approveAndExport(excerpt2, 'images/ledger-excerpt-card/v2', [ledger.id]);
  const timeline = await image('Relief fund timeline', { width: 1920, height: 1080 }, 'timeline', { title: 'The Larkmoor relief fund', caption: 'Dates are invented for the pilot.', events: [{ date: '2031-03-04', label: 'River Ost floods the lower town' }, { date: '2031-03-20', label: 'Relief fund opens' }, { date: '2031-04-18', label: 'Fund reaches 60,000' }, { date: '2031-06-01', label: 'Transfer of 31,000, no receipt' }, { date: '2031-09-15', label: 'Residents request an audit' }] });
  const quote = await image('Novak quote card', { width: 1600, height: 900 }, 'quoteCard', { quote: 'We were told the fund was full.', attribution: 'Mirela Novak, shopkeeper', source: 'E06:segment:seg-novak-3@1' });
  await image('Pump house location card', { width: 1600, height: 900 }, 'locationCard', { place: 'Larkmoor Pump House', region: 'Ost valley (a fictional place)', caption: 'Where the sandbags were counted on the night of the flood' });
  const cover = await image('Cover art', { width: 1600, height: 2400 }, 'coverArt', { title: 'The Larkmoor Flood Relief Fund', subtitle: 'Where the money went', author: 'Ines Varga', seedText: 'river ledger sandbags receipt transfer audit' });

  // ── 3. music and audio ──
  log('song');
  const song = await engine.createProjectFromEditorial(ctx(), { kind: 'audio', editorial: E09.lyrics, options: { mood: 'hopeful', seed: 'larkmoor-pilot' } });
  await engine.applyOperations(ctx(), { productionId: song.id, summary: 'Arrangement: intro, second verse, repeated chorus', operations: [{ op: 'compose', params: { seed: 'larkmoor-pilot', mood: 'hopeful', tempo: 108, key: { tonic: 'D', mode: 'minor' }, credits: ['Words: Ines Varga (fictional)', 'Music: generated arrangement, E10 composition generator'], sources: [MINUTES], sections: [
    { id: 'intro', type: 'intro', bars: 4 },
    { id: 'v1', type: 'verse', lyrics: ['The river rose on Larkmoor lane', 'We counted sandbags in the rain', 'They told us help was on the way', 'The ledger tells another day'], basis: 'reconstruction', disclosure: 'The verse retells events from committee minutes; details are approximated.', sources: [MINUTES] },
    { id: 'c1', type: 'chorus', lyrics: ['Where did the water go', 'Where did the money flow', 'Show us the paper, show us the sum', 'We will be here when morning comes'], basis: 'invention', disclosure: 'The chorus is the songwriters’ own words, not a quotation.' },
    { id: 'v2', type: 'verse', lyrics: ['The pump house door was open wide', 'The treasurer stood just inside', 'One line of ink, no slip, no name', 'And thirty one thousand never came'], basis: 'reconstruction', disclosure: 'The verse retells events from committee minutes; details are approximated.', sources: [MINUTES, CLAIM] },
    { id: 'c2', type: 'chorus', lyrics: ['Where did the water go', 'Where did the money flow', 'Show us the paper, show us the sum', 'We will be here when morning comes'], basis: 'invention', disclosure: 'The chorus is the songwriters’ own words, not a quotation.' },
    { id: 'outro', type: 'outro', bars: 4 } ] } }] });
  const s1 = await produce(await engine.getProject(ctx(), song.id), 'song/v1');
  await engine.applyOperations(ctx(), { productionId: song.id, summary: 'Revision: up a tone, flute lead, new second-verse melody, quieter pad', operations: [{ op: 'transpose', semitones: 2 }, { op: 'setInstrument', trackId: 'lead', program: 73, name: 'Flute (lead melody)' }, { op: 'regenerateSection', sectionId: 'v2', seed: 'take-2', roles: ['lead'] }, { op: 'setTrack', trackId: 'harmony', set: { volume: 0.45 } }, { op: 'setMix', mix: { reverb: 0.35, fadeOut: 3 } }] });
  const s2 = await produce(await engine.getProject(ctx(), song.id), 'song/v2'); await saveRevisions(song, 'song'); await approveAndExport(s2, 'song/v2', []);
  void s1;
  // instrumental bed for the programme and the film: the same song without the guide vocal
  await engine.applyOperations(ctx(), { productionId: song.id, summary: 'Instrumental version (guide vocal off)', operations: [{ op: 'setGuide', guide: { enabled: false } }] });
  const bedRender = await produce(await engine.getProject(ctx(), song.id), 'song/instrumental'); const bed = await asAsset(bedRender, bedRender.outputs.find((o) => o.name.endsWith('.flac') && o.role === 'primary')?.name as string, 'Instrumental bed — Where the Water Went');
  log('narrated programme');
  const programme = await engine.createProject(ctx(), { kind: 'audio', title: 'Larkmoor audio report', doc: { mode: 'program', title: 'Larkmoor audio report', sources: [CLAIM], clips: [
    { id: 'bed', track: 'music', source: { type: 'asset', assetId: bed }, start: 0, trimStart: 8, duration: 34, gain: -6, fadeIn: 1.5, fadeOut: 3 },
    { id: 'n1', source: { type: 'tts', text: 'This is a pilot report from Larkmoor, a town that does not exist. After the flood, the relief fund collected sixty thousand.' }, start: 2.5, sources: [CLAIM] },
    { id: 'n2', source: { type: 'tts', text: 'The council ledger shows one transfer of thirty one thousand with no receipt.' }, follow: 0.5, sources: [CLAIM] },
    { id: 'n3', source: { type: 'tts', text: 'That night, the treasurer stood at the pump house door and counted the sandbags twice.' }, follow: 0.5, basis: 'reconstruction', disclosure: 'One scene in this report is reconstructed from committee minutes.', sources: [MINUTES] } ] } });
  const pr1 = await produce(programme, 'programme/v1');
  await engine.applyOperations(ctx(), { productionId: programme.id, summary: 'Tighter opening, lower bed', operations: [{ op: 'updateClip', clipId: 'n1', set: { source: { text: 'This is a pilot report from Larkmoor, a town that does not exist. The relief fund there collected sixty thousand after the flood.' } } }, { op: 'updateClip', clipId: 'bed', set: { gain: -9 } }] });
  const pr2 = await produce(await engine.getProject(ctx(), programme.id), 'programme/v2'); await saveRevisions(programme, 'programme'); await approveAndExport(pr2, 'programme/v2', [bed]); void pr1;

  // ── 4. animation and video ──
  log('film');
  const timelineAsset = await asAsset(timeline.render, timeline.render.outputs.find((o) => o.name.endsWith('.png'))?.name as string, 'Timeline graphic');
  const quoteAsset = await asAsset(quote.render, quote.render.outputs.find((o) => o.name.endsWith('.png'))?.name as string, 'Quote card');
  const [W, H, FPS] = QUICK ? [640, 360, 15] : [1280, 720, 24];
  const film = await engine.createProjectFromEditorial(ctx(), { kind: 'video', editorial: E09.script, title: 'The Larkmoor Fund', options: { assets: { 'E05:evidence_version:ev-ledger': ledger.id }, width: W, height: H, fps: FPS } });
  await engine.applyOperations(ctx(), { productionId: film.id, summary: 'Opening title, timeline, animated reconstruction, quote, music', operations: [
    { op: 'set', path: '/title', value: 'The Larkmoor Fund' },
    { op: 'addScene', index: 0, scene: { id: 'open', duration: 4, visual: { type: 'title', title: 'The Larkmoor Fund', subtitle: 'A pilot film about an invented town' }, narration: { type: 'tts', text: 'Larkmoor does not exist. This pilot film tells the story of its flood relief fund.' } } },
    { op: 'addScene', index: 1, scene: { id: 'timeline', duration: 6, visual: { type: 'image', assetId: timelineAsset, kenBurns: { from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.75, y: 0.5, zoom: 1.35 } } }, transition: { type: 'crossfade', duration: 0.8 }, narration: { type: 'tts', text: 'The river flooded in March. By April the fund held sixty thousand.' }, sources: [CLAIM] } },
    { op: 'updateScene', sceneId: 's1-p1', set: { duration: 6, visual: { type: 'image', assetId: ledger.id, kenBurns: { from: { x: 0.1, y: 0.25, zoom: 1.5 }, to: { x: 0.25, y: 0.42, zoom: 2.2 } } }, transition: { type: 'crossfade', duration: 0.8 } } },
    { op: 'updateScene', sceneId: 's2-p1', set: { duration: 6, visual: { type: 'scene', scene: { background: { gradient: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#0b132b' }, { offset: 1, color: '#1c2541' }] } }, layers: [
      { id: 'moon', type: 'shape', shape: 'ellipse', x: W * 0.78, y: H * 0.1, width: H * 0.14, height: H * 0.14, fill: '#f4f1de', opacity: 0.9 },
      { id: 'house', type: 'shape', x: W * 0.36, y: H * 0.38, width: W * 0.28, height: H * 0.4, fill: '#3d405b' }, { id: 'roof', type: 'shape', shape: 'polygon', x: W * 0.33, y: H * 0.22, points: [[0, H * 0.16], [W * 0.17, 0], [W * 0.34, H * 0.16]], fill: '#2b2d42' },
      { id: 'door', type: 'shape', x: W * 0.47, y: H * 0.55, width: W * 0.06, height: H * 0.23, fill: '#f2cc8f', keyframes: [{ t: 0, props: { opacity: 0.2 } }, { t: 2, props: { opacity: 1 } }] },
      ...[0, 1, 2, 3, 4].map((i) => ({ id: `bag${i}`, type: 'shape', x: W * (0.3 + i * 0.075), y: H * 0.72, width: W * 0.07, height: H * 0.07, radius: H * 0.03, fill: '#a98467', keyframes: [{ t: 0.6 + i * 0.5, props: { opacity: 0, y: H * 0.6 } }, { t: 1 + i * 0.5, props: { opacity: 1, y: H * 0.72 } }] })),
      { id: 'water', type: 'shape', x: 0, y: H * 0.9, width: W, height: H * 0.3, fill: '#3a86ff', opacity: 0.85, keyframes: [{ t: 0, props: { y: H * 0.95 } }, { t: 6, props: { y: H * 0.78 } }] } ] } }, overlays: [{ id: 'place', type: 'lowerThird', title: 'The pump house', subtitle: 'Night of the flood', start: 0.5, end: 4.5, animation: 'slide' }] } },
    { op: 'addScene', scene: { id: 'quote', duration: 5, visual: { type: 'image', assetId: quoteAsset, kenBurns: { from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.5, y: 0.5, zoom: 1.06 } } }, transition: { type: 'crossfade', duration: 0.8 }, narration: { type: 'tts', text: 'Residents have asked for an audit. The question is still open.' }, sources: ['E06:segment:seg-novak-3@1'] } },
    { op: 'addAudio', clip: { id: 'music', role: 'music', assetId: bed, start: 0, trimStart: 8, gain: -10, fadeIn: 1, fadeOut: 3, loop: true } },
    { op: 'set', path: '/credits/lines', value: ['A fictional pilot production', 'Written by Ines Varga'] },
  ] });
  await produce(await engine.getProject(ctx(), film.id), 'film/preview', 'preview');
  const f1 = await produce(await engine.getProject(ctx(), film.id), 'film/v1');
  await engine.applyOperations(ctx(), { productionId: film.id, summary: 'Revision: retitle, add on-screen figure', operations: [{ op: 'set', path: '/scenes/id=open/visual/subtitle', value: 'Where the money went — a pilot film about an invented town' }, { op: 'addOverlay', sceneId: 'timeline', overlay: { id: 'figure', type: 'text', text: '60,000 collected', start: 2.5, end: 5.5, animation: 'typewriter', x: W * 0.06, y: H * 0.08, width: W * 0.5, size: Math.round(H * 0.07) } }] });
  const f2 = await produce(await engine.getProject(ctx(), film.id), 'film/v2'); await saveRevisions(film, 'film'); await approveAndExport(f2, 'film/v2', [ledger.id, bed, timelineAsset, quoteAsset]); void f1;

  // ── 5. interactive work, from the E09 interactive-story export ──
  log('interactive work');
  const story = await engine.createProjectFromEditorial(ctx(), { kind: 'interactive', editorial: E09.interactive });
  await engine.applyOperations(ctx(), { productionId: story.id, summary: 'Titles, intro, ledger image, source labels', operations: [
    { op: 'set', path: '/intro', value: 'An interactive walk through the records of an invented relief fund.' }, { op: 'set', path: '/sourceNotes', value: { [CLAIM]: 'Larkmoor council ledger, spring quarter', [MINUTES]: 'Relief committee minutes' } },
    { op: 'updateNode', nodeId: 'start', set: { title: 'The town hall' } }, { op: 'updateNode', nodeId: 'treasurer', set: { title: 'The pump house' } }, { op: 'updateNode', nodeId: 'answer', set: { title: 'An answer, of sorts' } }, { op: 'updateNode', nodeId: 'open', set: { title: 'An open question' } },
    { op: 'addMedia', nodeId: 'ledger', media: { assetId: excerpt2.outputs.length > 0 ? await asAsset(excerpt2, excerpt2.outputs.find((o) => o.name.endsWith('.jpg'))?.name as string, 'Ledger excerpt card') : ledger.id, alt: 'An excerpt of a ledger page; one line shows a transfer of 31,000 and the account number is blacked out.', caption: 'From the council ledger' } },
  ] });
  await produce(await engine.getProject(ctx(), story.id), 'interactive/v1');
  await engine.applyOperations(ctx(), { productionId: story.id, summary: 'Revision: a third path', operations: [
    { op: 'addNode', node: { id: 'minutes', title: 'The committee minutes', text: 'The minutes record the transfer but not who approved it.', basis: 'verified_fact', sources: [MINUTES], choices: [{ id: 'c1', label: 'Ask the treasurer', target: 'treasurer' }] } },
    { op: 'addChoice', nodeId: 'start', choice: { id: 'c3', label: 'Read the committee minutes', target: 'minutes', set: { sawLedger: true } } } ] });
  const i2 = await produce(await engine.getProject(ctx(), story.id), 'interactive/v2'); await saveRevisions(story, 'interactive');
  await approveAndExport(i2, 'interactive/v2', (i2.inputs as Doc[]).map((x) => x.assetId as string));
  void cover;

  // ── reopen a saved revision and show the engine's own account of one work ──
  const reopened = await engine.getRevision(ctx(), written.id, 2); const diff = await engine.diffRevisions(ctx(), written.id, 2, 3);
  report.reopenedRevision = { project: written.ref, revision: reopened.revision, digest: reopened.digest, changesToNext: diff.summary };
  report.inspection = (await engine.inspect(ctx(), f2.ref)) as unknown as Doc;
  report.health = (await engine.health()).detail as Doc; report.finishedAt = new Date().toISOString();
  report.notes = ['All names, places, figures and documents are invented.', 'Speech and guide vocals are synthetic (espeak-ng) and labelled as such in manifests and credits.', 'Rights decisions were made in standalone "declared-rights" mode: not verified by a consent engine.', 'No external generation provider was called.'];
  await writeFile(join(OUT, 'pilot-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(OUT, 'README.txt'), ['Larkmoor flood-relief fund — media production pilot (entirely fictional)', '', ...(report.works as Doc[]).map((w) => `${String(w.dir).padEnd(38)} ${String(w.kind).padEnd(12)} ${(w.outputs as Doc[]).filter((o) => o.role === 'primary' || o.role === 'preview').map((o) => o.name).join(', ')}`), '', 'Each directory holds the rendered files, manifest.json (inputs, rights, sources, tools, disclosures, digests) and,', 'next to the versions, project-revision-N.json (the editable project document at each saved revision).', '*.export.zip is the export bundle (outputs + manifest + credits + provenance sidecars).', ''].join('\n'));
  await rm(work, { recursive: true, force: true });
  log(`done: ${(report.works as Doc[]).length} renders in ${OUT}`);
}

await mkdir(OUT, { recursive: true });
const objectsDir = await mkdtemp(join(tmpdir(), 'e10-pilot-objects-'));
const make = (sql: kit.Sql): ProductionEngine => createEngine({ sql, objects: new kit.FsObjectStore(objectsDir), config: { standalone: { useDecisions: 'declared-rights' } } });
try {
  if (process.env.DATABASE_URL) { const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 }); const sql = kit.pgSql(pool); try { await migrate(sql); await run(make(sql)); } finally { await pool.end(); } }
  else if (process.env.TEST_DATABASE_URL) await kit.withDisposableDatabase(pg, process.env.TEST_DATABASE_URL, async (_url, sql) => { await migrate(sql); await run(make(sql)); });
  else { console.error('Set DATABASE_URL (used as is) or TEST_DATABASE_URL (a disposable database is created).'); process.exit(2); }
} finally { await rm(objectsDir, { recursive: true, force: true }); }
