// Song model, deterministic composition generator, track-editing operations and a Standard MIDI File writer.
// Notes are stored per section (start in beats from the section start), so sections can be reordered or regenerated.
import { invariant } from '../contracts.ts';
import { clamp, rng } from './tools.ts';
import { arr, bool, disclosureText, idOf, isObj, n, needsDisclosure, objs, str, uniqueIds, urefs } from './types.ts';
import type { Doc, OpHelpers } from './types.ts';

export const SECTION_TYPES: readonly string[] = ['intro', 'verse', 'pre_chorus', 'chorus', 'refrain', 'hook', 'bridge', 'outro', 'spoken', 'instrumental'];
export const ROLES: readonly string[] = ['lead', 'harmony', 'bass', 'drums', 'extra'];
const PCS: Readonly<Record<string, number>> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'], NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SCALES: Readonly<Record<string, readonly number[]>> = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10] };
export const MOODS: readonly string[] = ['hopeful', 'somber', 'driving', 'calm'];
const pcName = (pc: number, flat: boolean): string => (flat ? NAMES_FLAT : NAMES_SHARP)[((pc % 12) + 12) % 12] as string;
const usesFlats = (tonic: string, mode: string): boolean => tonic.includes('b') || ['F'].includes(tonic) || (mode !== 'major' && ['C', 'G', 'D', 'F'].includes(tonic));

