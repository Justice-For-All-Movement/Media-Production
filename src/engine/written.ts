// Written works: structured chapters → HTML (print CSS), DOCX and EPUB (pandoc), PDF (pandoc DOCX → LibreOffice).
// Sources become numbered notes and a source companion; reconstruction/invention disclosures are printed in the text.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { fontFamily, run, safeName, xml } from './tools.ts';
import { arr, basisLabel, bool, collectAssets, collectSources, collectText, disclosureText, idOf, isObj, isUref, n, needsDisclosure, objs, str, uniqueIds, urefs } from './types.ts';
import type { Disclosure, Doc, EditorialExport, Pipeline, RenderEnv, RenderOutput } from './types.ts';

const BLOCK_TYPES = ['heading', 'paragraph', 'quote', 'list', 'verse', 'image', 'pagebreak'];
const PAGES: Readonly<Record<string, [number, number]>> = { A4: [210, 297], Letter: [215.9, 279.4], A5: [148, 210], B5: [176, 250] };

function normBlock(raw: unknown): Doc {
  invariant(isObj(raw), 'invalid_input', 'Block must be an object');
  const type = str(raw.type, 'paragraph'); invariant(BLOCK_TYPES.includes(type), 'invalid_input', `Unknown block type ${type}`);
  const basis = str(raw.basis, '', 40);
  const out: Doc = { id: idOf(raw.id, 'block'), type, text: str(raw.text) };
  if (type === 'heading') out.level = Math.round(n(raw.level, 2, 2, 4));
  if (type === 'list') { out.items = arr(raw.items).filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 5000)); out.ordered = bool(raw.ordered); }
  if (type === 'image') { invariant(typeof raw.assetId === 'string' && raw.assetId !== '', 'invalid_input', 'Image block needs assetId'); out.assetId = raw.assetId; if (typeof raw.assetVersion === 'number') out.assetVersion = raw.assetVersion; out.caption = str(raw.caption, '', 1000); out.alt = str(raw.alt, '', 1000); }
  if (basis !== '') out.basis = basis;
  if (needsDisclosure(basis)) out.disclosure = disclosureText(basis, raw.disclosure); else if (typeof raw.disclosure === 'string' && raw.disclosure.trim() !== '') out.disclosure = raw.disclosure.slice(0, 1000);
  if (typeof raw.attribution === 'string' && raw.attribution.trim() !== '') out.attribution = raw.attribution.slice(0, 500);
  const sources = urefs(raw.sources); if (sources.length > 0) out.sources = sources;
  return out;
}
function validate(raw: unknown): Doc {
  invariant(isObj(raw), 'invalid_input', 'Document must be an object');
  const l = isObj(raw.layout) ? raw.layout : {}; const m = isObj(l.margins) ? l.margins : {};
  const chapters = objs(raw.chapters).map((c) => ({ id: idOf(c.id, 'chapter'), title: str(c.title, '', 300), blocks: arr(c.blocks).map(normBlock) }));
  invariant(chapters.length <= 500, 'invalid_input', 'Too many chapters');
  uniqueIds(chapters, 'chapter'); uniqueIds(chapters.flatMap((c) => c.blocks), 'block');
  const notes: Doc = {}; if (isObj(raw.sourceNotes)) for (const [k, v] of Object.entries(raw.sourceNotes)) if (isUref(k) && typeof v === 'string') notes[k] = v.slice(0, 1000);
  return {
    kind: 'written', title: str(raw.title, 'Untitled', 300), subtitle: str(raw.subtitle, '', 300), authors: arr(raw.authors).filter((a): a is string => typeof a === 'string').slice(0, 20), language: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(str(raw.language)) ? str(raw.language) : 'en',
    ...(typeof raw.notice === 'string' && raw.notice !== '' ? { notice: raw.notice.slice(0, 1000) } : {}), credits: arr(raw.credits).filter((a): a is string => typeof a === 'string').slice(0, 100),
    layout: { pageSize: Object.hasOwn(PAGES, str(l.pageSize)) ? str(l.pageSize) : 'A4', margins: { top: n(m.top, 25, 5, 80), bottom: n(m.bottom, 25, 5, 80), left: n(m.left, 25, 5, 80), right: n(m.right, 25, 5, 80) }, bodyFont: fontFamily(l.bodyFont ?? 'DejaVu Serif'), headingFont: fontFamily(l.headingFont ?? 'DejaVu Sans'), fontSizePt: n(l.fontSizePt, 11, 6, 24), lineHeight: n(l.lineHeight, 1.45, 1, 3),
      titlePage: bool(l.titlePage, true), toc: bool(l.toc, true), notes: l.notes === 'endnotes' ? 'endnotes' : 'footnotes', sourceCompanion: bool(l.sourceCompanion, true), copyright: str(l.copyright, '', 1000) },
    sourceNotes: notes, chapters,
  };
}
const chaptersOf = (doc: Doc): Doc[] => objs(doc.chapters);
function locate(doc: Doc, blockId: unknown): { chapter: Doc; index: number } {
  for (const c of chaptersOf(doc)) { const i = objs(c.blocks).findIndex((b) => b.id === blockId); if (i >= 0) return { chapter: c, index: i }; }
  invariant(false, 'invalid_input', `No block ${String(blockId)}`);
}

