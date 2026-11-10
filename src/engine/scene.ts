// SVG scene graph shared by the still-image and video pipelines: layers → SVG → raster (rsvg-convert).
// Layers: image (crop/scale/rotate/opacity/filters), text (font/size/colour/alignment/wrapping), shape, gradient, redaction.
// Any numeric layer property can be keyframed for motion graphics (`keyframes: [{ t, props, ease? }]`).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { clamp, fontFamily, loadFont, measurer, rng, run, sha256, wrapText, xml } from './tools.ts';
import { arr, bool, fail, idOf, isObj, n, objs, str, uniqueIds } from './types.ts';
import type { Doc } from './types.ts';

export const LAYER_TYPES: readonly string[] = ['image', 'text', 'shape', 'gradient', 'redaction'];
const NAMED = ['black', 'white', 'red', 'green', 'blue', 'gray', 'grey', 'yellow', 'orange', 'purple', 'none', 'transparent'];
export function color(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) || NAMED.includes(s.toLowerCase()) || /^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+\s*)?\)$/.test(s) ? s : fallback;
}
function stops(v: unknown): { offset: number; color: string }[] {
  const out = objs(v).map((s) => ({ offset: n(s.offset, 0, 0, 1), color: color(s.color, '#000000') }));
  return out.length >= 2 ? out : [{ offset: 0, color: '#1b2a41' }, { offset: 1, color: '#324a5f' }];
}
function gradientSpec(v: unknown): Doc { const g = isObj(v) ? v : {}; return { type: g.type === 'radial' ? 'radial' : 'linear', angle: n(g.angle, 90, -360, 360), stops: stops(g.stops) }; }

/** Normalises one layer; unknown properties are dropped so documents stay data, never markup. */
export function normalizeLayer(raw: unknown, canvas: { width: number; height: number }): Doc {
  invariant(isObj(raw), 'invalid_input', 'Layer must be an object');
  const type = str(raw.type); invariant(LAYER_TYPES.includes(type), 'invalid_input', `Unknown layer type ${type}`);
  const base: Doc = {
    id: idOf(raw.id, 'layer'), type, ...(typeof raw.name === 'string' ? { name: raw.name.slice(0, 120) } : {}), ...(typeof raw.group === 'string' ? { group: raw.group.slice(0, 64) } : {}),
    visible: bool(raw.visible, true), x: n(raw.x, 0, -1e5, 1e5), y: n(raw.y, 0, -1e5, 1e5),
    width: n(raw.width, canvas.width, 0, 1e5), height: n(raw.height, type === 'text' ? 0 : canvas.height, 0, 1e5),
    opacity: n(raw.opacity, 1, 0, 1), rotate: n(raw.rotate, 0, -3600, 3600),
  };
  if (Array.isArray(raw.keyframes)) {
    base.keyframes = objs(raw.keyframes).map((k) => ({ t: n(k.t, 0, 0, 86400), ease: ['linear', 'in', 'out', 'inout'].includes(str(k.ease)) ? str(k.ease) : 'inout', props: Object.fromEntries(Object.entries(isObj(k.props) ? k.props : {}).filter(([key, v]) => typeof v === 'number' && Number.isFinite(v) && ['x', 'y', 'width', 'height', 'opacity', 'rotate', 'size', 'reveal', 'scale'].includes(key))) as Doc })).sort((a, b) => (a.t as number) - (b.t as number));
  }
  if (type === 'image') {
    invariant(typeof raw.assetId === 'string' && raw.assetId !== '', 'invalid_input', 'Image layer needs assetId');
    const crop = isObj(raw.crop) ? { x: n(raw.crop.x, 0, 0, 1e6), y: n(raw.crop.y, 0, 0, 1e6), width: n(raw.crop.width, 0, 1, 1e6), height: n(raw.crop.height, 0, 1, 1e6) } : null;
    const f = isObj(raw.filters) ? raw.filters : {};
    return { ...base, assetId: raw.assetId, ...(typeof raw.assetVersion === 'number' ? { assetVersion: raw.assetVersion } : {}), ...(typeof raw.page === 'number' ? { page: n(raw.page, 1, 1, 10000) } : {}),
      fit: ['cover', 'contain', 'stretch'].includes(str(raw.fit)) ? str(raw.fit) : 'cover', ...(crop === null ? {} : { crop }), scale: n(raw.scale, 1, 0.01, 100),
      filters: { grayscale: n(f.grayscale, 0, 0, 1), sepia: n(f.sepia, 0, 0, 1), blur: n(f.blur, 0, 0, 200), brightness: n(f.brightness, 1, 0, 5), contrast: n(f.contrast, 1, 0, 5), saturate: n(f.saturate, 1, 0, 5) } };
  }
  if (type === 'text') {
    const bg = isObj(raw.background) ? { color: color(raw.background.color, '#000000'), padding: n(raw.background.padding, 12, 0, 500), radius: n(raw.background.radius, 0, 0, 500), opacity: n(raw.background.opacity, 1, 0, 1) } : null;
    return { ...base, text: str(raw.text, '', 20000), font: fontFamily(raw.font), size: n(raw.size, 32, 4, 2000), color: color(raw.color, '#111111'),
      align: ['left', 'center', 'right'].includes(str(raw.align)) ? str(raw.align) : 'left', bold: bool(raw.bold), italic: bool(raw.italic), wrap: bool(raw.wrap, true),
      lineHeight: n(raw.lineHeight, 1.25, 0.8, 4), letterSpacing: n(raw.letterSpacing, 0, -20, 200), ...(typeof raw.maxLines === 'number' ? { maxLines: n(raw.maxLines, 1, 1, 500) } : {}),
      ...(bg === null ? {} : { background: bg }), ...(typeof raw.uppercase === 'boolean' ? { uppercase: raw.uppercase } : {}), reveal: n(raw.reveal, 1, 0, 1) };
  }
  if (type === 'shape') {
    const shape = ['rect', 'ellipse', 'line', 'polygon', 'path'].includes(str(raw.shape)) ? str(raw.shape) : 'rect';
    const points = arr(raw.points).filter((p) => Array.isArray(p) && p.length === 2 && p.every((c) => typeof c === 'number' && Number.isFinite(c))).slice(0, 2000);
    const d = str(raw.d, '', 20000); invariant(/^[MmLlHhVvCcSsQqTtAaZz0-9eE\s,.+-]*$/.test(d), 'invalid_input', 'Invalid path data');
    return { ...base, shape, fill: color(raw.fill, shape === 'line' ? 'none' : '#cccccc'), stroke: color(raw.stroke, shape === 'line' ? '#111111' : 'none'), strokeWidth: n(raw.strokeWidth, shape === 'line' ? 2 : 0, 0, 500), radius: n(raw.radius, 0, 0, 1e4),
      ...(points.length > 0 ? { points } : {}), ...(d === '' ? {} : { d }), ...(isObj(raw.gradient) ? { gradient: gradientSpec(raw.gradient) } : {}), ...(typeof raw.dash === 'number' ? { dash: n(raw.dash, 0, 0, 500) } : {}) };
  }
  if (type === 'gradient') return { ...base, gradient: gradientSpec(raw.gradient) };
  return { ...base, label: str(raw.label, '', 80), fill: '#000000', opacity: 1, rotate: 0 }; // redaction: always opaque black
}
export type Scene = { width: number; height: number; background: Json; layers: Doc[] };
export function normalizeScene(raw: unknown, limits = { max: 8192 }): Scene {
  const s = isObj(raw) ? raw : {};
  const width = Math.round(n(s.width, 1280, 16, limits.max)), height = Math.round(n(s.height, 720, 16, limits.max));
  const background = isObj(s.background) ? { gradient: gradientSpec(s.background.gradient) } : s.background === 'transparent' ? 'transparent' : color(s.background, '#ffffff');
  const layers = arr(s.layers).map((l) => normalizeLayer(l, { width, height }));
  invariant(layers.length <= 500, 'invalid_input', 'Too many layers');
  uniqueIds(layers, 'layer');
  return { width, height, background, layers };
}