export type Chord = { root: number; quality: 'maj' | 'min' | 'dim'; pcs: number[] };
export function parseChord(symbol: unknown): Chord {
  const m = /^([A-G][#b]?)(m|dim)?$/.exec(str(symbol)); invariant(m !== null, 'invalid_input', `Invalid chord symbol "${String(symbol)}" (use C, Am, Bdim …)`);
  const root = PCS[m[1] as string] as number; const quality = m[2] === 'm' ? 'min' : m[2] === 'dim' ? 'dim' : 'maj';
  return { root, quality, pcs: [root, (root + (quality === 'maj' ? 4 : 3)) % 12, (root + (quality === 'dim' ? 6 : 7)) % 12] };
}
const chordName = (root: number, quality: string, flat: boolean): string => `${pcName(root, flat)}${quality === 'min' ? 'm' : quality === 'dim' ? 'dim' : ''}`;
function transposeChord(symbol: string, semis: number, flat: boolean): string { const c = parseChord(symbol); return chordName((c.root + semis + 120) % 12, c.quality, flat); }

// ───────────────────────────── validation ─────────────────────────────
function normNote(raw: unknown, sectionIds: Set<string>, drums: boolean): Doc {
  invariant(isObj(raw), 'invalid_input', 'Note must be an object');
  invariant(typeof raw.section === 'string' && sectionIds.has(raw.section), 'invalid_input', `Note ${String(raw.id)} names an unknown section`);
  void drums;
  return { id: idOf(raw.id, 'note'), section: raw.section, start: Math.round(n(raw.start, 0, 0, 4000) * 1000) / 1000, dur: Math.round(n(raw.dur, 1, 0.05, 64) * 1000) / 1000, pitch: Math.round(n(raw.pitch, 60, 0, 127)), vel: Math.round(n(raw.vel, 80, 1, 127)), ...(typeof raw.syl === 'string' && raw.syl !== '' ? { syl: raw.syl.slice(0, 60) } : {}), ...(raw.stress === true ? { stress: true } : {}) };
}
export function validateSong(raw: Doc): Doc {
  const key = isObj(raw.key) ? raw.key : {}; const tonic = Object.hasOwn(PCS, str(key.tonic)) ? str(key.tonic) : 'C'; const mode = Object.hasOwn(SCALES, str(key.mode)) ? str(key.mode) : 'major';
  const ts = Array.isArray(raw.timeSignature) ? raw.timeSignature : [4, 4]; const beats = Math.round(n(ts[0], 4, 2, 7));
  const sections = objs(raw.sections).map((s) => {
    const type = SECTION_TYPES.includes(str(s.type)) ? str(s.type) : 'verse'; const basis = str(s.basis, '', 40);
    const lyrics = arr(s.lyrics).filter((l): l is string => typeof l === 'string').map((l) => l.slice(0, 400)).slice(0, 64);
    const chords = arr(s.chords).map((c) => { parseChord(c); return c as string; });
    const bars = Math.round(n(s.bars, Math.max(chords.length, 1), 1, 128));
    invariant(chords.length === 0 || chords.length === bars, 'invalid_input', `Section ${String(s.id)} needs one chord per bar (${bars})`);
    return { id: idOf(s.id, 'section'), type, label: str(s.label, '', 80), bars, chords, lyrics, ...(typeof s.variation === 'number' ? { variation: Math.round(n(s.variation, 0, 0, 99)) } : {}), ...(basis === '' ? {} : { basis }), ...(needsDisclosure(basis) ? { disclosure: disclosureText(basis, s.disclosure) } : {}), ...(urefs(s.sources).length > 0 ? { sources: urefs(s.sources) } : {}), ...(typeof s.attribution === 'string' ? { attribution: s.attribution.slice(0, 300) } : {}) };
  });
  invariant(sections.length <= 64, 'invalid_input', 'Too many sections'); uniqueIds(sections, 'section');
  const ids = new Set(sections.map((s) => s.id));
  const tracks = objs(raw.tracks).map((t) => {
    const role = ROLES.includes(str(t.role)) ? str(t.role) : 'extra'; const drums = role === 'drums';
    const notes = arr(t.notes).map((x) => normNote(x, ids, drums)); invariant(notes.length <= 20000, 'invalid_input', 'Too many notes'); uniqueIds(notes, 'note');
    return { id: idOf(t.id, 'track'), role, name: str(t.name, role, 80), program: Math.round(n(t.program, 0, 0, 127)), volume: n(t.volume, 0.8, 0, 1.5), pan: n(t.pan, 0, -1, 1), mute: bool(t.mute), solo: bool(t.solo), notes };
  });
  invariant(tracks.length <= 16, 'invalid_input', 'At most 16 tracks'); uniqueIds(tracks, 'track');
  const mix = isObj(raw.mix) ? raw.mix : {}; const guide = isObj(raw.guide) ? raw.guide : {};
  return { kind: 'audio', mode: 'song', title: str(raw.title, 'Untitled', 300), seed: str(raw.seed, 'seed', 100), tempo: Math.round(n(raw.tempo, 96, 40, 220)), key: { tonic, mode }, timeSignature: [beats, 4], mood: MOODS.includes(str(raw.mood)) ? str(raw.mood) : 'hopeful',
    sections, tracks,
    mix: { loudness: n(mix.loudness, -16, -30, -9), reverb: n(mix.reverb, 0.25, 0, 1), fadeIn: n(mix.fadeIn, 0, 0, 20), fadeOut: n(mix.fadeOut, 2, 0, 20), compression: bool(mix.compression, true), lowCut: n(mix.lowCut, 35, 0, 400), highShelf: n(mix.highShelf, 0, -12, 12) },
    guide: { enabled: bool(guide.enabled, true), style: guide.style === 'spoken' ? 'spoken' : 'sung', voice: /^[a-z]{2,3}(-[a-z0-9]{1,8})*(\+[a-z0-9]{1,8})?$/i.test(str(guide.voice)) ? str(guide.voice) : 'en', gain: n(guide.gain, 0.9, 0, 2) },
    sources: urefs(raw.sources), credits: arr(raw.credits).filter((c): c is string => typeof c === 'string').slice(0, 100) };
}
export const beatsPerBar = (doc: Doc): number => (doc.timeSignature as number[])[0] as number;
/** Section start offsets in beats, in playing order. */
export function sectionStarts(doc: Doc): Map<string, number> {
  const out = new Map<string, number>(); let at = 0;
  for (const s of objs(doc.sections)) { out.set(s.id as string, at); at += (s.bars as number) * beatsPerBar(doc); }
  out.set('__end', at);
  return out;
}
export const totalBeats = (doc: Doc): number => sectionStarts(doc).get('__end') as number;
export const songSeconds = (doc: Doc): number => (totalBeats(doc) * 60) / (doc.tempo as number);

// ───────────────────────────── lyrics → syllables ─────────────────────────────
const FUNCTION_WORDS = new Set('the a an and of to in on at for with is was it we i you he she they that but or as by from be are were our my your his her its this so if not no do did had has have us me them their there then than when where who what will would can could'.split(' '));
const UNSTRESSED_PREFIX = /^(a|be|de|re|un|in|ex|con|com|pre|pro|dis|mis|en|em|for|to|sur|per)(?=[^aeiouy])/i;
export type Syllable = { text: string; stress: boolean; wordEnd: boolean };
/** Heuristic syllabifier (vowel groups). Explicit hyphens or middle dots in a word ("wa-ter", "re·lief") override it. */
export function syllabify(line: string): Syllable[] {
  const out: Syllable[] = [];
  for (const rawWord of line.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w))) {
    const word = rawWord.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    let parts: string[];
    if (/[-·]/.test(word)) parts = word.split(/[-·]+/).filter((p) => p !== '');
    else {
      parts = []; const lower = word.toLowerCase(); const groups = [...lower.matchAll(/[aeiouyàáâäãåèéêëìíîïòóôöõùúûüæœ]+/g)];
      let count = groups.length;
      if (count > 1 && /[^aeiouy]e$/.test(lower) && !/[^aeiouy]le$/.test(lower)) count--; // silent final e
      if (count > 1 && /[^aeiouytd]ed$/.test(lower)) count--;
      if (count <= 1) parts = [word];
      else {
        let from = 0;
        for (let g = 0; g < count - 1; g++) {
          const vEnd = (groups[g] as RegExpMatchArray).index as number + (groups[g] as RegExpMatchArray)[0].length; const next = (groups[g + 1] as RegExpMatchArray).index as number;
          const cut = next - vEnd >= 2 ? vEnd + Math.floor((next - vEnd) / 2) : vEnd; // VC|CV, V|CV
          parts.push(word.slice(from, cut)); from = cut;
        }
        parts.push(word.slice(from));
      }
    }
    const lower = word.toLowerCase(); const stressAt = parts.length === 1 ? (FUNCTION_WORDS.has(lower) ? -1 : 0) : UNSTRESSED_PREFIX.test(lower) && parts.length > 1 ? 1 : 0;
    parts.forEach((p, i) => out.push({ text: i < parts.length - 1 ? `${p}-` : p, stress: i === stressAt, wordEnd: i === parts.length - 1 }));
  }
  return out;
}