// ───────────────────────────── rendering model ─────────────────────────────
type Note = { number: number; blockId: string; text: string; sources: string[] };
type Model = { doc: Doc; notes: Note[]; disclosures: Disclosure[]; noteOf: Map<string, Note>; sourceIndex: { ref: string; label: string; blocks: string[] }[] };
function model(doc: Doc): Model {
  const notes: Note[] = []; const disclosures: Disclosure[] = []; const noteOf = new Map<string, Note>(); const labels = doc.sourceNotes as Doc; const idx = new Map<string, { ref: string; label: string; blocks: string[] }>();
  for (const c of chaptersOf(doc)) for (const b of objs(c.blocks)) {
    const sources = arr(b.sources) as string[];
    if (sources.length > 0) {
      const note: Note = { number: notes.length + 1, blockId: b.id as string, sources, text: `${sources.length === 1 ? 'Source' : 'Sources'}: ${sources.map((s) => (typeof labels[s] === 'string' ? `${labels[s] as string} (${s})` : s)).join('; ')}${typeof b.basis === 'string' ? `. Basis: ${b.basis.replaceAll('_', ' ')}` : ''}.` };
      notes.push(note); noteOf.set(b.id as string, note);
      for (const s of sources) { const e = idx.get(s) ?? { ref: s, label: str(labels[s]), blocks: [] }; e.blocks.push(`${str(c.title) || 'Untitled chapter'} — note ${note.number}`); idx.set(s, e); }
    }
    if (typeof b.basis === 'string' && needsDisclosure(b.basis)) disclosures.push({ basis: b.basis, text: str(b.disclosure), where: `text before block ${String(b.id)} and disclosures page`, blockId: b.id as string });
  }
  return { doc, notes, disclosures, noteOf, sourceIndex: [...idx.values()] };
}
const css = (doc: Doc): string => {
  const l = doc.layout as Doc; const m = l.margins as Doc; const [w, h] = PAGES[str(l.pageSize)] as [number, number];
  return `@page { size: ${w}mm ${h}mm; margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm; }
html { font-family: "${l.bodyFont}", serif; font-size: ${l.fontSizePt}pt; line-height: ${l.lineHeight}; color: #1a1a1a; }
body { max-width: 42rem; margin: 2rem auto; padding: 0 1.2rem; }
h1, h2, h3, h4, .title, nav { font-family: "${l.headingFont}", sans-serif; line-height: 1.2; }
h1 { font-size: 1.9em; margin-top: 2.2em; break-before: page; } h2 { font-size: 1.35em; } h3 { font-size: 1.1em; }
.titlepage { text-align: center; padding: 5rem 0 3rem; break-after: page; } .title { font-size: 2.6em; font-weight: bold; } .subtitle { font-size: 1.3em; margin-top: .6em; } .authors { margin-top: 2em; }
blockquote { margin: 1em 2em; font-style: italic; } .attribution { font-style: normal; text-align: right; }
.verse { white-space: pre-line; margin-left: 2em; }
.disclosure { border-left: .3em solid #9d0208; padding: .3em .8em; margin: 1em 0 .4em; font-size: .9em; background: #fdf0ef; break-inside: avoid; break-after: avoid; }
.disclosure strong { font-family: "${l.headingFont}", sans-serif; letter-spacing: .05em; }
.notice { border: 1px solid #555; padding: .6em 1em; font-weight: bold; }
figure { margin: 1.2em 0; text-align: center; break-inside: avoid; } figure img { max-width: 100%; } figcaption { font-size: .9em; }
sup a { text-decoration: none; } .notes, .companion { font-size: .88em; } .companion code, .notes code { font-family: "DejaVu Sans Mono", monospace; font-size: .92em; overflow-wrap: anywhere; }
.pagebreak { break-after: page; } nav ol { list-style: none; padding-left: 0; } nav a { text-decoration: none; color: inherit; }
@media print { body { max-width: none; margin: 0; padding: 0; } a { color: inherit; } }`;
};
function html(mo: Model, images: Map<string, { file: string; credit: string }>, credits: string[]): string {
  const d = mo.doc; const l = d.layout as Doc; const out: string[] = [];
  const mark = (b: Doc): string => { const nt = mo.noteOf.get(b.id as string); return nt === undefined ? '' : `<sup id="ref-${nt.number}"><a href="#note-${nt.number}" role="doc-noteref" aria-label="Note ${nt.number}">${nt.number}</a></sup>`; };
  const attr = (b: Doc): string => (typeof b.attribution === 'string' ? ` <span class="attribution-inline">(${xml(b.attribution)})</span>` : '');
  if (l.titlePage === true) out.push(`<header class="titlepage"><div class="title">${xml(d.title)}</div>${str(d.subtitle) === '' ? '' : `<div class="subtitle">${xml(d.subtitle)}</div>`}${arr(d.authors).length === 0 ? '' : `<div class="authors">${arr(d.authors).map(xml).join(', ')}</div>`}${str(l.copyright) === '' ? '' : `<div class="copyright">${xml(l.copyright)}</div>`}</header>`);
  if (typeof d.notice === 'string') out.push(`<p class="notice">${xml(d.notice)}</p>`);
  if (mo.disclosures.length > 0) out.push(`<section class="disclosures" aria-label="Disclosures"><h2>Disclosures</h2><p>Parts of this work are not a direct record of events. Each such passage is marked where it appears:</p><ul>${mo.disclosures.map((x) => `<li><strong>${xml(basisLabel(x.basis))}</strong> — ${xml(x.text)}</li>`).join('')}</ul></section>`);
  if (l.toc === true && chaptersOf(d).length > 1) out.push(`<nav aria-label="Contents"><h2>Contents</h2><ol>${chaptersOf(d).map((c) => `<li><a href="#ch-${xml(c.id)}">${xml(str(c.title) || 'Untitled')}</a></li>`).join('')}</ol></nav>`);
  for (const c of chaptersOf(d)) {
    out.push(`<section id="ch-${xml(c.id)}"><h1>${xml(str(c.title) || 'Untitled')}</h1>`);
    for (const b of objs(c.blocks)) {
      if (typeof b.basis === 'string' && needsDisclosure(b.basis)) out.push(`<p class="disclosure" role="note"><strong>${xml(basisLabel(b.basis))}</strong> — ${xml(b.disclosure)}</p>`);
      const id = `id="b-${xml(b.id)}"`;
      if (b.type === 'heading') out.push(`<h${b.level} ${id}>${xml(b.text)}${mark(b)}</h${b.level}>`);
      else if (b.type === 'quote') out.push(`<blockquote ${id}><p>${xml(b.text)}${mark(b)}</p>${typeof b.attribution === 'string' ? `<p class="attribution">— ${xml(b.attribution)}</p>` : ''}</blockquote>`);
      else if (b.type === 'list') out.push(`<${b.ordered === true ? 'ol' : 'ul'} ${id}>${arr(b.items).map((i) => `<li>${xml(i)}</li>`).join('')}</${b.ordered === true ? 'ol' : 'ul'}>${mark(b)}`);
      else if (b.type === 'verse') out.push(`<p class="verse" ${id}>${xml(b.text)}${mark(b)}</p>`);
      else if (b.type === 'pagebreak') out.push('<div class="pagebreak"></div>');
      else if (b.type === 'image') { const im = images.get(b.id as string); if (im !== undefined) out.push(`<figure ${id}><img src="${xml(im.file)}" alt="${xml(str(b.alt) || str(b.caption))}"/><figcaption>${xml(b.caption)}${mark(b)} <span class="credit">${xml(im.credit)}</span></figcaption></figure>`); }
      else out.push(`<p ${id}>${xml(b.text).replaceAll('\n', '<br/>')}${attr(b)}${mark(b)}</p>`);
    }
    out.push('</section>');
  }
  if (mo.notes.length > 0) out.push(`<section class="notes" role="doc-endnotes"><h1>Notes</h1><ol>${mo.notes.map((nt) => `<li id="note-${nt.number}">${xml(nt.text)} <a href="#ref-${nt.number}" role="doc-backlink" aria-label="Back to text">↩</a></li>`).join('')}</ol></section>`);
  if (l.sourceCompanion === true && mo.sourceIndex.length > 0) out.push(`<section class="companion"><h1>Source companion</h1><p>Every source this work relies on, with the places it is used.</p><dl>${mo.sourceIndex.map((x) => `<dt><code>${xml(x.ref)}</code>${x.label === '' ? '' : ` — ${xml(x.label)}`}</dt><dd>${x.blocks.map(xml).join('; ')}</dd>`).join('')}</dl></section>`);
  if (credits.length > 0) out.push(`<section class="credits"><h1>Credits</h1><ul>${credits.map((c) => `<li>${xml(c)}</li>`).join('')}</ul></section>`);
  return `<!DOCTYPE html>\n<html lang="${xml(d.language)}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${xml(d.title)}</title><style>${css(d)}</style></head><body>\n${out.join('\n')}\n</body></html>\n`;
}
// Pandoc Markdown: every piece of user text is escaped; the only raw content is page breaks this module writes.
const md = (text: unknown): string => String(text).replace(/[\\`*_{}[\]()<>#+\-.!|~^$@"'=:&]/g, (c) => `\\${c}`).replace(/\n/g, '\\\n');
const PAGEBREAK = '```{=openxml}\n<w:p><w:r><w:br w:type="page"/></w:r></w:p>\n```';
function markdown(mo: Model, images: Map<string, { file: string; credit: string }>, credits: string[], target: 'docx' | 'epub'): string {
  const d = mo.doc; const l = d.layout as Doc; const out: string[] = []; const foot = l.notes === 'footnotes';
  const mark = (b: Doc): string => { const nt = mo.noteOf.get(b.id as string); return nt === undefined ? '' : foot ? `^[${md(nt.text)}]` : `^${nt.number}^`; };
  const br = (): void => { if (target === 'docx') out.push(PAGEBREAK); };
  if (target === 'docx' && l.titlePage === true) { if (str(l.copyright) !== '') out.push(md(l.copyright)); br(); }
  if (typeof d.notice === 'string') out.push(`**${md(d.notice)}**`);
  if (mo.disclosures.length > 0) { out.push('## Disclosures {.unnumbered .unlisted}', 'Parts of this work are not a direct record of events\\. Each such passage is marked where it appears:', mo.disclosures.map((x) => `- **${md(basisLabel(x.basis))}** — ${md(x.text)}`).join('\n')); }
  if (target === 'docx' && l.toc === true && chaptersOf(d).length > 1) { out.push('## Contents {.unnumbered .unlisted}', chaptersOf(d).map((c, i) => `${i + 1}\\. ${md(str(c.title) || 'Untitled')}`).join('\\\n')); }
  for (const c of chaptersOf(d)) {
    br(); out.push(`# ${md(str(c.title) || 'Untitled')}`);
    for (const b of objs(c.blocks)) {
      if (typeof b.basis === 'string' && needsDisclosure(b.basis)) out.push(`> **${md(basisLabel(b.basis))}** — *${md(b.disclosure)}*`);
      if (b.type === 'heading') out.push(`${'#'.repeat(b.level as number)} ${md(b.text)}${mark(b)}`);
      else if (b.type === 'quote') out.push(`> ${md(b.text)}${mark(b)}${typeof b.attribution === 'string' ? `\n>\n> — ${md(b.attribution)}` : ''}`);
      else if (b.type === 'list') out.push(arr(b.items).map((i, k) => `${b.ordered === true ? `${k + 1}.` : '-'} ${md(i)}`).join('\n') + mark(b));
      else if (b.type === 'verse') out.push(str(b.text).split('\n').map((line) => `| ${md(line)}`).join('\n') + mark(b));
      else if (b.type === 'pagebreak') br();
      else if (b.type === 'image') { const im = images.get(b.id as string); if (im !== undefined) out.push(`![${md(`${str(b.caption)} ${im.credit}`.trim())}](${im.file}){width=100%}${mark(b)}`); }
      else out.push(`${md(b.text)}${typeof b.attribution === 'string' ? ` \\(${md(b.attribution)}\\)` : ''}${mark(b)}`);
    }
  }
  if (!foot && mo.notes.length > 0) { br(); out.push('# Notes', mo.notes.map((nt) => `${nt.number}\\. ${md(nt.text)}`).join('\n\n')); }
  if (l.sourceCompanion === true && mo.sourceIndex.length > 0) { br(); out.push('# Source companion', 'Every source this work relies on, with the places it is used\\.', mo.sourceIndex.map((x) => `**${md(x.ref)}**${x.label === '' ? '' : ` — ${md(x.label)}`}\\\n${x.blocks.map(md).join('; ')}`).join('\n\n')); }
  if (credits.length > 0) { br(); out.push('# Credits', credits.map((c) => `- ${md(c)}`).join('\n')); }
  return `${out.join('\n\n')}\n`;
}
/** Builds a pandoc reference.docx carrying the layout: page size, margins, fonts and base size. */
async function referenceDocx(dir: string, doc: Doc, signal: AbortSignal): Promise<string> {
  const l = doc.layout as Doc; const m = l.margins as Doc; const ref = join(dir, 'reference'); await mkdir(ref, { recursive: true });
  await run('pandoc', ['-o', join(dir, 'reference-base.docx'), '--print-default-data-file', 'reference.docx'], { signal });
  await run('unzip', ['-q', '-o', join(dir, 'reference-base.docx'), '-d', ref], { signal });
  const tw = (mm: number): number => Math.round(mm * 56.6929); const [w, h] = PAGES[str(l.pageSize)] as [number, number];
  const docPath = join(ref, 'word', 'document.xml'); const sect = `<w:sectPr><w:pgSz w:w="${tw(w)}" w:h="${tw(h)}"/><w:pgMar w:top="${tw(m.top as number)}" w:right="${tw(m.right as number)}" w:bottom="${tw(m.bottom as number)}" w:left="${tw(m.left as number)}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  const dx = await readFile(docPath, 'utf8'); invariant(/<w:sectPr\s*\/>|<w:sectPr>[\s\S]*?<\/w:sectPr>/.test(dx), 'tool_failed', 'Unexpected pandoc reference document');
  await writeFile(docPath, dx.replace(/<w:sectPr\s*\/>|<w:sectPr>[\s\S]*?<\/w:sectPr>/, sect));
  const themePath = join(ref, 'word', 'theme', 'theme1.xml'); let th = await readFile(themePath, 'utf8');
  th = th.replace(/(<a:majorFont>\s*<a:latin typeface=")[^"]*"/, `$1${xml(l.headingFont)}"`).replace(/(<a:minorFont>\s*<a:latin typeface=")[^"]*"/, `$1${xml(l.bodyFont)}"`);
  await writeFile(themePath, th);
  const stylePath = join(ref, 'word', 'styles.xml'); let st = await readFile(stylePath, 'utf8'); const half = Math.round((l.fontSizePt as number) * 2);
  st = st.replace(/(<w:docDefaults>[\s\S]*?<w:sz w:val=")\d+("[\s\S]*?<w:szCs w:val=")\d+"/, `$1${half}$2${half}"`);
  await writeFile(stylePath, st);
  const out = join(dir, 'reference.docx');
  await run('zip', ['-q', '-X', '-r', out, '.'], { cwd: ref, signal });
  return out;
}

