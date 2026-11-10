// Shared production types: project documents, pipeline contract, generic document editing and diffing.
import { DomainError, canonical, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';

export type ProjectKind = 'written' | 'image' | 'audio' | 'video' | 'interactive';
export const PROJECT_KINDS: readonly ProjectKind[] = ['written', 'image', 'audio', 'video', 'interactive'];
export type Doc = { [key: string]: Json };
export type RenderProfile = 'preview' | 'final';

/** Rights reference carried by every asset version. */
export type Rights =
  | { kind: 'permission'; ref: string; attribution?: string; restrictions?: string[] }
  | { kind: 'license'; license: string; attribution: string; url?: string }
  | { kind: 'generated'; license: string; attribution: string };
export type Provenance = { sourceRefs: string[]; tool?: string; toolVersion?: string; params?: Json; parentAssets?: string[]; provider?: string; note?: string; synthetic?: boolean };

export type AssetInput = Readonly<{
  ref: string; assetId: string; version: number; name: string; filename: string; mediaType: string; sha256: string; size: number;
  mediaInfo: Json; rights: Rights; provenance: Provenance; sources: readonly string[]; approval: string; path: string;
}>;
export type Disclosure = { basis: string; text: string; where: string; blockId?: string };
export type RenderOutput = { name: string; path: string; mediaType: string; role: string };
export type PipelineResult = {
  outputs: RenderOutput[]; parameters: Json; disclosures: Disclosure[]; credits: string[];
  /** Intermediates generated during the render (speech synthesis, stems …) with the tool and parameters used. */
  generated: Json[]; details?: Json;
};
export interface RenderEnv {
  readonly dir: string; readonly profile: RenderProfile; readonly signal: AbortSignal; readonly options: Doc; readonly title: string;
  /** Materialises an exact asset version to disk and records it as a manifest input. */
  asset(assetId: string, version?: number): Promise<AssetInput>;
  progress(fraction: number, stage: string): void;
  /** Records a tool (with its probed version) in the manifest; throws `unavailable` when missing. */
  tool(...names: string[]): Promise<void>;
  cacheGet(hash: string): Promise<Uint8Array | null>;
  cachePut(hash: string, bytes: Uint8Array): Promise<void>;
  /** Credits and source lines collected by the service for inputs seen so far (asset attributions, source refs). */
  credits(): string[];
}
export interface OpHelpers {
  /** Looks up an asset in the caller's scope (throws not_found). */
  assetInfo(assetId: string): Promise<{ assetId: string; version: number; mediaType: string; mediaInfo: Json; name: string }>;
  newId(prefix: string): string;
}
export interface Pipeline {
  readonly kind: ProjectKind;
  /** Normalises and validates a document; throws invalid_input. */
  validate(doc: unknown): Doc;
  empty(title: string): Doc;
  assetRefs(doc: Doc): { assetId: string; version?: number }[];
  sources(doc: Doc): string[];
  text(doc: Doc): string;
  /** Kind-specific semantic operation. Return null when the op is not recognised. */
  applyOp(doc: Doc, op: Doc, helpers: OpHelpers): Promise<Doc | null>;
  render(doc: Doc, env: RenderEnv): Promise<PipelineResult>;
  fromEditorial(input: EditorialExport, options: Doc): Promise<Doc>;
  estimateSeconds(doc: Doc, profile: RenderProfile): number;
  /** Structural problems a user should fix (unreachable nodes, missing narration …). Errors stop a final render. */
  check?(doc: Doc): { level: 'error' | 'warning'; message: string; at?: string }[];
  tools: readonly string[];
}

/**
 * Editorial (E09) export consumed by `createProjectFromEditorial`: the value E09 `exportDocument` returns
 * (`{ manifest, document, renderings }`). Only the fields below are read; `basis` labels and `disclosure` text are
 * carried into every rendered form.
 */
export type EditorialBlock = { id: string; type: string; text: string; basis: string; sources: string[]; attribution?: string; disclosure?: string; data: Doc };
export type EditorialExport = { ref: string; title: string; docType: string; language: string; notice: string | null; credits: string[]; blocks: EditorialBlock[]; sources: string[] };
/** Validates the E09 export envelope and reduces it to what the pipelines use. */
export function normalizeEditorial(raw: unknown): EditorialExport {
  invariant(isObj(raw) && isObj(raw.document), 'invalid_input', 'editorial must be an E09 export ({ manifest, document })');
  const d = raw.document; const meta = isObj(d.document) ? d.document : {}; const manifest = isObj(raw.manifest) ? raw.manifest : {};
  const ref = isUref(manifest.document) ? manifest.document : isUref(meta.ref) && typeof meta.revision === 'number' ? `${meta.ref.split('@')[0]}@${meta.revision}` : meta.ref;
  invariant(isUref(ref) && ref.startsWith('E09:') && ref.includes('@'), 'invalid_input', 'editorial export must name its document revision (E09:document:<id>@<rev>)');
  const disclosures = new Map(objs(d.disclosures).map((x) => [str(x.blockId), str(x.disclosure)]));
  const blocks = objs(d.blocks).map((b, i): EditorialBlock => {
    const id = isId(b.id) ? b.id : `b${i + 1}`; const basis = str(b.basis, 'unknown_acknowledged', 40);
    const disclosure = str(b.disclosure, disclosures.get(id) ?? '', 1000);
    invariant(!needsDisclosure(basis) || disclosure !== '', 'invalid_input', `editorial block ${id} is labelled ${basis} but carries no disclosure`);
    return { id, type: str(b.type, 'passage', 40), text: str(b.text), basis, sources: arr(b.sources).filter(isUref), ...(typeof b.attribution === 'string' ? { attribution: b.attribution.slice(0, 500) } : {}), ...(disclosure === '' ? {} : { disclosure }), data: isObj(b.data) ? b.data : {} };
  });
  invariant(blocks.length > 0, 'invalid_input', 'editorial export has no blocks');
  const labels = isObj(d.labels) ? d.labels : {};
  return { ref, title: str(meta.title, 'Untitled', 300), docType: str(meta.docType, 'article', 40), language: str(meta.language, 'en', 20), notice: typeof labels.notice === 'string' ? labels.notice : null,
    credits: objs(d.credits).map((c) => str(c.creditLine) || `${str(c.name)} (${str(c.role)})`).filter((c) => c.trim() !== ''), blocks, sources: [...new Set([...arr(d.sources).filter(isUref), ...blocks.flatMap((b) => b.sources)])] as string[] };
}

/** Basis labels that must be disclosed to the audience wherever the content appears. */
export const DISCLOSED_BASES: readonly string[] = ['reconstruction', 'invention', 'satire', 'dramatization', 'composite', 'illustration', 'speculation', 'synthetic'];
export const needsDisclosure = (basis: unknown): boolean => typeof basis === 'string' && DISCLOSED_BASES.includes(basis.toLowerCase());
export function disclosureText(basis: string, text: unknown): string {
  if (typeof text === 'string' && text.trim() !== '') return text.trim().slice(0, 600);
  const b = basis.toLowerCase();
  return b === 'reconstruction' ? 'This passage is a reconstruction based on the cited sources; details not in the record are approximations.'
    : b === 'satire' ? 'This passage is satire and is not a factual account.'
    : b === 'invention' ? 'This passage is invented for illustration and does not depict recorded events.'
    : `This passage is labelled "${b}" and is not a direct record of events.`;
}
export const basisLabel = (basis: string): string => basis.trim().toUpperCase().slice(0, 40);

// ───────────────────────────── validation helpers ─────────────────────────────
export const isObj = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v);
export const str = (v: unknown, fallback = '', max = 20000): string => (typeof v === 'string' ? v.slice(0, max) : fallback);
export const arr = (v: unknown): Json[] => (Array.isArray(v) ? v as Json[] : []);
export const objs = (v: unknown): Doc[] => arr(v).filter(isObj);
export const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback);
export const n = (v: unknown, fallback: number, lo = -1e9, hi = 1e9): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
export function idOf(v: unknown, label: string): string { invariant(isId(v), 'invalid_input', `${label} needs an id of letters, digits, ".", "_" or "-"`); return v; }
const UREF = /^E\d\d:[a-z][a-z0-9_]*:[A-Za-z0-9._~-]+(?:@\d+)?$/;
export const isUref = (v: unknown): v is string => typeof v === 'string' && UREF.test(v);
export function urefs(v: unknown, label = 'sources'): string[] {
  const out = arr(v); invariant(out.every(isUref), 'invalid_input', `${label} must be universal references`);
  return [...new Set(out as string[])];
}
export function uniqueIds(items: readonly Doc[], label: string): void {
  const seen = new Set<string>();
  for (const it of items) { const id = idOf(it.id, label); invariant(!seen.has(id), 'invalid_input', `Duplicate ${label} id ${id}`); seen.add(id); }
}
/** Walks a document and collects every `sources` array of urefs. */
export function collectSources(doc: Json, out = new Set<string>()): Set<string> {
  if (Array.isArray(doc)) for (const v of doc) collectSources(v, out);
  else if (isObj(doc)) for (const [k, v] of Object.entries(doc)) { if (k === 'sources' && Array.isArray(v)) { for (const s of v) if (isUref(s)) out.add(s); } else collectSources(v, out); }
  return out;
}
/** Walks a document and collects every `assetId` (with optional sibling `assetVersion`). */
export function collectAssets(doc: Json, out = new Map<string, { assetId: string; version?: number }>()): { assetId: string; version?: number }[] {
  if (Array.isArray(doc)) for (const v of doc) collectAssets(v, out);
  else if (isObj(doc)) {
    if (typeof doc.assetId === 'string' && doc.assetId !== '') { const version = typeof doc.assetVersion === 'number' ? doc.assetVersion : undefined; out.set(`${doc.assetId}@${version ?? ''}`, { assetId: doc.assetId, ...(version === undefined ? {} : { version }) }); }
    for (const v of Object.values(doc)) collectAssets(v, out);
  }
  return [...out.values()];
}
export function collectText(doc: Json, out: string[] = []): string[] {
  if (Array.isArray(doc)) for (const v of doc) collectText(v, out);
  else if (isObj(doc)) for (const [k, v] of Object.entries(doc)) { if (typeof v === 'string') { if (['text', 'title', 'subtitle', 'label', 'caption', 'quote', 'attribution', 'disclosure', 'name'].includes(k)) out.push(v); } else collectText(v, out); }
  return out;
}

