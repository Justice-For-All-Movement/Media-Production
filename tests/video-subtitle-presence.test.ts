// Real own-PG/FFmpeg private video fixtures; no provider, publication or semantic caption inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ctx, finish, needsPg, withEngine } from './helpers.ts';
const entry = process.env.MEDIA_PACKAGE_ROOT === undefined ? resolve('src/engine/index.ts')
 : createRequire(resolve(process.env.MEDIA_PACKAGE_ROOT, 'package.json')).resolve('@accountability/media-production/engine');
const { createEngine } = await import(pathToFileURL(entry).href) as typeof import('../src/engine/index.ts');
for (const profile of ['preview','final'] as const) for (const captioned of [false,true]) {
 test('private video subtitles ' + profile + ' captioned=' + captioned, needsPg, () => withEngine(async h => {
  const c = ctx(), engine = createEngine({ sql:h.sql, objects:h.objects, config:{workRoot:h.root}, ports:{useDecisions:h.port} });
  const project = await engine.createProject(c,{kind:'video',title:'Fictional private video',doc:{
   title:'Fictional private clip',width:160,height:90,fps:12,credits:{enabled:false},
   scenes:[{id:'one',duration:1,visual:{type:'color',color:'#202020'},captions:captioned?[{start:0,end:1,text:'Literal fictional caption'}]:[]}],
  }});
  const rendered = await finish(engine,c,await engine.requestRender(c,{productionId:project.id,profile}));
  assert.equal(rendered.state,'done',rendered.error??'');
  assert.ok(rendered.outputs.some(o=>o.name.endsWith('.mp4')));
  assert.equal(rendered.outputs.some(o=>o.name.endsWith('.srt')),captioned);
  assert.equal(rendered.outputs.some(o=>o.name.endsWith('.vtt')),captioned&&profile==='final');
  const man = await engine.getRenderManifest(c,rendered.id) as any;
  assert.equal(man.parameters.captions.cues,captioned?1:0);
  if(captioned){
   const srt=rendered.outputs.find(o=>o.name.endsWith('.srt'))!;
   const bytes=await engine.getRenderOutput(c,rendered.id,srt.name);
   assert.match(new TextDecoder().decode(bytes.bytes),/Literal fictional caption/);
  } else {
   assert.equal(man.parameters.captions.burnedIn,false);
   assert.ok(!JSON.stringify(man.outputs).includes('.srt'));
  }
  if(profile==='final')assert.ok(rendered.outputs.some(o=>o.name.endsWith('.webm')));
  assert.equal((await engine.listRenders(c,{productionId:project.id})).length,1);
 }));
}