async function render(doc: Doc, env: RenderEnv): Promise<{ outputs: RenderOutput[]; parameters: Json; disclosures: Disclosure[]; credits: string[]; generated: Json[]; details: Json }> {
  const mo = model(doc); const base = safeName(str(doc.title, 'document')).replace(/\.+$/, '') || 'document'; const outputs: RenderOutput[] = [];
  await env.tool('pandoc');
  const images = new Map<string, { file: string; credit: string }>();
  for (const c of chaptersOf(doc)) for (const b of objs(c.blocks)) if (b.type === 'image') {
    const a = await env.asset(b.assetId as string, typeof b.assetVersion === 'number' ? b.assetVersion : undefined);
    invariant(a.mediaType.startsWith('image/'), 'invalid_input', `Asset ${a.name} is not an image`);
    const file = `img-${String(b.id)}.png`; await env.tool('convert');
    await run('convert', [`${a.path}[0]`, '-auto-orient', '-resize', env.profile === 'preview' ? '800x800>' : '2000x2000>', '-strip', join(env.dir, file)], { signal: env.signal });
    images.set(b.id as string, { file, credit: `(${a.rights.kind === 'permission' ? a.rights.attribution ?? 'used with permission' : a.rights.attribution})` });
  }
  const credits = [...arr(doc.credits) as string[], ...env.credits()];
  env.progress(0.1, 'html');
  // HTML: images are inlined so the page is a single portable file.
  let page = html(mo, images, credits);
  for (const im of images.values()) page = page.replaceAll(`src="${im.file}"`, `src="data:image/png;base64,${(await readFile(join(env.dir, im.file))).toString('base64')}"`);
  await writeFile(join(env.dir, `${base}.html`), page); outputs.push({ name: `${base}.html`, path: join(env.dir, `${base}.html`), mediaType: 'text/html', role: env.profile === 'preview' ? 'preview' : 'primary' });
  const qc: Json[] = [];
  if (env.profile === 'final') {
    await env.tool('soffice', 'zip', 'unzip', 'pdftoppm', 'pdftotext');
    const meta = ['--metadata', `title=${str(doc.title)}`, '--metadata', `lang=${str(doc.language)}`, ...(str(doc.subtitle) === '' ? [] : ['--metadata', `subtitle=${str(doc.subtitle)}`]), ...(arr(doc.authors) as string[]).flatMap((a) => ['--metadata', `author=${a}`])];
    const from = 'markdown-raw_html-raw_tex+raw_attribute+inline_notes+line_blocks+superscript';
    env.progress(0.2, 'docx (pandoc)');
    const reference = await referenceDocx(env.dir, doc, env.signal);
    await writeFile(join(env.dir, 'docx.md'), markdown(mo, images, credits, 'docx'));
    await run('pandoc', ['-f', from, '-t', 'docx', '--reference-doc', reference, ...meta, '-o', `${base}.docx`, 'docx.md'], { cwd: env.dir, signal: env.signal, timeoutMs: 300_000 });
    outputs.push({ name: `${base}.docx`, path: join(env.dir, `${base}.docx`), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', role: 'primary' });
    env.progress(0.45, 'epub (pandoc)');
    await writeFile(join(env.dir, 'epub.md'), markdown(mo, images, credits, 'epub')); await writeFile(join(env.dir, 'epub.css'), css(doc).replace(/@page[^}]*}/, ''));
    await run('pandoc', ['-f', from, '-t', 'epub3', '--css', 'epub.css', '--toc', '--toc-depth=1', ...meta, '-o', `${base}.epub`, 'epub.md'], { cwd: env.dir, signal: env.signal, timeoutMs: 300_000 });
    outputs.push({ name: `${base}.epub`, path: join(env.dir, `${base}.epub`), mediaType: 'application/epub+zip', role: 'primary' });
    env.progress(0.6, 'pdf (libreoffice)');
    const pdfDir = join(env.dir, 'pdf'); await mkdir(pdfDir, { recursive: true });
    await run('soffice', [`-env:UserInstallation=file://${join(env.dir, 'lo-profile')}`, '--headless', '--norestore', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', pdfDir, join(env.dir, `${base}.docx`)], { cwd: env.dir, signal: env.signal, timeoutMs: 600_000, env: { HOME: env.dir } });
    const pdf = join(pdfDir, `${base}.pdf`);
    outputs.push({ name: `${base}.pdf`, path: pdf, mediaType: 'application/pdf', role: 'primary' });
    env.progress(0.9, 'verify');
    const text = (await run('pdftotext', [pdf, '-'], { signal: env.signal, maxOutputBytes: 32 * 1024 * 1024 })).stdout.replace(/\s+/g, ' ');
    const firstWords = str(doc.title).split(/\s+/).slice(0, 3).join(' ');
    qc.push({ check: 'pdf-text', ok: text.includes(firstWords), detail: `PDF text contains the title: ${text.includes(firstWords)}` });
    for (const x of mo.disclosures) qc.push({ check: `pdf-disclosure:${x.blockId ?? ''}`, ok: text.includes(x.text.replace(/\s+/g, ' ').slice(0, 40)), detail: 'disclosure text present in PDF' });
    for (const [f, label] of [[`${base}.docx`, 'docx'], [`${base}.epub`, 'epub']] as const) { const z = await run('unzip', ['-tqq', join(env.dir, f)], { allowFail: true, signal: env.signal }); qc.push({ check: `archive:${label}`, ok: z.code === 0, detail: z.code === 0 ? 'archive intact' : z.stderr.slice(0, 200) }); }
    await run('pdftoppm', ['-f', '1', '-l', '1', '-r', '50', '-png', '-singlefile', pdf, join(env.dir, 'page-1')], { signal: env.signal });
    outputs.push({ name: 'page-1.png', path: join(env.dir, 'page-1.png'), mediaType: 'image/png', role: 'thumbnail' });
  }
  return { outputs, parameters: { layout: doc.layout as Json, formats: outputs.map((o) => o.name.split('.').pop() as string), notes: mo.notes.length, pdfPath: 'pandoc markdown → docx (generated reference document) → LibreOffice writer_pdf_Export' }, disclosures: mo.disclosures, credits,
    generated: [], details: { requiredDisclosures: mo.disclosures.map((x) => x.blockId ?? ''), notes: mo.notes.length, sources: mo.sourceIndex.length, qc } };
}

async function fromEditorial(ed: EditorialExport): Promise<Doc> {
  const chapters: Doc[] = []; let current: Doc | null = null;
  const chapter = (title: string): Doc => { const c: Doc = { id: `c${chapters.length + 1}`, title, blocks: [] }; chapters.push(c); current = c; return c; };
  const push = (b: Doc): void => { ((current ?? chapter(ed.title)).blocks as Doc[]).push(b); };
  for (const b of ed.blocks) {
    const carry: Doc = { ...(b.basis === '' ? {} : { basis: b.basis }), ...(b.disclosure === undefined ? {} : { disclosure: b.disclosure }), ...(b.sources.length === 0 ? {} : { sources: b.sources }), ...(b.attribution === undefined ? {} : { attribution: b.attribution }) };
    const id = (): string => b.id; const d = b.data;
    if (typeof d.heading === 'string' && d.heading.trim() !== '') chapter(d.heading);
    if (b.type === 'outline_node') { if (n(d.level, 1) <= 1) chapter(b.text.split('\n')[0] as string); else push({ id: id(), type: 'heading', level: Math.min(4, Math.round(n(d.level, 2))), text: b.text, ...carry }); }
    else if (b.type === 'lyric_section') { push({ id: `${b.id}-h`, type: 'heading', level: 3, text: str(d.label) || str(d.part, 'verse') }); push({ id: id(), type: 'verse', text: b.text, ...carry }); }
    else if (b.type === 'script_element') {
      if (d.element === 'scene_heading') push({ id: id(), type: 'heading', level: 2, text: b.text, ...carry });
      else push({ id: id(), type: d.element === 'dialogue' ? 'quote' : 'paragraph', text: b.text, ...carry, ...(d.element === 'dialogue' ? { attribution: str(d.character) } : {}) });
    } else if (b.type === 'scene') {
      push({ id: `${b.id}-h`, type: 'heading', level: 2, text: [str(d.location), str(d.time)].filter((x) => x !== '').join(' — ') || 'Scene' });
      push({ id: id(), type: 'paragraph', text: b.text || str(d.purpose), ...carry });
      const panels = objs(d.panels); if (panels.length > 0) push({ id: `${b.id}-panels`, type: 'list', ordered: true, items: panels.map((p) => str(p.description)) });
    } else if (b.type === 'story_node') {
      push({ id: `${b.id}-h`, type: 'heading', level: 2, text: str(d.key, b.id) });
      push({ id: id(), type: 'paragraph', text: b.text, ...carry });
      const choices = objs(d.choices); if (choices.length > 0) push({ id: `${b.id}-choices`, type: 'list', items: choices.map((c) => `${str(c.label)} → ${str(c.to)}`) });
    } else push({ id: id(), type: b.basis === 'attributed_testimony' ? 'quote' : 'paragraph', text: b.text, ...carry });
  }
  return validate({ kind: 'written', title: ed.title, language: ed.language, ...(ed.notice === null ? {} : { notice: ed.notice }), credits: ed.credits, chapters });
}

export const writtenPipeline: Pipeline = {
  kind: 'written', tools: ['pandoc'],
  validate,
  empty: (title) => validate({ title, chapters: [{ id: 'c1', title: 'Chapter 1', blocks: [] }] }),
  assetRefs: (doc) => collectAssets(doc),
  sources: (doc) => [...collectSources(doc), ...Object.keys(isObj(doc.sourceNotes) ? doc.sourceNotes : {})].filter((v, i, a) => a.indexOf(v) === i),
  text: (doc) => collectText(doc).join('\n'),
  async applyOp(doc, op, helpers) {
    const out = structuredClone(doc);
    switch (op.op) {
      case 'addChapter': { const chapters = out.chapters as Doc[]; chapters.splice(typeof op.index === 'number' ? op.index : chapters.length, 0, { id: typeof op.id === 'string' ? op.id : helpers.newId('c'), title: str(op.title, 'Untitled'), blocks: [] }); return out; }
      case 'insertBlock': {
        invariant(isObj(op.block), 'invalid_input', 'insertBlock needs a block'); const block = { ...op.block, id: typeof op.block.id === 'string' ? op.block.id : helpers.newId('b') };
        if (typeof op.after === 'string') { const at = locate(out, op.after); (at.chapter.blocks as Doc[]).splice(at.index + 1, 0, block); }
        else { const c = chaptersOf(out).find((x) => x.id === op.chapterId); invariant(c !== undefined, 'invalid_input', 'insertBlock needs chapterId or after'); (c.blocks as Doc[]).splice(typeof op.index === 'number' ? op.index : (c.blocks as Doc[]).length, 0, block); }
        return out;
      }
      case 'updateBlock': { const at = locate(out, op.blockId); invariant(isObj(op.set), 'invalid_input', 'updateBlock needs "set"'); (at.chapter.blocks as Doc[])[at.index] = { ...(at.chapter.blocks as Doc[])[at.index], ...op.set, id: op.blockId as string }; return out; }
      case 'removeBlock': { const at = locate(out, op.blockId); (at.chapter.blocks as Doc[]).splice(at.index, 1); return out; }
      case 'moveBlock': { const at = locate(out, op.blockId); const [b] = (at.chapter.blocks as Doc[]).splice(at.index, 1); const c = chaptersOf(out).find((x) => x.id === (op.chapterId ?? at.chapter.id)); invariant(c !== undefined, 'invalid_input', 'Unknown chapter'); (c.blocks as Doc[]).splice(Math.min(Math.max(n(op.index, 0), 0), (c.blocks as Doc[]).length), 0, b as Doc); return out; }
      case 'setLayout': { invariant(isObj(op.layout), 'invalid_input', 'setLayout needs layout'); out.layout = { ...(out.layout as Doc), ...op.layout, margins: { ...((out.layout as Doc).margins as Doc), ...(isObj(op.layout.margins) ? op.layout.margins : {}) } }; return out; }
      default: return null;
    }
  },
  render,
  fromEditorial,
  estimateSeconds: (doc, profile) => (profile === 'preview' ? 2 : 20 + chaptersOf(doc).length),
  check(doc) {
    const problems: { level: 'error' | 'warning'; message: string; at?: string }[] = [];
    if (!chaptersOf(doc).some((c) => objs(c.blocks).some((b) => str(b.text).trim() !== '' || b.type === 'image' || arr(b.items).length > 0))) problems.push({ level: 'error', message: 'The work has no content yet' });
    return problems;
  },
};
