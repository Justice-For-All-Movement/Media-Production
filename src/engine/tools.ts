// Subprocess, media probing, WAV and font-metric helpers shared by all production pipelines.
// Every external tool is spawned with an argument array (never a shell), a timeout and an output cap.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';

export type RunOptions = Readonly<{
  cwd?: string; timeoutMs?: number; signal?: AbortSignal; input?: Uint8Array | string;
  onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void;
  allowFail?: boolean; maxOutputBytes?: number; env?: Readonly<Record<string, string>>;
}>;
export type RunResult = Readonly<{ code: number; stdout: string; stderr: string }>;

const SAFE_ENV: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };

/** Runs a tool. Abort (cancellation) and timeout kill the whole process with SIGKILL. */
export function run(cmd: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) { reject(new DomainError('cancelled', 'Cancelled')); return; }
    const max = options.maxOutputBytes ?? 4 * 1024 * 1024;
    let stdout = '', stderr = '', done = false, timedOut = false;
    const child = spawn(cmd, [...args], { cwd: options.cwd, env: { ...SAFE_ENV, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (fn: () => void): void => { if (done) return; done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); fn(); };
    const onAbort = (): void => { child.kill('SIGKILL'); finish(() => reject(new DomainError('cancelled', 'Cancelled'))); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? 120_000);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { options.onStdout?.(c); if (stdout.length < max) stdout += c; });
    child.stderr.on('data', (c: string) => { options.onStderr?.(c); stderr += c; if (stderr.length > max) stderr = stderr.slice(-max / 2); });
    child.on('error', (error: NodeJS.ErrnoException) => finish(() => reject(error.code === 'ENOENT' ? new DomainError('unavailable', `Required tool is not installed: ${cmd}`) : error)));
    child.on('close', (code) => finish(() => {
      if (timedOut) return reject(new DomainError('tool_failed', `${cmd} timed out`));
      const c = code ?? -1;
      if (c !== 0 && options.allowFail !== true) return reject(new DomainError('tool_failed', `${cmd} exited with ${c}: ${stderr.trim().split('\n').slice(-6).join(' | ').slice(0, 800)}`));
      resolve({ code: c, stdout, stderr });
    }));
    child.stdin.on('error', () => { /* tool closed stdin early */ });
    if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  });
}

