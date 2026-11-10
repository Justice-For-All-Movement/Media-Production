// Still images: an editable layered scene (SVG scene graph) rasterised with rsvg-convert and converted with ImageMagick.
// Exports PNG / JPEG / WebP / SVG with metadata stripped (exiftool); provenance travels in the manifest sidecar.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { run, safeName } from './tools.ts';
import { GENERATORS, generateLayers, imageResolver, normalizeLayer, normalizeScene, rasterize, sceneToSvg } from './scene.ts';
import type { Scene } from './scene.ts';
import { arr, basisLabel, collectAssets, collectText, disclosureText, isObj, n, needsDisclosure, objs, str, urefs } from './types.ts';
import type { Disclosure, Doc, EditorialExport, Pipeline, PipelineResult, RenderEnv, RenderOutput } from './types.ts';

const FORMATS = ['png', 'jpeg', 'webp', 'svg'];
function validate(raw: unknown): Doc {
  invariant(isObj(raw), 'invalid_input', 'Document must be an object');
  const scene = normalizeScene({ ...(isObj(raw.canvas) ? raw.canvas : {}), layers: raw.layers });
  const ex = isObj(raw.export) ? raw.export : {}; const formats = arr(ex.formats).filter((f): f is string => typeof f === 'string' && FORMATS.includes(f));
  const basis = str(raw.basis, '', 40);
  return { kind: 'image', title: str(raw.title, 'Untitled', 300), canvas: { width: scene.width, height: scene.height, background: scene.background }, layers: scene.layers,
    generated: objs(raw.generated).map((g) => ({ group: str(g.group, '', 64), generator: str(g.generator, '', 64), params: isObj(g.params) ? g.params : {} })).slice(0, 100),
    export: { formats: formats.length > 0 ? [...new Set(formats)] : ['png', 'jpeg', 'webp', 'svg'], jpegQuality: n(ex.jpegQuality, 90, 30, 100), webpQuality: n(ex.webpQuality, 88, 30, 100) },
    sources: urefs(raw.sources), ...(basis === '' ? {} : { basis }), ...(needsDisclosure(basis) ? { disclosure: disclosureText(basis, raw.disclosure) } : {}), ...(typeof raw.alt === 'string' ? { alt: raw.alt.slice(0, 2000) } : {}) };
}
const sceneOf = (doc: Doc): Scene => ({ width: (doc.canvas as Doc).width as number, height: (doc.canvas as Doc).height as number, background: (doc.canvas as Doc).background as Json, layers: objs(doc.layers) });
const layerIndex = (doc: Doc, id: unknown): number => { const i = objs(doc.layers).findIndex((l) => l.id === id); invariant(i >= 0, 'invalid_input', `No layer ${String(id)}`); return i; };