// ───────────────────────────── generic JSON-pointer editing ─────────────────────────────
function pointer(path: unknown): string[] {
  invariant(typeof path === 'string' && (path === '' || path.startsWith('/')) && path.length <= 500, 'invalid_input', 'path must be a JSON pointer such as /layers/0/text');
  const parts = path === '' ? [] : path.slice(1).split('/').map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'));
  invariant(parts.every((p) => p !== '__proto__' && p !== 'constructor' && p !== 'prototype'), 'invalid_input', 'Invalid path');
  return parts;
}
/** Array segments may be an index, `-` (append) or `id=<id>` (the element whose id matches). */
function step(node: Json, seg: string): { container: Json; key: string | number } {
  if (Array.isArray(node)) {
    if (seg === '-') return { container: node, key: node.length };
    if (seg.startsWith('id=')) { const i = node.findIndex((e) => isObj(e) && e.id === seg.slice(3)); invariant(i >= 0, 'invalid_input', `No element with id ${seg.slice(3)}`); return { container: node, key: i }; }
    const i = Number(seg); invariant(Number.isInteger(i) && i >= 0 && i <= node.length, 'invalid_input', `Invalid array index ${seg}`);
    return { container: node, key: i };
  }
  invariant(isObj(node), 'invalid_input', `Path does not exist at ${seg}`);
  return { container: node, key: seg };
}
/** Applies `set` / `remove` / `insert` / `move` at a JSON pointer on a deep copy. Returns null for other ops. */
export function applyGenericOp(doc: Doc, op: Doc): Doc | null {
  if (!['set', 'remove', 'insert', 'move'].includes(str(op.op))) return null;
  const out = structuredClone(doc);
  const parts = pointer(op.path); invariant(parts.length > 0, 'invalid_input', 'path may not be the document root');
  let node: Json = out;
  for (const seg of parts.slice(0, -1)) { const s = step(node, seg); const next = (s.container as Record<string | number, Json>)[s.key]; invariant(next !== undefined, 'invalid_input', `Path does not exist at ${seg}`); node = next; }
  const last = step(node, parts[parts.length - 1] as string);
  const c = last.container;
  if (op.op === 'set') { invariant(op.value !== undefined, 'invalid_input', 'set needs a value'); if (Array.isArray(c)) c[last.key as number] = op.value as Json; else (c as Doc)[last.key as string] = op.value as Json; }
  else if (op.op === 'insert') { invariant(Array.isArray(c) && op.value !== undefined, 'invalid_input', 'insert needs an array position and a value'); c.splice(last.key as number, 0, op.value as Json); }
  else if (op.op === 'remove') { if (Array.isArray(c)) { invariant((last.key as number) < c.length, 'invalid_input', 'Nothing to remove'); c.splice(last.key as number, 1); } else { invariant(Object.hasOwn(c as Doc, last.key as string), 'invalid_input', 'Nothing to remove'); delete (c as Doc)[last.key as string]; } }
  else { invariant(Array.isArray(c) && (last.key as number) < c.length && Number.isInteger(op.to), 'invalid_input', 'move needs an existing array element and an integer "to" index'); const [item] = c.splice(last.key as number, 1); c.splice(Math.min(Math.max(op.to as number, 0), c.length), 0, item as Json); }
  return out;
}

