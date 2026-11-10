// Interactive works: an editable story graph (nodes, choices, conditions, variables, endings) with a working preview and
// a self-contained distributable (index.html + sources.html + assets/, zipped; no network dependencies).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { run, safeName, sha256, xml } from './tools.ts';
import { arr, basisLabel, collectAssets, collectSources, collectText, disclosureText, idOf, isObj, isUref, needsDisclosure, objs, str, uniqueIds, urefs } from './types.ts';
import type { Disclosure, Doc, EditorialExport, Pipeline, PipelineResult, RenderEnv } from './types.ts';

const OPS = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'set', 'unset'];
const scalar = (v: unknown): v is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof v);
function validate(raw: unknown): Doc {
  invariant(isObj(raw), 'invalid_input', 'Document must be an object');
  const nodes = objs(raw.nodes).map((nd) => {
    const basis = str(nd.basis, '', 40);
    const choices = objs(nd.choices).map((c, i) => {
      const cond = isObj(c.condition) ? c.condition : null; invariant(cond === null || (typeof cond.var === 'string' && OPS.includes(str(cond.op))), 'invalid_input', `Node ${String(nd.id)}: a condition needs var and op (${OPS.join(', ')})`);
      const set: Doc = {}; if (isObj(c.set)) for (const [k, v] of Object.entries(c.set)) { invariant(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) && scalar(v), 'invalid_input', 'Choice effects must set simple variables to scalar values'); set[k] = v; }
      return { id: typeof c.id === 'string' ? idOf(c.id, 'choice') : `c${i + 1}`, label: str(c.label, '', 300), target: str(c.target, '', 64), ...(cond === null ? {} : { condition: { var: str(cond.var, '', 41), op: str(cond.op), ...(scalar(cond.value) ? { value: cond.value } : {}) } }), ...(Object.keys(set).length > 0 ? { set } : {}) };
    });
    invariant(choices.every((c) => c.label.trim() !== ''), 'invalid_input', `Node ${String(nd.id)}: every choice needs a label`);
    return { id: idOf(nd.id, 'node'), title: str(nd.title, '', 300), text: str(nd.text, '', 20000),
      media: objs(nd.media).map((m) => ({ assetId: (invariant(typeof m.assetId === 'string' && m.assetId !== '', 'invalid_input', 'Media needs assetId'), m.assetId as string), ...(typeof m.assetVersion === 'number' ? { assetVersion: m.assetVersion } : {}), alt: str(m.alt, '', 1000), caption: str(m.caption, '', 1000) })),
      choices, ...(typeof nd.ending === 'string' && nd.ending.trim() !== '' ? { ending: nd.ending.slice(0, 200) } : {}), ...(basis === '' ? {} : { basis }), ...(needsDisclosure(basis) ? { disclosure: disclosureText(basis, nd.disclosure) } : {}),
      ...(urefs(nd.sources).length > 0 ? { sources: urefs(nd.sources) } : {}), ...(typeof nd.sourceNote === 'string' && nd.sourceNote !== '' ? { sourceNote: nd.sourceNote.slice(0, 2000) } : {}), ...(typeof nd.attribution === 'string' && nd.attribution !== '' ? { attribution: nd.attribution.slice(0, 300) } : {}) };
  });
  invariant(nodes.length <= 2000, 'invalid_input', 'Too many nodes'); uniqueIds(nodes, 'node');
  const variables: Doc = {}; if (isObj(raw.variables)) for (const [k, v] of Object.entries(raw.variables)) { invariant(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) && scalar(v), 'invalid_input', 'Variables must be simple names with scalar initial values'); variables[k] = v; }
  const notes: Doc = {}; if (isObj(raw.sourceNotes)) for (const [k, v] of Object.entries(raw.sourceNotes)) if (isUref(k) && typeof v === 'string') notes[k] = v.slice(0, 1000);
  return { kind: 'interactive', title: str(raw.title, 'Untitled', 300), language: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(str(raw.language)) ? str(raw.language) : 'en', intro: str(raw.intro, '', 2000), ...(typeof raw.notice === 'string' && raw.notice !== '' ? { notice: raw.notice.slice(0, 1000) } : {}),
    start: str(raw.start, nodes[0]?.id ?? '', 64), variables, nodes, sourceNotes: notes, credits: arr(raw.credits).filter((c): c is string => typeof c === 'string').slice(0, 100) };
}
/** Graph validation: missing start/targets, dead ends, unreachable nodes, no reachable ending, undeclared variables. */
export function checkGraph(doc: Doc): { level: 'error' | 'warning'; message: string; at?: string }[] {
  const out: { level: 'error' | 'warning'; message: string; at?: string }[] = []; const nodes = objs(doc.nodes); const by = new Map(nodes.map((x) => [x.id as string, x]));
  if (nodes.length === 0) return [{ level: 'error', message: 'The story has no nodes yet' }];
  if (!by.has(str(doc.start))) out.push({ level: 'error', message: `Start node "${str(doc.start)}" does not exist` });
  const vars = new Set(Object.keys(doc.variables as Doc));
  for (const nd of nodes) {
    const id = nd.id as string; const choices = objs(nd.choices);
    if (typeof nd.ending !== 'string' && choices.length === 0) out.push({ level: 'error', message: `Node "${id}" is a dead end: give it choices or mark it as an ending`, at: id });
    if (typeof nd.ending === 'string' && choices.length > 0) out.push({ level: 'error', message: `Node "${id}" is an ending and cannot offer choices`, at: id });
    if (choices.length > 0 && choices.every((c) => isObj(c.condition))) out.push({ level: 'warning', message: `Every choice of node "${id}" is conditional; a reader may get stuck`, at: id });
    for (const c of choices) {
      if (!by.has(str(c.target))) out.push({ level: 'error', message: `Node "${id}": choice "${str(c.label)}" leads to unknown node "${str(c.target)}"`, at: id });
      if (isObj(c.condition) && !vars.has(str(c.condition.var))) out.push({ level: 'warning', message: `Node "${id}": condition uses undeclared variable "${str(c.condition.var)}"`, at: id });
      for (const k of Object.keys(isObj(c.set) ? c.set : {})) if (!vars.has(k)) out.push({ level: 'warning', message: `Node "${id}": choice sets undeclared variable "${k}"`, at: id });
    }
    if (str(nd.text).trim() === '' && objs(nd.media).length === 0) out.push({ level: 'warning', message: `Node "${id}" has no content`, at: id });
  }
  const reached = new Set<string>(); const queue = by.has(str(doc.start)) ? [str(doc.start)] : [];
  while (queue.length > 0) { const id = queue.pop() as string; if (reached.has(id)) continue; reached.add(id); for (const c of objs(by.get(id)?.choices)) if (by.has(str(c.target))) queue.push(str(c.target)); }
  for (const nd of nodes) if (!reached.has(nd.id as string)) out.push({ level: 'warning', message: `Node "${String(nd.id)}" cannot be reached from the start`, at: nd.id as string });
  if (reached.size > 0 && ![...reached].some((id) => typeof by.get(id)?.ending === 'string')) out.push({ level: 'error', message: 'No ending can be reached from the start' });
  return out;
}

