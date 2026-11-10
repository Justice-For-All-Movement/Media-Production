// Animation and video: a scene timeline assembled with ffmpeg filter graphs.
// Tracks: visual scenes (images with Ken Burns moves, trimmed video, title cards, keyframed motion graphics drawn
// frame by frame from the SVG scene graph), overlays (lower thirds, animated text), audio (narration, music, clips with
// gain/fades/ducking), captions (burned in and as SRT/WebVTT). Reconstruction/invention scenes get a mandatory
// disclosure card and an on-screen label; a credits roll is generated from the render's inputs.
import { link, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { clamp, ffmpeg, run, safeName, sha256 } from './tools.ts';
import { color, imageResolver, layoutText, normalizeLayer, normalizeScene, rasterize, sceneAt, sceneToSvg } from './scene.ts';
import type { ImageResolver, Scene } from './scene.ts';
import { SYNTHETIC_VOICE_NOTICE, normalizeLoudness, synthSpeech } from './audio.ts';
import { arr, basisLabel, bool, collectAssets, collectSources, collectText, disclosureText, idOf, isObj, n, needsDisclosure, objs, str, uniqueIds, urefs } from './types.ts';
import type { Disclosure, Doc, EditorialExport, Pipeline, PipelineResult, RenderEnv, RenderOutput } from './types.ts';

const VIDEO_VERSION = 'video/1';
function normOverlay(raw: Doc, i: number, size: { width: number; height: number }): Doc {
  const type = ['lowerThird', 'text', 'layer'].includes(str(raw.type)) ? str(raw.type) : 'text';
  const base: Doc = { id: typeof raw.id === 'string' ? idOf(raw.id, 'overlay') : `ov${i + 1}`, type, start: n(raw.start, 0, 0, 86400), ...(typeof raw.end === 'number' ? { end: n(raw.end, 0, 0, 86400) } : {}), animation: ['fade', 'slide', 'typewriter', 'none'].includes(str(raw.animation)) ? str(raw.animation) : 'fade' };
  if (type === 'lowerThird') return { ...base, title: str(raw.title, '', 200), subtitle: str(raw.subtitle, '', 300) };
  if (type === 'layer') return { ...base, layer: normalizeLayer(raw.layer, size) };
  return { ...base, text: str(raw.text, '', 2000), x: n(raw.x, size.width * 0.08), y: n(raw.y, size.height * 0.12), width: n(raw.width, size.width * 0.84, 10, 1e5), size: n(raw.size, Math.round(size.height * 0.06), 6, 1000), color: color(raw.color, '#ffffff'), align: ['left', 'center', 'right'].includes(str(raw.align)) ? str(raw.align) : 'left', bold: bool(raw.bold, true), ...(isObj(raw.background) ? { background: raw.background } : {}) };
}
function validate(raw: unknown): Doc {
  invariant(isObj(raw), 'invalid_input', 'Document must be an object');
  const width = Math.round(n(raw.width, 1280, 160, 3840) / 2) * 2, height = Math.round(n(raw.height, 720, 90, 2160) / 2) * 2; const size = { width, height };
  const scenes = objs(raw.scenes).map((s) => {
    const v = isObj(s.visual) ? s.visual : { type: 'title', title: str(s.title) }; const basis = str(s.basis, '', 40); let visual: Doc;
    if (v.type === 'image' || v.type === 'video') {
      invariant(typeof v.assetId === 'string' && v.assetId !== '', 'invalid_input', `Scene ${String(s.id)}: ${String(v.type)} visual needs assetId`);
      const kb = isObj(v.kenBurns) ? v.kenBurns : {}; const pt = (p: unknown, z: number): Doc => { const o = isObj(p) ? p : {}; return { x: n(o.x, 0.5, 0, 1), y: n(o.y, 0.5, 0, 1), zoom: n(o.zoom, z, 1, 4) }; };
      visual = v.type === 'image' ? { type: 'image', assetId: v.assetId, ...(typeof v.assetVersion === 'number' ? { assetVersion: v.assetVersion } : {}), kenBurns: { from: pt(kb.from, 1), to: pt(kb.to, 1.12) } } : { type: 'video', assetId: v.assetId, ...(typeof v.assetVersion === 'number' ? { assetVersion: v.assetVersion } : {}), trimStart: n(v.trimStart, 0, 0, 86400) };
    } else if (v.type === 'scene') { const sc = normalizeScene({ ...(isObj(v.scene) ? v.scene : {}), width, height }); visual = { type: 'scene', scene: { background: sc.background, layers: sc.layers } }; }
    else if (v.type === 'color') visual = { type: 'color', color: color(v.color, '#000000') };
    else visual = { type: 'title', title: str(v.title, '', 300), subtitle: str(v.subtitle, '', 600), background: color(v.background, '#14213d'), ...(v.placeholder === true ? { placeholder: true } : {}) };
    const tr = isObj(s.transition) ? s.transition : {}; const nar = isObj(s.narration) ? s.narration : null;
    const narration: Doc | null = nar === null ? null : nar.type === 'asset' ? { type: 'asset', assetId: (invariant(typeof nar.assetId === 'string' && nar.assetId !== '', 'invalid_input', 'Narration asset needs assetId'), nar.assetId as string), ...(typeof nar.assetVersion === 'number' ? { assetVersion: nar.assetVersion } : {}) } : str(nar.text).trim() === '' ? null : { type: 'tts', text: str(nar.text, '', 8000), voice: /^[a-z]{2,3}(-[a-z0-9]{1,8})*(\+[a-z0-9]{1,8})?$/i.test(str(nar.voice)) ? str(nar.voice) : 'en', speed: n(nar.speed, 155, 80, 300) };
    return { id: idOf(s.id, 'scene'), title: str(s.title, '', 300), duration: n(s.duration, 5, 0.5, 3600), visual, overlays: objs(s.overlays).map((o, i) => normOverlay(o, i, size)),
      transition: { type: ['cut', 'crossfade', 'fade'].includes(str(tr.type)) ? str(tr.type) : 'cut', duration: n(tr.duration, 0.6, 0.1, 5) }, ...(narration === null ? {} : { narration }),
      captions: objs(s.captions).map((c) => ({ start: n(c.start, 0, 0, 86400), end: n(c.end, 2, 0, 86400), text: str(c.text, '', 500) })).filter((c) => c.text.trim() !== '' && c.end > c.start),
      ...(basis === '' ? {} : { basis }), ...(needsDisclosure(basis) ? { disclosure: disclosureText(basis, s.disclosure) } : {}), ...(urefs(s.sources).length > 0 ? { sources: urefs(s.sources) } : {}), ...(typeof s.attribution === 'string' ? { attribution: s.attribution.slice(0, 300) } : {}) };
  });
  invariant(scenes.length <= 500, 'invalid_input', 'Too many scenes'); uniqueIds(scenes, 'scene');
  const audio = objs(raw.audio).map((a) => ({ id: idOf(a.id, 'audio clip'), role: a.role === 'clip' ? 'clip' : 'music', assetId: (invariant(typeof a.assetId === 'string' && a.assetId !== '', 'invalid_input', 'Audio clip needs assetId'), a.assetId as string), ...(typeof a.assetVersion === 'number' ? { assetVersion: a.assetVersion } : {}), start: n(a.start, 0, 0, 86400), trimStart: n(a.trimStart, 0, 0, 86400), ...(typeof a.duration === 'number' ? { duration: n(a.duration, 1, 0.1, 86400) } : {}), gain: n(a.gain, 0, -60, 24), fadeIn: n(a.fadeIn, 0, 0, 60), fadeOut: n(a.fadeOut, 0, 0, 60), loop: bool(a.loop) }));
  uniqueIds(audio, 'audio clip');
  const cap = isObj(raw.captions) ? raw.captions : {}; const cr = isObj(raw.credits) ? raw.credits : {}; const d = isObj(raw.ducking) ? raw.ducking : {};
  return { kind: 'video', title: str(raw.title, 'Untitled', 300), fps: Math.round(n(raw.fps, 24, 5, 60)), width, height, scenes, audio,
    ducking: { enabled: bool(d.enabled, true), threshold: n(d.threshold, 0.03, 0.001, 1), ratio: n(d.ratio, 8, 1, 20), attack: n(d.attack, 40, 1, 2000), release: n(d.release, 500, 10, 9000) },
    captions: { burnIn: bool(cap.burnIn, true), auto: bool(cap.auto, true), language: str(cap.language, 'en', 20) }, credits: { enabled: bool(cr.enabled, true), lines: arr(cr.lines).filter((l): l is string => typeof l === 'string').slice(0, 100), seconds: n(cr.seconds, 6, 2, 120) },
    disclosureCardSeconds: n(raw.disclosureCardSeconds, 3, 2, 20), loudness: n(raw.loudness, -16, -30, -9), sources: urefs(raw.sources) };
}

// ───────────────────────────── scene graphs for generated visuals ─────────────────────────────
type Size = { width: number; height: number };
const fadeFrames = (start: number, end: number, d = 0.4): Doc[] => [{ t: start, props: { opacity: 0 } }, { t: Math.min(start + d, (start + end) / 2), props: { opacity: 1 } }, { t: Math.max(end - d, (start + end) / 2), props: { opacity: 1 } }, { t: end, props: { opacity: 0 } }];
const textLayer = (id: string, props: Doc): Doc => ({ id, type: 'text', font: 'DejaVu Sans', color: '#ffffff', ...props });
async function titleScene(v: Doc, size: Size, duration: number): Promise<Scene> {
  const m = size.width * 0.1; const layers: Doc[] = [{ id: 'bar', type: 'shape', x: m, y: size.height * 0.3, width: size.width * 0.12, height: Math.max(4, size.height * 0.012), fill: '#fca311', keyframes: [{ t: 0, props: { width: 0 } }, { t: Math.min(0.7, duration / 2), props: { width: size.width * 0.12 } }] }];
  let ts = Math.round(size.height * 0.11); let t = normalizeLayer(textLayer('title', { text: str(v.title), x: m, y: 0, width: size.width - 2 * m, size: ts, bold: true, lineHeight: 1.12 }), size);
  while ((await layoutText(t)).height > size.height * 0.34 && ts > 12) { ts = Math.round(ts * 0.88); t = { ...t, size: ts }; }
  const th = (await layoutText(t)).height; t.y = size.height * 0.36; t.keyframes = [{ t: 0, props: { opacity: 0, x: m - size.width * 0.02 }, ease: 'out' }, { t: Math.min(0.6, duration / 2), props: { opacity: 1, x: m }, ease: 'out' }]; layers.push(t);
  if (str(v.subtitle) !== '') layers.push(textLayer('subtitle', { text: str(v.subtitle), x: m, y: size.height * 0.36 + th + size.height * 0.03, width: size.width - 2 * m, size: Math.round(size.height * 0.05), color: '#e5e5e5', maxLines: 5, keyframes: [{ t: Math.min(0.3, duration / 3), props: { opacity: 0 } }, { t: Math.min(1, duration * 0.7), props: { opacity: 1 } }] }));
  if (v.placeholder === true) layers.push(textLayer('placeholder', { text: 'STORYBOARD PLACEHOLDER', x: m, y: size.height * 0.88, width: size.width - 2 * m, size: Math.round(size.height * 0.03), color: '#fca311', bold: true, letterSpacing: 2 }));
  return normalizeScene({ ...size, background: { gradient: { type: 'linear', angle: 60, stops: [{ offset: 0, color: str(v.background, '#14213d') }, { offset: 1, color: '#000000' }] } }, layers });
}
function disclosureScene(basis: string, text: string, size: Size): Scene {
  const m = size.width * 0.1;
  return normalizeScene({ ...size, background: '#0b0b0f', layers: [
    { id: 'rule', type: 'shape', x: m, y: size.height * 0.24, width: size.width - 2 * m, height: Math.max(3, size.height * 0.008), fill: '#9d0208' },
    textLayer('label', { text: basisLabel(basis), x: m, y: size.height * 0.29, width: size.width - 2 * m, size: Math.round(size.height * 0.1), bold: true, letterSpacing: 4 }),
    textLayer('text', { text, x: m, y: size.height * 0.46, width: size.width - 2 * m, size: Math.round(size.height * 0.052), color: '#f2e9e4', lineHeight: 1.35, maxLines: 7 }),
  ] });
}
/** Overlay layers for a scene: lower thirds, text overlays, free layers and the persistent basis label. */
async function overlayScene(scene: Doc, size: Size, duration: number): Promise<Scene | null> {
  const layers: Doc[] = []; const H = size.height, W = size.width;
  for (const o of objs(scene.overlays)) {
    const start = clamp(o.start as number, 0, duration), end = clamp(typeof o.end === 'number' ? o.end : duration, start, duration); if (end - start < 0.05) continue; const id = str(o.id);
    const anim = (extra: Doc[] = []): Doc[] => (o.animation === 'none' ? [{ t: start, props: { opacity: 0 } }, { t: start + 0.001, props: { opacity: 1 } }, { t: end - 0.001, props: { opacity: 1 } }, { t: end, props: { opacity: 0 } }] : [...fadeFrames(start, end), ...extra]);
    if (o.type === 'lowerThird') {
      const x = W * 0.06, y = H * 0.6, bw = W * 0.5, bh = H * 0.15; const slide: Doc[] = o.animation === 'slide' ? [{ t: start, props: { x: x - W * 0.05 } }, { t: start + 0.4, props: { x } }] : [];
      layers.push({ id: `${id}-box`, type: 'shape', x, y, width: bw, height: bh, fill: 'rgba(11,19,43,0.86)', radius: H * 0.012, keyframes: anim(slide) }, { id: `${id}-accent`, type: 'shape', x, y, width: Math.max(4, W * 0.006), height: bh, fill: '#fca311', keyframes: anim(slide) },
        textLayer(`${id}-title`, { text: str(o.title), x: x + W * 0.02, y: y + bh * 0.14, width: bw - W * 0.03, size: Math.round(H * 0.05), bold: true, maxLines: 1, keyframes: anim() }), textLayer(`${id}-sub`, { text: str(o.subtitle), x: x + W * 0.02, y: y + bh * 0.58, width: bw - W * 0.03, size: Math.round(H * 0.032), color: '#e5e5e5', maxLines: 1, keyframes: anim() }));
    } else if (o.type === 'layer') { const l = o.layer as Doc; layers.push({ ...l, id: `${id}-layer`, keyframes: objs(l.keyframes).length > 0 ? objs(l.keyframes).map((k) => ({ ...k, t: (k.t as number) + start })) : anim() }); }
    else {
      const extra: Doc[] = o.animation === 'slide' ? [{ t: start, props: { x: (o.x as number) - W * 0.04 } }, { t: start + 0.4, props: { x: o.x as number } }] : o.animation === 'typewriter' ? [{ t: start, props: { reveal: 0 } }, { t: start + Math.min(2.5, (end - start) * 0.6), props: { reveal: 1 }, ease: 'linear' }] : [];
      layers.push(textLayer(`${id}-text`, { text: str(o.text), x: o.x as number, y: o.y as number, width: o.width as number, size: o.size as number, color: str(o.color), align: str(o.align), bold: o.bold === true, background: isObj(o.background) ? o.background : { color: '#000000', padding: Math.round(H * 0.012), radius: 4, opacity: 0.55 }, keyframes: o.animation === 'typewriter' ? [...extra, { t: start, props: { opacity: 1 } }, { t: end - 0.3, props: { opacity: 1 } }, { t: end, props: { opacity: 0 } }] : anim(extra) }));
    }
  }
  if (needsDisclosure(scene.basis)) layers.push(textLayer('basis-label', { text: basisLabel(str(scene.basis)), x: W * 0.03, y: H * 0.045, width: W * 0.6, size: Math.round(H * 0.034), bold: true, letterSpacing: 2, wrap: false, background: { color: '#9d0208', padding: Math.round(H * 0.012), radius: 3, opacity: 0.92 } }));
  return layers.length === 0 ? null : normalizeScene({ ...size, background: 'transparent', layers });
}
/** Renders a (possibly keyframed) scene to PNG frames; identical consecutive frames are hard links, static scenes one frame. */
async function renderFrames(scene: Scene, duration: number, fps: number, outWidth: number, dir: string, resolve: ImageResolver, signal: AbortSignal): Promise<{ pattern: string; frames: number; unique: number; still: boolean }> {
  await mkdir(dir, { recursive: true });
  const animated = scene.layers.some((l) => objs(l.keyframes).length > 0); const frames = animated ? Math.max(1, Math.round(duration * fps)) : 1; let last = '', lastPath = '', unique = 0;
  for (let f = 0; f < frames; f++) {
    const svg = await sceneToSvg(sceneAt(scene, f / fps), resolve); const h = sha256(svg); const path = join(dir, `f-${String(f).padStart(6, '0')}.png`);
    if (h === last) await link(lastPath, path); else { await rasterize(svg, path, outWidth, signal); last = h; lastPath = path; unique++; }
  }
  return { pattern: join(dir, 'f-%06d.png'), frames, unique, still: !animated };
}
const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2);
function splitCaption(text: string, max = 74): string[] {
  const out: string[] = []; let cur = '';
  for (const sentence of text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?;:])\s+/)) for (const word of sentence.split(' ')) { if (cur !== '' && (cur.length + 1 + word.length > max)) { out.push(cur); cur = word; } else cur = cur === '' ? word : `${cur} ${word}`; if (/[.!?]$/.test(word) && cur.length > max * 0.5) { out.push(cur); cur = ''; } }
  if (cur !== '') out.push(cur);
  return out;
}
const stamp = (t: number, sep: string): string => { const ms = Math.max(0, Math.round(t * 1000)); const p = (v: number, l = 2): string => String(v).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`; };
type Cue = { start: number; end: number; text: string };
export const toSrt = (cues: readonly Cue[]): string => cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text.replace(/\n{2,}/g, '\n')}\n`).join('\n');
export const toVtt = (cues: readonly Cue[]): string => `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text.replace(/-->/g, '→').replace(/\n{2,}/g, '\n')}\n`).join('\n')}`;

async function render(doc: Doc, env: RenderEnv): Promise<PipelineResult> {
  await env.tool('ffmpeg', 'ffprobe', 'rsvg-convert', 'convert', 'identify');
  const scenes = objs(doc.scenes); invariant(scenes.length > 0, 'invalid_input', 'The timeline has no scenes');
  const preview = env.profile === 'preview'; const full: Size = { width: doc.width as number, height: doc.height as number };
  const scale = preview ? Math.min(1, 240 / full.height) : 1; const W = even(full.width * scale), H = even(full.height * scale); const fps = preview ? Math.min(doc.fps as number, 12) : doc.fps as number;
  const base = safeName(str(doc.title, 'video')).replace(/\.+$/, '') || 'video'; const generated: Json[] = []; const disclosures: Disclosure[] = []; let synthetic = false;
  const resolve = imageResolver(env.dir, (id, v) => env.asset(id, v), env.signal, preview ? 0.5 : 1);
  const x264 = preview ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19'];
  const vout = ['-pix_fmt', 'yuv420p', '-r', String(fps), '-an', '-movflags', '+faststart'];

  // 1. narration: synthesise or load, and fit each scene to its narration
  type Seg = { id: string; kind: 'disclosure' | 'scene' | 'credits'; scene?: Doc; duration: number; transition: Doc; narration?: { path: string; seconds: number; text?: string }; start: number; path: string; cached: boolean };
  const segs: Seg[] = [];
  for (const [i, sc] of scenes.entries()) {
    let narration: Seg['narration']; const nar = isObj(sc.narration) ? sc.narration : null;
    if (nar !== null && nar.type === 'tts') { const p = join(env.dir, `narration-${i}.wav`); const seconds = await synthSpeech(env, str(nar.text), p, { voice: str(nar.voice), speed: nar.speed as number }); narration = { path: p, seconds, text: str(nar.text) }; synthetic = true; generated.push({ kind: 'speech', scene: sc.id as string, tool: 'espeak-ng', synthetic: true, voice: str(nar.voice), seconds: Math.round(seconds * 100) / 100 }); }
    else if (nar !== null) { const a = await env.asset(nar.assetId as string, typeof nar.assetVersion === 'number' ? nar.assetVersion : undefined); invariant(a.mediaType.startsWith('audio/'), 'invalid_input', `Narration asset ${a.name} is not audio`); narration = { path: a.path, seconds: n((a.mediaInfo as Doc).duration, 0) }; }
    const cut: Doc = { type: 'cut', duration: 0 };
    if (needsDisclosure(sc.basis)) { segs.push({ id: `${String(sc.id)}-disclosure`, kind: 'disclosure', scene: sc, duration: doc.disclosureCardSeconds as number, transition: i === 0 ? cut : sc.transition as Doc, start: 0, path: '', cached: false }); disclosures.push({ basis: str(sc.basis), text: str(sc.disclosure), where: 'disclosure card before the scene, on-screen label during it, caption track and credits', blockId: sc.id as string }); }
    segs.push({ id: sc.id as string, kind: 'scene', scene: sc, duration: Math.max(sc.duration as number, narration === undefined ? 0 : narration.seconds + 0.7), transition: needsDisclosure(sc.basis) ? { type: 'fade', duration: 0.4 } : i === 0 ? cut : sc.transition as Doc, ...(narration === undefined ? {} : { narration }), start: 0, path: '', cached: false });
    env.progress(0.08 * ((i + 1) / scenes.length), 'narration');
  }
  const credits = [...env.credits(), ...(synthetic ? [`Narration: ${SYNTHETIC_VOICE_NOTICE}`] : [])]; const cr = doc.credits as Doc;
  if (cr.enabled === true) segs.push({ id: 'credits', kind: 'credits', duration: cr.seconds as number, transition: { type: 'fade', duration: 0.5 }, start: 0, path: '', cached: false });
  // transitions overlap the previous segment; never longer than a third of either neighbour
  let at = 0;
  for (const [i, s] of segs.entries()) { const t = s.transition; if (i === 0 || t.type === 'cut') t.duration = 0; else t.duration = Math.round(Math.min(t.duration as number, s.duration / 3, (segs[i - 1] as Seg).duration / 3) * fps) / fps; s.duration = Math.round(s.duration * fps) / fps; s.start = at - (t.duration as number); at = s.start + s.duration; }
  const total = at;

  // 2. render each segment to its own video file, cached by content hash
  let hits = 0;
  for (const [i, s] of segs.entries()) {
    env.progress(0.1 + 0.5 * (i / segs.length), `segment ${i + 1}/${segs.length}: ${s.id}`);
    const sc = s.scene; const v = sc === undefined ? {} : sc.visual as Doc; const frames = Math.max(1, Math.round(s.duration * fps));
    const assetSha = sc !== undefined && s.kind === 'scene' ? await Promise.all(collectAssets({ visual: v, overlays: sc.overlays as Json }).map(async (r) => (await env.asset(r.assetId, r.version)).sha256)) : [];
    const spec = s.kind === 'credits' ? { credits, lines: cr.lines, title: str(doc.title), disclosures } : s.kind === 'disclosure' ? { basis: sc?.basis ?? '', text: sc?.disclosure ?? '' } : { visual: v, overlays: sc?.overlays ?? [], basis: sc?.basis ?? '' };
    const hash = sha256(JSON.stringify([VIDEO_VERSION, s.kind, spec, assetSha, W, H, fps, s.duration, env.profile]));
    s.path = join(env.dir, `seg-${i}.mp4`);
    const hit = await env.cacheGet(hash); if (hit !== null) { await writeFile(s.path, hit); s.cached = true; hits++; continue; }
    const dir = join(env.dir, `seg-${i}`); const inputs: string[] = []; let graph = ''; let ov: Awaited<ReturnType<typeof renderFrames>> | null = null;
    const seq = (r: { pattern: string; still: boolean }): string[] => (r.still ? ['-loop', '1', '-framerate', String(fps), '-t', s.duration.toFixed(3), '-i', r.pattern.replace('%06d', '000000')] : ['-framerate', String(fps), '-i', r.pattern]);
    if (s.kind === 'credits') {
      // one tall image scrolled by ffmpeg
      const lines: [string, Doc][] = [[str(doc.title), { size: full.height * 0.07, bold: true }], ...(arr(cr.lines) as string[]).map((l): [string, Doc] => [l, {}]), ['Credits', { bold: true, color: '#fca311' }], ...credits.map((c): [string, Doc] => [c, {}]),
        ...(disclosures.length > 0 ? [['Disclosures', { bold: true, color: '#fca311' }] as [string, Doc], ...disclosures.map((d): [string, Doc] => [`${basisLabel(d.basis)} — ${d.text}`, {}])] : []), ['Sources, rights and tool versions are listed in the production manifest.', { italic: true, color: '#bbbbbb' }]];
      const layers: Doc[] = []; let y = full.height * 0.1;
      for (const [k, [text, props]] of lines.entries()) { const l = normalizeLayer(textLayer(`c${k}`, { text, x: full.width * 0.12, y, width: full.width * 0.76, size: full.height * 0.042, align: 'center', lineHeight: 1.3, ...props }), { width: full.width, height: 100000 }); layers.push(l); y += (await layoutText(l)).height + full.height * (props.bold === true ? 0.03 : 0.045); }
      const tall = Math.min(16000, Math.ceil(y + full.height * 0.05)); const png = join(env.dir, `credits-${i}.png`);
      await rasterize(await sceneToSvg({ width: full.width, height: tall, background: 'transparent', layers }, resolve), png, W, env.signal);
      const th = Math.round(tall * (W / full.width));
      inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${s.duration.toFixed(3)}`, '-loop', '1', '-framerate', String(fps), '-t', s.duration.toFixed(3), '-i', png);
      graph = `[0:v][1:v]overlay=x=0:y='${H}-(t/${s.duration.toFixed(3)})*(${H}+${th})':shortest=1,format=yuv420p[v]`;
    } else {
      if (s.kind === 'disclosure') { const r = await renderFrames(disclosureScene(str(sc?.basis), str(sc?.disclosure), full), s.duration, fps, W, `${dir}-base`, resolve, env.signal); inputs.push(...seq(r)); graph = `[0:v]scale=${W}:${H},format=yuv420p[b]`; }
      else if (v.type === 'image') {
        const a = await env.asset(v.assetId as string, typeof v.assetVersion === 'number' ? v.assetVersion : undefined); invariant(a.mediaType.startsWith('image/'), 'invalid_input', `Asset ${a.name} is not an image`);
        const big = join(env.dir, `kb-${i}.png`); const bw = W * 2, bh = H * 2; // oversample so the pan/zoom moves on a finer grid
        await run('convert', [`${a.path}[0]`, '-auto-orient', '-resize', `${bw}x${bh}^`, '-gravity', 'center', '-extent', `${bw}x${bh}`, '-strip', big], { signal: env.signal });
        const kb = v.kenBurns as Doc; const f = kb.from as Doc, t = kb.to as Doc; const u = `(on/${Math.max(1, frames - 1)})`;
        const z = `(${f.zoom}+(${(t.zoom as number) - (f.zoom as number)})*${u})`;
        inputs.push('-i', big); graph = `[0:v]zoompan=z='${z}':x='(iw-iw/zoom)*(${f.x}+(${(t.x as number) - (f.x as number)})*${u})':y='(ih-ih/zoom)*(${f.y}+(${(t.y as number) - (f.y as number)})*${u})':d=${frames}:s=${W}x${H}:fps=${fps},format=yuv420p[b]`;
      } else if (v.type === 'video') {
        const a = await env.asset(v.assetId as string, typeof v.assetVersion === 'number' ? v.assetVersion : undefined); invariant(a.mediaType.startsWith('video/'), 'invalid_input', `Asset ${a.name} is not a video`);
        inputs.push('-ss', String(v.trimStart), '-t', s.duration.toFixed(3), '-i', a.path); graph = `[0:v]fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},tpad=stop_mode=clone:stop_duration=${s.duration.toFixed(3)},format=yuv420p[b]`;
      } else {
        const g = v.type === 'scene' ? normalizeScene({ ...(v.scene as Doc), ...full }) : v.type === 'color' ? normalizeScene({ ...full, background: str(v.color), layers: [] }) : await titleScene(v, full, s.duration);
        const r = await renderFrames(g, s.duration, fps, W, `${dir}-base`, resolve, env.signal); inputs.push(...seq(r)); graph = `[0:v]scale=${W}:${H},tpad=stop_mode=clone:stop_duration=${s.duration.toFixed(3)},format=yuv420p[b]`;
        generated.push({ kind: 'motion-graphics', scene: s.id, tool: 'rsvg-convert', frames: r.frames, uniqueFrames: r.unique });
      }
      const overlay = s.kind === 'scene' && sc !== undefined ? await overlayScene(sc, full, s.duration) : null;
      if (overlay !== null) { ov = await renderFrames(overlay, s.duration, fps, W, `${dir}-ov`, resolve, env.signal); inputs.push(...seq(ov)); graph += `;[b][1:v]overlay=0:0:format=auto:eof_action=repeat,format=yuv420p[v]`; } else graph += ';[b]null[v]';
    }
    await ffmpeg([...inputs, '-filter_complex', graph, '-map', '[v]', '-t', s.duration.toFixed(3), ...x264, ...vout, s.path], { signal: env.signal, totalSeconds: s.duration });
    await env.cachePut(hash, await readFile(s.path));
  }

  // 3. captions: disclosure cards, narration (auto) and authored cues
  const cues: Cue[] = []; const cap = doc.captions as Doc;
  for (const s of segs) {
    const sc = s.scene; const t0 = s.start + (s.transition.duration as number);
    if (s.kind === 'disclosure' && sc !== undefined) cues.push({ start: t0, end: s.start + s.duration, text: `[${basisLabel(str(sc.basis))}] ${str(sc.disclosure)}` });
    if (s.kind !== 'scene' || sc === undefined) continue;
    if (cap.auto === true && s.narration?.text !== undefined) { const parts = splitCaption(s.narration.text); const chars = parts.reduce((a, p) => a + p.length, 0); let t = s.start + 0.35; for (const p of parts) { const d = (s.narration.seconds * p.length) / Math.max(1, chars); cues.push({ start: t, end: t + d, text: p }); t += d; } }
    for (const c of objs(sc.captions)) cues.push({ start: s.start + (c.start as number), end: Math.min(s.start + (c.end as number), s.start + s.duration), text: str(c.text) });
  }
  cues.sort((a, b) => a.start - b.start);
  for (const [i, c] of cues.entries()) { const next = cues[i + 1]; if (next !== undefined && c.end > next.start) c.end = Math.max(c.start + 0.2, next.start - 0.02); }
  await writeFile(join(env.dir, 'captions.srt'), toSrt(cues)); await writeFile(join(env.dir, 'captions.vtt'), toVtt(cues));

  // 4. audio: narration at scene starts, music/clips with gain, fades, loops and ducking under narration
  env.progress(0.62, 'audio mix');
  type AItem = { args: string[]; start: number; trimStart: number; dur: number; gain: number; fadeIn: number; fadeOut: number; bus: 'voice' | 'music' }; const items: AItem[] = [];
  for (const s of segs) if (s.narration !== undefined) items.push({ args: ['-i', s.narration.path], start: s.start + 0.35, trimStart: 0, dur: s.narration.seconds, gain: 0, fadeIn: 0, fadeOut: 0, bus: 'voice' });
  for (const a of objs(doc.audio)) {
    const as = await env.asset(a.assetId as string, typeof a.assetVersion === 'number' ? a.assetVersion : undefined); invariant(as.mediaType.startsWith('audio/'), 'invalid_input', `Asset ${as.name} is not audio`);
    const len = n((as.mediaInfo as Doc).duration, 0); const start = Math.min(a.start as number, Math.max(0, total - 0.1)); const avail = a.loop === true ? total - start : len - (a.trimStart as number);
    const dur = Math.min(typeof a.duration === 'number' ? a.duration : avail, avail, total - start); if (dur <= 0.05) continue;
    items.push({ args: [...(a.loop === true ? ['-stream_loop', '-1'] : []), '-i', as.path], start, trimStart: a.trimStart as number, dur, gain: a.gain as number, fadeIn: a.fadeIn as number, fadeOut: a.fadeOut as number, bus: a.role === 'clip' ? 'voice' : 'music' });
  }
  const audioPath = join(env.dir, 'audio.wav'); const duck = doc.ducking as Doc;
  if (items.length === 0) { await ffmpeg(['-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo', '-c:a', 'pcm_s16le', audioPath], { signal: env.signal }); generated.push({ kind: 'silence', note: 'No narration or music on the timeline; a silent audio track was written.' }); }
  else {
    const f: string[] = items.map((x, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${x.trimStart.toFixed(3)}:duration=${x.dur.toFixed(3)},asetpts=PTS-STARTPTS${x.fadeIn > 0 ? `,afade=t=in:st=0:d=${Math.min(x.fadeIn, x.dur).toFixed(3)}` : ''}${x.fadeOut > 0 ? `,afade=t=out:st=${Math.max(0, x.dur - x.fadeOut).toFixed(3)}:d=${Math.min(x.fadeOut, x.dur).toFixed(3)}` : ''},volume=${x.gain.toFixed(2)}dB,adelay=${Math.round(x.start * 1000)}:all=1[c${i}]`);
    const bus = (name: 'voice' | 'music'): string | null => { const ix = items.map((x, i) => (x.bus === name ? i : -1)).filter((i) => i >= 0); if (ix.length === 0) return null; f.push(`${ix.map((i) => `[c${i}]`).join('')}amix=inputs=${ix.length}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)},atrim=duration=${total.toFixed(3)}[${name}]`); return name; };
    const voice = bus('voice'), music = bus('music'); let last = voice ?? music as string;
    if (voice !== null && music !== null) { if (duck.enabled === true) f.push('[voice]asplit=2[vm][vk]', `[music][vk]sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}:attack=${duck.attack}:release=${duck.release}[dk]`, '[vm][dk]amix=inputs=2:normalize=0:duration=longest[sum]'); else f.push('[voice][music]amix=inputs=2:normalize=0:duration=longest[sum]'); last = 'sum'; }
    f.push(`[${last}]highpass=f=40[out]`);
    const premix = join(env.dir, 'premix.wav');
    await ffmpeg([...items.flatMap((x) => x.args), '-filter_complex', f.join(';'), '-map', '[out]', '-t', total.toFixed(3), '-c:a', 'pcm_s24le', '-ar', '44100', premix], { signal: env.signal, totalSeconds: total });
    if (preview) await ffmpeg(['-i', premix, '-c:a', 'pcm_s16le', audioPath], { signal: env.signal }); else await normalizeLoudness(env, premix, audioPath, doc.loudness as number, total);
  }

  // 5. assemble: transitions (xfade), burned-in captions, audio
  env.progress(0.7, 'assemble');
  const parts: string[] = segs.map((_, i) => `[${i}:v]settb=AVTB,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`); let cur = 'v0'; let accDur = (segs[0] as Seg).duration;
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i] as Seg; const d = s.transition.duration as number; const out = `x${i}`;
    if (d > 0) parts.push(`[${cur}][v${i}]xfade=transition=${s.transition.type === 'fade' ? 'fadeblack' : 'fade'}:duration=${d.toFixed(3)}:offset=${(accDur - d).toFixed(3)}[${out}]`); else parts.push(`[${cur}][v${i}]concat=n=2:v=1:a=0,settb=AVTB,fps=${fps}[${out}]`);
    cur = out; accDur += s.duration - d;
  }
  const burn = cap.burnIn === true && cues.length > 0;
  parts.push(`[${cur}]${burn ? `subtitles=captions.srt:force_style='FontName=DejaVu Sans,FontSize=${preview ? 16 : 15},Outline=1,Shadow=0,MarginV=${preview ? 14 : 18}',` : ''}format=yuv420p[vout]`);
  const name = preview ? `${base}.preview.mp4` : `${base}.mp4`; const mp4 = join(env.dir, name);
  await ffmpeg([...segs.flatMap((s) => ['-i', s.path]), '-i', audioPath, '-filter_complex', parts.join(';'), '-map', '[vout]', '-map', `${segs.length}:a`, ...x264, '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', preview ? '96k' : '160k', '-t', total.toFixed(3), '-movflags', '+faststart', '-metadata', `title=${str(doc.title)}`, mp4],
    { cwd: env.dir, signal: env.signal, totalSeconds: total, onProgress: (x) => env.progress(0.7 + x * (preview ? 0.28 : 0.15), 'encode H.264') });
  const outputs: RenderOutput[] = [{ name, path: mp4, mediaType: 'video/mp4', role: preview ? 'preview' : 'primary' }, { name: `${base}.srt`, path: join(env.dir, 'captions.srt'), mediaType: 'text/plain', role: 'sidecar' }];
  const timeline = segs.map((s) => ({ id: s.id, kind: s.kind, start: Math.round(s.start * 1000) / 1000, duration: s.duration, transition: s.transition, cached: s.cached }));
  const params = { width: W, height: H, fps, durationSeconds: Math.round(total * 1000) / 1000, captions: { cues: cues.length, burnedIn: burn }, segmentCache: { hits, total: segs.length } };
  if (!preview) {
    outputs.push({ name: `${base}.vtt`, path: join(env.dir, 'captions.vtt'), mediaType: 'text/plain', role: 'sidecar' });
    const webm = join(env.dir, `${base}.webm`);
    await ffmpeg(['-i', mp4, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '112k', webm], { signal: env.signal, totalSeconds: total, onProgress: (x) => env.progress(0.85 + x * 0.12, 'encode WebM') });
    outputs.push({ name: `${base}.webm`, path: webm, mediaType: 'video/webm', role: 'primary' });
    const firstScene = segs.find((s) => s.kind === 'scene') as Seg; const shots: [string, number][] = [['poster.jpg', firstScene.start + Math.min(firstScene.duration * 0.6, 2)], ...[0.25, 0.5, 0.75].map((p, i): [string, number] => [`thumb-${i + 1}.jpg`, total * p])];
    for (const [file, t] of shots) { const p = join(env.dir, file); await ffmpeg(['-ss', t.toFixed(3), '-i', mp4, '-frames:v', '1', '-q:v', '3', ...(file.startsWith('thumb') ? ['-vf', 'scale=320:-2'] : []), p], { signal: env.signal }); outputs.push({ name: file, path: p, mediaType: 'image/jpeg', role: file === 'poster.jpg' ? 'poster' : 'thumbnail' }); }
  }
  return { outputs, parameters: params, disclosures, credits, generated, details: { requiredDisclosures: scenes.filter((s) => needsDisclosure(s.basis)).map((s) => s.id as string), timeline: timeline as unknown as Json, qc: [{ check: 'timeline-duration', ok: total > 0.5, detail: `${total.toFixed(2)} s in ${segs.length} segments` }] } };
}

const sceneIndex = (doc: Doc, id: unknown): number => { const i = objs(doc.scenes).findIndex((s) => s.id === id); invariant(i >= 0, 'invalid_input', `No scene ${String(id)}`); return i; };
export const videoPipeline: Pipeline = {
  kind: 'video', tools: ['ffmpeg', 'ffprobe', 'rsvg-convert', 'convert'],
  validate,
  empty: (title) => validate({ title, scenes: [] }),
  assetRefs: (doc) => collectAssets(doc),
  sources: (doc) => [...collectSources(doc)],
  text: (doc) => [str(doc.title), ...collectText(doc.scenes as Json), ...objs(doc.scenes).map((s) => str((s.narration as Doc | undefined)?.text))].join('\n'),
  async applyOp(doc, op, helpers) {
    const out = structuredClone(doc); const scenes = out.scenes as Doc[]; const audio = out.audio as Doc[];
    switch (op.op) {
      case 'addScene': { invariant(isObj(op.scene), 'invalid_input', 'addScene needs a scene'); scenes.splice(typeof op.index === 'number' ? clamp(op.index, 0, scenes.length) : scenes.length, 0, { ...op.scene, id: typeof op.scene.id === 'string' ? op.scene.id : helpers.newId('scene') }); return out; }
      case 'updateScene': { const i = sceneIndex(out, op.sceneId); invariant(isObj(op.set), 'invalid_input', 'updateScene needs "set"'); scenes[i] = { ...scenes[i], ...op.set, id: op.sceneId as string }; return out; }
      case 'removeScene': { scenes.splice(sceneIndex(out, op.sceneId), 1); return out; }
      case 'moveScene': { const i = sceneIndex(out, op.sceneId); invariant(typeof op.to === 'number', 'invalid_input', 'moveScene needs "to"'); const [s] = scenes.splice(i, 1); scenes.splice(clamp(op.to, 0, scenes.length), 0, s as Doc); return out; }
      case 'addOverlay': { const s = scenes[sceneIndex(out, op.sceneId)] as Doc; invariant(isObj(op.overlay), 'invalid_input', 'addOverlay needs an overlay'); (s.overlays as Doc[]).push({ ...op.overlay, id: typeof op.overlay.id === 'string' ? op.overlay.id : helpers.newId('ov') }); return out; }
      case 'removeOverlay': { const s = scenes[sceneIndex(out, op.sceneId)] as Doc; const before = objs(s.overlays).length; s.overlays = objs(s.overlays).filter((o) => o.id !== op.overlayId); invariant(objs(s.overlays).length < before, 'invalid_input', 'No such overlay'); return out; }
      case 'setNarration': { const s = scenes[sceneIndex(out, op.sceneId)] as Doc; if (op.narration === null) delete s.narration; else { invariant(isObj(op.narration), 'invalid_input', 'setNarration needs narration or null'); s.narration = op.narration; } return out; }
      case 'addAudio': { invariant(isObj(op.clip), 'invalid_input', 'addAudio needs a clip'); await helpers.assetInfo(str(op.clip.assetId)); audio.push({ ...op.clip, id: typeof op.clip.id === 'string' ? op.clip.id : helpers.newId('audio') }); return out; }
      case 'updateAudio': { const i = audio.findIndex((a) => a.id === op.clipId); invariant(i >= 0 && isObj(op.set), 'invalid_input', 'updateAudio needs clipId and "set"'); audio[i] = { ...audio[i], ...op.set, id: op.clipId as string }; return out; }
      case 'removeAudio': { const i = audio.findIndex((a) => a.id === op.clipId); invariant(i >= 0, 'invalid_input', 'No such audio clip'); audio.splice(i, 1); return out; }
      default: return null;
    }
  },
  render,
  /** Script / storyboard → timeline: scene panels become clips with durations, narration and dialogue become speech. */
  async fromEditorial(ed: EditorialExport, options) {
    const assets = isObj(options.assets) ? options.assets : {}; const scenes: Doc[] = []; const byBlock = new Map<string, Doc>(); let alt = 0;
    const kb = (): Doc => (alt++ % 2 === 0 ? { from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.5, y: 0.4, zoom: 1.15 } } : { from: { x: 0.3, y: 0.5, zoom: 1.15 }, to: { x: 0.7, y: 0.5, zoom: 1.05 } });
    const say = (sc: Doc, text: string): void => { const cur = isObj(sc.narration) ? str(sc.narration.text) : ''; sc.narration = { type: 'tts', text: `${cur} ${text}`.trim(), voice: str(options.voice, 'en') }; };
    for (const b of ed.blocks) {
      const carry: Doc = { basis: b.basis, ...(b.disclosure === undefined ? {} : { disclosure: b.disclosure }), sources: b.sources, ...(b.attribution === undefined ? {} : { attribution: b.attribution }) };
      if (b.type === 'scene') {
        const panels = objs(b.data.panels); const heading = [str(b.data.location), str(b.data.time)].filter((x) => x !== '').join(' — ');
        const list = panels.length > 0 ? panels : [{ id: 'p1', description: b.text || str(b.data.purpose) }];
        for (const [i, p] of list.entries()) {
          const bound = (arr(p.assetRefs) as string[]).map((r) => assets[r] ?? assets[r.split('@')[0] as string]).find((a) => typeof a === 'string');
          const sc: Doc = { id: `${b.id}-${str(p.id, `p${i + 1}`)}`.slice(0, 64), title: heading, duration: n(p.durationSeconds, 5, 1, 600), ...carry, ...(typeof p.disclosure === 'string' && needsDisclosure(b.basis) ? { disclosure: p.disclosure } : {}), transition: { type: scenes.length === 0 ? 'cut' : 'crossfade', duration: 0.6 },
            visual: typeof bound === 'string' ? { type: 'image', assetId: bound, kenBurns: kb() } : { type: 'title', title: heading || ed.title, subtitle: str(p.description), placeholder: true }, overlays: [] };
          scenes.push(sc); if (i === 0) byBlock.set(b.id, sc);
        }
      } else if (b.type === 'script_element') {
        const target = (typeof b.data.sceneRef === 'string' ? byBlock.get(b.data.sceneRef) : undefined) ?? scenes[scenes.length - 1]; const el = str(b.data.element);
        if (el === 'scene_heading' || el === 'transition' || el === 'parenthetical') continue;
        if (target === undefined) { scenes.push({ id: b.id, title: ed.title, duration: 4, ...carry, visual: { type: 'title', title: ed.title, subtitle: el === 'on_screen_text' ? b.text : '' }, overlays: [], ...(el === 'on_screen_text' ? {} : { narration: { type: 'tts', text: b.text, voice: str(options.voice, 'en') } }) }); continue; }
        if (el === 'on_screen_text') (target.overlays as Doc[]).push({ id: `t-${b.id}`.slice(0, 64), type: 'text', text: b.text, start: 0.5, animation: 'fade', y: (options.height as number | undefined ?? 720) * 0.62 });
        else if (el === 'dialogue') { say(target, `${str(b.data.character)}: ${b.text}`); (target.overlays as Doc[]).push({ id: `lt-${b.id}`.slice(0, 64), type: 'lowerThird', title: str(b.data.character), subtitle: b.attribution ?? '', start: 0.3, animation: 'slide' }); }
        else if (el === 'narration') say(target, b.text);
        if (needsDisclosure(b.basis) && !needsDisclosure(target.basis)) { target.basis = b.basis; target.disclosure = b.disclosure ?? ''; }
        target.sources = [...new Set([...(arr(target.sources) as string[]), ...b.sources])];
      } else if (b.text.trim() !== '') scenes.push({ id: b.id, title: str(b.data.heading), duration: 4, ...carry, transition: { type: scenes.length === 0 ? 'cut' : 'crossfade', duration: 0.6 }, visual: { type: 'title', title: str(b.data.heading) || ed.title, subtitle: b.text.length > 220 ? '' : b.text }, overlays: [], narration: { type: 'tts', text: b.attribution === undefined ? b.text : `${b.attribution}: ${b.text}`, voice: str(options.voice, 'en') } });
    }
    return validate({ title: ed.title, width: options.width ?? 1280, height: options.height ?? 720, fps: options.fps ?? 24, scenes, credits: { enabled: true, lines: ed.credits }, sources: ed.sources });
  },
  estimateSeconds: (doc, profile) => { const t = objs(doc.scenes).reduce((a, s) => a + (s.duration as number), 0); return profile === 'preview' ? 5 + t * 0.3 : 20 + t * 2.5; },
  check(doc) {
    const problems: { level: 'error' | 'warning'; message: string; at?: string }[] = [];
    if (objs(doc.scenes).length === 0) problems.push({ level: 'error', message: 'The timeline has no scenes yet' });
    for (const s of objs(doc.scenes)) if ((s.visual as Doc).placeholder === true) problems.push({ level: 'warning', message: `Scene ${String(s.id)} still shows a storyboard placeholder instead of a visual`, at: s.id as string });
    return problems;
  },
};