// ───────────────────────────── keyframes ─────────────────────────────
const EASE: Readonly<Record<string, (u: number) => number>> = { linear: (u) => u, in: (u) => u * u, out: (u) => 1 - (1 - u) * (1 - u), inout: (u) => (u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) ** 2) / 2) };
/** Resolves keyframed properties of every layer at time t (seconds). Layers without keyframes are returned unchanged. */
export function sceneAt(scene: Scene, t: number): Scene {
  return { ...scene, layers: scene.layers.map((layer) => {
    const kfs = objs(layer.keyframes); if (kfs.length === 0) return layer;
    const out: Doc = { ...layer }; delete out.keyframes;
    const keys = new Set(kfs.flatMap((k) => Object.keys(k.props as Doc)));
    for (const key of keys) {
      const ks = kfs.filter((k) => typeof (k.props as Doc)[key] === 'number');
      const first = ks[0] as Doc, last = ks[ks.length - 1] as Doc;
      let v: number;
      if (t <= (first.t as number)) v = (first.props as Doc)[key] as number;
      else if (t >= (last.t as number)) v = (last.props as Doc)[key] as number;
      else {
        const i = ks.findIndex((k) => (k.t as number) > t); const a = ks[i - 1] as Doc, b = ks[i] as Doc;
        const u = (t - (a.t as number)) / Math.max(1e-9, (b.t as number) - (a.t as number));
        const e = (EASE[str(b.ease)] ?? EASE.inout as (u: number) => number)(u);
        v = ((a.props as Doc)[key] as number) + (((b.props as Doc)[key] as number) - ((a.props as Doc)[key] as number)) * e;
      }
      out[key] = Math.round(v * 1000) / 1000;
    }
    return out;
  }) };
}
export const sceneHasMotion = (scene: Scene): boolean => scene.layers.some((l) => objs(l.keyframes).length > 1);
export function sceneMotionEnd(scene: Scene): number { return Math.max(0, ...scene.layers.flatMap((l) => objs(l.keyframes).map((k) => k.t as number))); }