// ───────────────────────────── composition ─────────────────────────────
const PROGRESSIONS: Readonly<Record<string, Readonly<Record<string, readonly (readonly number[])[]>>>> = {
  major: { verse: [[1, 5, 6, 4], [1, 6, 4, 5], [1, 4, 6, 5]], chorus: [[4, 1, 5, 6], [1, 5, 6, 4], [6, 4, 1, 5]], bridge: [[6, 5, 4, 5], [2, 5, 3, 6]], intro: [[1, 4, 1, 5]], outro: [[4, 5, 1, 1]] },
  minor: { verse: [[1, 6, 3, 7], [1, 4, 7, 3], [1, 7, 6, 7]], chorus: [[6, 3, 7, 1], [1, 6, 7, 1], [3, 7, 1, 6]], bridge: [[4, 7, 3, 6], [6, 7, 1, 1]], intro: [[1, 6, 1, 7]], outro: [[6, 7, 1, 1]] },
};
const family = (type: string): string => (['chorus', 'refrain', 'hook'].includes(type) ? 'chorus' : ['bridge', 'pre_chorus'].includes(type) ? 'bridge' : type === 'intro' || type === 'instrumental' ? 'intro' : type === 'outro' ? 'outro' : 'verse');
function degreeChord(doc: Doc, degree: number, dominant = false): string {
  const key = doc.key as Doc; const mode = str(key.mode); const scale = SCALES[mode] as readonly number[]; const tonic = PCS[str(key.tonic)] as number; const flat = usesFlats(str(key.tonic), mode);
  const d = ((degree - 1) % 7 + 7) % 7; const root = (tonic + (scale[d] as number)) % 12; const third = ((scale[(d + 2) % 7] as number) - (scale[d] as number) + 12) % 12; const fifth = ((scale[(d + 4) % 7] as number) - (scale[d] as number) + 12) % 12;
  if (dominant && d === 4) return chordName(root, 'maj', flat); // raised leading note at cadences in minor modes
  return chordName(root, fifth === 6 ? 'dim' : third === 4 ? 'maj' : 'min', flat);
}
/** Chords for a section: a progression chosen by seed for the section family, with a cadence at the end. */
export function sectionChords(doc: Doc, type: string, bars: number, seed: string): string[] {
  const mode = str((doc.key as Doc).mode) === 'major' || str((doc.key as Doc).mode) === 'mixolydian' ? 'major' : 'minor'; const fam = family(type);
  const options = (PROGRESSIONS[mode] as Readonly<Record<string, readonly (readonly number[])[]>>)[fam] as readonly (readonly number[])[];
  const prog = options[Math.floor(rng(`${seed}:prog:${fam}`)() * options.length)] as readonly number[];
  const out = Array.from({ length: bars }, (_, i) => degreeChord(doc, prog[i % prog.length] as number));
  if (fam === 'chorus' || fam === 'outro') { if (bars >= 2) out[bars - 2] = degreeChord(doc, 5, true); out[bars - 1] = degreeChord(doc, 1); }
  else if (bars >= 2) out[bars - 1] = degreeChord(doc, 5, true); // half cadence leading on
  return out;
}
function scalePitches(doc: Doc): number[] {
  const key = doc.key as Doc; const tonic = PCS[str(key.tonic)] as number; const scale = SCALES[str(key.mode)] as readonly number[];
  const base = 60 + (tonic > 5 ? tonic - 12 : tonic); // tonic between F#3 and F4 so melodies sit in a singable range
  const out: number[] = []; for (let o = -1; o <= 2; o++) for (const s of scale) out.push(base + o * 12 + s);
  return out; // index 7 is the tonic in the main octave
}
type Gen = { lead: Doc[]; harmony: Doc[]; bass: Doc[]; drums: Doc[] };
/** Generates all parts for one section. The melody of chorus-family sections is seeded by family, so repeats share a motif. */
export function generateSection(doc: Doc, section: Doc, variationSeed = ''): Gen {
  const B = beatsPerBar(doc); const bars = section.bars as number; const sid = section.id as string; const type = str(section.type); const fam = family(type); const mood = str(doc.mood);
  const chords = (arr(section.chords) as string[]).map(parseChord); const scale = scalePitches(doc); const TONIC = 7;
  const variation = n(section.variation, 0);
  const melodySeed = `${str(doc.seed)}:${fam === 'chorus' ? 'chorus' : sid}:${variationSeed}`;
  const out: Gen = { lead: [], harmony: [], bass: [], drums: [] }; let k = 0;
  const note = (role: keyof Gen, start: number, dur: number, pitch: number, vel: number, extra: Doc = {}): void => { out[role].push({ id: `${sid}-${role[0]}${k++}`, section: sid, start: Math.round(start * 1000) / 1000, dur: Math.round(dur * 1000) / 1000, pitch: clamp(Math.round(pitch), 0, 127), vel: clamp(Math.round(vel), 1, 127), ...extra }); };
  const chordAt = (beat: number): Chord => chords[clamp(Math.floor(beat / B), 0, bars - 1)] as Chord;
  const nearestChordTone = (idx: number, chord: Chord): number => { let best = idx, bd = 99; for (let i = Math.max(0, idx - 4); i <= Math.min(scale.length - 1, idx + 4); i++) { const p = scale[i] as number; if (chord.pcs.includes(((p % 12) + 12) % 12) && Math.abs(i - idx) < bd) { bd = Math.abs(i - idx); best = i; } } if (bd === 99) return idx; return best; };

  // ── lead melody ──
  const lines = (arr(section.lyrics) as string[]).filter((l) => l.trim() !== '');
  const lineBars = lines.length > 0 ? Math.max(1, Math.floor(bars / lines.length)) : 2;
  const phrases: { syl: Syllable[]; startBeat: number; beats: number; last: boolean }[] = lines.length > 0
    ? lines.map((l, i) => ({ syl: syllabify(l), startBeat: i * lineBars * B, beats: lineBars * B, last: i === lines.length - 1 }))
    : type === 'spoken' ? [] : Array.from({ length: Math.max(1, Math.floor(bars / 2)) }, (_x, i) => ({ syl: Array.from({ length: 5 + (i % 2) * 2 }, (_y, j) => ({ text: '', stress: j % 2 === 0, wordEnd: true })), startBeat: i * 2 * B, beats: Math.min(2, bars) * B, last: i === Math.max(1, Math.floor(bars / 2)) - 1 }));
  const rand = rng(melodySeed); const high = fam === 'chorus' ? 3 : fam === 'bridge' ? 2 : 0;
  let idx = TONIC + (fam === 'chorus' ? 4 : [0, 2, 4][Math.floor(rand() * 3)] as number);
  for (const [pi, ph] of phrases.entries()) {
    const count = ph.syl.length; if (count === 0) continue;
    const usable = ph.beats * 2 - 2; // eighth-note slots, leaving a breath at the phrase end
    const slotBeats = count > usable ? (ph.beats - 0.5) / count : 0.5;
    let slack = count > usable ? 0 : usable - count; let cursor = 0;
    // Chorus lines open with the same seeded motif (odd lines a third lower, as a sequence), then move to their cadence.
    const lineRand = rand; const motif: number[] = [];
    if (fam === 'chorus') { const mr = rng(`${str(doc.seed)}:chorus:motif`); let at = TONIC + 4 + (pi % 2 === 1 ? -2 : 0); motif.push(at); for (let j = 0; j < 3; j++) { at += ([-1, 1, 1, 2, 0, -2] as const)[Math.floor(mr() * 6)] as number; motif.push(at); } idx = motif[0] as number; }
    const arch = 2 + Math.floor(lineRand() * 2);
    for (const [i, sy] of ph.syl.entries()) {
      const strongSlot = cursor % 2 === 0;
      if (count <= usable && sy.stress && !strongSlot && slack > 0) { cursor++; slack--; }
      let slots = 1; const lastSyl = i === count - 1;
      if (count <= usable) { if (lastSyl) slots = clamp(usable - cursor, 2, 6); else if (sy.stress && slack > 0 && lineRand() < 0.6) { slots = 2; slack--; } }
      const beat = ph.startBeat + cursor * slotBeats; const chord = chordAt(beat);
      const target = TONIC + high + Math.round(arch * Math.sin((Math.PI * i) / Math.max(1, count - 1))) + (fam === 'chorus' ? 2 : 0);
      const pull = Math.sign(target - idx); const r = lineRand();
      let step = r < 0.5 ? pull : r < 0.75 ? 0 : r < 0.9 ? -pull : pull * 2;
      if (i === 0 && pi > 0) step = 0;
      let nidx = clamp(idx + step, TONIC - 3, TONIC + 9);
      if (i < motif.length && i < count - 1) nidx = motif[i] as number;
      else if (sy.stress || cursor % (B * 2) === 0) nidx = nearestChordTone(nidx, chord);
      if (lastSyl) {
        const endChord = chordAt(ph.startBeat + ph.beats - 0.01);
        nidx = ph.last && (fam === 'chorus' || fam === 'outro') ? TONIC + (variation > 0 && idx > TONIC + 3 ? 7 : 0) : nearestChordTone(nidx, endChord);
      } else if (variation > 0 && ph.last && fam === 'chorus') nidx = clamp(nidx + 2, TONIC - 3, TONIC + 9); // final-chorus lift
      idx = nidx;
      const dur = lastSyl ? Math.max(slots * slotBeats, 1) : slots * slotBeats * 0.95;
      note('lead', beat, Math.min(dur, ph.startBeat + ph.beats - beat), scale[idx] as number, sy.stress ? 100 : 84, sy.text === '' ? {} : { syl: sy.text, ...(sy.stress ? { stress: true } : {}) });
      cursor += slots;
    }
  }
  // ── harmony: voice-led triads, one per bar ──
  let prevVoicing: number[] | null = null;
  for (let bar = 0; bar < bars; bar++) {
    const c = chords[bar] as Chord; let best: number[] = [], cost = 1e9;
    for (let inv = 0; inv < 3; inv++) for (const base of [48, 60]) {
      const v: number[] = []; let floor = base - 1;
      for (let i = 0; i < 3; i++) { let p = floor + 1; while (((p % 12) + 12) % 12 !== (c.pcs[(i + inv) % 3] as number)) p++; v.push(p); floor = p; }
      if ((v[0] as number) < 50 || (v[2] as number) > 72) continue;
      const cst = prevVoicing === null ? Math.abs((v[1] as number) - 60) : v.reduce((a, p, i) => a + Math.abs(p - (prevVoicing as number[])[i]!), 0);
      if (cst < cost) { cost = cst; best = v; }
    }
    if (best.length === 0) best = [0, 1, 2].map((i) => 52 + ((c.pcs[i] as number) - 52 % 12 + 12) % 12);
    prevVoicing = best;
    if (mood === 'driving' && fam === 'chorus') for (let b = 0; b < B; b += 1) for (const p of best) note('harmony', bar * B + b, 0.9, p, 62);
    else for (const p of best) note('harmony', bar * B, B * 0.98, p, fam === 'chorus' ? 66 : 56);
  }
  // ── bass: root, fifth, approach to the next root ──
  for (let bar = 0; bar < bars; bar++) {
    const c = chords[bar] as Chord; const root = 36 + ((c.root - 36 % 12 + 12) % 12); const fifth = root + 7 > 50 ? root - 5 : root + 7; const start = bar * B;
    const next = chords[bar + 1]; const nextRoot = next === undefined ? root : 36 + ((next.root - 36 % 12 + 12) % 12);
    if (type === 'intro' && bar < bars / 2) { note('bass', start, B * 0.95, root, 70); continue; }
    if (mood === 'driving') { for (let e = 0; e < B * 2; e++) note('bass', start + e / 2, 0.45, e === B * 2 - 1 && nextRoot !== root ? nextRoot + (nextRoot > root ? -1 : 1) : root, e % 2 === 0 ? 96 : 80); continue; }
    if (B >= 4) { note('bass', start, 1.9, root, 96); note('bass', start + 2, 0.95, fifth, 84); note('bass', start + 3, 0.95, nextRoot === root ? root : nextRoot + (nextRoot > root ? -2 : 2), 80); if (B > 4) note('bass', start + 4, B - 4, root, 80); }
    else { note('bass', start, B - 1.05, root, 96); note('bass', start + B - 1, 0.95, nextRoot === root ? fifth : nextRoot + (nextRoot > root ? -2 : 2), 80); }
  }
  // ── drums: pattern by section and mood, with a fill in the last bar and a crash on the downbeat ──
  const soft = mood === 'calm' || mood === 'somber'; const drand = rng(`${str(doc.seed)}:drums:${sid}:${variationSeed}`);
  if (type !== 'spoken') for (let bar = 0; bar < bars; bar++) {
    const start = bar * B; const lastBar = bar === bars - 1 && bars > 1; const sparse = type === 'intro' && bar < bars / 2;
    if (bar === 0 && (fam === 'chorus' || type === 'outro')) note('drums', start, 1, 49, 96);
    const fillFrom = lastBar ? B - (soft ? 1 : 2) : B;
    for (let e = 0; e < B * 2; e++) {
      const beat = e / 2; if (beat >= fillFrom) break;
      if (!soft || e % 2 === 0) note('drums', start + beat, 0.25, fam === 'chorus' && !soft ? 46 - (e % 2) * 4 : 42, e % 2 === 0 ? 78 : 58);
      if (sparse) continue;
      if (e % 2 === 0) { const b = e / 2; if (b % 2 === 0) note('drums', start + beat, 0.5, 36, b === 0 ? 108 : 96); else note('drums', start + beat, 0.5, soft ? 37 : 38, 98); }
      else if (!soft && e === B * 2 - 3 && drand() < 0.5) note('drums', start + beat, 0.25, 36, 84);
    }
    if (lastBar && !sparse) { const steps = (B - fillFrom) * 4; const toms = [38, 38, 50, 47, 45, 45, 43, 43]; for (let st = 0; st < steps; st++) note('drums', start + fillFrom + st / 4, 0.25, soft ? (st % 2 === 0 ? 37 : 42) : toms[Math.floor((st / steps) * toms.length)] as number, 76 + Math.round((st / steps) * 36)); }
  }
  return out;
}
const INSTRUMENTS: Readonly<Record<string, Readonly<Record<string, [number, string]>>>> = {
  hopeful: { lead: [0, 'Piano (lead melody)'], harmony: [48, 'Strings (pad)'], bass: [33, 'Fingered bass'] }, somber: { lead: [71, 'Clarinet (lead melody)'], harmony: [89, 'Warm pad'], bass: [32, 'Acoustic bass'] },
  driving: { lead: [27, 'Clean guitar (lead melody)'], harmony: [4, 'Electric piano'], bass: [34, 'Picked bass'] }, calm: { lead: [73, 'Flute (lead melody)'], harmony: [24, 'Nylon guitar'], bass: [32, 'Acoustic bass'] },
};
/**
 * Composes a complete arrangement from lyrics and musical parameters. Deterministic for a seed.
 * params: { title, seed?, tempo?, key?: { tonic, mode }, mood?, timeSignature?, sections: [{ id?, type, label?, lyrics?: string[], bars?, basis?, disclosure?, sources? }] }
 */