// ───────────────────────────── diff summary ─────────────────────────────
export type DiffEntry = { path: string; change: 'added' | 'removed' | 'changed'; before?: string; after?: string };
const brief = (v: Json | undefined): string => { const s = typeof v === 'string' ? v : JSON.stringify(v) ?? ''; return s.length > 120 ? `${s.slice(0, 117)}…` : s; };
/** Structural diff. Arrays of objects with `id` are matched by id (reorders are reported once); other arrays by index. */
export function diffDocs(a: Json, b: Json, path = '', out: DiffEntry[] = [], limit = 300): DiffEntry[] {
  if (out.length >= limit || canonical(a) === canonical(b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    const keyed = [...a, ...b].every((e) => isObj(e) && typeof e.id === 'string');
    if (keyed) {
      const am = new Map(a.map((e) => [(e as Doc).id as string, e])), bm = new Map(b.map((e) => [(e as Doc).id as string, e]));
      for (const [id, e] of am) { if (!bm.has(id)) out.push({ path: `${path}/id=${id}`, change: 'removed', before: brief(e) }); else diffDocs(e, bm.get(id) as Json, `${path}/id=${id}`, out, limit); }
      for (const [id, e] of bm) if (!am.has(id)) out.push({ path: `${path}/id=${id}`, change: 'added', after: brief(e) });
      const common = (x: Json[], other: Map<string, Json>): string => x.map((e) => (e as Doc).id as string).filter((id) => other.has(id)).join(',');
      if (common(a, bm) !== common(b, am)) out.push({ path: path === '' ? '/' : path, change: 'changed', before: 'order', after: 'reordered' });
      return out;
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) out.push({ path: `${path}/${i}`, change: 'added', after: brief(b[i]) });
      else if (i >= b.length) out.push({ path: `${path}/${i}`, change: 'removed', before: brief(a[i]) });
      else diffDocs(a[i] as Json, b[i] as Json, `${path}/${i}`, out, limit);
    }
    return out;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = `${path}/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (!Object.hasOwn(a, k)) out.push({ path: p, change: 'added', after: brief(b[k]) });
      else if (!Object.hasOwn(b, k)) out.push({ path: p, change: 'removed', before: brief(a[k]) });
      else diffDocs(a[k] as Json, b[k] as Json, p, out, limit);
    }
    return out;
  }
  out.push({ path: path === '' ? '/' : path, change: 'changed', before: brief(a), after: brief(b) });
  return out;
}
export function diffSummary(entries: readonly DiffEntry[]): { added: number; removed: number; changed: number; paths: string[] } {
  return { added: entries.filter((e) => e.change === 'added').length, removed: entries.filter((e) => e.change === 'removed').length, changed: entries.filter((e) => e.change === 'changed').length, paths: entries.slice(0, 40).map((e) => e.path) };
}
export const fail = (message: string): never => { throw new DomainError('invalid_input', message); };