// ───────────────────────────── text layout ─────────────────────────────
export type TextLayout = { lines: string[]; lineHeight: number; height: number; ascent: number; widths: number[] };
export async function layoutText(layer: Doc): Promise<TextLayout> {
  const size = layer.size as number; const bold = layer.bold === true, italic = layer.italic === true;
  const measure0 = await measurer(str(layer.font), size, bold, italic);
  const spacing = n(layer.letterSpacing, 0);
  const measure = (t: string): number => measure0(t) + spacing * [...t].length;
  let text = str(layer.text); if (layer.uppercase === true) text = text.toUpperCase();
  let lines = layer.wrap === false || (layer.width as number) <= 0 ? text.split('\n') : wrapText(text, layer.width as number, measure);
  if (typeof layer.maxLines === 'number' && lines.length > layer.maxLines) { lines = lines.slice(0, layer.maxLines); const li = lines.length - 1; let l = lines[li] as string; while (l.length > 1 && measure(`${l}…`) > (layer.width as number)) l = l.slice(0, -1); lines[li] = `${l.trimEnd()}…`; }
  const reveal = n(layer.reveal, 1, 0, 1);
  if (reveal < 1) { let budget = Math.round(lines.join('').length * reveal); lines = lines.map((l) => { const take = Math.min(l.length, budget); budget -= take; return l.slice(0, take); }); }
  const font = await loadFont(str(layer.font), bold, italic);
  const ascent = font === null ? size * 0.93 : (font.ascent / font.unitsPerEm) * size;
  const lineHeight = size * (layer.lineHeight as number);
  return { lines, lineHeight, height: lines.length * lineHeight, ascent, widths: lines.map(measure) };
}

