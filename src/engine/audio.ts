// Music and audio rendering: MIDI → per-track stems (fluidsynth + GM SoundFont), synthetic guide vocal (espeak-ng,
// pitch/time fitted with sox), mixdown and loudness normalisation (ffmpeg), plus narration/podcast programmes.
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { clamp, estimateF0, ffmpeg, measureLoudness, readWav, run, safeName, writeWav } from './tools.ts';
import type { Pcm } from './tools.ts';
import { applySongOp, audibleTracks, compose, lyricSheet, sectionStarts, songSeconds, validateSong, writeMidi } from './music.ts';
import { arr, basisLabel, bool, collectAssets, collectSources, collectText, disclosureText, idOf, isObj, n, needsDisclosure, objs, str, uniqueIds, urefs } from './types.ts';
import type { Disclosure, Doc, EditorialExport, Pipeline, PipelineResult, RenderEnv, RenderOutput } from './types.ts';

export const SOUNDFONT = process.env.E10_SOUNDFONT ?? '/usr/share/sounds/sf2/FluidR3_GM.sf2';
export const SYNTHETIC_VOICE_NOTICE = 'Voice is synthetic speech generated with espeak-ng; it is not a recording of a person.';
const VOICE = /^[a-z]{2,3}(-[a-z0-9]{1,8})*(\+[a-z0-9]{1,8})?$/i;