// ───────────────────────────── page generation ─────────────────────────────
type Media = { src: string; kind: 'image' | 'audio' | 'video'; credit: string };
const CSS = `:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1a1a1a;--muted:#555;--accent:#14213d;--warn:#9d0208;--card:#fff;--line:#d0cdc4}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--fg:#ecebe7;--muted:#a9a9a9;--accent:#fca311;--warn:#ff6b6b;--card:#1b1e23;--line:#33373d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:1.05rem/1.6 "DejaVu Serif",Georgia,serif}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;background:var(--card);padding:.5rem 1rem;z-index:2}
header,main,footer,.wrap{max-width:42rem;margin:0 auto;padding:1rem 1.2rem}header{border-bottom:1px solid var(--line)}
header p{margin:.2rem 0;color:var(--muted);font-size:.9rem}h1,h2,button,.label,nav{font-family:"DejaVu Sans",Verdana,sans-serif}
h1{font-size:1.15rem;margin:0}h2{font-size:1.6rem;line-height:1.25;margin:.4rem 0 1rem}h2:focus{outline:none}
.label{display:inline-block;background:var(--warn);color:#fff;font-weight:bold;font-size:.8rem;letter-spacing:.08em;padding:.15rem .5rem;border-radius:.2rem}
.disclosure{border-left:.3rem solid var(--warn);padding:.4rem .8rem;margin:.6rem 0 1rem;background:var(--card);font-size:.95rem}
figure{margin:1rem 0}figure img,figure video{max-width:100%;height:auto;display:block}figcaption{font-size:.85rem;color:var(--muted)}audio{width:100%}
ol.choices{list-style:none;padding:0;margin:1.5rem 0}ol.choices li{margin:.6rem 0}
button{font-size:1rem;padding:.7rem 1rem;border:2px solid var(--accent);background:var(--card);color:var(--fg);border-radius:.4rem;cursor:pointer;text-align:left;width:100%}
button:hover,button:focus-visible{background:var(--accent);color:var(--bg);outline:3px solid var(--fg);outline-offset:2px}
button.secondary{width:auto;border-width:1px;font-size:.9rem;padding:.4rem .8rem}
.ending{font-weight:bold;border-top:1px solid var(--line);padding-top:1rem}details{margin:1rem 0;font-size:.9rem}code{font-family:"DejaVu Sans Mono",monospace;font-size:.85em;overflow-wrap:anywhere}
footer{border-top:1px solid var(--line);font-size:.85rem;color:var(--muted)}footer a,main a{color:inherit}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
section.static{border-top:1px solid var(--line);margin-top:2rem;padding-top:1rem}`;
// The runtime builds every element with textContent/setAttribute: story text is never parsed as HTML.
const RUNTIME = `(function(){
var story=JSON.parse(document.getElementById('story').textContent),nodes={},KEY='e10-story:'+story.id;
story.nodes.forEach(function(n){nodes[n.id]=n});
var state={node:story.start,vars:Object.assign({},story.variables),steps:0};
function load(){try{var s=JSON.parse(window.localStorage.getItem(KEY)||'null');if(s&&nodes[s.node]&&s.digest===story.digest){state={node:s.node,vars:s.vars||{},steps:s.steps||0};return true}}catch(e){}return false}
function save(){try{window.localStorage.setItem(KEY,JSON.stringify({node:state.node,vars:state.vars,steps:state.steps,digest:story.digest}))}catch(e){}}
function clear(){try{window.localStorage.removeItem(KEY)}catch(e){}}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function ok(c){if(!c)return true;var v=state.vars[c.var],x=c.value;switch(c.op){case'eq':return v===x;case'ne':return v!==x;case'gt':return v>x;case'lt':return v<x;case'gte':return v>=x;case'lte':return v<=x;case'set':return v!==undefined&&v!==false&&v!==null&&v!=='';case'unset':return v===undefined||v===false||v===null||v==='';}return false}
function go(choice){if(choice.set)for(var k in choice.set)state.vars[k]=choice.set[k];state.node=choice.target;state.steps++;save();render(true)}
function restart(){clear();state={node:story.start,vars:Object.assign({},story.variables),steps:0};render(true)}
function render(focus){var n=nodes[state.node],root=document.getElementById('scene');root.textContent='';
var h=el('h2','',n.title||story.title);h.id='node-title';h.tabIndex=-1;root.appendChild(h);
if(n.disclosure){var d=el('p','disclosure');d.setAttribute('role','note');d.appendChild(el('span','label',n.label));d.appendChild(document.createTextNode(' '+n.disclosure));root.appendChild(d)}
(n.media||[]).forEach(function(m){var f=el('figure'),x;if(m.kind==='image'){x=el('img');x.alt=m.alt||''}else{x=el(m.kind);x.controls=true;x.setAttribute('aria-label',m.alt||m.caption||m.kind)}x.src=m.src;f.appendChild(x);f.appendChild(el('figcaption','',(m.caption?m.caption+' — ':'')+m.credit));root.appendChild(f)});
n.text.split(/\\n\\s*\\n/).forEach(function(p){if(p.trim())root.appendChild(el('p','',p.trim()))});
if(n.attribution)root.appendChild(el('p','attribution','— '+n.attribution));
if(n.ending){root.appendChild(el('p','ending','The end: '+n.ending));var r=el('button','secondary','Start again');r.type='button';r.id='restart';r.addEventListener('click',restart);root.appendChild(r)}
else{var list=el('ol','choices');list.setAttribute('aria-label','Choices');var i=0;n.choices.forEach(function(c){if(!ok(c.condition))return;i++;var li=el('li'),b=el('button','',i+'. '+c.label);b.type='button';b.setAttribute('data-choice',c.id);b.addEventListener('click',function(){go(c)});li.appendChild(b);list.appendChild(li)});root.appendChild(list);
if(i===0)root.appendChild(el('p','ending','No further choices are available on this path.'));if(state.steps>0){var rb=el('button','secondary','Start again');rb.type='button';rb.id='restart';rb.addEventListener('click',restart);root.appendChild(rb)}}
if((n.sources&&n.sources.length)||n.sourceNote){var dt=el('details'),sm=el('summary','','Sources for this page');dt.appendChild(sm);if(n.sourceNote)dt.appendChild(el('p','',n.sourceNote));var ul=el('ul');(n.sources||[]).forEach(function(s){var li=el('li');if(story.sourceNotes[s])li.appendChild(document.createTextNode(story.sourceNotes[s]+' — '));li.appendChild(el('code','',s));ul.appendChild(li)});dt.appendChild(ul);root.appendChild(dt)}
document.getElementById('status').textContent=(n.title||story.title)+(n.ending?'. The end.':'');
if(focus){h.focus();window.scrollTo(0,0)}}
document.addEventListener('keydown',function(e){if(e.altKey||e.ctrlKey||e.metaKey)return;var t=e.target&&e.target.tagName;if(t==='INPUT'||t==='TEXTAREA')return;if(e.key>='1'&&e.key<='9'){var b=document.querySelectorAll('ol.choices button')[Number(e.key)-1];if(b){e.preventDefault();b.click()}}});
var resumed=load();render(false);if(resumed&&state.steps>0)document.getElementById('status').textContent='Resumed where you left off: '+(nodes[state.node].title||story.title);
})();`;
function pageShell(doc: Doc, title: string, body: string, script: string): string {
  return `<!DOCTYPE html>\n<html lang="${xml(doc.language)}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; media-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"/><title>${xml(title)}</title><style>${CSS}</style></head><body>\n${body}\n${script}</body></html>\n`;
}
const mediaKey = (m: Doc): string => `${String(m.assetId)}@${typeof m.assetVersion === 'number' ? m.assetVersion : ''}`;
function disclosuresOf(doc: Doc): Disclosure[] { return objs(doc.nodes).filter((x) => needsDisclosure(x.basis)).map((x) => ({ basis: str(x.basis), text: str(x.disclosure), where: 'shown on the page above the passage, and listed on the sources page', blockId: x.id as string })); }
/** Builds index.html and sources.html. `media` maps `assetId@version` to a relative path or data URI. */
export function buildPages(doc: Doc, media: ReadonlyMap<string, Media>, credits: readonly string[], sourcesHref: string | null): { index: string; sources: string } {
  const nodes = objs(doc.nodes); const notes = doc.sourceNotes as Doc;
  const story = { id: sha256(str(doc.title)).slice(0, 12), digest: sha256(JSON.stringify(nodes)).slice(0, 16), title: str(doc.title), start: str(doc.start), variables: doc.variables, sourceNotes: notes,
    nodes: nodes.map((x) => ({ id: x.id, title: x.title, text: x.text, choices: x.choices, ...(typeof x.ending === 'string' ? { ending: x.ending } : {}), ...(needsDisclosure(x.basis) ? { disclosure: x.disclosure, label: basisLabel(str(x.basis)) } : {}), ...(Array.isArray(x.sources) ? { sources: x.sources } : {}), ...(typeof x.sourceNote === 'string' ? { sourceNote: x.sourceNote } : {}), ...(typeof x.attribution === 'string' ? { attribution: x.attribution } : {}),
      media: objs(x.media).flatMap((m) => { const r = media.get(mediaKey(m)); return r === undefined ? [] : [{ src: r.src, kind: r.kind, alt: m.alt, caption: m.caption, credit: r.credit }]; }) })) };
  const disclosures = disclosuresOf(doc);
  // Without JavaScript the whole story is still readable as linked sections.
  const fallback = nodes.map((x) => `<section class="static" id="n-${xml(x.id)}"><h2>${xml(str(x.title) || str(x.id))}</h2>${needsDisclosure(x.basis) ? `<p class="disclosure" role="note"><span class="label">${xml(basisLabel(str(x.basis)))}</span> ${xml(x.disclosure)}</p>` : ''}${str(x.text).split(/\n\s*\n/).map((p) => `<p>${xml(p.trim())}</p>`).join('')}${typeof x.ending === 'string' ? `<p class="ending">The end: ${xml(x.ending)}</p>` : `<ul>${objs(x.choices).map((c) => `<li><a href="#n-${xml(c.target)}">${xml(c.label)}</a></li>`).join('')}</ul>`}</section>`).join('\n');
  const srcLink = sourcesHref === null ? '<a href="#sources">Sources and disclosures</a>' : `<a href="${xml(sourcesHref)}">Sources and disclosures</a>`;
  const sourcesBody = (heading: string): string => {
    const all = new Map<string, string[]>(); for (const x of nodes) for (const s of arr(x.sources) as string[]) all.set(s, [...(all.get(s) ?? []), str(x.title) || str(x.id)]);
    return `<${heading}>Disclosures</${heading}>${disclosures.length === 0 ? '<p>No part of this work is labelled as reconstruction or invention.</p>' : `<ul>${disclosures.map((d) => `<li><span class="label">${xml(basisLabel(d.basis))}</span> ${xml(d.text)} <em>(${xml(str(nodes.find((x) => x.id === d.blockId)?.title) || d.blockId)})</em></li>`).join('')}</ul>`}
<${heading}>Sources</${heading}>${all.size === 0 ? '<p>No sources are cited.</p>' : `<dl>${[...all].map(([s, where]) => `<dt><code>${xml(s)}</code>${typeof notes[s] === 'string' ? ` — ${xml(notes[s])}` : ''}</dt><dd>Used in: ${where.map(xml).join('; ')}</dd>`).join('')}</dl>`}
<${heading}>Credits</${heading}>${credits.length === 0 ? '<p>None.</p>' : `<ul>${credits.map((c) => `<li>${xml(c)}</li>`).join('')}</ul>`}`;
  };
  const index = pageShell(doc, str(doc.title), `<a class="skip" href="#scene">Skip to the story</a>
<header><h1>${xml(doc.title)}</h1>${str(doc.intro) === '' ? '' : `<p>${xml(doc.intro)}</p>`}${typeof doc.notice === 'string' ? `<p><strong>${xml(doc.notice)}</strong></p>` : ''}<p>Choose with Tab and Enter, or press a number key. Your place is saved on this device.</p></header>
<main id="main"><div id="status" class="sr" role="status" aria-live="polite"></div><div id="scene"></div><noscript><p><strong>This story works best with JavaScript. Without it, every passage is listed below and the choices are links.</strong></p>${fallback}</noscript></main>
${sourcesHref === null ? `<section id="sources" class="wrap" aria-label="Sources and disclosures">${sourcesBody('h2')}</section>` : ''}
<footer><nav aria-label="About this work"><p>${srcLink}</p></nav></footer>`, `<script type="application/json" id="story">${JSON.stringify(story).replace(/</g, '\\u003c')}</script><script>${RUNTIME}</script>`);
  const sources = pageShell(doc, `${str(doc.title)} — sources`, `<header><h1>${xml(doc.title)} — sources and disclosures</h1><p><a href="index.html">Back to the story</a></p></header><main id="main">${sourcesBody('h2')}</main>`, '');
  return { index, sources };
}
const kindOf = (mediaType: string): Media['kind'] | null => (mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('audio/') ? 'audio' : mediaType.startsWith('video/') ? 'video' : null);
/** Live preview: one HTML page with media inlined as data URIs (a single authenticated request serves everything). */
export async function buildInteractivePreview(doc: Doc, asset: (assetId: string, version?: number) => Promise<{ bytes: Uint8Array; mediaType: string; filename: string; credit: string } | null>): Promise<string> {
  const media = new Map<string, Media>();
  for (const nd of objs(doc.nodes)) for (const m of objs(nd.media)) {
    if (media.has(mediaKey(m))) continue;
    const a = await asset(m.assetId as string, typeof m.assetVersion === 'number' ? m.assetVersion : undefined).catch(() => null); const kind = a === null ? null : kindOf(a.mediaType);
    if (a !== null && kind !== null && a.mediaType !== 'image/svg+xml') media.set(mediaKey(m), { src: `data:${a.mediaType};base64,${Buffer.from(a.bytes).toString('base64')}`, kind, credit: a.credit });
  }
  return buildPages(doc, media, arr(doc.credits) as string[], null).index;
}
async function render(doc: Doc, env: RenderEnv): Promise<PipelineResult> {
  const problems = checkGraph(doc); const base = safeName(str(doc.title, 'story')).replace(/\.+$/, '') || 'story';
  invariant(!problems.some((p) => p.level === 'error'), 'invalid_input', `The story graph has problems: ${problems.filter((p) => p.level === 'error').map((p) => p.message).slice(0, 5).join('; ')}`);
  const site = join(env.dir, 'site'); await mkdir(join(site, 'assets'), { recursive: true }); const media = new Map<string, Media>(); const inline = new Map<string, Media>();
  for (const nd of objs(doc.nodes)) for (const m of objs(nd.media)) {
    if (media.has(mediaKey(m))) continue;
    const a = await env.asset(m.assetId as string, typeof m.assetVersion === 'number' ? m.assetVersion : undefined); const kind = kindOf(a.mediaType);
    invariant(kind !== null && a.mediaType !== 'image/svg+xml', 'invalid_input', `Asset ${a.name} cannot be shown in an interactive work (use PNG, JPEG, WebP, audio or video)`);
    const file = `${a.assetId.slice(0, 8)}-v${a.version}-${a.filename}`; const bytes = await readFile(a.path); await writeFile(join(site, 'assets', file), bytes);
    const credit = a.rights.kind === 'permission' ? a.rights.attribution ?? 'used with permission' : a.rights.attribution;
    media.set(mediaKey(m), { src: `assets/${encodeURIComponent(file)}`, kind, credit }); inline.set(mediaKey(m), { src: `data:${a.mediaType};base64,${bytes.toString('base64')}`, kind, credit });
  }
  const credits = [...arr(doc.credits) as string[], ...env.credits()]; const disclosures = disclosuresOf(doc);
  const single = join(env.dir, `${base}.html`); await writeFile(single, buildPages(doc, inline, credits, null).index);
  const params = { nodes: objs(doc.nodes).length, endings: objs(doc.nodes).filter((x) => typeof x.ending === 'string').length, warnings: problems.map((p) => p.message), offline: true };
  if (env.profile === 'preview') return { outputs: [{ name: `${base}.preview.html`, path: single, mediaType: 'text/html', role: 'preview' }], parameters: params, disclosures, credits, generated: [] };
  await env.tool('zip', 'unzip');
  const pages = buildPages(doc, media, credits, 'sources.html'); await writeFile(join(site, 'index.html'), pages.index); await writeFile(join(site, 'sources.html'), pages.sources);
  await writeFile(join(site, 'README.txt'), `${str(doc.title)}\n\nOpen index.html in any web browser. No internet connection is needed.\nSources and disclosures: sources.html\n`);
  const zip = join(env.dir, `${base}.zip`); await run('zip', ['-q', '-X', '-r', zip, '.'], { cwd: site, signal: env.signal });
  const test = await run('unzip', ['-tqq', zip], { allowFail: true, signal: env.signal });
  const external = /(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(pages.index + pages.sources);
  return { outputs: [{ name: `${base}.zip`, path: zip, mediaType: 'application/zip', role: 'primary' }, { name: `${base}.html`, path: single, mediaType: 'text/html', role: 'primary' }], parameters: params, disclosures, credits, generated: [],
    details: { requiredDisclosures: disclosures.map((d) => d.blockId ?? ''), qc: [{ check: 'archive', ok: test.code === 0, detail: 'zip integrity' }, { check: 'no-network-references', ok: !external, detail: 'pages reference only bundled files' }, { check: 'graph', ok: true, detail: `${params.nodes} nodes, ${params.endings} endings, ${problems.length} warnings` }] } };
}

const nodeIndex = (doc: Doc, id: unknown): number => { const i = objs(doc.nodes).findIndex((x) => x.id === id); invariant(i >= 0, 'invalid_input', `No node ${String(id)}`); return i; };
export const interactivePipeline: Pipeline = {
  kind: 'interactive', tools: [],
  validate,
  empty: (title) => validate({ title, nodes: [] }),
  assetRefs: (doc) => collectAssets(doc.nodes as Json),
  sources: (doc) => [...new Set([...collectSources(doc), ...Object.keys(doc.sourceNotes as Doc)])],
  text: (doc) => [str(doc.title), str(doc.intro), ...collectText(doc.nodes as Json)].join('\n'),
  async applyOp(doc, op, helpers) {
    const out = structuredClone(doc); const nodes = out.nodes as Doc[];
    switch (op.op) {
      case 'addNode': { invariant(isObj(op.node), 'invalid_input', 'addNode needs a node'); nodes.push({ choices: [], media: [], ...op.node, id: typeof op.node.id === 'string' ? op.node.id : helpers.newId('node') }); if (nodes.length === 1) out.start = nodes[0]?.id as string; return out; }
      case 'updateNode': { const i = nodeIndex(out, op.nodeId); invariant(isObj(op.set), 'invalid_input', 'updateNode needs "set"'); nodes[i] = { ...nodes[i], ...op.set, id: op.nodeId as string }; return out; }
      case 'removeNode': { nodes.splice(nodeIndex(out, op.nodeId), 1); return out; }
      case 'addChoice': { const nd = nodes[nodeIndex(out, op.nodeId)] as Doc; invariant(isObj(op.choice), 'invalid_input', 'addChoice needs a choice'); (nd.choices as Doc[]).push({ ...op.choice, id: typeof op.choice.id === 'string' ? op.choice.id : helpers.newId('choice') }); return out; }
      case 'updateChoice': { const nd = nodes[nodeIndex(out, op.nodeId)] as Doc; const i = objs(nd.choices).findIndex((c) => c.id === op.choiceId); invariant(i >= 0 && isObj(op.set), 'invalid_input', 'updateChoice needs an existing choiceId and "set"'); (nd.choices as Doc[])[i] = { ...(nd.choices as Doc[])[i], ...op.set, id: op.choiceId as string }; return out; }
      case 'removeChoice': { const nd = nodes[nodeIndex(out, op.nodeId)] as Doc; const before = objs(nd.choices).length; nd.choices = objs(nd.choices).filter((c) => c.id !== op.choiceId); invariant(objs(nd.choices).length < before, 'invalid_input', 'No such choice'); return out; }
      case 'addMedia': { const nd = nodes[nodeIndex(out, op.nodeId)] as Doc; invariant(isObj(op.media), 'invalid_input', 'addMedia needs media'); await helpers.assetInfo(str(op.media.assetId)); (nd.media as Doc[]).push(op.media); return out; }
      case 'setStart': { nodeIndex(out, op.nodeId); out.start = op.nodeId as string; return out; }
      case 'setVariable': { invariant(typeof op.name === 'string' && scalar(op.value), 'invalid_input', 'setVariable needs name and a scalar value'); (out.variables as Doc)[op.name] = op.value; return out; }
      default: return null;
    }
  },
  render,
  async fromEditorial(ed: EditorialExport) {
    const story = ed.blocks.filter((b) => b.type === 'story_node');
    invariant(story.length > 0, 'invalid_input', 'The editorial document has no story nodes (an interactive_story export is needed)');
    const variables: Doc = {};
    const nodes = story.map((b) => {
      const choices = objs(b.data.choices).map((c, i) => { for (const [k, v] of Object.entries(isObj(c.effects) ? c.effects : {})) if (variables[k] === undefined) variables[k] = typeof v === 'number' ? 0 : typeof v === 'boolean' ? false : ''; if (isObj(c.condition) && variables[str(c.condition.var)] === undefined) variables[str(c.condition.var)] = false; return { id: `c${i + 1}`, label: str(c.label), target: str(c.to), ...(isObj(c.condition) ? { condition: c.condition } : {}), ...(isObj(c.effects) ? { set: c.effects } : {}) }; });
      return { id: str(b.data.key, b.id), title: str(b.data.title) || str(b.data.key, b.id).replace(/[-_]+/g, ' ').replace(/^./, (x) => x.toUpperCase()), text: b.text, choices, ...(typeof b.data.ending === 'string' ? { ending: b.data.ending } : {}), basis: b.basis, ...(b.disclosure === undefined ? {} : { disclosure: b.disclosure }), sources: b.sources, ...(b.attribution === undefined ? {} : { attribution: b.attribution }) };
    });
    const start = story.find((b) => b.data.start === true);
    return validate({ title: ed.title, language: ed.language, ...(ed.notice === null ? {} : { notice: ed.notice }), start: start === undefined ? nodes[0]?.id : str(start.data.key, start.id), variables, nodes, credits: ed.credits });
  },
  estimateSeconds: () => 3,
  check: checkGraph,
};
