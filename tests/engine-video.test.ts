import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctx, finish, ledgerPage, needsPg, withEngine } from './helpers.ts';
import { compose } from '../src/engine/music.ts';

const tool = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const probe = (file: string): any => JSON.parse(tool('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
const ocrAt = (file: string, t: number, dir: string, crop = ''): string => { const png = join(dir, `frame-${t}.png`); tool('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `${crop}scale=iw*2:-1`, png]); return tool('tesseract', [png, '-', '--psm', '11']).replace(/\s+/g, ' '); };

test('video: timeline with title card, Ken Burns still, motion graphics, narration, music, captions, credits', needsPg, async () => {
  await withEngine(async ({ engine, root }) => {
    const c = ctx();
    const page = await engine.importAsset(c, { name: 'Ledger page 14', filename: 'ledger.png', bytes: ledgerPage(root), rights: { kind: 'permission', ref: 'E11:permission:perm-ledger', attribution: 'Larkmoor council archive' }, provenance: { sourceRefs: ['E05:evidence_version:ev-ledger@1'] } });
    const song = await engine.createProject(c, { kind: 'audio', title: 'Bed', doc: compose({ title: 'Bed', seed: 'bed', mood: 'calm', guide: { enabled: false }, sections: [{ type: 'instrumental', bars: 4 }] }) });
    const sr = await finish(engine, c, await engine.requestRender(c, { productionId: song.id })); assert.equal(sr.state, 'done', sr.error ?? '');
    const bed = await engine.importRenderOutput(c, { renderId: sr.id, output: 'Bed.flac', name: 'Music bed' });
    const doc = { title: 'The Larkmoor Fund', width: 640, height: 360, fps: 15, scenes: [
      { id: 'open', duration: 2.5, visual: { type: 'title', title: 'The Larkmoor Fund', subtitle: 'Where the money went' }, narration: { type: 'tts', text: 'This is the story of the Larkmoor relief fund.' } },
      { id: 'ledger', duration: 4, visual: { type: 'image', assetId: page.id, kenBurns: { from: { x: 0.3, y: 0.2, zoom: 1.2 }, to: { x: 0.4, y: 0.35, zoom: 1.6 } } }, transition: { type: 'crossfade', duration: 0.5 }, sources: ['E07:claim:c-ledger@2'],
        overlays: [{ id: 'lt', type: 'lowerThird', title: 'Council ledger', subtitle: 'Spring quarter', start: 0.4, end: 3.5, animation: 'slide' }], narration: { type: 'tts', text: 'One transfer of thirty one thousand has no receipt.' } },
      { id: 'pump', duration: 3.5, basis: 'reconstruction', disclosure: 'This scene is a reconstruction drawn from committee minutes.', transition: { type: 'cut' },
        visual: { type: 'scene', scene: { background: '#1b4332', layers: [
          { id: 'water', type: 'shape', x: 0, y: 260, width: 640, height: 100, fill: '#3a86ff', keyframes: [{ t: 0, props: { y: 330 } }, { t: 3, props: { y: 200 } }] },
          { id: 'label', type: 'text', text: 'PUMP HOUSE', x: 60, y: 110, width: 520, size: 54, color: '#ffffff', bold: true, align: 'center' } ] } } },
    ], audio: [{ id: 'bed', role: 'music', assetId: bed.id, start: 0, gain: -8, fadeIn: 0.5, fadeOut: 1.5, loop: true }], credits: { lines: ['Directed by Ines Varga'], seconds: 4 } };
    const project = await engine.createProject(c, { kind: 'video', title: doc.title, doc, editorialRef: 'E09:document:script-flood@2' });
    const save = async (renderId: string, name: string): Promise<string> => { const f = await engine.getRenderOutput(c, renderId, name); const p = join(root, `${renderId.slice(0, 6)}-${name}`); writeFileSync(p, f.bytes); return p; };

    const pv = await finish(engine, c, await engine.requestRender(c, { productionId: project.id, profile: 'preview' }));
    assert.equal(pv.state, 'done', pv.error ?? '');
    const pvInfo = probe(await save(pv.id, 'The-Larkmoor-Fund.preview.mp4')); const pvVideo = pvInfo.streams.find((s: any) => s.codec_type === 'video');
    assert.equal(pvVideo.height, 240); assert.equal(pvVideo.r_frame_rate, '12/1');                    // previews are low-res and fast

    const r1 = await finish(engine, c, await engine.requestRender(c, { productionId: project.id }));
    assert.equal(r1.state, 'done', r1.error ?? '');
    const man = await engine.getRenderManifest(c, r1.id) as any;
    const mp4 = await save(r1.id, 'The-Larkmoor-Fund.mp4'); const info = probe(mp4);
    const v = info.streams.find((s: any) => s.codec_type === 'video'), a = info.streams.find((s: any) => s.codec_type === 'audio');
    assert.equal(v.codec_name, 'h264'); assert.equal(v.width, 640); assert.equal(v.height, 360); assert.equal(v.pix_fmt, 'yuv420p'); assert.equal(a.codec_name, 'aac');
    if (process.env.E10_KEEP) writeFileSync(join(process.env.E10_KEEP, 'video.mp4'), (await engine.getRenderOutput(c, r1.id, 'The-Larkmoor-Fund.mp4')).bytes);
    const timeline = man.details.timeline as any[];
    assert.deepEqual(timeline.map((s) => s.kind), ['scene', 'scene', 'disclosure', 'scene', 'credits']);      // mandatory disclosure card inserted
    const expected = man.parameters.durationSeconds; assert.ok(expected > 15 && expected < 22, `duration ${expected}`);
    assert.ok(Math.abs(Number(info.format.duration) - expected) < 0.4, `mp4 ${info.format.duration} vs ${expected}`);
    const webm = probe(await save(r1.id, 'The-Larkmoor-Fund.webm'));
    assert.deepEqual(webm.streams.map((s: any) => s.codec_name).sort(), ['opus', 'vp9']); assert.ok(Math.abs(Number(webm.format.duration) - expected) < 0.5);
    // on-screen text: title card, burned-in caption, lower third, disclosure card and persistent label
    const at = (id: string): any => timeline.find((s) => s.id === id);
    assert.match(ocrAt(mp4, at('open').start + 1.8, root), /Larkmoor Fund/);
    const ledgerFrame = ocrAt(mp4, at('ledger').start + 2, root);
    assert.match(ledgerFrame, /Council ledger/); assert.match(ledgerFrame, /thirty one thousand|no receipt/);
    assert.match(ocrAt(mp4, at('pump-disclosure').start + 1.5, root), /RECONSTRUCTION/);
    const pumpFrame = ocrAt(mp4, at('pump').start + 2, root); assert.match(pumpFrame, /PUMP HOUSE/); assert.match(ocrAt(mp4, at('pump').start + 2.1, root, 'crop=iw*0.4:ih*0.14:0:0,scale=iw*3:-1,'), /RECONSTRUCTION/);
    assert.match(ocrAt(mp4, at('credits').start + 2.2, root), /Ines Varga|Credits|Larkmoor/);
    // motion: the keyframed water level differs between two frames of the same scene
    const px = (t: number): string => { const png = join(root, `px-${t}.png`); tool('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', mp4, '-frames:v', '1', png]); return tool('convert', [png, '-crop', '1x1+320+250', '-depth', '8', 'txt:-']).split('\n')[1]!.match(/#([0-9A-F]{6})/)![1]!; };
    assert.notEqual(px(at('pump').start + 0.3), px(at('pump').start + 3.2));
    // sidecars
    const srt = Buffer.from((await engine.getRenderOutput(c, r1.id, 'The-Larkmoor-Fund.srt')).bytes).toString();
    assert.match(srt, /^1\n00:00:00,\d{3} --> /); assert.match(srt, /story of the Larkmoor relief fund/); assert.match(srt, /\[RECONSTRUCTION\] This scene is a reconstruction/);
    assert.match(Buffer.from((await engine.getRenderOutput(c, r1.id, 'The-Larkmoor-Fund.vtt')).bytes).toString(), /^WEBVTT\n\n00:00:00\.\d{3} --> /);
    assert.equal(tool('identify', ['-format', '%w %h', await save(r1.id, 'poster.jpg')]), '640 360'); assert.ok(r1.outputs.some((o) => o.name === 'thumb-2.jpg'));
    // audio: narration over a ducked, looped bed; loudness normalised
    const wav = join(root, 'a.wav'); tool('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const rms = (x: number, y: number): number => JSON.parse(tool('python3', ['-I', join(import.meta.dirname, 'analyze.py'), 'rms', wav, String(x), String(y)]));
    assert.ok(rms(0.5, 2.5) > 0.02, 'narration audible'); assert.ok(rms(at('pump-disclosure').start + 0.5, at('pump-disclosure').start + 2.5) > 0.003, 'music continues (looped) without narration');
    // manifest
    assert.equal(man.disclosures.length, 1); assert.equal(man.disclosures[0].blockId, 'pump');
    assert.deepEqual(man.inputs.map((i: any) => i.name).sort(), ['Ledger page 14', 'Music bed']);
    assert.ok(man.credits.some((x: string) => /Larkmoor council archive/.test(x)) && man.credits.some((x: string) => /synthetic speech/.test(x)));
    assert.ok(man.sources.includes('E09:document:script-flood@2') && man.sources.includes('E07:claim:c-ledger@2') && man.sources.includes('E11:permission:perm-ledger'));
    assert.ok(man.generated.some((g: any) => g.kind === 'motion-graphics' && g.uniqueFrames > 10));
    assert.ok(man.tools.some((t: any) => t.name === 'ffmpeg')); assert.equal((r1.qc as any).ok, true, JSON.stringify(r1.qc));

    // revise one scene: only that segment is re-rendered (the others come from the per-scene cache); old render retained
    await engine.applyOperations(c, { productionId: project.id, operations: [{ op: 'set', path: '/scenes/id=open/visual/title', value: 'Larkmoor: The Missing Receipt' }, { op: 'addOverlay', sceneId: 'ledger', overlay: { id: 'note', type: 'text', text: 'Page 14', start: 1, end: 3, animation: 'typewriter', x: 420, y: 30, width: 200, size: 22 } }] });
    const r2 = await finish(engine, c, await engine.requestRender(c, { productionId: project.id }));
    assert.equal(r2.state, 'done', r2.error ?? '');
    const man2 = await engine.getRenderManifest(c, r2.id) as any;
    assert.deepEqual(man2.details.timeline.map((s: any) => s.cached), [false, false, true, true, true]); assert.equal(man2.parameters.segmentCache.hits, 3);
    const mp4b = await save(r2.id, 'The-Larkmoor-Fund.mp4');
    assert.match(ocrAt(mp4b, 1.9, root), /Missing Receipt/); assert.doesNotMatch(ocrAt(mp4, 1.9, root), /Missing Receipt/);
    assert.equal((await engine.getRenderOutput(c, r1.id, 'The-Larkmoor-Fund.mp4')).sha256, r1.outputs[0]!.sha256);
    assert.equal(r2.revision, 2); assert.ok(r2.seq > r1.seq);
  });
});