/** Scene with the mandatory disclosure strip appended when the image is labelled reconstruction/invention/…. */
async function withDisclosure(doc: Doc): Promise<{ scene: Scene; disclosures: Disclosure[] }> {
  const scene = sceneOf(doc); if (!needsDisclosure(doc.basis)) return { scene, disclosures: [] };
  const size = Math.max(11, Math.round(scene.height * 0.024)); const text = `${basisLabel(str(doc.basis))} — ${str(doc.disclosure)}`;
  const strip = normalizeLayer({ id: 'disclosure-strip', type: 'text', text, x: size, y: 0, width: scene.width - 2 * size, size, color: '#ffffff', bold: true, background: { color: '#9d0208', padding: Math.round(size * 0.6), radius: 0, opacity: 0.95 } }, scene);
  const { layoutText } = await import('./scene.ts'); strip.y = scene.height - (await layoutText(strip)).height - size;
  return { scene: { ...scene, layers: [...scene.layers, strip] }, disclosures: [{ basis: str(doc.basis), text: str(doc.disclosure), where: 'strip rendered into the image' }] };
}
async function render(doc: Doc, env: RenderEnv): Promise<PipelineResult> {
  await env.tool('rsvg-convert', 'convert', 'identify');
  const { scene, disclosures } = await withDisclosure(doc);
  const base = safeName(str(doc.title, 'image')).replace(/\.+$/, '') || 'image'; const outputs: RenderOutput[] = [];
  const resolve = imageResolver(env.dir, async (id, v) => { const a = await env.asset(id, v); if (a.mediaType === 'application/pdf') await env.tool('pdftoppm'); return a; }, env.signal, env.profile === 'preview' ? 0.5 : 1);
  env.progress(0.1, 'compose');
  // Redactions must be irreversible in every format: everything up to the top-most redaction is flattened to pixels,
  // so the vector export never carries the covered content.
  const lastRedaction = scene.layers.map((l) => l.type).lastIndexOf('redaction');
  const rasterSvg = await sceneToSvg(scene, resolve);
  const width = env.profile === 'preview' ? Math.min(scene.width, 480) : scene.width;
  const png = join(env.dir, `${base}.png`);
  await rasterize(rasterSvg, png, width, env.signal);
  if (env.profile === 'preview') { outputs.push({ name: `${base}.preview.png`, path: png, mediaType: 'image/png', role: 'preview' }); return { outputs, parameters: { canvas: doc.canvas as Json, width }, disclosures, credits: env.credits(), generated: doc.generated as Json[] }; }
  await env.tool('exiftool');
  const ex = doc.export as Doc; const formats = arr(ex.formats) as string[]; const made: string[] = [];
  env.progress(0.5, 'convert');
  if (formats.includes('png')) { outputs.push({ name: `${base}.png`, path: png, mediaType: 'image/png', role: 'primary' }); made.push(png); }
  if (formats.includes('jpeg')) { const p = join(env.dir, `${base}.jpg`); await run('convert', [png, '-background', 'white', '-flatten', '-quality', String(ex.jpegQuality), p], { signal: env.signal }); outputs.push({ name: `${base}.jpg`, path: p, mediaType: 'image/jpeg', role: 'primary' }); made.push(p); }
  if (formats.includes('webp')) { const p = join(env.dir, `${base}.webp`); await run('convert', [png, '-quality', String(ex.webpQuality), p], { signal: env.signal }); outputs.push({ name: `${base}.webp`, path: p, mediaType: 'image/webp', role: 'primary' }); made.push(p); }
  if (made.length > 0) await run('exiftool', ['-all=', '-overwrite_original', '-q', ...made], { signal: env.signal });
  if (formats.includes('svg')) {
    let svg = rasterSvg;
    if (lastRedaction >= 0) {
      const flat = join(env.dir, 'flattened.png');
      await rasterize(await sceneToSvg(scene, resolve, { to: lastRedaction + 1 }), flat, scene.width, env.signal);
      const href = `data:image/png;base64,${(await readFile(flat)).toString('base64')}`;
      svg = await sceneToSvg(scene, resolve, { from: lastRedaction + 1, background: false, prepend: `<image x="0" y="0" width="${scene.width}" height="${scene.height}" href="${href}"/>` });
    }
    const p = join(env.dir, `${base}.svg`); await writeFile(p, svg); outputs.push({ name: `${base}.svg`, path: p, mediaType: 'image/svg+xml', role: 'primary' });
  }
  invariant(outputs.length > 0, 'invalid_input', 'No export formats selected');
  return { outputs, parameters: { canvas: doc.canvas as Json, export: ex, layers: scene.layers.length, redactionsFlattened: lastRedaction >= 0, metadataStripped: true }, disclosures, credits: env.credits(), generated: doc.generated as Json[], details: { requiredDisclosures: disclosures.map(() => 'image') } };
}

