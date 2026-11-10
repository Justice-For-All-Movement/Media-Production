import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctx, finish, needsPg, withEngine } from './helpers.ts';
import { compose, syllabify, writeMidi } from '../src/engine/music.ts';
import { parseMidiSummary } from '../src/engine/tools.ts';

const tool = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const analyze = (cmd: string, file: string, ...rest: string[]): any => JSON.parse(tool('python3', ['-I', join(import.meta.dirname, 'analyze.py'), cmd, file, ...rest]));
const probe = (file: string): any => JSON.parse(tool('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
export const SONG = {
  title: 'Where the Water Went', seed: 'larkmoor-1', mood: 'hopeful', tempo: 112, key: { tonic: 'C', mode: 'major' },
  sections: [
    { type: 'intro', bars: 2 },
    { type: 'verse', lyrics: ['The river rose on Larkmoor lane', 'We counted sandbags in the rain', 'They told us help was on the way', 'The ledger tells another day'], basis: 'reconstruction', disclosure: 'The verse retells events from committee minutes; details are approximated.', sources: ['E05:evidence_version:ev-minutes@1'] },
    { type: 'chorus', lyrics: ['Where did the water go', 'Where did the money flow', 'Show us the paper, show us the sum', 'We will be here when morning comes'] },
    { type: 'chorus', lyrics: ['Where did the water go', 'Where did the money flow', 'Show us the paper, show us the sum', 'We will be here when morning comes'] },
  ],
};

test('composition generator: deterministic, scale-aware, cadences, chorus motif, MIDI writer', () => {
  const a = compose(SONG), b = compose(SONG);
  assert.deepEqual(a, b);                                                     // same seed → same arrangement
  assert.notDeepEqual(compose({ ...SONG, seed: 'other' }).tracks, a.tracks);
  const sy = syllabify('The river rose on Larkmoor lane'); assert.equal(sy.length, 8); assert.equal(sy.find((s) => s.text === 'ri-')!.stress, true); assert.equal(sy[0]!.stress, false);
  const tracks = a.tracks as any[]; const lead = tracks.find((t) => t.role === 'lead').notes as any[];
  assert.deepEqual(tracks.map((t) => t.role), ['lead', 'harmony', 'bass', 'drums']);
  const cMajor = [0, 2, 4, 5, 7, 9, 11];
  assert.ok(lead.every((n) => cMajor.includes(n.pitch % 12)), 'melody stays in the scale');
  assert.ok(new Set(lead.map((n) => n.pitch)).size >= 6, 'melody uses many pitches');
  const sections = a.sections as any[]; const [, verse, ch1, ch2] = sections;
  assert.equal(verse.bars, 8); assert.equal(verse.chords.at(-1), 'G');           // half cadence at the verse end
  assert.deepEqual(ch1.chords.slice(-2), ['G', 'C']);                             // authentic cadence closing the chorus
  const of = (id: string) => lead.filter((n) => n.section === id).sort((x, y) => x.start - y.start);
  assert.equal(of(verse.id).filter((n) => n.syl).length, 8 + 8 + 8 + 8);          // one note per syllable
  assert.equal(of(ch1.id).at(-1).pitch % 12, 0);                                  // chorus resolves on the tonic
  const p1 = of(ch1.id).map((n) => n.pitch), p2 = of(ch2.id).map((n) => n.pitch);
  assert.equal(p1.length, p2.length); const same = p1.filter((p, i) => p === p2[i]).length;
  assert.ok(same >= p1.length * 0.7 && same < p1.length, 'final chorus repeats the motif with a variation');
  assert.deepEqual(p1.slice(0, 3), of(ch1.id).filter((n) => n.start >= 16).map((n) => n.pitch).slice(0, 3), 'chorus line 3 restates the opening motif');
  const stressed = lead.filter((n) => n.stress), on = stressed.filter((n) => Number.isInteger(n.start)).length;
  assert.ok(on / stressed.length > 0.6, `stressed syllables mostly on the beat (${on}/${stressed.length})`);
  const drums = tracks.find((t) => t.role === 'drums').notes as any[];
  assert.ok(drums.some((n) => n.section === verse.id && n.start >= 30 && [45, 47, 50, 43].includes(n.pitch)), 'fill in the last bar');
  const bass = tracks.find((t) => t.role === 'bass').notes as any[]; assert.ok(bass.every((n) => n.pitch < 52));
  const midi = parseMidiSummary(writeMidi(a));
  assert.equal(midi.format, 1); assert.equal(midi.tracks, 5); assert.equal(midi.division, 480);
  assert.equal(midi.noteOns, tracks.reduce((s, t) => s + t.notes.length, 0));
});

test('song: compose, render stems/mix/exports, transpose and section edit change MIDI and audio', needsPg, async () => {
  await withEngine(async ({ engine, root }) => {
    const c = ctx();
    const project = await engine.createProject(c, { kind: 'audio', title: SONG.title });
    await engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'compose', params: SONG }] });
    const save = async (renderId: string, name: string): Promise<string> => { const f = await engine.getRenderOutput(c, renderId, name); const p = join(root, `${renderId.slice(0, 6)}-${name}`); writeFileSync(p, f.bytes); return p; };
    const toWav = (file: string): string => { tool('ffmpeg', ['-v', 'error', '-y', '-i', file, '-ac', '1', '-c:a', 'pcm_s16le', `${file}.wav`]); return `${file}.wav`; };

    const prev = await finish(engine, c, await engine.requestRender(c, { productionId: project.id, profile: 'preview', options: { previewSeconds: 10 } }));
    assert.equal(prev.state, 'done', prev.error ?? ''); assert.ok(Math.abs((prev.outputs[0]!.info as any).duration - 10) < 0.5);

    const r1 = await finish(engine, c, await engine.requestRender(c, { productionId: project.id }));
    assert.equal(r1.state, 'done', r1.error ?? '');
    const names = r1.outputs.map((o) => o.name);
    for (const n of ['Where-the-Water-Went.wav', 'Where-the-Water-Went.flac', 'Where-the-Water-Went.mp3', 'Where-the-Water-Went.ogg', 'Where-the-Water-Went.mid', 'Where-the-Water-Went-lyrics.txt', 'stem-lead.flac', 'stem-harmony.flac', 'stem-bass.flac', 'stem-drums.flac', 'stem-guide-vocal.flac']) assert.ok(names.includes(n), `missing ${n}`);
    const expected = (26 * 4 * 60) / 112 + 2;
    const wav = await save(r1.id, 'Where-the-Water-Went.wav'); const info = probe(wav);
    assert.ok(Math.abs(Number(info.format.duration) - expected) < 0.3, `duration ${info.format.duration} vs ${expected}`);
    assert.equal(info.streams[0].channels, 2); assert.equal(info.streams[0].sample_rate, '44100');
    assert.equal(probe(await save(r1.id, 'Where-the-Water-Went.mp3')).streams[0].codec_name, 'mp3');
    assert.equal(probe(await save(r1.id, 'Where-the-Water-Went.ogg')).streams[0].codec_name, 'vorbis');
    assert.equal(probe(await save(r1.id, 'Where-the-Water-Went.flac')).streams[0].codec_name, 'flac');
    const loud = execFileSync('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] as any });
    void loud; const man = await engine.getRenderManifest(c, r1.id) as any;
    assert.ok(Math.abs(man.details.loudness.integrated - -16) <= 1.5, `loudness ${man.details.loudness.integrated}`);   // loudnorm hit the target
    assert.ok(man.details.loudness.truePeak <= 0);
    // real music, not a tone: many distinct pitches in the lead stem, and the mix has broadband content
    const lead1 = toWav(await save(r1.id, 'stem-lead.flac')); const pitches = analyze('pitches', lead1);
    assert.ok(pitches.distinct.length >= 6, `distinct pitches ${JSON.stringify(pitches.distinct)}`);
    assert.ok(analyze('rms', toWav(await save(r1.id, 'stem-guide-vocal.flac')), '6', '14') > 0.01, 'guide vocal is audible in the verse');
    assert.ok(analyze('rms', toWav(await save(r1.id, 'stem-drums.flac')), '4', '10') > 0.005);
    const sheet = Buffer.from((await engine.getRenderOutput(c, r1.id, 'Where-the-Water-Went-lyrics.txt')).bytes).toString();
    assert.match(sheet, /\[Verse 1\]/); assert.match(sheet, /RECONSTRUCTION — The verse retells/); assert.match(sheet, /Where did the money flow/); assert.match(sheet, /C \| /);
    assert.equal(man.disclosures[0].basis, 'reconstruction'); assert.ok(man.sources.includes('E05:evidence_version:ev-minutes@1'));
    assert.ok(man.generated.some((g: any) => g.kind === 'guide-vocal' && g.synthetic === true && g.pitchFitted > 10));
    assert.ok(man.credits.some((x: string) => /synthetic speech/.test(x)));
    assert.ok(man.tools.some((t: any) => t.name === 'fluidsynth') && man.tools.some((t: any) => t.name === 'espeak-ng') && man.tools.some((t: any) => t.name === 'sox'));
    assert.equal(man.parameters.seed, 'larkmoor-1');
    const midi1 = (await engine.getRenderOutput(c, r1.id, 'Where-the-Water-Went.mid')).bytes;

    // transpose up a minor third: key, chords, MIDI and audio all move; drums do not
    const before = (await engine.getRevision(c, project.id)).doc as any;
    await engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'transpose', semitones: 3 }, { op: 'setTrack', trackId: 'harmony', set: { mute: true } }, { op: 'setGuide', guide: { enabled: false } }] });
    const after = (await engine.getRevision(c, project.id)).doc as any;
    assert.deepEqual(after.key, { tonic: 'Eb', mode: 'major' }); assert.equal(after.sections[1].chords.at(-1), 'Bb');
    assert.deepEqual(after.tracks[0].notes.map((n: any) => n.pitch), before.tracks[0].notes.map((n: any) => n.pitch + 3));
    assert.deepEqual(after.tracks[3].notes, before.tracks[3].notes);
    const r2 = await finish(engine, c, await engine.requestRender(c, { productionId: project.id }));
    assert.equal(r2.state, 'done', r2.error ?? '');
    assert.ok(!r2.outputs.some((o) => o.name === 'stem-harmony.flac' || o.name === 'stem-guide-vocal.flac'), 'muted track and disabled guide produce no stems');
    const midi2 = (await engine.getRenderOutput(c, r2.id, 'Where-the-Water-Went.mid')).bytes;
    assert.notDeepEqual(Buffer.from(midi1), Buffer.from(midi2)); assert.equal(parseMidiSummary(midi2).tracks, 4);
    const h1 = pitches.hist as Record<string, number>, h2 = analyze('pitches', toWav(await save(r2.id, 'stem-lead.flac'))).hist as Record<string, number>;
    const overlap = (shift: number): number => Object.entries(h1).reduce((sum, [note, count]) => sum + Math.min(count, h2[String(Number(note) + shift)] ?? 0), 0) / pitches.frames;
    assert.ok(overlap(3) > 0.65 && overlap(3) > 2 * overlap(0), `audio pitch content moved up three semitones (shift 3: ${overlap(3)}, shift 0: ${overlap(0)})`);
    assert.equal((await engine.getRenderOutput(c, r1.id, 'Where-the-Water-Went.mid')).sha256, r1.outputs.find((o) => o.name.endsWith('.mid'))!.sha256); // old version retained

    // edit one section: new lyrics and a regenerated melody change only that section; note edits, instrument, tempo, order
    const sid = after.sections[1].id;
    const rev = await engine.applyOperations(c, { productionId: project.id, operations: [
      { op: 'setLyrics', sectionId: sid, lines: ['The river rose on Larkmoor lane', 'We stacked the sandbags in the rain', 'They promised help was on the way', 'The ledger shows a different day'] },
      { op: 'regenerateSection', sectionId: sid, seed: 'take-2', roles: ['lead'] },
      { op: 'setInstrument', trackId: 'lead', program: 73, name: 'Flute (lead melody)' }, { op: 'setTempo', tempo: 120 },
      { op: 'editNote', trackId: 'bass', noteId: after.tracks[2].notes[0].id, set: { pitch: 40, dur: 3 } }, { op: 'deleteNote', trackId: 'bass', noteId: after.tracks[2].notes[1].id },
      { op: 'moveSection', sectionId: after.sections[0].id, to: 3 },
    ] });
    const edited = (await engine.getRevision(c, project.id, rev.revision)).doc as any;
    const leadOf = (d: any, id: string) => d.tracks[0].notes.filter((n: any) => n.section === id).map((n: any) => [n.start, n.pitch, n.syl]);
    assert.notDeepEqual(leadOf(edited, sid), leadOf(after, sid)); assert.deepEqual(leadOf(edited, after.sections[2].id), leadOf(after, after.sections[2].id));
    assert.ok(edited.tracks[0].notes.some((n: any) => n.syl === 'stacked')); assert.equal(edited.tracks[0].program, 73); assert.equal(edited.tempo, 120);
    assert.equal(edited.tracks[2].notes.length, after.tracks[2].notes.length - 1); assert.equal(edited.sections.at(-1).type, 'intro');
    const rev1 = await engine.getRevision(c, project.id, 2); assert.equal((rev1.doc as any).key.tonic, 'C');   // saved revision reopens unchanged
    await assert.rejects(engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'setChords', sectionId: sid, chords: ['H'] }] }), (e: any) => e.code === 'invalid_input');
  });
});