export function compose(params: Doc): Doc {
  const secs = objs(params.sections); invariant(secs.length > 0, 'invalid_input', 'compose needs at least one section');
  const mood = MOODS.includes(str(params.mood)) ? str(params.mood) : 'hopeful';
  const base = validateSong({ title: str(params.title, 'Untitled'), seed: str(params.seed) || str(params.title, 'song'), tempo: params.tempo ?? ({ hopeful: 104, somber: 76, driving: 126, calm: 88 } as Record<string, number>)[mood] as number, key: params.key ?? { tonic: mood === 'somber' ? 'A' : 'C', mode: mood === 'somber' ? 'minor' : 'major' }, timeSignature: params.timeSignature ?? [4, 4], mood, sections: [], tracks: [], mix: params.mix ?? {}, guide: params.guide ?? {}, sources: params.sources ?? [], credits: params.credits ?? [] });
  const counts = new Map<string, number>(); const chorusTotal = secs.filter((s) => family(str(s.type)) === 'chorus').length; let chorusSeen = 0;
  const sections = secs.map((s) => {
    const type = SECTION_TYPES.includes(str(s.type)) ? str(s.type) : 'verse'; const c = (counts.get(type) ?? 0) + 1; counts.set(type, c);
    const lyrics = arr(s.lyrics).filter((l): l is string => typeof l === 'string' && l.trim() !== '');
    const bars = Math.round(n(s.bars, lyrics.length > 0 ? lyrics.length * 2 : 4, 1, 64)); const isChorus = family(type) === 'chorus'; if (isChorus) chorusSeen++;
    const sec: Doc = { ...s, id: typeof s.id === 'string' ? s.id : `${type}-${c}`, type, label: str(s.label) || `${type.replace('_', ' ').replace(/^./, (x) => x.toUpperCase())}${['verse', 'chorus', 'bridge'].includes(type) ? ` ${c}` : ''}`, bars, lyrics, ...(isChorus && chorusTotal > 1 && chorusSeen === chorusTotal ? { variation: 1 } : {}) };
    sec.chords = sectionChords(base, type, bars, str(base.seed));
    return sec;
  });
  const ins = INSTRUMENTS[mood] as Readonly<Record<string, [number, string]>>;
  const tracks: Doc[] = [
    { id: 'lead', role: 'lead', name: (ins.lead as [number, string])[1], program: (ins.lead as [number, string])[0], volume: 0.9, pan: 0, notes: [] },
    { id: 'harmony', role: 'harmony', name: (ins.harmony as [number, string])[1], program: (ins.harmony as [number, string])[0], volume: 0.55, pan: -0.25, notes: [] },
    { id: 'bass', role: 'bass', name: (ins.bass as [number, string])[1], program: (ins.bass as [number, string])[0], volume: 0.8, pan: 0.1, notes: [] },
    { id: 'drums', role: 'drums', name: 'Drum kit', program: 0, volume: 0.7, pan: 0, notes: [] },
  ];
  const doc = { ...base, sections, tracks };
  for (const s of sections) { const g = generateSection(doc, s); for (const t of tracks) (t.notes as Doc[]).push(...(g[t.role as keyof Gen] ?? [])); }
  return validateSong(doc);
}
function replaceSection(doc: Doc, sectionId: string, variationSeed: string, roles?: readonly string[]): void {
  const section = objs(doc.sections).find((s) => s.id === sectionId); invariant(section !== undefined, 'invalid_input', `No section ${sectionId}`);
  const g = generateSection(doc, section, variationSeed);
  for (const t of objs(doc.tracks)) { const part = g[t.role as keyof Gen]; if (part === undefined || (roles !== undefined && !roles.includes(str(t.role)))) continue; t.notes = [...objs(t.notes).filter((x) => x.section !== sectionId), ...part]; }
}