/** Text-to-speech with espeak-ng (clearly synthetic). Returns the duration in seconds of the WAV written to `out`. */
export async function synthSpeech(env: RenderEnv, text: string, out: string, options: { voice?: string; speed?: number; pitch?: number } = {}): Promise<number> {
  await env.tool('espeak-ng');
  const input = `${out}.txt`; await writeFile(input, text.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' '));
  await run('espeak-ng', ['-v', VOICE.test(options.voice ?? '') ? options.voice as string : 'en', '-s', String(Math.round(clamp(options.speed ?? 155, 80, 300))), '-p', String(Math.round(clamp(options.pitch ?? 45, 0, 99))), '-w', out, '-f', input], { signal: env.signal, timeoutMs: 120_000 });
  const pcm = readWav(await readFile(out)); invariant(pcm.samples.length > 0, 'tool_failed', 'Speech synthesis produced no audio');
  return pcm.samples.length / pcm.sampleRate / pcm.channels;
}
/** Two-pass EBU R128 normalisation (ffmpeg loudnorm): measure, then apply with the measured values so the target is met. */
export async function normalizeLoudness(env: RenderEnv, input: string, output: string, target: number, duration: number, onProgress?: (f: number) => void): Promise<void> {
  const spec = `loudnorm=I=${target}:TP=-1.5:LRA=11`;
  const pass1 = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', input, '-af', `${spec}:print_format=json`, '-f', 'null', '-'], { signal: env.signal, timeoutMs: 900_000 });
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(pass1.stderr); let filter = spec;
  if (m !== null) { const j = JSON.parse(m[0]) as Record<string, string>; if ([j.input_i, j.input_tp, j.input_lra, j.input_thresh].every((v) => Number.isFinite(Number(v)))) filter = `${spec}:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${Number.isFinite(Number(j.target_offset)) ? j.target_offset : '0'}:linear=true`; }
  await ffmpeg(['-i', input, '-af', `${filter},aresample=44100`, '-c:a', 'pcm_s16le', '-ar', '44100', output], { signal: env.signal, totalSeconds: duration, ...(onProgress === undefined ? {} : { onProgress }) });
}
function trimSilence(pcm: Pcm, threshold = 0.02): Pcm {
  const x = pcm.samples; let a = 0, b = x.length - 1;
  while (a < b && Math.abs(x[a] as number) < threshold) a++; while (b > a && Math.abs(x[b] as number) < threshold) b--;
  const pad = Math.floor(pcm.sampleRate * 0.005); a = Math.max(0, a - pad); b = Math.min(x.length - 1, b + pad);
  return { ...pcm, samples: x.slice(a, b + 1) };
}
/** Sung guide: each syllable is spoken, pitch-shifted to its melody note (octave-folded) and time-fitted to the note. */
async function guideVocal(doc: Doc, env: RenderEnv, out: string): Promise<{ syllables: number; pitched: number; style: string } | null> {
  const guide = doc.guide as Doc; const lead = audibleTracks(doc).find((t) => t.role === 'lead'); if (guide.enabled !== true || lead === undefined) return null;
  const starts = sectionStarts(doc); const spb = 60 / (doc.tempo as number);
  const notes = objs(lead.notes).filter((x) => typeof x.syl === 'string' && starts.has(x.section as string)).map((x) => ({ t: ((starts.get(x.section as string) as number) + (x.start as number)) * spb, d: (x.dur as number) * spb, pitch: x.pitch as number, syl: (x.syl as string), section: x.section as string })).sort((a, b) => a.t - b.t);
  if (notes.length === 0) return null;
  await env.tool('espeak-ng', 'sox');
  const sr = 22050; const total = new Float32Array(Math.ceil((songSeconds(doc) + 2) * sr)); let pitched = 0; const voice = str(guide.voice, 'en');
  const place = (pcm: Pcm, at: number, maxLen: number): void => { const s0 = Math.round(at * sr); const len = Math.min(pcm.samples.length, Math.round(maxLen * sr)); const fade = Math.min(Math.floor(sr * 0.01), Math.floor(len / 2)); for (let i = 0; i < len && s0 + i < total.length; i++) { const g = i < fade ? i / fade : i > len - fade ? (len - i) / fade : 1; total[s0 + i] = (total[s0 + i] as number) + (pcm.samples[i] as number) * g; } };
  if (guide.style === 'spoken') {
    // Rhythmic spoken guide: each lyric phrase is spoken once and time-fitted to the span of its notes.
    const groups: (typeof notes)[] = []; for (const nt of notes) { const g = groups[groups.length - 1]; const prev = g?.[g.length - 1]; if (g === undefined || prev === undefined || prev.section !== nt.section || nt.t - (prev.t + prev.d) > spb * 0.75) groups.push([nt]); else g.push(nt); }
    for (const [gi, g] of groups.entries()) {
      const text = g.map((x) => (x.syl.endsWith('-') ? x.syl.slice(0, -1) : `${x.syl} `)).join('').trim(); const raw = join(env.dir, `guide-${gi}.wav`);
      await synthSpeech(env, text, raw, { voice, speed: 150 }); const first = g[0] as (typeof notes)[number], last = g[g.length - 1] as (typeof notes)[number]; const span = last.t + last.d - first.t;
      const pcm = trimSilence(readWav(await readFile(raw))); const factor = clamp(pcm.samples.length / sr / span, 0.6, 1.8); const fitted = join(env.dir, `guide-${gi}-fit.wav`);
      await writeFile(raw, writeWav(pcm)); await run('sox', [raw, fitted, 'tempo', '-s', factor.toFixed(4)], { signal: env.signal });
      place(readWav(await readFile(fitted)), first.t, span + 0.2); env.progress(0.45 + 0.15 * (gi / groups.length), 'guide vocal (spoken)');
    }
  } else {
    for (const [i, nt] of notes.entries()) {
      const raw = join(env.dir, `syl-${i}.wav`), fitted = join(env.dir, `syl-${i}-fit.wav`);
      await synthSpeech(env, nt.syl.replace(/-$/, ''), raw, { voice, speed: 120, pitch: 50 });
      const pcm = trimSilence(readWav(await readFile(raw))); if (pcm.samples.length < sr * 0.02) continue;
      await writeFile(raw, writeWav(pcm));
      const f0 = estimateF0(pcm); const effects: string[] = [];
      if (f0 !== null) { let cents = 1200 * Math.log2((440 * 2 ** ((nt.pitch - 69) / 12)) / f0); while (cents > 600) cents -= 1200; while (cents < -600) cents += 1200; effects.push('pitch', cents.toFixed(1)); pitched++; }
      const target = Math.max(0.09, nt.d * 0.96); effects.push('tempo', '-s', clamp(pcm.samples.length / sr / target, 0.35, 2.5).toFixed(4));
      await run('sox', [raw, fitted, ...effects], { signal: env.signal });
      place(readWav(await readFile(fitted)), nt.t, target + 0.05);
      if (i % 8 === 0) env.progress(0.45 + 0.15 * (i / notes.length), 'guide vocal (sung)');
    }
  }
  let peak = 0; for (const v of total) peak = Math.max(peak, Math.abs(v)); if (peak > 0) for (let i = 0; i < total.length; i++) total[i] = ((total[i] as number) / peak) * 0.8;
  await writeFile(out, writeWav({ sampleRate: sr, channels: 1, samples: total }));
  return { syllables: notes.length, pitched, style: str(guide.style) };
}
async function synth(env: RenderEnv, midi: Uint8Array, name: string, rate: number): Promise<string> {
  try { await access(SOUNDFONT); } catch { throw new DomainError('unavailable', `General MIDI SoundFont not found at ${SOUNDFONT}`); }
  const mid = join(env.dir, `${name}.mid`), wav = join(env.dir, `${name}.wav`); await writeFile(mid, midi);
  await run('fluidsynth', ['-ni', '-q', '-F', wav, '-r', String(rate), '-g', '0.7', '-R', '0', '-C', '0', SOUNDFONT, mid], { signal: env.signal, timeoutMs: 600_000 });
  return wav;
}
type Stem = { path: string; volume: number; pan: number };
/** ffmpeg mix graph: per-stem gain and constant-power pan, sum, low cut, optional shelf, reverb send, compressor, fades, loudnorm, limiter. */
export function mixGraph(stems: readonly Stem[], mix: Doc, duration: number, final: boolean): string {
  const parts = stems.map((s, i) => { const a = ((s.pan + 1) / 2) * (Math.PI / 2); return `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${s.volume.toFixed(3)},pan=stereo|c0=${(Math.cos(a) * Math.SQRT2).toFixed(4)}*c0|c1=${(Math.sin(a) * Math.SQRT2).toFixed(4)}*c1[s${i}]`; });
  const chain: string[] = [`${stems.map((_, i) => `[s${i}]`).join('')}amix=inputs=${stems.length}:normalize=0:duration=longest`, `apad=whole_dur=${duration.toFixed(3)}`, `atrim=duration=${duration.toFixed(3)}`];
  if ((mix.lowCut as number) > 0) chain.push(`highpass=f=${mix.lowCut}`);
  if ((mix.highShelf as number) !== 0) chain.push(`treble=g=${mix.highShelf}:f=6000`);
  const rv = mix.reverb as number; if (rv > 0) chain.push(`aecho=0.8:${(0.3 + rv * 0.5).toFixed(2)}:43|71|113:${(rv * 0.35).toFixed(3)}|${(rv * 0.25).toFixed(3)}|${(rv * 0.15).toFixed(3)}`);
  if (mix.compression === true) chain.push('acompressor=threshold=0.25:ratio=3:attack=15:release=180:makeup=1.5');
  if ((mix.fadeIn as number) > 0) chain.push(`afade=t=in:st=0:d=${mix.fadeIn}`);
  if ((mix.fadeOut as number) > 0) chain.push(`afade=t=out:st=${Math.max(0, duration - (mix.fadeOut as number)).toFixed(3)}:d=${mix.fadeOut}`);
  void final;
  return `${parts.join(';')};${chain.join(',')}[out]`;
}
async function encodeAll(env: RenderEnv, wav: string, base: string, duration: number, meta: Readonly<Record<string, string>>, outputs: RenderOutput[]): Promise<void> {
  const tags = Object.entries(meta).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  for (const [ext, type, codec] of [['flac', 'audio/flac', ['-c:a', 'flac']], ['mp3', 'audio/mpeg', ['-c:a', 'libmp3lame', '-q:a', '2']], ['ogg', 'audio/ogg', ['-c:a', 'libvorbis', '-q:a', '5']]] as const) {
    const p = join(env.dir, `${base}.${ext}`); await ffmpeg(['-i', wav, ...codec, ...tags, p], { signal: env.signal, totalSeconds: duration });
    outputs.push({ name: `${base}.${ext}`, path: p, mediaType: type, role: 'primary' });
  }
}
function songDisclosures(doc: Doc): Disclosure[] { return objs(doc.sections).filter((s) => needsDisclosure(s.basis)).map((s) => ({ basis: str(s.basis), text: str(s.disclosure), where: 'lyric sheet, file metadata and credits', blockId: s.id as string })); }