test('narration programme: speech clips, music bed from a song render, trims, fades, ducking', needsPg, async () => {
  await withEngine(async ({ engine, root }) => {
    const c = ctx();
    const song = await engine.createProject(c, { kind: 'audio', title: 'Bed', doc: compose({ ...SONG, title: 'Bed', guide: { enabled: false }, sections: SONG.sections.slice(1, 3) }) });
    const sr = await finish(engine, c, await engine.requestRender(c, { productionId: song.id }));
    assert.equal(sr.state, 'done', sr.error ?? '');
    const bed = await engine.importRenderOutput(c, { renderId: sr.id, output: 'Bed.flac', name: 'Music bed (pilot song)' });
    assert.equal(bed.class, 'audio'); assert.equal(bed.versions[0]!.provenance.tool, 'E10 render'); assert.ok((bed.versions[0]!.provenance.params as any).render.startsWith('E10:render:'));
    const doc = { mode: 'program', title: 'Larkmoor report', ducking: { enabled: true }, clips: [
      { id: 'bed', track: 'music', source: { type: 'asset', assetId: bed.id }, start: 0, trimStart: 2, duration: 16, gain: -3, fadeIn: 1, fadeOut: 2 },
      { id: 'n1', source: { type: 'tts', text: 'In Larkmoor, the relief fund collected sixty thousand. One transfer of thirty one thousand has no receipt.' }, start: 2, sources: ['E07:claim:c-ledger@2'] },
      { id: 'n2', source: { type: 'tts', text: 'The treasurer counted the sandbags twice that night.' }, follow: 0.4, basis: 'reconstruction', disclosure: 'One scene in this report is reconstructed from minutes.' },
    ] };
    const project = await engine.createProject(c, { kind: 'audio', title: doc.title, doc });
    const save = async (renderId: string, name: string): Promise<string> => { const f = await engine.getRenderOutput(c, renderId, name); const p = join(root, `${renderId.slice(0, 6)}-${name}`); writeFileSync(p, f.bytes); tool('ffmpeg', ['-v', 'error', '-y', '-i', p, '-ac', '1', '-c:a', 'pcm_s16le', `${p}.wav`]); return `${p}.wav`; };
    const ducked = await finish(engine, c, await engine.requestRender(c, { productionId: project.id, profile: 'preview' }));
    assert.equal(ducked.state, 'done', ducked.error ?? '');
    await engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'setDucking', ducking: { enabled: false } }, { op: 'updateClip', clipId: 'n1', set: { gain: -60 } }, { op: 'updateClip', clipId: 'n2', set: { gain: -60 } }] });
    const bedOnly = await finish(engine, c, await engine.requestRender(c, { productionId: project.id, profile: 'preview' }));
    await engine.restoreRevision(c, { productionId: project.id, revision: 1 });
    await engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'removeClip', clipId: 'bed' }] });
    const voiceOnly = await finish(engine, c, await engine.requestRender(c, { productionId: project.id, profile: 'preview' }));
    const d = await save(ducked.id, ducked.outputs[0]!.name), b = await save(bedOnly.id, bedOnly.outputs[0]!.name), v = await save(voiceOnly.id, voiceOnly.outputs[0]!.name);
    // While the narrator speaks the bed is pushed down: the ducked mix is quieter than voice + undipped bed would be.
    const [dm, bm, vm] = [analyze('rms', d, '3', '7'), analyze('rms', b, '3', '7'), analyze('rms', v, '3', '7')];
    assert.ok(vm > 0.01 && bm > 0.01); assert.ok(dm < Math.sqrt(vm * vm + bm * bm) * 0.9, `ducking lowered the bed (${dm} vs ${Math.sqrt(vm * vm + bm * bm)})`);
    assert.ok(analyze('rms', b, '0', '0.3') < analyze('rms', b, '1.5', '2') * 0.6, 'fade-in on the bed');

    await engine.restoreRevision(c, { productionId: project.id, revision: 1 });
    const final = await finish(engine, c, await engine.requestRender(c, { productionId: project.id }));
    assert.equal(final.state, 'done', final.error ?? '');
    const man = await engine.getRenderManifest(c, final.id) as any;
    assert.equal(man.inputs[0].assetId, bed.id); assert.ok(man.inputs[0].provenance.parentAssets !== undefined);
    assert.ok(Math.abs(man.details.loudness.integrated - -16) <= 2);
    assert.equal(man.disclosures.length, 1); assert.ok(man.generated.some((g: any) => g.clip === 'disclosure-end-note'));
    const transcript = Buffer.from((await engine.getRenderOutput(c, final.id, 'Larkmoor-report-transcript.txt')).bytes).toString();
    assert.match(transcript, /\[RECONSTRUCTION\] The treasurer counted/); assert.match(transcript, /Disclosure\. One scene in this report is reconstructed/); assert.match(transcript, /synthetic speech/);
    assert.ok(man.details.durationSeconds > 18, 'spoken disclosure extends the programme past the bed');
  });
});