// ───────────────────────────── editing operations ─────────────────────────────
export async function applySongOp(doc: Doc, op: Doc, helpers: OpHelpers): Promise<Doc | null> {
  if (op.op === 'compose') { invariant(isObj(op.params), 'invalid_input', 'compose needs params'); return compose({ title: str(doc.title), ...op.params }); }
  const out = structuredClone(doc); const tracks = objs(out.tracks); const sections = objs(out.sections);
  const track = (): Doc => { const t = tracks.find((x) => x.id === op.trackId); invariant(t !== undefined, 'invalid_input', `No track ${String(op.trackId)}`); return t; };
  const noteAt = (t: Doc): number => { const i = objs(t.notes).findIndex((x) => x.id === op.noteId); invariant(i >= 0, 'invalid_input', `No note ${String(op.noteId)}`); return i; };
  switch (op.op) {
    case 'transpose': {
      const semis = Math.round(n(op.semitones, 0, -36, 36)); invariant(semis !== 0, 'invalid_input', 'transpose needs non-zero semitones');
      if (typeof op.trackId === 'string') { const t = track(); invariant(t.role !== 'drums', 'invalid_input', 'Drum tracks are not transposed'); for (const x of objs(t.notes)) x.pitch = clamp((x.pitch as number) + semis, 0, 127); return out; }
      const key = out.key as Doc; const mode = str(key.mode); const pc = ((PCS[str(key.tonic)] as number) + semis + 120) % 12; const flat = [1, 3, 5, 8, 10].includes(pc) || usesFlats(pcName(pc, true), mode); key.tonic = pcName(pc, flat);
      for (const s of sections) s.chords = (arr(s.chords) as string[]).map((c) => transposeChord(c, semis, flat));
      for (const t of tracks) if (t.role !== 'drums') for (const x of objs(t.notes)) x.pitch = clamp((x.pitch as number) + semis, 0, 127);
      return out;
    }
    case 'setInstrument': { const t = track(); t.program = Math.round(n(op.program, 0, 0, 127)); if (typeof op.name === 'string') t.name = op.name; return out; }
    case 'setTrack': { const t = track(); invariant(isObj(op.set), 'invalid_input', 'setTrack needs "set"'); for (const k of ['volume', 'pan', 'mute', 'solo', 'name', 'program']) { const v = op.set[k]; if (v !== undefined) t[k] = v; } return out; }
    case 'addTrack': { invariant(isObj(op.track), 'invalid_input', 'addTrack needs a track'); (out.tracks as Doc[]).push({ notes: [], ...op.track, id: typeof op.track.id === 'string' ? op.track.id : helpers.newId('track') }); return out; }
    case 'removeTrack': { out.tracks = tracks.filter((t) => t.id !== track().id); return out; }
    case 'editNote': case 'moveNote': { const t = track(); const i = noteAt(t); invariant(isObj(op.set), 'invalid_input', `${String(op.op)} needs "set"`); (t.notes as Doc[])[i] = { ...(t.notes as Doc[])[i], ...op.set, id: op.noteId as string }; return out; }
    case 'addNote': { const t = track(); invariant(isObj(op.note), 'invalid_input', 'addNote needs a note'); (t.notes as Doc[]).push({ ...op.note, id: typeof op.note.id === 'string' ? op.note.id : helpers.newId('n') }); return out; }
    case 'deleteNote': { const t = track(); (t.notes as Doc[]).splice(noteAt(t), 1); return out; }
    case 'reorderSections': { const order = arr(op.order); invariant(order.length === sections.length && sections.every((s) => order.includes(s.id as string)), 'invalid_input', 'order must list every section id exactly once'); out.sections = order.map((id) => sections.find((s) => s.id === id) as Doc); return out; }
    case 'moveSection': { const i = sections.findIndex((s) => s.id === op.sectionId); invariant(i >= 0 && typeof op.to === 'number', 'invalid_input', 'moveSection needs sectionId and to'); const [s] = sections.splice(i, 1); sections.splice(clamp(op.to, 0, sections.length), 0, s as Doc); out.sections = sections; return out; }
    case 'removeSection': { invariant(sections.some((s) => s.id === op.sectionId), 'invalid_input', 'No such section'); out.sections = sections.filter((s) => s.id !== op.sectionId); for (const t of tracks) t.notes = objs(t.notes).filter((x) => x.section !== op.sectionId); return out; }
    case 'duplicateSection': {
      const i = sections.findIndex((s) => s.id === op.sectionId); invariant(i >= 0, 'invalid_input', 'No such section'); const id = typeof op.newId === 'string' ? op.newId : helpers.newId(str((sections[i] as Doc).type));
      sections.splice(typeof op.to === 'number' ? clamp(op.to, 0, sections.length) : i + 1, 0, { ...(sections[i] as Doc), id }); out.sections = sections;
      for (const t of tracks) (t.notes as Doc[]).push(...objs(t.notes).filter((x) => x.section === op.sectionId).map((x) => ({ ...x, section: id, id: `${id}-${String(x.id)}`.slice(0, 64) })));
      return out;
    }
    case 'regenerateSection': { invariant(typeof op.sectionId === 'string', 'invalid_input', 'regenerateSection needs sectionId'); replaceSection(out, op.sectionId, str(op.seed) || helpers.newId('v'), Array.isArray(op.roles) ? op.roles as string[] : undefined); return out; }
    case 'setLyrics': {
      const s = sections.find((x) => x.id === op.sectionId); invariant(s !== undefined && Array.isArray(op.lines), 'invalid_input', 'setLyrics needs sectionId and lines');
      s.lyrics = (op.lines as unknown[]).filter((l): l is string => typeof l === 'string'); const bars = Math.max(1, (s.lyrics as string[]).filter((l) => l.trim() !== '').length * 2);
      if (bars !== s.bars) { s.bars = bars; s.chords = sectionChords(out, str(s.type), bars, str(out.seed)); replaceSection(out, s.id as string, ''); } else replaceSection(out, s.id as string, '', ['lead']);
      return out;
    }
    case 'setChords': { const s = sections.find((x) => x.id === op.sectionId); invariant(s !== undefined && Array.isArray(op.chords) && op.chords.length === s.bars, 'invalid_input', 'setChords needs sectionId and one chord per bar'); s.chords = op.chords; replaceSection(out, s.id as string, '', ['harmony', 'bass']); return out; }
    case 'setTempo': { out.tempo = Math.round(n(op.tempo, 96, 40, 220)); return out; }
    case 'setKey': {
      const tonic = str(op.tonic); invariant(Object.hasOwn(PCS, tonic), 'invalid_input', 'setKey needs a tonic such as C, F# or Bb'); const key = out.key as Doc; const mode = typeof op.mode === 'string' ? op.mode : str(key.mode); invariant(Object.hasOwn(SCALES, mode), 'invalid_input', 'Unknown mode');
      if (mode !== key.mode) { key.tonic = tonic; key.mode = mode; for (const s of sections) { s.chords = sectionChords(out, str(s.type), s.bars as number, str(out.seed)); replaceSection(out, s.id as string, ''); } return out; }
      let semis = ((PCS[tonic] as number) - (PCS[str(key.tonic)] as number) + 12) % 12; if (semis > 6) semis -= 12; if (semis === 0) { key.tonic = tonic; return out; }
      const moved = await applySongOp(out, { op: 'transpose', semitones: semis }, helpers) as Doc; (moved.key as Doc).tonic = tonic; return moved;
    }
    case 'setMix': { invariant(isObj(op.mix), 'invalid_input', 'setMix needs mix'); out.mix = { ...(out.mix as Doc), ...op.mix }; return out; }
    case 'setGuide': { invariant(isObj(op.guide), 'invalid_input', 'setGuide needs guide'); out.guide = { ...(out.guide as Doc), ...op.guide }; return out; }
    default: return null;
  }
}