async function renderSong(doc: Doc, env: RenderEnv): Promise<PipelineResult> {
  await env.tool('fluidsynth', 'ffmpeg', 'ffprobe');
  const base = safeName(str(doc.title, 'song')).replace(/\.+$/, '') || 'song'; const outputs: RenderOutput[] = []; const tracks = audibleTracks(doc);
  invariant(tracks.some((t) => objs(t.notes).length > 0), 'invalid_input', 'The song has no audible notes (all tracks are empty or muted)');
  const seconds = songSeconds(doc); const duration = seconds + 2; const disclosures = songDisclosures(doc); const generated: Json[] = [];
  const params = { tempo: doc.tempo as number, key: doc.key as Json, timeSignature: doc.timeSignature as Json, seed: str(doc.seed), mood: str(doc.mood), soundfont: SOUNDFONT.split('/').pop() as string, tracks: tracks.map((t) => ({ id: t.id as string, program: t.program as number, volume: t.volume as number, pan: t.pan as number })), mix: doc.mix as Json };
  if (env.profile === 'preview') {
    env.progress(0.2, 'synthesise (preview)');
    const wav = await synth(env, writeMidi(doc, { tailBeats: 2 }), 'preview', 22050); const limit = clamp(n(env.options.previewSeconds, 45), 5, 600);
    const p = join(env.dir, `${base}.preview.mp3`); await ffmpeg(['-i', wav, '-t', String(limit), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '96k', p], { signal: env.signal, totalSeconds: Math.min(limit, duration), onProgress: (f) => env.progress(0.5 + f * 0.5, 'encode preview') });
    return { outputs: [{ name: `${base}.preview.mp3`, path: p, mediaType: 'audio/mpeg', role: 'preview' }], parameters: { ...params, preview: true }, disclosures, credits: [...arr(doc.credits) as string[], ...env.credits()], generated };
  }
  const midiPath = join(env.dir, `${base}.mid`); await writeFile(midiPath, writeMidi(doc)); outputs.push({ name: `${base}.mid`, path: midiPath, mediaType: 'audio/midi', role: 'primary' });
  const sheet = join(env.dir, `${base}-lyrics.txt`); await writeFile(sheet, lyricSheet(doc)); outputs.push({ name: `${base}-lyrics.txt`, path: sheet, mediaType: 'text/plain', role: 'sidecar' });
  const stems: Stem[] = [];
  for (const [i, t] of tracks.entries()) {
    env.progress(0.05 + 0.4 * (i / tracks.length), `stem ${i + 1}/${tracks.length}: ${str(t.name)}`);
    if (objs(t.notes).length === 0) continue;
    const wav = await synth(env, writeMidi(doc, { only: t.id as string, tailBeats: 4 }), `stem-${String(t.id)}`, 44100);
    stems.push({ path: wav, volume: t.volume as number, pan: t.pan as number });
    const flac = join(env.dir, `stem-${String(t.id)}.flac`); await ffmpeg(['-i', wav, '-c:a', 'flac', flac], { signal: env.signal }); outputs.push({ name: `stem-${String(t.id)}.flac`, path: flac, mediaType: 'audio/flac', role: 'stem' });
    generated.push({ kind: 'stem', track: t.id as string, tool: 'fluidsynth', program: t.program as number, notes: objs(t.notes).length });
  }
  const guidePath = join(env.dir, 'stem-guide-vocal.wav'); const g = await guideVocal(doc, env, guidePath); const credits = [...arr(doc.credits) as string[], ...env.credits()];
  if (g !== null) {
    stems.push({ path: guidePath, volume: (doc.guide as Doc).gain as number, pan: 0 });
    const flac = join(env.dir, 'stem-guide-vocal.flac'); await ffmpeg(['-i', guidePath, '-c:a', 'flac', flac], { signal: env.signal }); outputs.push({ name: 'stem-guide-vocal.flac', path: flac, mediaType: 'audio/flac', role: 'stem' });
    generated.push({ kind: 'guide-vocal', tool: 'espeak-ng + sox', synthetic: true, style: g.style, syllables: g.syllables, pitchFitted: g.pitched, note: g.style === 'sung' ? 'Syllables are synthetic speech pitch-shifted to the melody (octave-folded) and time-fitted to each note; a guide, not a performance.' : 'Synthetic speech, time-fitted per phrase (rhythmic spoken guide).' });
    credits.push(`Guide vocal: ${SYNTHETIC_VOICE_NOTICE}`);
  }
  env.progress(0.62, 'mix');
  const wav = join(env.dir, `${base}.wav`);
  const premix = join(env.dir, 'premix.wav');
  await ffmpeg([...stems.flatMap((s) => ['-i', s.path]), '-filter_complex', mixGraph(stems, doc.mix as Doc, duration, true), '-map', '[out]', '-c:a', 'pcm_s24le', '-ar', '44100', premix], { signal: env.signal, totalSeconds: duration, onProgress: (f) => env.progress(0.62 + f * 0.12, 'mix') });
  await normalizeLoudness(env, premix, wav, (doc.mix as Doc).loudness as number, duration, (f) => env.progress(0.74 + f * 0.1, 'loudness normalisation'));
  outputs.unshift({ name: `${base}.wav`, path: wav, mediaType: 'audio/wav', role: 'primary' });
  env.progress(0.85, 'encode');
  await encodeAll(env, wav, base, duration, { title: str(doc.title), comment: [g !== null ? SYNTHETIC_VOICE_NOTICE : '', ...disclosures.map((d) => `${basisLabel(d.basis)}: ${d.text}`)].filter((x) => x !== '').join(' | ').slice(0, 900) }, outputs);
  const loud = await measureLoudness(wav, env.signal); const target = (doc.mix as Doc).loudness as number;
  return { outputs, parameters: params, disclosures, credits, generated,
    details: { requiredDisclosures: disclosures.map((d) => d.blockId ?? ''), durationSeconds: duration, loudness: loud as Json, qc: [{ check: 'loudness', ok: loud !== null && Math.abs(loud.integrated - target) <= 2, detail: `${String(loud?.integrated)} LUFS (target ${target})` }] } };
}