// ───────────────────────────── SVG generation ─────────────────────────────
export type ImageResolver = (layer: Doc, target: { width: number; height: number }) => Promise<{ href: string; width: number; height: number }>;
function gradientDef(id: string, g: Doc): string {
  const st = objs(g.stops).map((s) => `<stop offset="${s.offset}" stop-color="${xml(s.color)}"/>`).join('');
  if (g.type === 'radial') return `<radialGradient id="${id}" cx="50%" cy="50%" r="70%">${st}</radialGradient>`;
  const a = ((g.angle as number) * Math.PI) / 180; const dx = Math.cos(a) / 2, dy = Math.sin(a) / 2;
  return `<linearGradient id="${id}" x1="${(0.5 - dx).toFixed(4)}" y1="${(0.5 - dy).toFixed(4)}" x2="${(0.5 + dx).toFixed(4)}" y2="${(0.5 + dy).toFixed(4)}">${st}</linearGradient>`;
}
function filterDef(id: string, f: Doc): string {
  const parts: string[] = [];
  const g = f.grayscale as number, s = f.sepia as number, sat = f.saturate as number, br = f.brightness as number, co = f.contrast as number, blur = f.blur as number;
  if (g > 0) parts.push(`<feColorMatrix type="saturate" values="${(1 - g).toFixed(3)}"/>`);
  if (sat !== 1) parts.push(`<feColorMatrix type="saturate" values="${sat.toFixed(3)}"/>`);
  if (s > 0) { const m = (a: number, b: number): string => (a + (b - a) * s).toFixed(4); parts.push(`<feColorMatrix type="matrix" values="${m(1, 0.393)} ${m(0, 0.769)} ${m(0, 0.189)} 0 0 ${m(0, 0.349)} ${m(1, 0.686)} ${m(0, 0.168)} 0 0 ${m(0, 0.272)} ${m(0, 0.534)} ${m(1, 0.131)} 0 0 0 0 0 1 0"/>`); }
  if (br !== 1 || co !== 1) { const slope = (br * co).toFixed(4), intercept = ((1 - co) / 2).toFixed(4); parts.push(`<feComponentTransfer><feFuncR type="linear" slope="${slope}" intercept="${intercept}"/><feFuncG type="linear" slope="${slope}" intercept="${intercept}"/><feFuncB type="linear" slope="${slope}" intercept="${intercept}"/></feComponentTransfer>`); }
  if (blur > 0) parts.push(`<feGaussianBlur stdDeviation="${blur}"/>`);
  return parts.length === 0 ? '' : `<filter id="${id}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">${parts.join('')}</filter>`;
}
/** Renders the scene (or a slice of its layers) to a standalone SVG string. */
export async function sceneToSvg(scene: Scene, resolveImage: ImageResolver, options: { from?: number; to?: number; background?: boolean; prepend?: string } = {}): Promise<string> {
  const defs: string[] = [], body: string[] = [];
  const { width: W, height: H } = scene;
  if (options.background !== false && scene.background !== 'transparent') {
    if (isObj(scene.background)) { defs.push(gradientDef('bg', scene.background.gradient as Doc)); body.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`); }
    else body.push(`<rect width="${W}" height="${H}" fill="${xml(scene.background)}"/>`);
  }
  if (options.prepend !== undefined) body.push(options.prepend);
  const layers = scene.layers.slice(options.from ?? 0, options.to ?? scene.layers.length);
  for (const [i, layer] of layers.entries()) {
    if (layer.visible === false || (layer.opacity as number) <= 0) continue;
    let { x, y, width: w, height: h } = layer as { x: number; y: number; width: number; height: number };
    const sc = n(layer.scale, 1);
    if (sc !== 1 && layer.type !== 'image') { x += (w * (1 - sc)) / 2; y += (h * (1 - sc)) / 2; w *= sc; h *= sc; }
    const uid = `l${i}`; let inner = '';
    if (layer.type === 'image') {
      const iw = w * sc, ih = h * sc, ix = x + (w - iw) / 2, iy = y + (h - ih) / 2;
      const img = await resolveImage(layer, { width: Math.max(1, Math.round(iw)), height: Math.max(1, Math.round(ih)) });
      const fd = filterDef(`f${uid}`, layer.filters as Doc); if (fd !== '') defs.push(fd);
      let dx = ix, dy = iy, dw = iw, dh = ih;
      if (layer.fit === 'contain') { const r = Math.min(iw / img.width, ih / img.height); dw = img.width * r; dh = img.height * r; dx = ix + (iw - dw) / 2; dy = iy + (ih - dh) / 2; }
      inner = `<image x="${dx.toFixed(2)}" y="${dy.toFixed(2)}" width="${dw.toFixed(2)}" height="${dh.toFixed(2)}" preserveAspectRatio="none" href="${img.href}"${fd === '' ? '' : ` filter="url(#f${uid})"`}/>`;
      x = ix; y = iy; w = iw; h = ih;
    } else if (layer.type === 'text') {
      const lt = await layoutText(sc === 1 ? layer : { ...layer, size: (layer.size as number) * sc, width: w });
      h = Math.max(h, lt.height);
      const anchor = layer.align === 'center' ? 'middle' : layer.align === 'right' ? 'end' : 'start';
      const tx = layer.align === 'center' ? x + w / 2 : layer.align === 'right' ? x + w : x;
      if (isObj(layer.background) && lt.lines.some((l) => l !== '')) {
        const p = layer.background.padding as number; const tw = Math.max(...lt.widths, 1);
        const bx = layer.align === 'center' ? x + w / 2 - tw / 2 : layer.align === 'right' ? x + w - tw : x;
        inner += `<rect x="${(bx - p).toFixed(2)}" y="${(y - p).toFixed(2)}" width="${(tw + 2 * p).toFixed(2)}" height="${(lt.height + 2 * p).toFixed(2)}" rx="${layer.background.radius}" fill="${xml(layer.background.color)}" fill-opacity="${layer.background.opacity}"/>`;
      }
      const size = (layer.size as number) * sc;
      inner += `<text font-family="${xml(layer.font)}" font-size="${size.toFixed(2)}" fill="${xml(layer.color)}" text-anchor="${anchor}"${layer.bold === true ? ' font-weight="bold"' : ''}${layer.italic === true ? ' font-style="italic"' : ''}${(layer.letterSpacing as number) !== 0 ? ` letter-spacing="${layer.letterSpacing}"` : ''} xml:space="preserve">${lt.lines.map((l, li) => `<tspan x="${tx.toFixed(2)}" y="${(y + lt.ascent + (lt.lineHeight - size) / 2 + li * lt.lineHeight).toFixed(2)}">${xml(l)}</tspan>`).join('')}</text>`;
    } else if (layer.type === 'shape') {
      let fill = xml(layer.fill);
      if (isObj(layer.gradient)) { defs.push(gradientDef(`g${uid}`, layer.gradient)); fill = `url(#g${uid})`; }
      const paint = `fill="${fill}" stroke="${xml(layer.stroke)}" stroke-width="${layer.strokeWidth}"${typeof layer.dash === 'number' && layer.dash > 0 ? ` stroke-dasharray="${layer.dash}"` : ''}`;
      if (layer.shape === 'ellipse') inner = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${paint}/>`;
      else if (layer.shape === 'line') inner = `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" ${paint} stroke-linecap="round"/>`;
      else if (layer.shape === 'polygon') inner = `<polygon points="${arr(layer.points).map((p) => `${x + ((p as number[])[0] as number)},${y + ((p as number[])[1] as number)}`).join(' ')}" ${paint}/>`;
      else if (layer.shape === 'path') inner = `<path transform="translate(${x} ${y})" d="${xml(layer.d ?? '')}" ${paint}/>`;
      else inner = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${layer.radius}" ${paint}/>`;
    } else if (layer.type === 'gradient') {
      defs.push(gradientDef(`g${uid}`, layer.gradient as Doc));
      inner = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#g${uid})"/>`;
    } else {
      inner = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000000"/>`;
      if (str(layer.label) !== '' && h >= 14) { const fs = clamp(h * 0.45, 9, 28); inner += `<text x="${x + w / 2}" y="${y + h / 2 + fs * 0.35}" font-family="DejaVu Sans" font-size="${fs.toFixed(1)}" fill="#ffffff" text-anchor="middle">${xml(layer.label)}</text>`; }
    }
    const rot = layer.rotate as number;
    body.push(`<g${(layer.opacity as number) < 1 ? ` opacity="${layer.opacity}"` : ''}${rot !== 0 ? ` transform="rotate(${rot} ${(x + w / 2).toFixed(2)} ${(y + h / 2).toFixed(2)})"` : ''}>${inner}</g>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs.length > 0 ? `<defs>${defs.join('')}</defs>` : ''}${body.join('')}</svg>\n`;
}
/** Rasterises SVG text to a PNG file with rsvg-convert at an output width (aspect preserved). */
export async function rasterize(svg: string, outPath: string, width: number, signal?: AbortSignal, background?: string): Promise<void> {
  await run('rsvg-convert', ['--format', 'png', '--width', String(Math.max(1, Math.round(width))), '--keep-aspect-ratio', ...(background === undefined ? [] : ['--background-color', background]), '--output', outPath], { input: svg, timeoutMs: 120_000, ...(signal === undefined ? {} : { signal }) });
}
/**
 * Builds an image resolver over materialised asset files: crops/resizes with ImageMagick and embeds the pixels as a data
 * URI, so the SVG has no external references and cropped-away pixels are never shipped.
 */
export function imageResolver(dir: string, assetPath: (assetId: string, version?: number) => Promise<{ path: string; mediaType: string; sha256: string }>, signal?: AbortSignal, quality = 1): ImageResolver {
  const cache = new Map<string, { href: string; width: number; height: number }>();
  return async (layer, target) => {
    const a = await assetPath(layer.assetId as string, typeof layer.assetVersion === 'number' ? layer.assetVersion : undefined);
    invariant(a.mediaType.startsWith('image/') || a.mediaType === 'application/pdf', 'invalid_input', `Asset ${String(layer.assetId)} is not an image`);
    const crop = isObj(layer.crop) ? layer.crop : null;
    const key = sha256(JSON.stringify([a.sha256, crop, layer.fit, layer.page ?? 1, target, quality]));
    const hit = cache.get(key); if (hit !== undefined) return hit;
    let src = a.path;
    if (a.mediaType === 'application/pdf') {
      const page = String(n(layer.page, 1)); const base = join(dir, `pdf-${key.slice(0, 16)}`);
      await run('pdftoppm', ['-f', page, '-l', page, '-r', '150', '-png', '-singlefile', a.path, base], { timeoutMs: 120_000, ...(signal === undefined ? {} : { signal }) });
      src = `${base}.png`;
    } else if (a.mediaType === 'image/svg+xml') { src = join(dir, `svg-${key.slice(0, 16)}.png`); await rasterize(await readFile(a.path, 'utf8'), src, Math.max(target.width * 2, 64), signal); }
    const dim = (await run('identify', ['-format', '%w %h %[channels]', `${src}[0]`], { timeoutMs: 60_000 })).stdout.trim().split(' ');
    const sw = Number(dim[0]), sh = Number(dim[1]); const alpha = (dim[2] ?? '').includes('a');
    let cx = 0, cy = 0, cw = sw, ch = sh;
    if (crop !== null) { cx = clamp(Math.round(crop.x as number), 0, sw - 1); cy = clamp(Math.round(crop.y as number), 0, sh - 1); cw = clamp(Math.round(crop.width as number), 1, sw - cx); ch = clamp(Math.round(crop.height as number), 1, sh - cy); }
    if (layer.fit === 'cover') { const ta = target.width / target.height; if (cw / ch > ta) { const nw = Math.max(1, Math.round(ch * ta)); cx += Math.round((cw - nw) / 2); cw = nw; } else { const nh = Math.max(1, Math.round(cw / ta)); cy += Math.round((ch - nh) / 2); ch = nh; } }
    const scale = Math.min(1, (layer.fit === 'contain' ? Math.min((target.width * 2) / cw, (target.height * 2) / ch) : Math.max((target.width * 2) / cw, (target.height * 2) / ch)) * quality);
    const ow = Math.max(1, Math.round(cw * scale)), oh = Math.max(1, Math.round(ch * scale));
    const fmt = alpha || a.mediaType !== 'image/jpeg' ? 'png' : 'jpg'; const out = join(dir, `img-${key.slice(0, 20)}.${fmt}`);
    await run('convert', [`${src}[0]`, '-auto-orient', '-crop', `${cw}x${ch}+${cx}+${cy}`, '+repage', '-resize', `${ow}x${oh}!`, '-strip', ...(fmt === 'jpg' ? ['-quality', '90'] : []), out], { timeoutMs: 120_000, ...(signal === undefined ? {} : { signal }) });
    const res = { href: `data:image/${fmt === 'jpg' ? 'jpeg' : 'png'};base64,${(await readFile(out)).toString('base64')}`, width: ow, height: oh };
    cache.set(key, res);
    return res;
  };
}
export async function writeSvg(path: string, svg: string): Promise<void> { await writeFile(path, svg, 'utf8'); }

// ───────────────────────────── procedural generators ─────────────────────────────
// Each generator returns layers (tagged with `group`) composed from project content; output is deterministic for a seed.
type Gen = (params: Doc, canvas: { width: number; height: number }, group: string) => Promise<Doc[]>;
const PALETTES: readonly (readonly string[])[] = [
  ['#0b132b', '#1c2541', '#3a506b', '#5bc0be', '#f4f4f9'], ['#2b2d42', '#8d99ae', '#edf2f4', '#ef233c', '#d90429'],
  ['#1b4332', '#2d6a4f', '#52b788', '#d8f3dc', '#081c15'], ['#3d2c2e', '#7d4f50', '#cc8b86', '#f9eae1', '#d1be9c'],
  ['#14213d', '#fca311', '#e5e5e5', '#ffffff', '#000000'], ['#22223b', '#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4'],
];
async function textBlock(id: string, group: string, props: Doc): Promise<{ layer: Doc; height: number }> {
  const layer: Doc = { id, group, type: 'text', visible: true, opacity: 1, rotate: 0, height: 0, font: 'DejaVu Sans', size: 32, color: '#111111', align: 'left', bold: false, italic: false, wrap: true, lineHeight: 1.25, letterSpacing: 0, reveal: 1, x: 0, y: 0, width: 100, text: '', ...props };
  return { layer, height: (await layoutText(layer)).height };
}
const shape = (id: string, group: string, props: Doc): Doc => ({ id, group, type: 'shape', shape: 'rect', visible: true, opacity: 1, rotate: 0, fill: '#cccccc', stroke: 'none', strokeWidth: 0, radius: 0, x: 0, y: 0, width: 10, height: 10, ...props });

const timeline: Gen = async (p, c, g) => {
  const events = objs(p.events).slice(0, 12); invariant(events.length >= 2, 'invalid_input', 'timeline generator needs at least two events');
  const pal = PALETTES[0] as readonly string[]; const m = Math.round(c.width * 0.06); const layers: Doc[] = [];
  layers.push({ id: `${g}-bg`, group: g, type: 'gradient', visible: true, opacity: 1, rotate: 0, x: 0, y: 0, width: c.width, height: c.height, gradient: { type: 'linear', angle: 90, stops: [{ offset: 0, color: pal[0] as string }, { offset: 1, color: pal[1] as string }] } });
  const title = await textBlock(`${g}-title`, g, { text: str(p.title, 'Timeline'), x: m, y: m, width: c.width - 2 * m, size: Math.round(c.height * 0.06), bold: true, color: pal[4] as string });
  layers.push(title.layer);
  const axisY = Math.round(c.height * 0.5); const x0 = m * 1.5, x1 = c.width - m * 1.5;
  layers.push(shape(`${g}-axis`, g, { shape: 'line', x: x0, y: axisY, width: x1 - x0, height: 0, stroke: pal[3] as string, strokeWidth: Math.max(3, c.height * 0.006), fill: 'none' }));
  // Position by real dates when every event has a parseable one; otherwise evenly.
  const times = events.map((e) => Date.parse(str(e.date))); const dated = times.every((t) => Number.isFinite(t)) && Math.max(...times) > Math.min(...times);
  const tmin = Math.min(...times), tmax = Math.max(...times); const colW = (x1 - x0) / events.length;
  for (const [i, e] of events.entries()) {
    const fx = dated ? ((times[i] as number) - tmin) / (tmax - tmin) : i / (events.length - 1);
    const cx = x0 + fx * (x1 - x0); const up = i % 2 === 0; const r = Math.max(8, c.height * 0.016);
    layers.push(shape(`${g}-dot-${i}`, g, { shape: 'ellipse', x: cx - r, y: axisY - r, width: 2 * r, height: 2 * r, fill: pal[4] as string, stroke: pal[3] as string, strokeWidth: 3 }));
    const stem = c.height * (0.08 + (i % 4 >= 2 ? 0.1 : 0));
    layers.push(shape(`${g}-stem-${i}`, g, { shape: 'line', x: cx, y: up ? axisY - r - stem : axisY + r, width: 0, height: stem, stroke: pal[2] as string, strokeWidth: 2, fill: 'none' }));
    const bw = Math.min(colW * 1.7, c.width * 0.26); const bx = clamp(cx - bw / 2, m / 2, c.width - bw - m / 2);
    const date = await textBlock(`${g}-date-${i}`, g, { text: str(e.date), x: bx, width: bw, size: Math.round(c.height * 0.026), bold: true, color: pal[3] as string, align: 'center' });
    const label = await textBlock(`${g}-label-${i}`, g, { text: str(e.label), x: bx, width: bw, size: Math.round(c.height * 0.026), color: pal[4] as string, align: 'center', maxLines: 4 });
    const total = date.height + label.height + 4; const top = up ? axisY - r - stem - total - 6 : axisY + r + stem + 6;
    date.layer.y = top; label.layer.y = top + date.height + 4; layers.push(date.layer, label.layer);
  }
  if (str(p.caption) !== '') layers.push((await textBlock(`${g}-caption`, g, { text: str(p.caption), x: m, y: c.height - m - c.height * 0.035, width: c.width - 2 * m, size: Math.round(c.height * 0.024), color: pal[2] as string === '#3a506b' ? '#c5d1de' : '#cccccc', italic: true })).layer);
  return layers;
};
const quoteCard: Gen = async (p, c, g) => {
  const quote = str(p.quote); invariant(quote.trim() !== '', 'invalid_input', 'quote generator needs quote text');
  const pal = PALETTES[5] as readonly string[]; const m = Math.round(c.width * 0.09); const layers: Doc[] = [];
  layers.push(shape(`${g}-bg`, g, { x: 0, y: 0, width: c.width, height: c.height, fill: pal[4] as string }));
  layers.push(shape(`${g}-bar`, g, { x: m * 0.55, y: m, width: Math.max(6, c.width * 0.008), height: c.height - 2 * m, fill: pal[0] as string }));
  layers.push((await textBlock(`${g}-mark`, g, { text: '“', x: m, y: m * 0.4, width: c.width * 0.3, size: Math.round(c.height * 0.3), font: 'DejaVu Serif', color: pal[3] as string, wrap: false })).layer);
  let size = Math.round(c.height * 0.085); let q = await textBlock(`${g}-quote`, g, { text: quote, x: m, width: c.width - 2 * m, size, font: 'DejaVu Serif', color: pal[0] as string, lineHeight: 1.3 });
  while (q.height > c.height * 0.52 && size > 14) { size = Math.round(size * 0.9); q = await textBlock(`${g}-quote`, g, { text: quote, x: m, width: c.width - 2 * m, size, font: 'DejaVu Serif', color: pal[0] as string, lineHeight: 1.3 }); }
  q.layer.y = Math.round(c.height * 0.24); layers.push(q.layer);
  let y = (q.layer.y as number) + q.height + c.height * 0.04;
  if (str(p.attribution) !== '') { const a = await textBlock(`${g}-attr`, g, { text: `— ${str(p.attribution)}`, x: m, y, width: c.width - 2 * m, size: Math.round(c.height * 0.042), bold: true, color: pal[1] as string }); layers.push(a.layer); y += a.height + 8; }
  if (str(p.basis) !== '') layers.push((await textBlock(`${g}-basis`, g, { text: str(p.basis).toUpperCase(), x: m, y: c.height - m * 0.8, width: c.width - 2 * m, size: Math.round(c.height * 0.028), color: '#ffffff', bold: true, wrap: false, background: { color: '#9d0208', padding: 8, radius: 4, opacity: 1 } })).layer);
  if (str(p.source) !== '') layers.push((await textBlock(`${g}-source`, g, { text: str(p.source), x: m, y: c.height - m * 0.8, width: c.width - 2 * m, size: Math.round(c.height * 0.026), color: pal[2] as string, align: 'right', wrap: false })).layer);
  return layers;
};
const locationCard: Gen = async (p, c, g) => {
  const place = str(p.place); invariant(place.trim() !== '', 'invalid_input', 'location generator needs a place');
  const pal = PALETTES[2] as readonly string[]; const m = Math.round(c.width * 0.07); const layers: Doc[] = []; const rand = rng(`loc:${place}:${str(p.seed)}`);
  layers.push({ id: `${g}-bg`, group: g, type: 'gradient', visible: true, opacity: 1, rotate: 0, x: 0, y: 0, width: c.width, height: c.height, gradient: { type: 'linear', angle: 60, stops: [{ offset: 0, color: pal[4] as string }, { offset: 1, color: pal[0] as string }] } });
  // Abstract contour rings (not a map): concentric offset ellipses seeded by the place name.
  const cx = c.width * (0.62 + rand() * 0.2), cy = c.height * (0.3 + rand() * 0.3);
  for (let i = 0; i < 7; i++) { const r = c.height * (0.08 + i * 0.075); layers.push(shape(`${g}-ring-${i}`, g, { shape: 'ellipse', x: cx - r * (1.2 + rand() * 0.3), y: cy - r, width: r * (2.4 + rand() * 0.6), height: 2 * r, fill: 'none', stroke: pal[2] as string, strokeWidth: 1.5, opacity: 0.55 - i * 0.05, rotate: Math.round(rand() * 30 - 15) })); }
  const pr = c.height * 0.022; layers.push(shape(`${g}-pin`, g, { shape: 'ellipse', x: cx - pr, y: cy - pr, width: 2 * pr, height: 2 * pr, fill: '#ffffff', stroke: pal[2] as string, strokeWidth: 4 }));
  layers.push((await textBlock(`${g}-kicker`, g, { text: str(p.kicker, 'LOCATION').toUpperCase(), x: m, y: c.height * 0.52, width: c.width * 0.6, size: Math.round(c.height * 0.032), bold: true, color: pal[2] as string, letterSpacing: 3 })).layer);
  const t = await textBlock(`${g}-place`, g, { text: place, x: m, y: c.height * 0.57, width: c.width - 2 * m, size: Math.round(c.height * 0.1), bold: true, color: '#ffffff', lineHeight: 1.1 }); layers.push(t.layer);
  let y = c.height * 0.57 + t.height + c.height * 0.015;
  for (const [key, text] of [['region', str(p.region)], ['coords', str(p.coordinates)], ['caption', str(p.caption)]] as const) {
    if (text === '') continue;
    const b = await textBlock(`${g}-${key}`, g, { text, x: m, y, width: c.width - 2 * m, size: Math.round(c.height * (key === 'caption' ? 0.03 : 0.036)), color: pal[3] as string, italic: key === 'caption', font: key === 'coords' ? 'DejaVu Sans Mono' : 'DejaVu Sans' }); layers.push(b.layer); y += b.height + 6;
  }
  return layers;
};
const documentExcerpt: Gen = async (p, c, g) => {
  invariant(typeof p.assetId === 'string' && isObj(p.region), 'invalid_input', 'documentExcerpt generator needs assetId and region {x,y,width,height} in source pixels');
  const region = p.region; const m = Math.round(c.width * 0.05); const layers: Doc[] = [];
  layers.push(shape(`${g}-bg`, g, { x: 0, y: 0, width: c.width, height: c.height, fill: '#22223b' }));
  const head = await textBlock(`${g}-head`, g, { text: str(p.title, 'From the record'), x: m, y: m * 0.8, width: c.width - 2 * m, size: Math.round(c.height * 0.045), bold: true, color: '#f2e9e4' }); layers.push(head.layer);
  const top = m * 0.8 + head.height + m * 0.4; const captionH = c.height * 0.2; const boxH = c.height - top - captionH - m * 0.4; const boxW = c.width - 2 * m;
  const ra = n(region.width, 1, 1) / n(region.height, 1, 1); let iw = boxW, ih = boxW / ra; if (ih > boxH) { ih = boxH; iw = boxH * ra; }
  const ix = (c.width - iw) / 2, iy = top + (boxH - ih) / 2;
  layers.push(shape(`${g}-paper`, g, { x: ix - 10, y: iy - 10, width: iw + 20, height: ih + 20, fill: '#ffffff', radius: 4 }));
  layers.push({ id: `${g}-excerpt`, group: g, type: 'image', visible: true, opacity: 1, rotate: 0, x: ix, y: iy, width: iw, height: ih, assetId: p.assetId, ...(typeof p.assetVersion === 'number' ? { assetVersion: p.assetVersion } : {}), ...(typeof p.page === 'number' ? { page: p.page } : {}), fit: 'stretch', scale: 1, crop: { x: n(region.x, 0), y: n(region.y, 0), width: n(region.width, 1, 1), height: n(region.height, 1, 1) }, filters: { grayscale: 0, sepia: 0, blur: 0, brightness: 1, contrast: 1, saturate: 1 } });
  if (isObj(p.highlight)) { const hx = n(p.highlight.x, 0) - n(region.x, 0), hy = n(p.highlight.y, 0) - n(region.y, 0); const k = iw / n(region.width, 1, 1); layers.push(shape(`${g}-highlight`, g, { x: ix + hx * k, y: iy + hy * k, width: n(p.highlight.width, 1) * k, height: n(p.highlight.height, 1) * k, fill: '#ffd60a', opacity: 0.35 })); }
  for (const [i, r] of objs(p.redactions).entries()) { const k = iw / n(region.width, 1, 1); layers.push({ id: `${g}-redact-${i}`, group: g, type: 'redaction', visible: true, opacity: 1, rotate: 0, x: ix + (n(r.x, 0) - n(region.x, 0)) * k, y: iy + (n(r.y, 0) - n(region.y, 0)) * k, width: n(r.width, 1) * k, height: n(r.height, 1) * k, label: str(r.label), fill: '#000000' }); }
  const cap = await textBlock(`${g}-caption`, g, { text: str(p.caption), x: m, y: c.height - captionH, width: c.width - 2 * m, size: Math.round(c.height * 0.034), color: '#f2e9e4' }); layers.push(cap.layer);
  if (str(p.sourceRef) !== '') layers.push((await textBlock(`${g}-source`, g, { text: `Source: ${str(p.sourceRef)}`, x: m, y: c.height - m * 0.9, width: c.width - 2 * m, size: Math.round(c.height * 0.022), color: '#9a8c98', font: 'DejaVu Sans Mono', wrap: false })).layer);
  return layers;
};
const coverArt: Gen = async (p, c, g) => {
  const title = str(p.title); invariant(title.trim() !== '', 'invalid_input', 'cover generator needs a title');
  const seedText = `${title}|${str(p.subtitle)}|${str(p.seedText)}|${str(p.seed)}`; const rand = rng(seedText);
  const pal = PALETTES[Math.floor(rand() * PALETTES.length)] as readonly string[]; const layers: Doc[] = []; const m = Math.round(c.width * 0.08);
  layers.push({ id: `${g}-bg`, group: g, type: 'gradient', visible: true, opacity: 1, rotate: 0, x: 0, y: 0, width: c.width, height: c.height, gradient: { type: 'linear', angle: Math.round(30 + rand() * 120), stops: [{ offset: 0, color: pal[0] as string }, { offset: 1, color: pal[1] as string }] } });
  // Geometric field: bars whose heights follow word lengths of the seed text, so the composition comes from the project content.
  const words = seedText.split(/\W+/).filter((w) => w !== '').slice(0, 40); const bw = (c.width - 2 * m) / Math.max(12, words.length);
  for (const [i, w] of words.entries()) { const h = c.height * (0.05 + (Math.min(w.length, 12) / 12) * 0.28) * (0.7 + rand() * 0.6); layers.push(shape(`${g}-bar-${i}`, g, { x: m + i * bw, y: c.height * 0.62 - h / 2, width: Math.max(2, bw * 0.62), height: h, fill: pal[2 + (i % 2)] as string, opacity: 0.35 + rand() * 0.5, radius: bw * 0.2 })); }
  for (let i = 0; i < 3; i++) { const r = c.width * (0.12 + rand() * 0.2); layers.push(shape(`${g}-disc-${i}`, g, { shape: 'ellipse', x: rand() * c.width - r, y: rand() * c.height * 0.5 - r * 0.3, width: 2 * r, height: 2 * r, fill: 'none', stroke: pal[3] as string, strokeWidth: 2 + rand() * 5, opacity: 0.25 + rand() * 0.3 })); }
  let size = Math.round(c.width * 0.11); let t = await textBlock(`${g}-title`, g, { text: title, x: m, width: c.width - 2 * m, size, bold: true, font: 'DejaVu Serif', color: '#ffffff', lineHeight: 1.08 });
  while (t.height > c.height * 0.36 && size > 16) { size = Math.round(size * 0.9); t = await textBlock(`${g}-title`, g, { text: title, x: m, width: c.width - 2 * m, size, bold: true, font: 'DejaVu Serif', color: '#ffffff', lineHeight: 1.08 }); }
  t.layer.y = Math.round(c.height * 0.1); layers.push(t.layer);
  if (str(p.subtitle) !== '') layers.push((await textBlock(`${g}-subtitle`, g, { text: str(p.subtitle), x: m, y: (t.layer.y as number) + t.height + c.height * 0.02, width: c.width - 2 * m, size: Math.round(c.width * 0.038), color: pal[3] === '#ffffff' ? '#e5e5e5' : pal[3] as string, italic: true })).layer);
  if (str(p.author) !== '') layers.push((await textBlock(`${g}-author`, g, { text: str(p.author), x: m, y: c.height - m - c.width * 0.04, width: c.width - 2 * m, size: Math.round(c.width * 0.04), color: '#ffffff', bold: true, letterSpacing: 2, uppercase: true })).layer);
  return layers;
};
export const GENERATORS: Readonly<Record<string, Gen>> = { timeline, quoteCard, locationCard, documentExcerpt, coverArt };
export async function generateLayers(generator: string, params: Doc, canvas: { width: number; height: number }, group: string): Promise<Doc[]> {
  const g = GENERATORS[generator]; if (g === undefined) return fail(`Unknown generator ${generator}; available: ${Object.keys(GENERATORS).join(', ')}`);
  return (await g(params, canvas, group)).map((l) => normalizeLayer(l, canvas));
}