// ───────────────────────────── Standard MIDI File writer ─────────────────────────────
const PPQ = 480;
function vlq(value: number): number[] { let v = Math.max(0, Math.round(value)); const out = [v & 0x7f]; while ((v >>= 7) > 0) out.unshift((v & 0x7f) | 0x80); return out; }
type Ev = { tick: number; order: number; bytes: number[] };
function trackChunk(events: Ev[], endTick: number): Buffer {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = []; let last = 0;
  for (const e of events) { body.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
  body.push(...vlq(Math.max(0, endTick - last)), 0xff, 0x2f, 0x00);
  const head = Buffer.alloc(8); head.write('MTrk', 0, 'latin1'); head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, Buffer.from(body)]);
}
const meta = (type: number, data: Uint8Array): number[] => [0xff, type, ...vlq(data.length), ...data];
export type MidiOptions = { only?: string; tailBeats?: number; includeMuted?: boolean };
/** Tracks that sound in the mix: not muted, and soloed ones only when any track is soloed. */
export function audibleTracks(doc: Doc): Doc[] { const tracks = objs(doc.tracks); const solo = tracks.some((t) => t.solo === true); return tracks.filter((t) => t.mute !== true && (!solo || t.solo === true)); }
/** Writes a format-1 Standard MIDI File: conductor track (tempo, time and key signature, section markers) plus one track per part. */
export function writeMidi(doc: Doc, options: MidiOptions = {}): Uint8Array {
  const starts = sectionStarts(doc); const endTick = Math.round(((starts.get('__end') as number) + (options.tailBeats ?? 0)) * PPQ); const key = doc.key as Doc;
  const conductor: Ev[] = []; const us = Math.round(60_000_000 / (doc.tempo as number));
  conductor.push({ tick: 0, order: 0, bytes: meta(0x03, Buffer.from(str(doc.title).slice(0, 120), 'utf8')) });
  conductor.push({ tick: 0, order: 1, bytes: meta(0x51, Uint8Array.from([(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff])) });
  conductor.push({ tick: 0, order: 2, bytes: meta(0x58, Uint8Array.from([beatsPerBar(doc), 2, 24, 8])) });
  const sf = ({ 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5 } as Record<number, number>)[((PCS[str(key.tonic)] as number) + (str(key.mode) === 'major' ? 0 : str(key.mode) === 'minor' ? 3 : str(key.mode) === 'dorian' ? 10 : 5)) % 12] ?? 0;
  conductor.push({ tick: 0, order: 3, bytes: meta(0x59, Uint8Array.from([sf & 0xff, str(key.mode) === 'minor' ? 1 : 0])) });
  for (const s of objs(doc.sections)) conductor.push({ tick: Math.round((starts.get(s.id as string) as number) * PPQ), order: 4, bytes: meta(0x06, Buffer.from(str(s.label) || str(s.type), 'utf8')) });
  const chunks = [trackChunk(conductor, endTick)];
  const chosen = (options.includeMuted === true ? objs(doc.tracks) : audibleTracks(doc)).filter((t) => options.only === undefined || t.id === options.only);
  let channel = 0;
  for (const t of chosen) {
    const ch = t.role === 'drums' ? 9 : (channel === 9 ? ++channel : channel); if (t.role !== 'drums') channel++;
    const ev: Ev[] = [{ tick: 0, order: 0, bytes: meta(0x03, Buffer.from(str(t.name), 'utf8')) }];
    if (t.role !== 'drums') ev.push({ tick: 0, order: 1, bytes: [0xc0 | ch, t.program as number] });
    ev.push({ tick: 0, order: 1, bytes: [0xb0 | ch, 7, 100] }, { tick: 0, order: 1, bytes: [0xb0 | ch, 10, 64] });
    for (const x of objs(t.notes)) {
      const s0 = starts.get(x.section as string); if (s0 === undefined) continue;
      const on = Math.round((s0 + (x.start as number)) * PPQ); const off = Math.min(endTick, Math.max(on + 1, Math.round((s0 + (x.start as number) + (x.dur as number)) * PPQ)));
      if (typeof x.syl === 'string') ev.push({ tick: on, order: 2, bytes: meta(0x05, Buffer.from(x.syl.endsWith('-') ? x.syl.slice(0, -1) : `${x.syl} `, 'utf8')) });
      ev.push({ tick: on, order: 3, bytes: [0x90 | ch, x.pitch as number, x.vel as number] }, { tick: off, order: 1, bytes: [0x80 | ch, x.pitch as number, 0] });
    }
    chunks.push(trackChunk(ev, endTick));
  }
  const head = Buffer.alloc(14); head.write('MThd', 0, 'latin1'); head.writeUInt32BE(6, 4); head.writeUInt16BE(1, 8); head.writeUInt16BE(chunks.length, 10); head.writeUInt16BE(PPQ, 12);
  return Buffer.concat([head, ...chunks]);
}
/** Plain-text lyric sheet with chords per section and disclosures for reconstructed/invented sections. */
export function lyricSheet(doc: Doc): string {
  const key = doc.key as Doc; const out = [str(doc.title), `Key: ${str(key.tonic)} ${str(key.mode)} · Tempo: ${String(doc.tempo)} BPM · Time: ${(doc.timeSignature as number[]).join('/')}`, ''];
  for (const s of objs(doc.sections)) {
    out.push(`[${str(s.label) || str(s.type)}]`);
    if (typeof s.basis === 'string' && needsDisclosure(s.basis)) out.push(`(${s.basis.toUpperCase()} — ${str(s.disclosure)})`);
    out.push(`  ${(arr(s.chords) as string[]).join(' | ')}`);
    for (const l of arr(s.lyrics) as string[]) out.push(l);
    if (typeof s.attribution === 'string') out.push(`  — ${s.attribution}`);
    out.push('');
  }
  if (arr(doc.credits).length > 0) out.push('Credits', ...(arr(doc.credits) as string[]).map((c) => `  ${c}`), '');
  return out.join('\n');
}