// ───────────────────────────── narration / podcast programmes ─────────────────────────────
function validateProgram(raw: Doc): Doc {
  const clips = objs(raw.clips).map((c) => {
    const src = isObj(c.source) ? c.source : {}; const basis = str(c.basis, '', 40);
    const source: Doc = src.type === 'asset' ? { type: 'asset', assetId: (invariant(typeof src.assetId === 'string' && src.assetId !== '', 'invalid_input', 'Asset clip needs assetId'), src.assetId as string), ...(typeof src.assetVersion === 'number' ? { assetVersion: src.assetVersion } : {}) }
      : { type: 'tts', text: (invariant(typeof src.text === 'string' && src.text.trim() !== '', 'invalid_input', 'Narration clip needs text'), (src.text as string).slice(0, 20000)), voice: VOICE.test(str(src.voice)) ? str(src.voice) : 'en', speed: n(src.speed, 155, 80, 300) };
    return { id: idOf(c.id, 'clip'), track: ['narration', 'music', 'clip'].includes(str(c.track)) ? str(c.track) : source.type === 'tts' ? 'narration' : 'clip', source, start: n(c.start, 0, 0, 86400), ...(typeof c.follow === 'number' ? { follow: n(c.follow, 0.4, 0, 600) } : {}), trimStart: n(c.trimStart, 0, 0, 86400), ...(typeof c.duration === 'number' ? { duration: n(c.duration, 1, 0.05, 86400) } : {}), gain: n(c.gain, 0, -60, 24), fadeIn: n(c.fadeIn, 0, 0, 60), fadeOut: n(c.fadeOut, 0, 0, 60),
      ...(basis === '' ? {} : { basis }), ...(needsDisclosure(basis) ? { disclosure: disclosureText(basis, c.disclosure) } : {}), ...(urefs(c.sources).length > 0 ? { sources: urefs(c.sources) } : {}) };
  });
  invariant(clips.length <= 500, 'invalid_input', 'Too many clips'); uniqueIds(clips, 'clip');
  const d = isObj(raw.ducking) ? raw.ducking : {}; const mix = isObj(raw.mix) ? raw.mix : {};
  return { kind: 'audio', mode: 'program', title: str(raw.title, 'Untitled', 300), clips, ducking: { enabled: bool(d.enabled, true), threshold: n(d.threshold, 0.03, 0.001, 1), ratio: n(d.ratio, 8, 1, 20), attack: n(d.attack, 40, 1, 2000), release: n(d.release, 500, 10, 9000) },
    mix: { loudness: n(mix.loudness, -16, -30, -9), reverb: 0, fadeIn: n(mix.fadeIn, 0, 0, 20), fadeOut: n(mix.fadeOut, 0, 0, 20), compression: bool(mix.compression, false), lowCut: n(mix.lowCut, 60, 0, 400), highShelf: 0 }, sources: urefs(raw.sources), credits: arr(raw.credits).filter((c): c is string => typeof c === 'string').slice(0, 100) };
}
async function renderProgram(doc: Doc, env: RenderEnv): Promise<PipelineResult> {
  await env.tool('ffmpeg', 'ffprobe');
  const base = safeName(str(doc.title, 'programme')).replace(/\.+$/, '') || 'programme'; const clips = objs(doc.clips); invariant(clips.length > 0, 'invalid_input', 'The programme has no clips');
  const generated: Json[] = []; const disclosures: Disclosure[] = []; const transcript: string[] = [str(doc.title), '']; let synthetic = false;
  type Item = { path: string; start: number; trimStart: number; dur: number; gain: number; fadeIn: number; fadeOut: number; bus: 'voice' | 'music' };
  const items: Item[] = []; let voiceEnd = 0; const stamp = (t: number): string => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  for (const [i, c] of clips.entries()) {
    const src = c.source as Doc; let path: string, full: number;
    if (src.type === 'tts') { path = join(env.dir, `tts-${i}.wav`); full = await synthSpeech(env, str(src.text), path, { voice: str(src.voice), speed: src.speed as number }); synthetic = true; generated.push({ kind: 'speech', clip: c.id as string, tool: 'espeak-ng', synthetic: true, voice: str(src.voice), speed: src.speed as number, seconds: Math.round(full * 100) / 100 }); }
    else { const a = await env.asset(src.assetId as string, typeof src.assetVersion === 'number' ? src.assetVersion : undefined); invariant(a.mediaType.startsWith('audio/') || a.mediaType.startsWith('video/'), 'invalid_input', `Asset ${a.name} is not audio`); path = a.path; full = n((a.mediaInfo as Doc).duration, 0); invariant(full > 0, 'invalid_input', `Asset ${a.name} has no audio duration`); }
    const dur = Math.min(typeof c.duration === 'number' ? c.duration : full - (c.trimStart as number), full - (c.trimStart as number)); invariant(dur > 0, 'invalid_input', `Clip ${String(c.id)} is trimmed to nothing`);
    // `follow` places a clip after the previous voice clip (real synthesised length), so narration never overlaps itself.
    const start = typeof c.follow === 'number' ? voiceEnd + (voiceEnd === 0 ? 0 : c.follow) : c.start as number; if (c.track !== 'music') voiceEnd = Math.max(voiceEnd, start + dur);
    items.push({ path, start, trimStart: c.trimStart as number, dur, gain: c.gain as number, fadeIn: c.fadeIn as number, fadeOut: c.fadeOut as number, bus: c.track === 'music' ? 'music' : 'voice' });
    if (needsDisclosure(c.basis)) disclosures.push({ basis: str(c.basis), text: str(c.disclosure), where: 'spoken end note, transcript and credits', blockId: c.id as string });
    if (src.type === 'tts') transcript.push(`[${stamp(start)}]${needsDisclosure(c.basis) ? ` [${basisLabel(str(c.basis))}]` : ''} ${str(src.text)}`);
    env.progress(0.3 * ((i + 1) / clips.length), 'prepare clips');
  }
  let end = Math.max(...items.map((x) => x.start + x.dur));
  if (disclosures.length > 0) { // disclosures are made audible, not only written
    const text = `Disclosure. ${disclosures.map((d) => d.text).join(' ')}`; const p = join(env.dir, 'tts-disclosure.wav'); const d = await synthSpeech(env, text, p, {}); synthetic = true;
    items.push({ path: p, start: end + 0.6, trimStart: 0, dur: d, gain: 0, fadeIn: 0, fadeOut: 0, bus: 'voice' }); transcript.push(`[${stamp(end + 0.6)}] ${text}`); generated.push({ kind: 'speech', clip: 'disclosure-end-note', tool: 'espeak-ng', synthetic: true }); end += 0.6 + d;
  }
  const duration = end + 0.5; const duck = doc.ducking as Doc; const mix = doc.mix as Doc;
  const f: string[] = items.map((x, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${x.trimStart.toFixed(3)}:duration=${x.dur.toFixed(3)},asetpts=PTS-STARTPTS${x.fadeIn > 0 ? `,afade=t=in:st=0:d=${Math.min(x.fadeIn, x.dur).toFixed(3)}` : ''}${x.fadeOut > 0 ? `,afade=t=out:st=${Math.max(0, x.dur - x.fadeOut).toFixed(3)}:d=${Math.min(x.fadeOut, x.dur).toFixed(3)}` : ''},volume=${x.gain.toFixed(2)}dB,adelay=${Math.round(x.start * 1000)}:all=1[c${i}]`);
  const bus = (name: 'voice' | 'music'): string | null => { const ix = items.map((x, i) => (x.bus === name ? i : -1)).filter((i) => i >= 0); if (ix.length === 0) return null; f.push(`${ix.map((i) => `[c${i}]`).join('')}amix=inputs=${ix.length}:normalize=0:duration=longest,apad=whole_dur=${duration.toFixed(3)},atrim=duration=${duration.toFixed(3)}[${name}]`); return name; };
  const voice = bus('voice'), music = bus('music'); let last = voice ?? music as string;
  if (voice !== null && music !== null) {
    if (duck.enabled === true) { f.push('[voice]asplit=2[voice_mix][voice_key]', `[music][voice_key]sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}:attack=${duck.attack}:release=${duck.release}[ducked]`, '[voice_mix][ducked]amix=inputs=2:normalize=0:duration=longest[sum]'); }
    else f.push('[voice][music]amix=inputs=2:normalize=0:duration=longest[sum]');
    last = 'sum';
  }
  const tail = [(mix.lowCut as number) > 0 ? `highpass=f=${mix.lowCut}` : 'anull', ...((mix.fadeIn as number) > 0 ? [`afade=t=in:st=0:d=${mix.fadeIn}`] : []), ...((mix.fadeOut as number) > 0 ? [`afade=t=out:st=${Math.max(0, duration - (mix.fadeOut as number)).toFixed(3)}:d=${mix.fadeOut}`] : [])];
  f.push(`[${last}]${tail.join(',')}[out]`);
  const credits = [...arr(doc.credits) as string[], ...env.credits(), ...(synthetic ? [`Narration: ${SYNTHETIC_VOICE_NOTICE}`] : [])]; const params = { clips: clips.length, ducking: duck, mix, durationSeconds: Math.round(duration * 100) / 100 };
  const inputs = items.flatMap((x) => ['-i', x.path]);
  if (env.profile === 'preview') {
    const p = join(env.dir, `${base}.preview.mp3`); await ffmpeg([...inputs, '-filter_complex', f.join(';'), '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', p], { signal: env.signal, totalSeconds: duration, onProgress: (x) => env.progress(0.3 + x * 0.7, 'mix preview') });
    return { outputs: [{ name: `${base}.preview.mp3`, path: p, mediaType: 'audio/mpeg', role: 'preview' }], parameters: { ...params, preview: true }, disclosures, credits, generated };
  }
  const wav = join(env.dir, `${base}.wav`); const outputs: RenderOutput[] = [{ name: `${base}.wav`, path: wav, mediaType: 'audio/wav', role: 'primary' }];
  const premix = join(env.dir, 'premix.wav');
  await ffmpeg([...inputs, '-filter_complex', f.join(';'), '-map', '[out]', '-c:a', 'pcm_s24le', '-ar', '44100', premix], { signal: env.signal, totalSeconds: duration, onProgress: (x) => env.progress(0.3 + x * 0.35, 'mix') });
  await normalizeLoudness(env, premix, wav, mix.loudness as number, duration, (x) => env.progress(0.65 + x * 0.15, 'loudness normalisation'));
  await encodeAll(env, wav, base, duration, { title: str(doc.title), comment: [synthetic ? SYNTHETIC_VOICE_NOTICE : '', ...disclosures.map((d) => `${basisLabel(d.basis)}: ${d.text}`)].filter((x) => x !== '').join(' | ').slice(0, 900) }, outputs);
  const tp = join(env.dir, `${base}-transcript.txt`); await writeFile(tp, `${transcript.join('\n')}\n\n${credits.map((c) => `Credit: ${c}`).join('\n')}\n`); outputs.push({ name: `${base}-transcript.txt`, path: tp, mediaType: 'text/plain', role: 'sidecar' });
  const loud = await measureLoudness(wav, env.signal);
  return { outputs, parameters: params, disclosures, credits, generated, details: { requiredDisclosures: disclosures.map((d) => d.blockId ?? ''), durationSeconds: duration, loudness: loud as Json, qc: [{ check: 'loudness', ok: loud !== null && Math.abs(loud.integrated - (mix.loudness as number)) <= 2, detail: `${String(loud?.integrated)} LUFS (target ${String(mix.loudness)})` }] } };
}

const isProgram = (doc: Doc): boolean => doc.mode === 'program';
export const audioPipeline: Pipeline = {
  kind: 'audio', tools: ['ffmpeg', 'ffprobe'],
  validate(raw) { invariant(isObj(raw), 'invalid_input', 'Document must be an object'); return raw.mode === 'program' ? validateProgram(raw) : validateSong(raw); },
  empty: (title) => validateSong({ title, sections: [], tracks: [] }),
  assetRefs: (doc) => collectAssets(doc),
  sources: (doc) => [...collectSources(doc)],
  text: (doc) => [str(doc.title), ...objs(doc.sections).flatMap((s) => [str(s.label), ...(arr(s.lyrics) as string[])]), ...collectText(doc.clips ?? [])].join('\n'),
  async applyOp(doc, op, helpers) {
    if (!isProgram(doc)) return applySongOp(doc, op, helpers);
    const out = structuredClone(doc); const clips = out.clips as Doc[]; const at = (): number => { const i = clips.findIndex((c) => c.id === op.clipId); invariant(i >= 0, 'invalid_input', `No clip ${String(op.clipId)}`); return i; };
    switch (op.op) {
      case 'addClip': { invariant(isObj(op.clip), 'invalid_input', 'addClip needs a clip'); if (isObj(op.clip.source) && typeof op.clip.source.assetId === 'string') await helpers.assetInfo(op.clip.source.assetId); clips.push({ ...op.clip, id: typeof op.clip.id === 'string' ? op.clip.id : helpers.newId('clip') }); return out; }
      case 'updateClip': { const i = at(); invariant(isObj(op.set), 'invalid_input', 'updateClip needs "set"'); clips[i] = { ...clips[i], ...op.set, id: op.clipId as string, ...(isObj(op.set.source) ? { source: { ...((clips[i] as Doc).source as Doc), ...op.set.source } } : {}) }; return out; }
      case 'removeClip': { clips.splice(at(), 1); return out; }
      case 'setDucking': { invariant(isObj(op.ducking), 'invalid_input', 'setDucking needs ducking'); out.ducking = { ...(out.ducking as Doc), ...op.ducking }; return out; }
      case 'setMix': { invariant(isObj(op.mix), 'invalid_input', 'setMix needs mix'); out.mix = { ...(out.mix as Doc), ...op.mix }; return out; }
      default: return null;
    }
  },
  render: (doc, env) => (isProgram(doc) ? renderProgram(doc, env) : renderSong(doc, env)),
  async fromEditorial(ed: EditorialExport, options) {
    const lyric = ed.blocks.filter((b) => b.type === 'lyric_section');
    if (lyric.length > 0 && options.mode !== 'program') {
      const first = lyric.find((b) => typeof b.data.tempoBpm === 'number' || typeof b.data.key === 'string')?.data ?? {}; const km = /^([A-G][#b]?)\s*(major|minor|m)?/i.exec(str(first.key));
      return compose({ title: ed.title, seed: str(options.seed) || ed.ref, mood: options.mood ?? null, ...(typeof (options.tempo ?? first.tempoBpm) === 'number' ? { tempo: (options.tempo ?? first.tempoBpm) as number } : {}), ...(isObj(options.key) ? { key: options.key } : km !== null ? { key: { tonic: `${(km[1] as string)[0]?.toUpperCase() ?? 'C'}${(km[1] as string).slice(1)}`, mode: /^m(inor)?$/i.test(km[2] ?? '') ? 'minor' : 'major' } } : {}), credits: ed.credits, sources: ed.sources,
        sections: lyric.map((b) => ({ id: b.id, type: b.data.part === 'spoken' ? 'spoken' : str(b.data.part, 'verse'), label: str(b.data.label), lyrics: b.text.split('\n').map((l) => l.trim()).filter((l) => l !== ''), basis: b.basis, ...(b.disclosure === undefined ? {} : { disclosure: b.disclosure }), sources: b.sources, ...(b.attribution === undefined ? {} : { attribution: b.attribution }) })) });
    }
    // Any other editorial document becomes a narrated programme: one synthetic-speech clip per block, laid end to end by estimated length.
    let t = 0; const clips: Doc[] = [];
    for (const b of ed.blocks) { const text = b.text.trim(); if (text === '') continue; const est = Math.max(1.5, (text.split(/\s+/).length / 155) * 60 * 1.15 + 0.6); clips.push({ id: b.id, track: 'narration', source: { type: 'tts', text: b.attribution === undefined ? text : `${b.attribution}: ${text}`, voice: str(options.voice, 'en') }, start: Math.round(t * 100) / 100, follow: 0.45, basis: b.basis, ...(b.disclosure === undefined ? {} : { disclosure: b.disclosure }), sources: b.sources }); t += est; }
    return validateProgram({ mode: 'program', title: ed.title, clips, credits: ed.credits, sources: ed.sources });
  },
  estimateSeconds: (doc, profile) => (isProgram(doc) ? 10 + objs(doc.clips).length * 2 : profile === 'preview' ? 5 : 15 + songSeconds(doc) * 0.6),
  check(doc) {
    if (isProgram(doc)) return objs(doc.clips).length === 0 ? [{ level: 'error', message: 'The programme has no clips yet' }] : [];
    const problems: { level: 'error' | 'warning'; message: string; at?: string }[] = [];
    if (!objs(doc.tracks).some((t) => objs(t.notes).length > 0)) problems.push({ level: 'error', message: 'The song has no notes yet; compose or add notes' });
    for (const s of objs(doc.sections)) if (arr(s.chords).length !== s.bars) problems.push({ level: 'warning', message: `Section ${String(s.id)} has no chords`, at: s.id as string });
    return problems;
  },
};