const VERSION_ARGS: Readonly<Record<string, readonly string[]>> = {
  ffmpeg: ['-version'], ffprobe: ['-version'], 'rsvg-convert': ['--version'], convert: ['-version'], identify: ['-version'], pandoc: ['--version'],
  soffice: ['--version'], fluidsynth: ['--version'], 'espeak-ng': ['--version'], sox: ['--version'], exiftool: ['-ver'], zip: ['-v'], unzip: ['-v'],
  pdftoppm: ['-v'], pdfinfo: ['-v'], pdftotext: ['-v'], 'fc-match': ['--version'],
};
const versionCache = new Map<string, string | null>();
/** First line of the tool's version output, or null when the tool is not installed. */
export async function toolVersion(name: string): Promise<string | null> {
  if (versionCache.has(name)) return versionCache.get(name) ?? null;
  let v: string | null = null;
  try {
    const r = await run(name, VERSION_ARGS[name] ?? ['--version'], { allowFail: true, timeoutMs: 20_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    const line = name === 'zip' || name === 'unzip' ? text.split('\n').find((l) => /\b(Zip|UnZip) \d/.test(l)) : text.split('\n').find((l) => l.trim() !== '');
    v = (line ?? '').trim().slice(0, 160) || 'unknown';
  } catch (error) { if (!(error instanceof DomainError && error.code === 'unavailable')) throw error; }
  versionCache.set(name, v);
  return v;
}
export async function requireTools(names: readonly string[]): Promise<{ name: string; version: string }[]> {
  const out: { name: string; version: string }[] = [];
  for (const name of names) {
    const version = await toolVersion(name);
    if (version === null) throw new DomainError('unavailable', `Required tool is not installed: ${name}`);
    out.push({ name, version });
  }
  return out;
}

export async function withWorkdir<T>(root: string | undefined, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(root ?? tmpdir(), 'e10-work-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3 }); }
}
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export const xml = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
export const safeName = (name: string, fallback = 'file'): string => {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 96);
  return cleaned === '' ? fallback : cleaned;
};

/** Deterministic PRNG (mulberry32) seeded from any string, so generation is reproducible. */
export function rng(seed: string): () => number {
  let a = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ───────────────────────────── Media type sniffing & probing ─────────────────────────────
const ascii = (b: Uint8Array, at: number, len: number): string => Buffer.from(b.subarray(at, at + len)).toString('latin1');
/** Identifies a media type from content (never from the client-declared type alone). Returns null when not allowed. */
export function sniffMediaType(bytes: Uint8Array, filename: string): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(b, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(b, 0, 4) === '%PDF') return 'application/pdf';
  if (ascii(b, 0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(b, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(b, 0, 4) === 'MThd') return 'audio/midi';
  if (ascii(b, 0, 3) === 'ID3' || (b.length > 2 && b[0] === 0xff && ((b[1] as number) & 0xe0) === 0xe0 && /\.mp3$/i.test(filename))) return 'audio/mpeg';
  if (ascii(b, 4, 4) === 'ftyp') return /\.m4a$/i.test(filename) ? 'audio/mp4' : 'video/mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  const head = Buffer.from(b.subarray(0, 4096)).toString('utf8');
  if (/<svg[\s>]/i.test(head) && /\.svg$/i.test(filename)) return 'image/svg+xml';
  if (/\.(txt|md|srt|vtt)$/i.test(filename) && !head.includes('\u0000')) return 'text/plain';
  if (/\.json$/i.test(filename) && !head.includes('\u0000')) return 'application/json';
  return null;
}
/** SVG assets are data: reject scripts, entities and any non-embedded reference. */
export function assertSafeSvg(bytes: Uint8Array): void {
  const text = Buffer.from(bytes).toString('utf8');
  invariant(!/<script|<!ENTITY|<!DOCTYPE[^>]*\[|<foreignObject|javascript:/i.test(text), 'invalid_input', 'SVG assets may not contain scripts, entities or foreign objects');
  for (const m of text.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) invariant((m[1] as string).startsWith('#') || (m[1] as string).startsWith('data:image/'), 'invalid_input', 'SVG assets may not reference external resources');
  invariant(!/url\(\s*["']?(?!#)/i.test(text), 'invalid_input', 'SVG assets may not reference external resources');
}
export const mediaClass = (mediaType: string): 'image' | 'audio' | 'video' | 'document' | 'data' =>
  mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('audio/') ? 'audio' : mediaType.startsWith('video/') ? 'video' : mediaType === 'application/pdf' ? 'document' : 'data';

export type MediaInfo = { [key: string]: Json };
/** Real probe of a file on disk: ffprobe for audio/video, identify for images, pdfinfo for PDF. */
export async function probeFile(path: string, mediaType: string): Promise<MediaInfo> {
  const cls = mediaClass(mediaType);
  try {
    if (mediaType === 'audio/midi') { const m = parseMidiSummary(await readFile(path)); return { probe: 'smf', ...m }; }
    if (cls === 'audio' || cls === 'video') {
      const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { timeoutMs: 60_000 });
      const j = JSON.parse(r.stdout) as { format?: { duration?: string; format_name?: string; bit_rate?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; sample_rate?: string; channels?: number; r_frame_rate?: string; duration?: string }[] };
      return {
        probe: 'ffprobe', duration: Number(j.format?.duration ?? 0), format: j.format?.format_name ?? '', bitRate: Number(j.format?.bit_rate ?? 0),
        streams: (j.streams ?? []).map((s) => ({ type: s.codec_type ?? '', codec: s.codec_name ?? '', ...(s.width ? { width: s.width, height: s.height ?? 0 } : {}), ...(s.sample_rate ? { sampleRate: Number(s.sample_rate), channels: s.channels ?? 0 } : {}), ...(s.r_frame_rate && s.codec_type === 'video' ? { frameRate: s.r_frame_rate } : {}) })),
      };
    }
    if (cls === 'image') {
      const r = await run('identify', ['-format', '%w %h %m %[colorspace] %[channels]\n', `${path}[0]`], { timeoutMs: 60_000 });
      const [w, h, fmt, cs] = r.stdout.trim().split('\n')[0]?.split(' ') ?? [];
      return { probe: 'identify', width: Number(w), height: Number(h), format: fmt ?? '', colorspace: cs ?? '' };
    }
    if (mediaType === 'application/pdf') {
      const r = await run('pdfinfo', [path], { timeoutMs: 60_000 });
      const pages = Number(/Pages:\s+(\d+)/.exec(r.stdout)?.[1] ?? 0);
      return { probe: 'pdfinfo', pages, pageSize: /Page size:\s+(.+)/.exec(r.stdout)?.[1]?.trim() ?? '' };
    }
  } catch (error) {
    if (error instanceof DomainError && error.code === 'cancelled') throw error;
    return { probe: 'failed', error: error instanceof Error ? error.message.slice(0, 300) : 'probe failed' };
  }
  return { probe: 'none' };
}
export function parseMidiSummary(bytes: Uint8Array): { format: number; tracks: number; division: number; noteOns: number } {
  const b = Buffer.from(bytes);
  invariant(b.length >= 14 && b.toString('latin1', 0, 4) === 'MThd', 'invalid_input', 'Not a Standard MIDI File');
  let noteOns = 0, at = 14;
  const tracks = b.readUInt16BE(10);
  for (let t = 0; t < tracks && at + 8 <= b.length; t++) {
    const len = b.readUInt32BE(at + 4); const end = at + 8 + len; let p = at + 8, status = 0;
    while (p < end) {
      while (p < end && ((b[p++] as number) & 0x80) !== 0) { /* delta time */ }
      let s = b[p] as number;
      if ((s & 0x80) !== 0) { status = s; p++; } else s = status;
      if (s === 0xff) { p++; let l = 0, c: number; do { c = b[p++] as number; l = (l << 7) | (c & 0x7f); } while ((c & 0x80) !== 0 && p < end); p += l; }
      else if (s === 0xf0 || s === 0xf7) { let l = 0, c: number; do { c = b[p++] as number; l = (l << 7) | (c & 0x7f); } while ((c & 0x80) !== 0 && p < end); p += l; }
      else { const hi = s & 0xf0; if (hi === 0x90 && (b[p + 1] as number) > 0) noteOns++; p += hi === 0xc0 || hi === 0xd0 ? 1 : 2; }
    }
    at = end;
  }
  return { format: b.readUInt16BE(8), tracks, division: b.readUInt16BE(12), noteOns };
}

// ───────────────────────────── WAV (PCM16) ─────────────────────────────
export type Pcm = { sampleRate: number; channels: number; samples: Float32Array };
export function readWav(bytes: Uint8Array): Pcm {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  invariant(b.length > 44 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE', 'invalid_input', 'Not a WAV file');
  let at = 12, sampleRate = 0, channels = 0, bits = 0, format = 1;
  while (at + 8 <= b.length) {
    const id = b.toString('latin1', at, at + 4); let size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') { format = b.readUInt16LE(at + 8); channels = b.readUInt16LE(at + 10); sampleRate = b.readUInt32LE(at + 12); bits = b.readUInt16LE(at + 22); }
    else if (id === 'data') {
      if (size === 0xffffffff || at + 8 + size > b.length) size = b.length - at - 8;
      invariant((format === 1 || format === 0xfffe) && bits === 16 && channels > 0, 'invalid_input', 'Only 16-bit PCM WAV is supported');
      const n = Math.floor(size / 2); const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(at + 8 + i * 2) / 32768;
      return { sampleRate, channels, samples };
    }
    at += 8 + size + (size % 2);
  }
  throw new DomainError('invalid_input', 'WAV file has no data chunk');
}
export function writeWav(pcm: Pcm): Uint8Array {
  const n = pcm.samples.length; const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(pcm.channels, 22); b.writeUInt32LE(pcm.sampleRate, 24); b.writeUInt32LE(pcm.sampleRate * pcm.channels * 2, 28); b.writeUInt16LE(pcm.channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(clamp(pcm.samples[i] as number, -1, 1) * 32767), 44 + i * 2);
  return b;
}
/** Fundamental frequency of the voiced part of a mono signal by normalised autocorrelation; null when unvoiced. */
export function estimateF0(pcm: Pcm, minHz = 70, maxHz = 400): number | null {
  const x = pcm.samples; const sr = pcm.sampleRate;
  const win = Math.min(x.length, Math.floor(sr * 0.25));
  if (win < sr * 0.03) return null;
  // analyse the loudest window
  let best = 0, bestE = 0; const hop = Math.max(1, Math.floor(win / 4));
  for (let s = 0; s + win <= x.length; s += hop) { let e = 0; for (let i = s; i < s + win; i += 4) e += (x[i] as number) ** 2; if (e > bestE) { bestE = e; best = s; } }
  if (bestE < 1e-4) return null;
  const lo = Math.floor(sr / maxHz), hi = Math.min(Math.floor(sr / minHz), win - 1);
  let r0 = 0; for (let i = best; i < best + win; i++) r0 += (x[i] as number) ** 2;
  let bestLag = 0, bestR = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let r = 0; for (let i = best; i + lag < best + win; i++) r += (x[i] as number) * (x[i + lag] as number);
    const nr = r / (r0 * (1 - lag / win) + 1e-9);
    if (nr > bestR * 1.05) { bestR = nr; bestLag = lag; }
  }
  return bestR > 0.35 && bestLag > 0 ? sr / bestLag : null;
}

// ───────────────────────────── Font metrics (TrueType hmtx/cmap) ─────────────────────────────
type FontMetrics = { unitsPerEm: number; ascent: number; descent: number; advance: (cp: number) => number; file: string; family: string };
const fontCache = new Map<string, FontMetrics | null>();
const fontFileCache = new Map<string, { file: string; family: string } | null>();
/** Font families the scene graph and layouts accept (installed DejaVu / Noto). Anything else falls back to DejaVu Sans. */
export const FONT_FAMILIES: readonly string[] = ['DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Noto Sans', 'Noto Serif', 'Noto Sans Mono'];
export const fontFamily = (name: unknown): string => (typeof name === 'string' && FONT_FAMILIES.includes(name) ? name : 'DejaVu Sans');

async function resolveFontFile(family: string, bold: boolean, italic: boolean): Promise<{ file: string; family: string } | null> {
  const key = `${family}|${bold}|${italic}`;
  if (fontFileCache.has(key)) return fontFileCache.get(key) ?? null;
  let out: { file: string; family: string } | null = null;
  try {
    const r = await run('fc-match', ['-f', '%{file}\n%{family}', `${fontFamily(family)}:weight=${bold ? 'bold' : 'regular'}:slant=${italic ? 'italic' : 'roman'}`], { timeoutMs: 20_000 });
    const [file, fam] = r.stdout.split('\n');
    if (file !== undefined && /\.ttf$/i.test(file)) out = { file, family: (fam ?? '').split(',')[0] ?? '' };
  } catch { out = null; }
  fontFileCache.set(key, out);
  return out;
}
function parseTtf(file: string, family: string): FontMetrics | null {
  try {
    const b = readFileSync(file);
    const numTables = b.readUInt16BE(4); const tables = new Map<string, number>();
    for (let i = 0; i < numTables; i++) tables.set(b.toString('latin1', 12 + i * 16, 16 + i * 16), b.readUInt32BE(12 + i * 16 + 8));
    const head = tables.get('head'), hhea = tables.get('hhea'), hmtx = tables.get('hmtx'), cmap = tables.get('cmap');
    if (head === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) return null;
    const unitsPerEm = b.readUInt16BE(head + 18); const ascent = b.readInt16BE(hhea + 4); const descent = b.readInt16BE(hhea + 6); const nH = b.readUInt16BE(hhea + 34);
    const n = b.readUInt16BE(cmap + 2); let sub12 = -1, sub4 = -1;
    for (let i = 0; i < n; i++) { const off = cmap + b.readUInt32BE(cmap + 4 + i * 8 + 4); const fmt = b.readUInt16BE(off); if (fmt === 12) sub12 = off; else if (fmt === 4) sub4 = off; }
    const glyph = (cp: number): number => {
      if (sub12 >= 0) {
        const groups = b.readUInt32BE(sub12 + 12); let lo = 0, hi = groups - 1;
        while (lo <= hi) { const mid = (lo + hi) >> 1; const g = sub12 + 16 + mid * 12; const s = b.readUInt32BE(g), e = b.readUInt32BE(g + 4); if (cp < s) hi = mid - 1; else if (cp > e) lo = mid + 1; else return b.readUInt32BE(g + 8) + cp - s; }
        return 0;
      }
      if (sub4 >= 0 && cp <= 0xffff) {
        const segX2 = b.readUInt16BE(sub4 + 6); const endAt = sub4 + 14, startAt = endAt + segX2 + 2, deltaAt = startAt + segX2, rangeAt = deltaAt + segX2;
        for (let i = 0; i < segX2; i += 2) {
          if (cp <= b.readUInt16BE(endAt + i)) {
            const start = b.readUInt16BE(startAt + i); if (cp < start) return 0;
            const ro = b.readUInt16BE(rangeAt + i); const delta = b.readInt16BE(deltaAt + i);
            if (ro === 0) return (cp + delta) & 0xffff;
            const g = b.readUInt16BE(rangeAt + i + ro + (cp - start) * 2); return g === 0 ? 0 : (g + delta) & 0xffff;
          }
        }
      }
      return 0;
    };
    const advCache = new Map<number, number>();
    const advance = (cp: number): number => {
      let a = advCache.get(cp);
      if (a === undefined) { const g = glyph(cp); a = b.readUInt16BE(hmtx + Math.min(g, nH - 1) * 4); advCache.set(cp, a); }
      return a;
    };
    return { unitsPerEm, ascent, descent, advance, file, family };
  } catch { return null; }
}
export async function loadFont(family: string, bold = false, italic = false): Promise<FontMetrics | null> {
  const key = `${fontFamily(family)}|${bold}|${italic}`;
  if (fontCache.has(key)) return fontCache.get(key) ?? null;
  const f = await resolveFontFile(family, bold, italic);
  const m = f === null ? null : parseTtf(f.file, f.family);
  fontCache.set(key, m);
  return m;
}
/** Text measurer for a font at a size, using real glyph advances (falls back to 0.56em when the font cannot be read). */
export async function measurer(family: string, size: number, bold = false, italic = false): Promise<(text: string) => number> {
  const f = await loadFont(family, bold, italic);
  return (text: string): number => {
    let w = 0;
    for (const ch of text) w += f === null ? 0.56 * size : (f.advance(ch.codePointAt(0) as number) / f.unitsPerEm) * size;
    return w;
  };
}
/** Greedy word wrap to a pixel width; explicit newlines are kept; over-long words are split. */
export function wrapText(text: string, maxWidth: number, measure: (t: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (let word of para.split(/\s+/).filter((w) => w !== '')) {
      while (measure(word) > maxWidth && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && measure(`${line === '' ? '' : `${line} `}${word.slice(0, cut)}`) > maxWidth) cut--;
        if (line !== '' && cut <= 1) { out.push(line); line = ''; continue; }
        out.push(`${line === '' ? '' : `${line} `}${word.slice(0, cut)}`); line = ''; word = word.slice(cut);
      }
      const candidate = line === '' ? word : `${line} ${word}`;
      if (measure(candidate) <= maxWidth || line === '') line = candidate; else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

export async function writeFiles(dir: string, files: Readonly<Record<string, Uint8Array | string>>): Promise<void> {
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
}
/** Loudness (integrated LUFS) and true peak of an audio file measured with ffmpeg's ebur128 scanner. */
export async function measureLoudness(path: string, signal?: AbortSignal): Promise<{ integrated: number; truePeak: number } | null> {
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { timeoutMs: 300_000, allowFail: true, ...(signal === undefined ? {} : { signal }) });
  const tail = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const i = /I:\s+(-?[\d.]+) LUFS/.exec(tail), p = /Peak:\s+(-?[\d.]+) dBFS/.exec(tail);
  return i === null ? null : { integrated: Number(i[1]), truePeak: p === null ? 0 : Number(p[1]) };
}
/** Runs ffmpeg with `-progress` and reports the encoded position as a fraction of `totalSeconds` (real tool output). */
export async function ffmpeg(args: readonly string[], options: RunOptions & { totalSeconds?: number; onProgress?: (fraction: number) => void } = {}): Promise<RunResult> {
  let buf = '';
  return run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', ...args], {
    timeoutMs: 900_000, ...options,
    onStdout: (chunk) => {
      buf += chunk; const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) { const m = /^out_time_(?:us|ms)=(\d+)/.exec(line); if (m !== null && options.totalSeconds !== undefined && options.totalSeconds > 0) options.onProgress?.(clamp(Number(m[1]) / 1e6 / options.totalSeconds, 0, 1)); }
    },
  });
}