export const imagePipeline: Pipeline = {
  kind: 'image', tools: ['rsvg-convert', 'convert', 'identify'],
  validate,
  empty: (title) => validate({ title, canvas: { width: 1600, height: 900, background: '#ffffff' }, layers: [] }),
  assetRefs: (doc) => collectAssets(doc.layers as Json),
  sources: (doc) => arr(doc.sources) as string[],
  text: (doc) => [str(doc.title), ...collectText(doc.layers as Json), ...collectText(doc.generated as Json)].join('\n'),
  async applyOp(doc, op, helpers) {
    const out = structuredClone(doc); const layers = out.layers as Doc[]; const canvas = out.canvas as { width: number; height: number };
    switch (op.op) {
      case 'addLayer': { invariant(isObj(op.layer), 'invalid_input', 'addLayer needs a layer'); const layer = normalizeLayer({ ...op.layer, id: typeof op.layer.id === 'string' ? op.layer.id : helpers.newId('layer') }, canvas); if (layer.type === 'image') await helpers.assetInfo(layer.assetId as string); layers.splice(typeof op.index === 'number' ? Math.min(Math.max(op.index, 0), layers.length) : layers.length, 0, layer); return out; }
      case 'updateLayer': { const i = layerIndex(out, op.layerId); invariant(isObj(op.set), 'invalid_input', 'updateLayer needs "set"'); const cur = layers[i] as Doc; layers[i] = normalizeLayer({ ...cur, ...op.set, id: cur.id, type: cur.type, ...(isObj(op.set.filters) ? { filters: { ...(cur.filters as Doc), ...op.set.filters } } : {}) }, canvas); return out; }
      case 'removeLayer': { layers.splice(layerIndex(out, op.layerId), 1); return out; }
      case 'reorderLayer': { const i = layerIndex(out, op.layerId); const [l] = layers.splice(i, 1); invariant(typeof op.to === 'number', 'invalid_input', 'reorderLayer needs "to"'); layers.splice(Math.min(Math.max(op.to, 0), layers.length), 0, l as Doc); return out; }
      case 'setCanvas': { invariant(isObj(op.canvas), 'invalid_input', 'setCanvas needs canvas'); out.canvas = { ...(out.canvas as Doc), ...op.canvas }; return out; }
      case 'generate': {
        const generator = str(op.generator); invariant(Object.hasOwn(GENERATORS, generator), 'invalid_input', `Unknown generator ${generator}; available: ${Object.keys(GENERATORS).join(', ')}`);
        const params = isObj(op.params) ? op.params : {}; const group = typeof op.group === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(op.group) ? op.group : helpers.newId('gen');
        if (typeof params.assetId === 'string') await helpers.assetInfo(params.assetId);
        const made = await generateLayers(generator, params, canvas, group);
        // Re-running a generator for the same group replaces its layers in place; hand-made layers are kept.
        const at = layers.findIndex((l) => l.group === group); const kept = layers.filter((l) => l.group !== group);
        kept.splice(at < 0 ? kept.length : Math.min(at, kept.length), 0, ...made);
        out.layers = kept; out.generated = [...objs(out.generated).filter((g) => g.group !== group), { group, generator, params }];
        return out;
      }
      default: return null;
    }
  },
  render,
  async fromEditorial(ed: EditorialExport, options) {
    const canvas = { width: Math.round(n(options.width, 1600, 64, 8192)), height: Math.round(n(options.height, 900, 64, 8192)) };
    const block = typeof options.blockId === 'string' ? ed.blocks.find((b) => b.id === options.blockId) : undefined;
    invariant(options.blockId === undefined || block !== undefined, 'invalid_input', 'No such editorial block');
    const generator = block === undefined ? 'coverArt' : 'quoteCard';
    const params: Doc = block === undefined ? { title: ed.title, subtitle: ed.notice ?? '', author: ed.credits[0] ?? '', seedText: ed.blocks.map((b) => b.text).join(' ').slice(0, 2000) } : { quote: block.text, attribution: block.attribution ?? '', basis: needsDisclosure(block.basis) ? block.basis : '', source: block.sources[0] ?? '' };
    const layers = await generateLayers(generator, params, canvas, 'editorial');
    return validate({ title: ed.title, canvas: { ...canvas, background: '#ffffff' }, layers, generated: [{ group: 'editorial', generator, params }], sources: block === undefined ? ed.sources : block.sources, ...(block !== undefined && needsDisclosure(block.basis) ? { basis: block.basis, disclosure: block.disclosure ?? '' } : {}) });
  },
  estimateSeconds: (_doc, profile) => (profile === 'preview' ? 1 : 5),
  check(doc) { return objs(doc.layers).length === 0 ? [{ level: 'error', message: 'The image has no layers yet' }] : []; },
};
