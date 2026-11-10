// E10 — Media Production engine: service layer.
// Editable project documents (revisioned JSON), asset library, render jobs, immutable renders with manifests, exports,
// consent gate, budget reservation and stale/blocked propagation shared by the five production pipelines.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError, canonical, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import * as kit from '../service-kit.ts';
import type { AuditRecord, AuthorizationPort, BudgetPort, EngineEvent, EngineManifestV1, Inspection, Job, Migration, ObjectStore, Route, SearchHit, ServiceContext, Sql, StandardEngine, UpstreamChange, UseAction, UseDecisionPort } from '../service-kit.ts';
import { assertSafeSvg, mediaClass, probeFile, requireTools, run, safeName, sha256, sniffMediaType, toolVersion, withWorkdir } from './tools.ts';
import { PROJECT_KINDS, applyGenericOp, arr, collectAssets, diffDocs, diffSummary, isObj, isUref, normalizeEditorial, objs, str, urefs } from './types.ts';
import type { AssetInput, DiffEntry, Disclosure, Doc, OpHelpers, Pipeline, PipelineResult, ProjectKind, Provenance, RenderEnv, RenderProfile, Rights } from './types.ts';
import { PIPELINES } from './pipelines.ts';
import { providerStatus, runProvider } from './providers.ts';
import type { ProviderConfig } from './providers.ts';

export const SCHEMA = 'e10_production';
export const ENGINE_VERSION = '0.1.0';
export const manifest: EngineManifestV1 = {
  id: 'E10', name: 'Media production engine', version: ENGINE_VERSION, kit: kit.SERVICE_KIT_VERSION,
  capabilities: ['production:read', 'production:write', 'production:render', 'production:approve', 'production:export', 'production:spend', 'production:events', 'production:audit'],
  emits: ['production.project_created', 'production.revision_saved', 'production.asset_created', 'production.asset_version_added', 'production.asset_approval_changed', 'production.render_requested', 'production.render_completed', 'production.render_failed', 'production.render_cancelled', 'production.render_blocked', 'production.render_stale', 'production.project_stale', 'production.project_blocked', 'production.asset_stale', 'production.asset_blocked', 'production.export_created', 'production.export_stale', 'production.export_blocked', 'production.qc_failed'],
  consumes: ['content_changed', 'claim_changed', 'source_corrected', 'source_superseded', 'source_removed', 'permission_withdrawn', 'permission_changed', 'rights_changed', 'render_changed', 'audience_changed'],
};

export const migrations: readonly Migration[] = [{ id: '001_production', sql: `
create table {s}.projects (
  id uuid primary key, tenant_id text not null, project_id text not null, kind text not null, title text not null, compartment text,
  editorial_ref text, sources text[] not null default '{}', head_revision int not null default 0,
  stale boolean not null default false, blocked boolean not null default false, reasons jsonb not null default '[]',
  search_text text not null default '', created_by text not null, created_at timestamptz not null, updated_at timestamptz not null
);
create index projects_scope on {s}.projects (tenant_id, project_id, created_at);
create table {s}.project_revisions (
  production_id uuid not null references {s}.projects(id), revision int not null, tenant_id text not null, project_id text not null,
  doc jsonb not null, digest text not null, summary text not null default '', diff jsonb not null default '[]', restored_from int,
  asset_ids text[] not null default '{}', sources text[] not null default '{}', actor_id text not null, at timestamptz not null,
  primary key (production_id, revision)
);
create table {s}.assets (
  id uuid primary key, tenant_id text not null, project_id text not null, name text not null, class text not null, compartment text,
  head_version int not null default 0, approval text not null default 'pending', approval_by text, approval_note text,
  stale boolean not null default false, blocked boolean not null default false, reasons jsonb not null default '[]',
  created_by text not null, created_at timestamptz not null
);
create index assets_scope on {s}.assets (tenant_id, project_id, created_at);
create table {s}.asset_versions (
  asset_id uuid not null references {s}.assets(id), version int not null, tenant_id text not null, project_id text not null,
  object_key text not null, sha256 text not null, size bigint not null, media_type text not null, filename text not null,
  media_info jsonb not null, provenance jsonb not null, rights jsonb not null, sources text[] not null default '{}',
  actor_id text not null, at timestamptz not null, primary key (asset_id, version)
);
create table {s}.renders (
  id uuid primary key, tenant_id text not null, project_id text not null, production_id uuid not null references {s}.projects(id),
  revision int not null, seq int not null, profile text not null,
  state text not null check (state in ('queued','running','done','failed','cancelled','blocked')),
  job_id uuid, progress real not null default 0, stage text not null default '', options jsonb not null default '{}',
  inputs jsonb not null default '[]', sources text[] not null default '{}', decisions jsonb not null default '[]',
  outputs jsonb not null default '[]', manifest jsonb, manifest_digest text, qc jsonb, error text,
  stale boolean not null default false, blocked boolean not null default false, reasons jsonb not null default '[]',
  reservation text, requested_by text not null, created_at timestamptz not null, started_at timestamptz, completed_at timestamptz
);
create index renders_scope on {s}.renders (tenant_id, project_id, production_id, seq);
create table {s}.exports (
  id uuid primary key, tenant_id text not null, project_id text not null, render_id uuid not null references {s}.renders(id),
  format text not null, object_key text not null, sha256 text not null, size bigint not null, filename text not null, media_type text not null,
  manifest jsonb not null, decisions jsonb not null default '[]',
  stale boolean not null default false, blocked boolean not null default false, reasons jsonb not null default '[]',
  created_by text not null, created_at timestamptz not null
);
create index exports_scope on {s}.exports (tenant_id, project_id, render_id);
create table {s}.upstream_changes (
  tenant_id text not null, project_id text not null, event_id text not null, kind text not null, refs text[] not null,
  affected jsonb not null, at timestamptz not null, primary key (tenant_id, project_id, event_id)
);
create table {s}.render_cache (
  tenant_id text not null, project_id text not null, hash text not null, object_key text not null, size bigint not null, at timestamptz not null,
  primary key (tenant_id, project_id, hash)
);
` }];
export function migrate(sql: Sql): Promise<string[]> { return kit.runMigrations(sql, SCHEMA, migrations); }

// ───────────────────────────── public types ─────────────────────────────
export type Reason = { kind: string; reason: string; cause: string; refs: string[]; at: string };
export type Project = { ref: string; id: string; kind: ProjectKind; title: string; compartment: string | null; editorialRef: string | null; sources: string[]; headRevision: number; stale: boolean; blocked: boolean; reasons: Reason[]; createdBy: string; createdAt: string; updatedAt: string };
export type RevisionInfo = { ref: string; productionId: string; revision: number; digest: string; summary: string; diff: DiffEntry[]; restoredFrom: number | null; assetIds: string[]; sources: string[]; actorId: string; at: string };
export type Revision = RevisionInfo & { doc: Doc };
export type AssetVersion = { ref: string; version: number; sha256: string; size: number; mediaType: string; filename: string; mediaInfo: Json; provenance: Provenance; rights: Rights; sources: string[]; actorId: string; at: string };
export type Asset = { ref: string; id: string; name: string; class: string; compartment: string | null; headVersion: number; approval: 'pending' | 'approved' | 'rejected'; approvalBy: string | null; approvalNote: string | null; stale: boolean; blocked: boolean; reasons: Reason[]; createdBy: string; createdAt: string; versions: AssetVersion[] };
export type OutputInfo = { name: string; mediaType: string; size: number; sha256: string; role: string; info: Json };
export type DecisionRecord = { action: string; subjects: string[]; decision: 'allow' | 'deny' | 'review'; reasons: string[]; permissionRefs: string[]; restrictions: string[]; decidedAt: string; by: string };
export type RenderState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked';
export type Render = { ref: string; id: string; productionId: string; revision: number; seq: number; profile: RenderProfile; state: RenderState; jobId: string | null; progress: number; stage: string; options: Doc; inputs: Json[]; sources: string[]; decisions: DecisionRecord[]; outputs: OutputInfo[]; manifestDigest: string | null; qc: Json | null; error: string | null; stale: boolean; blocked: boolean; reasons: Reason[]; requestedBy: string; createdAt: string; startedAt: string | null; completedAt: string | null };
export type Export = { ref: string; id: string; renderId: string; format: string; filename: string; mediaType: string; size: number; sha256: string; manifest: Json; decisions: DecisionRecord[]; stale: boolean; blocked: boolean; reasons: Reason[]; createdBy: string; createdAt: string };
export type Problem = { level: 'error' | 'warning'; message: string; at?: string };
export type FileResult = { bytes: Uint8Array; mediaType: string; filename: string; sha256: string };

export type EngineConfig = Readonly<{
  /** Directory for temporary render workspaces (default: OS temp dir). */
  workRoot?: string;
  /** Explicit standalone mode when no UseDecisionPort is supplied: declared asset rights are accepted and recorded as unverified. */
  standalone?: { useDecisions?: 'declared-rights' };
  /** Exports require every input asset to be approved (default true). */
  requireApprovedAssetsForExport?: boolean;
  maxAssetBytes?: number;
  providers?: ProviderConfig;
}>;
export type EngineDeps = Readonly<{ sql: Sql; objects?: ObjectStore; ports?: { useDecisions?: UseDecisionPort; budget?: BudgetPort; authorization?: AuthorizationPort }; config?: EngineConfig }>;

export interface ProductionEngine extends StandardEngine {
  createProject(ctx: ServiceContext, input: { kind: ProjectKind; title: string; doc?: Doc; editorialRef?: string; sources?: string[]; compartment?: string; idempotencyKey?: string }): Promise<Project>;
  createProjectFromEditorial(ctx: ServiceContext, input: { kind: ProjectKind; editorial: unknown; title?: string; options?: Doc; compartment?: string; idempotencyKey?: string }): Promise<Project>;
  getProject(ctx: ServiceContext, productionId: string): Promise<Project>;
  listProjects(ctx: ServiceContext, options?: { kind?: ProjectKind; limit?: number }): Promise<Project[]>;
  updateProjectLinks(ctx: ServiceContext, input: { productionId: string; editorialRef?: string; sources?: string[]; resolveStale?: boolean }): Promise<Project>;
  saveRevision(ctx: ServiceContext, input: { productionId: string; doc: Doc; baseRevision?: number; summary?: string; idempotencyKey?: string }): Promise<RevisionInfo>;
  applyOperations(ctx: ServiceContext, input: { productionId: string; operations: Doc[]; baseRevision?: number; summary?: string; idempotencyKey?: string }): Promise<RevisionInfo>;
  getRevision(ctx: ServiceContext, productionId: string, revision?: number): Promise<Revision>;
  listRevisions(ctx: ServiceContext, productionId: string): Promise<RevisionInfo[]>;
  diffRevisions(ctx: ServiceContext, productionId: string, from: number, to: number): Promise<{ from: number; to: number; entries: DiffEntry[]; summary: ReturnType<typeof diffSummary> }>;
  restoreRevision(ctx: ServiceContext, input: { productionId: string; revision: number; idempotencyKey?: string }): Promise<RevisionInfo>;
  validateProject(ctx: ServiceContext, productionId: string, revision?: number): Promise<{ ok: boolean; problems: Problem[] }>;
  importAsset(ctx: ServiceContext, input: AssetImport): Promise<Asset>;
  addAssetVersion(ctx: ServiceContext, input: AssetImport & { assetId: string }): Promise<Asset>;
  setAssetRights(ctx: ServiceContext, input: { assetId: string; rights: Rights; note?: string }): Promise<Asset>;
  setAssetApproval(ctx: ServiceContext, input: { assetId: string; approval: 'approved' | 'rejected' | 'pending'; note?: string }): Promise<Asset>;
  importRenderOutput(ctx: ServiceContext, input: { renderId: string; output: string; name?: string; idempotencyKey?: string }): Promise<Asset>;
  generateAsset(ctx: ServiceContext, input: { provider: 'image' | 'tts' | 'music' | 'singing'; name: string; params: Doc; sources?: string[]; idempotencyKey?: string }): Promise<Asset>;
  getAsset(ctx: ServiceContext, assetId: string): Promise<Asset>;
  listAssets(ctx: ServiceContext, options?: { class?: string; limit?: number }): Promise<Asset[]>;
  getAssetBytes(ctx: ServiceContext, assetId: string, version?: number): Promise<FileResult>;
  requestRender(ctx: ServiceContext, input: { productionId: string; revision?: number; profile?: RenderProfile; options?: Doc; idempotencyKey?: string }): Promise<Render>;
  getRender(ctx: ServiceContext, renderId: string): Promise<Render>;
  listRenders(ctx: ServiceContext, options?: { productionId?: string; limit?: number }): Promise<Render[]>;
  cancelRender(ctx: ServiceContext, renderId: string): Promise<Render>;
  getRenderManifest(ctx: ServiceContext, renderId: string): Promise<Json>;
  getRenderOutput(ctx: ServiceContext, renderId: string, name: string): Promise<FileResult>;
  runQc(ctx: ServiceContext, renderId: string): Promise<{ ok: boolean; checks: Json[] }>;
  createExport(ctx: ServiceContext, input: { renderId: string; format?: string; audience?: string; destination?: string; idempotencyKey?: string }): Promise<Export>;
  getExport(ctx: ServiceContext, exportId: string): Promise<Export>;
  listExports(ctx: ServiceContext, options?: { renderId?: string }): Promise<Export[]>;
  getExportBytes(ctx: ServiceContext, exportId: string): Promise<FileResult>;
  /** Working preview of an interactive project revision as one self-contained HTML page. */
  previewInteractive(ctx: ServiceContext, productionId: string, revision?: number): Promise<string>;
  providers(ctx: ServiceContext): Promise<Json>;
  /** Runs one pass of the render worker. Returns the number of jobs processed. */
  runJobs(options?: { worker?: string; limit?: number }): Promise<number>;
}
export type AssetImport = { name: string; filename: string; bytes: Uint8Array; rights: Rights; provenance?: Partial<Provenance>; sources?: string[]; compartment?: string; idempotencyKey?: string };

// ───────────────────────────── helpers ─────────────────────────────
const iso = (v: unknown): string => new Date(v as Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (v: unknown): string => { if (typeof v !== 'string' || !UUID.test(v)) throw new DomainError('not_found', 'Not found'); return v; };
const projectRef = (id: string, revision?: number): string => kit.uref('E10', 'project', id, revision);
const assetRef = (id: string, version?: number): string => kit.uref('E10', 'asset', id, version);
const renderRef = (id: string): string => kit.uref('E10', 'render', id);
const exportRef = (id: string): string => kit.uref('E10', 'export', id);
const J = (v: unknown): string => JSON.stringify(v);
const likeEscape = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);

function toProject(r: kit.Row): Project { return { ref: projectRef(r.id as string), id: r.id as string, kind: r.kind as ProjectKind, title: r.title as string, compartment: (r.compartment as string | null) ?? null, editorialRef: (r.editorial_ref as string | null) ?? null, sources: r.sources as string[], headRevision: r.head_revision as number, stale: r.stale as boolean, blocked: r.blocked as boolean, reasons: r.reasons as Reason[], createdBy: r.created_by as string, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }; }
function toRevInfo(r: kit.Row): RevisionInfo { return { ref: projectRef(r.production_id as string, r.revision as number), productionId: r.production_id as string, revision: r.revision as number, digest: r.digest as string, summary: r.summary as string, diff: r.diff as DiffEntry[], restoredFrom: (r.restored_from as number | null) ?? null, assetIds: r.asset_ids as string[], sources: r.sources as string[], actorId: r.actor_id as string, at: iso(r.at) }; }
function toVersion(r: kit.Row): AssetVersion { return { ref: assetRef(r.asset_id as string, r.version as number), version: r.version as number, sha256: r.sha256 as string, size: Number(r.size), mediaType: r.media_type as string, filename: r.filename as string, mediaInfo: r.media_info as Json, provenance: r.provenance as Provenance, rights: r.rights as Rights, sources: r.sources as string[], actorId: r.actor_id as string, at: iso(r.at) }; }
function toAsset(r: kit.Row, versions: AssetVersion[]): Asset { return { ref: assetRef(r.id as string), id: r.id as string, name: r.name as string, class: r.class as string, compartment: (r.compartment as string | null) ?? null, headVersion: r.head_version as number, approval: r.approval as Asset['approval'], approvalBy: (r.approval_by as string | null) ?? null, approvalNote: (r.approval_note as string | null) ?? null, stale: r.stale as boolean, blocked: r.blocked as boolean, reasons: r.reasons as Reason[], createdBy: r.created_by as string, createdAt: iso(r.created_at), versions }; }
function toRender(r: kit.Row): Render { return { ref: renderRef(r.id as string), id: r.id as string, productionId: r.production_id as string, revision: r.revision as number, seq: r.seq as number, profile: r.profile as RenderProfile, state: r.state as RenderState, jobId: (r.job_id as string | null) ?? null, progress: Number(r.progress), stage: r.stage as string, options: r.options as Doc, inputs: r.inputs as Json[], sources: r.sources as string[], decisions: r.decisions as DecisionRecord[], outputs: r.outputs as OutputInfo[], manifestDigest: (r.manifest_digest as string | null) ?? null, qc: (r.qc as Json | null) ?? null, error: (r.error as string | null) ?? null, stale: r.stale as boolean, blocked: r.blocked as boolean, reasons: r.reasons as Reason[], requestedBy: r.requested_by as string, createdAt: iso(r.created_at), startedAt: isoOrNull(r.started_at), completedAt: isoOrNull(r.completed_at) }; }
function toExport(r: kit.Row): Export { return { ref: exportRef(r.id as string), id: r.id as string, renderId: r.render_id as string, format: r.format as string, filename: r.filename as string, mediaType: r.media_type as string, size: Number(r.size), sha256: r.sha256 as string, manifest: r.manifest as Json, decisions: r.decisions as DecisionRecord[], stale: r.stale as boolean, blocked: r.blocked as boolean, reasons: r.reasons as Reason[], createdBy: r.created_by as string, createdAt: iso(r.created_at) }; }

function normalizeRights(raw: unknown): Rights {
  invariant(isObj(raw), 'invalid_input', 'rights are required: an E11 permission reference or a declared license with attribution');
  if (raw.kind === 'permission') { invariant(isUref(raw.ref), 'invalid_input', 'rights.ref must be a universal reference to a permission'); return { kind: 'permission', ref: raw.ref, ...(typeof raw.attribution === 'string' ? { attribution: raw.attribution.slice(0, 500) } : {}), ...(Array.isArray(raw.restrictions) ? { restrictions: raw.restrictions.filter((x): x is string => typeof x === 'string').slice(0, 50) } : {}) }; }
  invariant(raw.kind === 'license' || raw.kind === 'generated', 'invalid_input', 'rights.kind must be permission, license or generated');
  invariant(typeof raw.license === 'string' && raw.license.trim() !== '' && typeof raw.attribution === 'string' && raw.attribution.trim() !== '', 'invalid_input', 'Declared rights need a license and an attribution');
  return raw.kind === 'license' ? { kind: 'license', license: raw.license.slice(0, 200), attribution: raw.attribution.slice(0, 500), ...(typeof raw.url === 'string' ? { url: raw.url.slice(0, 500) } : {}) } : { kind: 'generated', license: raw.license.slice(0, 200), attribution: raw.attribution.slice(0, 500) };
}
function normalizeProvenance(raw: unknown): Provenance {
  const p = isObj(raw) ? raw : {};
  return { sourceRefs: urefs(p.sourceRefs, 'provenance.sourceRefs'), ...(typeof p.tool === 'string' ? { tool: p.tool.slice(0, 200) } : {}), ...(typeof p.toolVersion === 'string' ? { toolVersion: p.toolVersion.slice(0, 200) } : {}), ...(p.params === undefined ? {} : { params: JSON.parse(J(p.params)) as Json }),
    ...(Array.isArray(p.parentAssets) ? { parentAssets: urefs(p.parentAssets, 'provenance.parentAssets') } : {}), ...(typeof p.provider === 'string' ? { provider: p.provider.slice(0, 200) } : {}), ...(typeof p.note === 'string' ? { note: p.note.slice(0, 1000) } : {}), ...(typeof p.synthetic === 'boolean' ? { synthetic: p.synthetic } : {}) };
}
/** Does an upstream change ref affect something that depends on `candidate`? A dependent pinned to the same or a newer revision of changed content is current. */
function affects(change: UpstreamChange, candidate: string): boolean {
  let c; try { c = kit.parseUref(candidate); } catch { return false; }
  return change.refs.some((ref) => {
    let r; try { r = kit.parseUref(ref); } catch { return false; }
    if (r.engine !== c.engine || r.kind !== c.kind || r.id !== c.id) return false;
    return !(change.kind === 'content_changed' && r.revision !== undefined && c.revision !== undefined && c.revision >= r.revision);
  });
}
const BLOCKING: readonly string[] = ['permission_withdrawn', 'source_removed'];
const HTTP_STATUS: Readonly<Record<string, number>> = { unavailable: 503, provider_unavailable: 503, tool_failed: 500, cancelled: 409, policy_denied: 403, blocked: 403 };

// ───────────────────────────── engine ─────────────────────────────
export function createEngine(deps: EngineDeps): ProductionEngine {
  const { sql } = deps; const config = deps.config ?? {}; const ports = deps.ports ?? {};
  const s = SCHEMA;
  const active = new Map<string, AbortController>();
  const objects = (): ObjectStore => { if (deps.objects === undefined) throw new DomainError('unavailable', 'Object storage is not configured'); return deps.objects; };
  const scopeKey = (ctx: ServiceContext, ...parts: string[]): string => kit.validObjectKey([ctx.tenantId, ctx.projectId, ...parts].join('/'));
  const pipeline = (kind: string): Pipeline => { const p = PIPELINES[kind as ProjectKind]; if (p === undefined) throw new DomainError('invalid_input', `Unknown project kind ${kind}`); return p; };
  const cap = (ctx: ServiceContext, action: string): void => kit.requireCapability(ctx, `production:${action}`);

  // ── row access (always tenant + project scoped; foreign and compartment-hidden rows are "not found") ──
  async function projectRow(q: Sql, ctx: ServiceContext, id: string, lock = false): Promise<kit.Row> {
    const r = (await q.query(`select * from ${s}.projects where id=$1 and tenant_id=$2 and project_id=$3${lock ? ' for update' : ''}`, [uuid(id), ctx.tenantId, ctx.projectId]))[0];
    if (r === undefined) throw new DomainError('not_found', 'Not found');
    kit.requireCompartment(ctx, r.compartment as string | null);
    return r;
  }
  async function revisionRow(q: Sql, ctx: ServiceContext, productionId: string, revision: number): Promise<kit.Row> {
    const r = (await q.query(`select * from ${s}.project_revisions where production_id=$1 and revision=$2 and tenant_id=$3 and project_id=$4`, [productionId, revision, ctx.tenantId, ctx.projectId]))[0];
    if (r === undefined) throw new DomainError('not_found', 'Not found');
    return r;
  }
  async function assetRow(q: Sql, ctx: ServiceContext, id: string, lock = false): Promise<kit.Row> {
    const r = (await q.query(`select * from ${s}.assets where id=$1 and tenant_id=$2 and project_id=$3${lock ? ' for update' : ''}`, [uuid(id), ctx.tenantId, ctx.projectId]))[0];
    if (r === undefined) throw new DomainError('not_found', 'Not found');
    kit.requireCompartment(ctx, r.compartment as string | null);
    return r;
  }
  async function assetVersions(q: Sql, ctx: ServiceContext, id: string): Promise<AssetVersion[]> {
    return (await q.query(`select * from ${s}.asset_versions where asset_id=$1 and tenant_id=$2 and project_id=$3 order by version`, [id, ctx.tenantId, ctx.projectId])).map(toVersion);
  }
  async function loadAsset(q: Sql, ctx: ServiceContext, id: string): Promise<Asset> { const r = await assetRow(q, ctx, id); return toAsset(r, await assetVersions(q, ctx, r.id as string)); }
  async function renderRow(q: Sql, ctx: ServiceContext, id: string, lock = false): Promise<kit.Row> {
    const r = (await q.query(`select r.*, p.compartment as p_compartment from ${s}.renders r join ${s}.projects p on p.id=r.production_id where r.id=$1 and r.tenant_id=$2 and r.project_id=$3${lock ? ' for update of r' : ''}`, [uuid(id), ctx.tenantId, ctx.projectId]))[0];
    if (r === undefined) throw new DomainError('not_found', 'Not found');
    kit.requireCompartment(ctx, r.p_compartment as string | null);
    return r;
  }
  async function exportRow(q: Sql, ctx: ServiceContext, id: string): Promise<kit.Row> {
    const r = (await q.query(`select e.*, p.compartment as p_compartment from ${s}.exports e join ${s}.renders r on r.id=e.render_id join ${s}.projects p on p.id=r.production_id where e.id=$1 and e.tenant_id=$2 and e.project_id=$3`, [uuid(id), ctx.tenantId, ctx.projectId]))[0];
    if (r === undefined) throw new DomainError('not_found', 'Not found');
    kit.requireCompartment(ctx, r.p_compartment as string | null);
    return r;
  }

  // ── documents ──
  async function prepareDoc(q: Sql, ctx: ServiceContext, kind: ProjectKind, raw: unknown): Promise<{ doc: Doc; assetIds: string[]; sources: string[]; text: string }> {
    const p = pipeline(kind); const doc = p.validate(raw);
    invariant(J(doc).length <= 8 * 1024 * 1024, 'payload_too_large', 'Project document is too large');
    const refs = p.assetRefs(doc);
    for (const ref of refs) {
      let a: Asset; try { a = await loadAsset(q, ctx, ref.assetId); } catch (error) { if (error instanceof DomainError && error.code === 'not_found') throw new DomainError('invalid_input', `Document references an unknown asset ${ref.assetId}`); throw error; }
      invariant(ref.version === undefined || a.versions.some((v) => v.version === ref.version), 'invalid_input', `Asset ${ref.assetId} has no version ${String(ref.version)}`);
    }
    return { doc, assetIds: [...new Set(refs.map((r) => r.assetId))], sources: p.sources(doc), text: p.text(doc).slice(0, 200_000) };
  }
  async function insertRevision(tx: Sql, ctx: ServiceContext, project: kit.Row, prepared: Awaited<ReturnType<typeof prepareDoc>>, summary: string, restoredFrom: number | null): Promise<RevisionInfo> {
    const head = project.head_revision as number;
    const prior = head === 0 ? null : (await revisionRow(tx, ctx, project.id as string, head)).doc as Doc;
    const diff = prior === null ? [] : diffDocs(prior, prepared.doc);
    invariant(prior === null || diff.length > 0 || restoredFrom !== null, 'invalid_input', 'The document is unchanged; no new revision was created');
    const revision = head + 1; const digest = sha256(canonical(prepared.doc));
    const sum = summary !== '' ? summary.slice(0, 500) : prior === null ? 'Initial revision' : (() => { const d = diffSummary(diff); return `${d.changed} changed, ${d.added} added, ${d.removed} removed`; })();
    const row = (await tx.query(`insert into ${s}.project_revisions (production_id, revision, tenant_id, project_id, doc, digest, summary, diff, restored_from, asset_ids, sources, actor_id, at) values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11,$12,$13) returning *`,
      [project.id, revision, ctx.tenantId, ctx.projectId, J(prepared.doc), digest, sum, J(diff), restoredFrom, prepared.assetIds, prepared.sources, ctx.actor.id, ctx.now]))[0] as kit.Row;
    await tx.query(`update ${s}.projects set head_revision=$2, search_text=$3, title=$4, updated_at=$5 where id=$1`, [project.id, revision, prepared.text, str(prepared.doc.title, project.title as string, 300) || project.title, ctx.now]);
    await kit.appendAudit(tx, s, ctx, 'production.revision_saved', projectRef(project.id as string, revision), { digest, summary: sum, restoredFrom });
    await kit.emitEvent(tx, s, ctx, 'production.revision_saved', projectRef(project.id as string, revision), { revision, digest, kind: project.kind as string });
    return toRevInfo(row);
  }
  const helpers = (q: Sql, ctx: ServiceContext): OpHelpers => ({
    async assetInfo(assetId) { let a: Asset; try { a = await loadAsset(q, ctx, assetId); } catch { throw new DomainError('invalid_input', `Unknown asset ${assetId}`); } const v = a.versions[a.versions.length - 1] as AssetVersion; return { assetId: a.id, version: v.version, mediaType: v.mediaType, mediaInfo: v.mediaInfo, name: a.name }; },
    newId: (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`,
  });

  // ── assets ──
  async function storeAssetVersion(ctx: ServiceContext, input: AssetImport, existing: string | null): Promise<Asset> {
    const max = config.maxAssetBytes ?? 512 * 1024 * 1024;
    invariant(input.bytes instanceof Uint8Array && input.bytes.byteLength > 0, 'invalid_input', 'Asset bytes are required (an empty file is not an asset)');
    invariant(input.bytes.byteLength <= max, 'payload_too_large', 'Asset is too large');
    invariant(typeof input.name === 'string' && input.name.trim() !== '' && input.name.length <= 200, 'invalid_input', 'Asset name is required');
    const filename = safeName(str(input.filename, 'asset'));
    const mediaType = sniffMediaType(input.bytes, filename);
    if (mediaType === null) throw new DomainError('unsupported_media_type', 'Asset content is not a supported media type');
    if (mediaType === 'image/svg+xml') assertSafeSvg(input.bytes);
    const rights = normalizeRights(input.rights); const provenance = normalizeProvenance(input.provenance);
    const sources = [...new Set([...urefs(input.sources), ...provenance.sourceRefs])];
    const digest = sha256(input.bytes);
    const mediaInfo = await withWorkdir(config.workRoot, async (dir) => { const p = join(dir, filename); await writeFile(p, input.bytes); return probeFile(p, mediaType); });
    invariant(mediaInfo.probe !== 'failed' || mediaClass(mediaType) === 'data', 'unsupported_media_type', `Asset could not be read as ${mediaType}`);
    const store = objects();
    return sql.tx((tx) => kit.idempotent(tx, s, ctx, input.idempotencyKey, { op: 'asset', existing, name: input.name, filename, digest, rights, provenance, sources }, async () => {
      let row: kit.Row;
      if (existing === null) {
        row = (await tx.query(`insert into ${s}.assets (id, tenant_id, project_id, name, class, compartment, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [randomUUID(), ctx.tenantId, ctx.projectId, input.name.trim(), mediaClass(mediaType), input.compartment ?? null, ctx.actor.id, ctx.now]))[0] as kit.Row;
        if (typeof input.compartment === 'string') kit.requireCompartment(ctx, input.compartment);
      } else row = await assetRow(tx, ctx, existing, true);
      const version = (row.head_version as number) + 1; const id = row.id as string;
      const key = scopeKey(ctx, 'assets', id, `v${version}`, filename);
      await store.put(key, input.bytes);
      await tx.query(`insert into ${s}.asset_versions (asset_id, version, tenant_id, project_id, object_key, sha256, size, media_type, filename, media_info, provenance, rights, sources, actor_id, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15)`,
        [id, version, ctx.tenantId, ctx.projectId, key, digest, input.bytes.byteLength, mediaType, filename, J(mediaInfo), J(provenance), J(rights), sources, ctx.actor.id, ctx.now]);
      // New bytes need a new approval; a rights change through setAssetRights is handled there.
      await tx.query(`update ${s}.assets set head_version=$2, approval=case when $3 then approval else 'pending' end where id=$1`, [id, version, existing === null]);
      const type = existing === null ? 'production.asset_created' : 'production.asset_version_added';
      await kit.appendAudit(tx, s, ctx, type, assetRef(id, version), { sha256: digest, mediaType, size: input.bytes.byteLength, rights: rights.kind });
      await kit.emitEvent(tx, s, ctx, type, assetRef(id, version), { version, sha256: digest, mediaType });
      return (await loadAsset(tx, ctx, id)) as unknown as Json;
    })) as unknown as Promise<Asset>;
  }

  // ── consent gate ──
  type GateAsset = { ref: string; id: string; name: string; rights: Rights; sources: string[]; approval: string; blocked: boolean; reasons: Reason[] };
  async function gate(ctx: ServiceContext, action: UseAction, assets: readonly GateAsset[], sources: readonly string[], strict: boolean, extra: { audience?: string; destination?: string } = {}): Promise<{ decisions: DecisionRecord[]; denied: string[] }> {
    const decisions: DecisionRecord[] = []; const denied: string[] = [];
    for (const a of assets) {
      if (a.blocked) denied.push(`Asset "${a.name}" is blocked: ${a.reasons.map((r) => r.reason).join('; ') || 'rights withdrawn'}`);
      if (a.approval === 'rejected') denied.push(`Asset "${a.name}" was rejected in review`);
    }
    const groups: { subjects: string[]; label: string }[] = assets.map((a) => ({ subjects: [...new Set([a.ref, ...(a.rights.kind === 'permission' ? [a.rights.ref] : []), ...a.sources])], label: `asset "${a.name}"` }));
    if (sources.length > 0) groups.push({ subjects: [...new Set(sources)], label: 'project sources' });
    for (const g of groups) {
      let d: DecisionRecord;
      if (ports.useDecisions !== undefined) {
        try { const r = await ports.useDecisions.decide(ctx, { subjects: g.subjects, action, purpose: ctx.purpose, ...extra }); d = { action, subjects: g.subjects, decision: r.decision, reasons: [...r.reasons], permissionRefs: [...r.permissionRefs], restrictions: [...r.restrictions], decidedAt: r.decidedAt, by: 'use-decision-port' }; }
        catch (error) { d = { action, subjects: g.subjects, decision: 'deny', reasons: [`Use decision could not be obtained: ${error instanceof DomainError ? error.code : 'error'}`], permissionRefs: [], restrictions: [], decidedAt: ctx.now, by: 'use-decision-port' }; }
      } else if (config.standalone?.useDecisions === 'declared-rights') {
        d = { action, subjects: g.subjects, decision: 'allow', reasons: ['Standalone mode: declared rights accepted; not verified by a consent engine'], permissionRefs: [], restrictions: [], decidedAt: ctx.now, by: 'standalone-declared-rights' };
      } else d = { action, subjects: g.subjects, decision: 'deny', reasons: ['No use-decision port is configured and standalone mode is not enabled'], permissionRefs: [], restrictions: [], decidedAt: ctx.now, by: 'engine' };
      decisions.push(d);
      if (d.decision === 'deny') denied.push(`Use of ${g.label} for "${action}" was denied: ${d.reasons.join('; ') || 'no reason given'}`);
      else if (d.decision === 'review' && strict) denied.push(`Use of ${g.label} for "${action}" needs rights review before a final render or export: ${d.reasons.join('; ')}`);
    }
    return { decisions, denied };
  }
  async function gateInputs(q: Sql, ctx: ServiceContext, assetIds: readonly { assetId: string; version?: number }[]): Promise<GateAsset[]> {
    const out: GateAsset[] = [];
    for (const ref of assetIds) {
      const a = await loadAsset(q, ctx, ref.assetId); const v = a.versions.find((x) => x.version === (ref.version ?? a.headVersion)) as AssetVersion;
      // Rights are those of the newest version: a correction of rights applies to every use of the asset.
      const head = a.versions[a.versions.length - 1] as AssetVersion;
      out.push({ ref: v.ref, id: a.id, name: a.name, rights: head.rights, sources: v.sources, approval: a.approval, blocked: a.blocked, reasons: a.reasons });
    }
    return out;
  }

  // ── render worker ──
  async function markRender(id: string, set: string, params: unknown[]): Promise<void> { await sql.query(`update ${s}.renders set ${set} where id=$1`, [id, ...params]); }
  async function finishFailed(ctx: ServiceContext, row: kit.Row, state: 'failed' | 'blocked' | 'cancelled', error: string, decisions?: DecisionRecord[]): Promise<void> {
    await sql.tx(async (tx) => {
      const cur = (await tx.query(`select state from ${s}.renders where id=$1 for update`, [row.id]))[0];
      if (cur === undefined || ['done', 'failed', 'blocked'].includes(cur.state as string) || (cur.state === 'cancelled' && state !== 'cancelled')) return;
      await tx.query(`update ${s}.renders set state=$2, error=$3, completed_at=$4, stage=$2, decisions=coalesce($5::jsonb, decisions), blocked=$6 where id=$1`, [row.id, state, error.slice(0, 2000), ctx.now, decisions === undefined ? null : J(decisions), state === 'blocked']);
      if (cur.state !== 'cancelled') {
        await kit.appendAudit(tx, s, ctx, `production.render_${state}`, renderRef(row.id as string), { error: error.slice(0, 500) });
        await kit.emitEvent(tx, s, ctx, `production.render_${state}`, renderRef(row.id as string), { productionId: row.production_id as string, revision: row.revision as number, reason: error.slice(0, 300) });
      }
    });
    if (typeof row.reservation === 'string' && ports.budget !== undefined) { try { await ports.budget.release(ctx, row.reservation, state); } catch { /* reservation expiry is the budget engine's concern */ } }
  }
  async function renderJob(job: Job): Promise<Json> {
    const ctx: ServiceContext = { ...job.ctx, now: new Date().toISOString() };
    const renderId = (job.payload as { renderId: string }).renderId;
    const row = (await sql.query(`select * from ${s}.renders where id=$1 and tenant_id=$2 and project_id=$3`, [renderId, ctx.tenantId, ctx.projectId]))[0];
    if (row === undefined || !['queued', 'running'].includes(row.state as string)) return { skipped: true };
    const started = Date.now(); const controller = new AbortController(); active.set(renderId, controller);
    let progress = 0.01, stage = 'starting', dirty = true, live = job;
    const beat = setInterval(() => { void (async () => {
      try { live = await kit.heartbeatJob(sql, s, live, 60_000); if (dirty) { dirty = false; await markRender(renderId, 'progress=$2, stage=$3', [progress, stage]); } }
      catch (error) { if (error instanceof DomainError && error.code === 'lease_lost') controller.abort(); }
    })(); }, 400);
    try {
      if (ports.authorization !== undefined) { const a = await ports.authorization.authorize(ctx, { capability: 'production:render', resource: renderRef(renderId) }); if (!a.allowed) throw new DomainError('forbidden', `Authorization re-check failed: ${a.reason}`); }
      const project = await projectRow(sql, ctx, row.production_id as string);
      const rev = await revisionRow(sql, ctx, project.id as string, row.revision as number);
      const p = pipeline(project.kind as string); const doc = rev.doc as Doc; const profile = row.profile as RenderProfile;
      // Re-check use decisions immediately before doing the work: a withdrawal after the request must still stop it.
      const g = await gate(ctx, 'adapt', await gateInputs(sql, ctx, p.assetRefs(doc)), [...new Set([...(project.sources as string[]), ...(rev.sources as string[])])], profile === 'final');
      if (g.denied.length > 0) { await finishFailed(ctx, row, 'blocked', g.denied.join(' | '), g.decisions); return { state: 'blocked' }; }
      await markRender(renderId, `state='running', started_at=$2, decisions=$3::jsonb`, [ctx.now, J(g.decisions)]);
      const tools = new Map<string, string>(); const inputs = new Map<string, AssetInput>(); const store = objects();
      const result = await withWorkdir(config.workRoot, async (dir) => {
        const env: RenderEnv = {
          dir, profile, signal: controller.signal, options: row.options as Doc, title: project.title as string,
          async asset(assetId, version) {
            const a = await loadAsset(sql, ctx, assetId); const v = a.versions.find((x) => x.version === (version ?? a.headVersion));
            if (v === undefined) throw new DomainError('invalid_input', `Asset ${assetId} has no version ${String(version)}`);
            const hit = inputs.get(v.ref); if (hit !== undefined) return hit;
            const key = (await sql.query<{ object_key: string }>(`select object_key from ${s}.asset_versions where asset_id=$1 and version=$2`, [a.id, v.version]))[0]?.object_key as string;
            const bytes = await store.get(key);
            invariant(sha256(bytes) === v.sha256, 'integrity_failed', `Stored bytes of asset ${a.name} do not match their recorded digest`);
            const path = join(dir, `asset-${a.id.slice(0, 8)}-v${v.version}-${v.filename}`); await writeFile(path, bytes);
            const head = a.versions[a.versions.length - 1] as AssetVersion;
            const input: AssetInput = { ref: v.ref, assetId: a.id, version: v.version, name: a.name, filename: v.filename, mediaType: v.mediaType, sha256: v.sha256, size: v.size, mediaInfo: v.mediaInfo, rights: head.rights, provenance: v.provenance, sources: v.sources, approval: a.approval, path };
            inputs.set(v.ref, input); return input;
          },
          progress(fraction, st) { const f = Math.min(0.99, Math.max(0, fraction)); if (f !== progress || st !== stage) { progress = f; stage = st.slice(0, 120); dirty = true; } },
          async tool(...names) { for (const t of await requireTools(names)) tools.set(t.name, t.version); },
          async cacheGet(hash) { const c = (await sql.query<{ object_key: string }>(`select object_key from ${s}.render_cache where tenant_id=$1 and project_id=$2 and hash=$3`, [ctx.tenantId, ctx.projectId, hash]))[0]; if (c === undefined) return null; try { return await store.get(c.object_key); } catch { return null; } },
          async cachePut(hash, bytes) { const key = scopeKey(ctx, 'cache', hash); await store.put(key, bytes); await sql.query(`insert into ${s}.render_cache (tenant_id, project_id, hash, object_key, size, at) values ($1,$2,$3,$4,$5,now()) on conflict do nothing`, [ctx.tenantId, ctx.projectId, hash, key, bytes.byteLength]); },
          credits() { return [...inputs.values()].map((i) => creditLine(i)); },
        };
        for (const ref of p.assetRefs(doc)) await env.asset(ref.assetId, ref.version);
        const res: PipelineResult = await p.render(doc, env);
        invariant(res.outputs.length > 0, 'tool_failed', 'The pipeline produced no output');
        const outputs: OutputInfo[] = [];
        for (const o of res.outputs) {
          const bytes = await readFile(o.path); invariant(bytes.byteLength > 0, 'tool_failed', `Output ${o.name} is empty`);
          const name = safeName(o.name); await store.put(scopeKey(ctx, 'renders', renderId, name), bytes);
          outputs.push({ name, mediaType: o.mediaType, size: bytes.byteLength, sha256: sha256(bytes), role: o.role, info: await probeFile(o.path, o.mediaType) });
        }
        return { res, outputs };
      });
      if (controller.signal.aborted) throw new DomainError('cancelled', 'Cancelled');
      const inputList = [...inputs.values()].map((i) => ({ ref: i.ref, assetId: i.assetId, version: i.version, name: i.name, filename: i.filename, mediaType: i.mediaType, sha256: i.sha256, size: i.size, rights: i.rights as unknown as Json, provenance: i.provenance as unknown as Json, sources: [...i.sources], approval: i.approval }));
      const sources = [...new Set([...(project.editorial_ref === null ? [] : [project.editorial_ref as string]), ...(project.sources as string[]), ...(rev.sources as string[]), ...inputList.flatMap((i) => [...i.sources, ...(i.rights as unknown as Rights).kind === 'permission' ? [((i.rights as unknown as Rights) as { ref: string }).ref] : []])])];
      const man: Doc = {
        schema: 'production.manifest/v1', engine: { id: 'E10', version: ENGINE_VERSION },
        render: { ref: renderRef(renderId), id: renderId, seq: row.seq as number, profile, requestedBy: row.requested_by as string, completedAt: ctx.now },
        project: { ref: projectRef(project.id as string, row.revision as number), kind: project.kind as string, title: project.title as string, revision: row.revision as number, documentDigest: rev.digest as string, editorialRef: (project.editorial_ref as string | null) ?? null },
        inputs: inputList as unknown as Json, sources, tools: [...tools].map(([name, version]) => ({ name, version })), parameters: result.res.parameters,
        disclosures: result.res.disclosures as unknown as Json, credits: [...new Set(result.res.credits)], generated: result.res.generated, decisions: g.decisions as unknown as Json,
        outputs: result.outputs as unknown as Json, ...(result.res.details === undefined ? {} : { details: result.res.details }),
      };
      const manifestDigest = sha256(canonical(man));
      await store.put(scopeKey(ctx, 'renders', renderId, 'manifest.json'), Buffer.from(JSON.stringify(man, null, 2)));
      const qc = qcStatic(man, result.outputs);
      const done = await sql.tx(async (tx) => {
        const cur = (await tx.query(`select state from ${s}.renders where id=$1 for update`, [renderId]))[0];
        if (cur === undefined || cur.state !== 'running') return false;
        await tx.query(`update ${s}.renders set state='done', progress=1, stage='done', inputs=$2::jsonb, sources=$3, outputs=$4::jsonb, manifest=$5::jsonb, manifest_digest=$6, qc=$7::jsonb, completed_at=$8 where id=$1`, [renderId, J(inputList), sources, J(result.outputs), J(man), manifestDigest, J(qc), ctx.now]);
        await kit.appendAudit(tx, s, ctx, 'production.render_completed', renderRef(renderId), { manifestDigest, outputs: result.outputs.map((o) => ({ name: o.name, sha256: o.sha256 })) });
        await kit.emitEvent(tx, s, ctx, 'production.render_completed', renderRef(renderId), { productionId: project.id as string, revision: row.revision as number, profile, kind: project.kind as string, manifestDigest, seq: row.seq as number });
        if (!qc.ok) await kit.emitEvent(tx, s, ctx, 'production.qc_failed', renderRef(renderId), { failed: qc.checks.filter((c) => (c as Doc).ok === false).map((c) => (c as Doc).check as string) });
        return true;
      });
      if (!done) return { state: 'cancelled' };
      if (typeof row.reservation === 'string' && ports.budget !== undefined) { try { await ports.budget.commit(ctx, row.reservation, { amount: Math.max(1, Math.round((Date.now() - started) / 1000)), detail: { render: renderRef(renderId) } }); } catch { /* recorded by the budget engine */ } }
      return { state: 'done', manifestDigest };
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DomainError && error.code === 'cancelled')) { await finishFailed(ctx, row, 'cancelled', 'Cancelled'); return { state: 'cancelled' }; }
      if (error instanceof DomainError && error.code === 'consent_denied') { await finishFailed(ctx, row, 'blocked', error.message); return { state: 'blocked' }; }
      const message = error instanceof DomainError ? `${error.code}: ${error.message}` : error instanceof Error ? `internal: ${error.message}` : 'internal error';
      await finishFailed(ctx, row, 'failed', message);
      return { state: 'failed', error: message.slice(0, 300) };
    } finally { clearInterval(beat); active.delete(renderId); }
  }
  function creditLine(i: AssetInput): string {
    const r = i.rights; const who = r.kind === 'permission' ? (r.attribution ?? 'used with permission') : r.attribution;
    return `${i.name} — ${who}${r.kind === 'permission' ? ` (permission ${r.ref})` : ` (${r.license})`}${i.provenance.synthetic === true ? ' [synthetic]' : ''}`;
  }
  /** Checks that need only the manifest and recorded output probes. */
  function qcStatic(man: Doc, outputs: readonly OutputInfo[]): { ok: boolean; checks: Json[] } {
    const checks: Json[] = [];
    for (const o of outputs) {
      const info = isObj(o.info) ? o.info : {};
      checks.push({ check: `probe:${o.name}`, ok: info.probe !== 'failed' && o.size > 0, detail: info.probe === 'failed' ? str(info.error) : `${o.size} bytes` });
      if (o.role === 'primary' && (o.mediaType.startsWith('audio/') || o.mediaType.startsWith('video/')) && o.mediaType !== 'audio/midi') checks.push({ check: `duration:${o.name}`, ok: typeof info.duration === 'number' && info.duration > 0.5, detail: `${String(info.duration)} s` });
      if (o.mediaType.startsWith('video/')) { const st = arr(info.streams) as Doc[]; checks.push({ check: `streams:${o.name}`, ok: st.some((x) => x.type === 'video') && st.some((x) => x.type === 'audio'), detail: st.map((x) => `${String(x.type)}/${String(x.codec)}`).join(',') }); }
      if (o.mediaType === 'application/pdf') checks.push({ check: `pages:${o.name}`, ok: typeof info.pages === 'number' && info.pages > 0, detail: `${String(info.pages)} pages` });
    }
    const required = arr(isObj(man.details) ? man.details.requiredDisclosures : []).length; const shown = arr(man.disclosures).length;
    checks.push({ check: 'disclosures', ok: shown >= required, detail: `${shown} disclosed of ${required} required` });
    const qcList = arr(isObj(man.details) ? man.details.qc : []); for (const c of qcList) checks.push(c);
    return { ok: checks.every((c) => (c as Doc).ok !== false), checks };
  }

  const engine: ProductionEngine = {
    manifest,
    // ── projects & revisions ──
    async createProject(ctx, input) {
      cap(ctx, 'write');
      invariant(isObj(input) && PROJECT_KINDS.includes(input.kind), 'invalid_input', `kind must be one of ${PROJECT_KINDS.join(', ')}`);
      invariant(typeof input.title === 'string' && input.title.trim() !== '' && input.title.length <= 300, 'invalid_input', 'title is required');
      invariant(input.editorialRef === undefined || isUref(input.editorialRef), 'invalid_input', 'editorialRef must be a universal reference');
      if (typeof input.compartment === 'string') kit.requireCompartment(ctx, input.compartment);
      const sources = urefs(input.sources); const p = pipeline(input.kind);
      return sql.tx((tx) => kit.idempotent(tx, s, ctx, input.idempotencyKey, { op: 'createProject', ...input }, async () => {
        const prepared = await prepareDoc(tx, ctx, input.kind, input.doc ?? p.empty(input.title.trim()));
        const row = (await tx.query(`insert into ${s}.projects (id, tenant_id, project_id, kind, title, compartment, editorial_ref, sources, created_by, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning *`,
          [randomUUID(), ctx.tenantId, ctx.projectId, input.kind, input.title.trim(), input.compartment ?? null, input.editorialRef ?? null, sources, ctx.actor.id, ctx.now]))[0] as kit.Row;
        await kit.appendAudit(tx, s, ctx, 'production.project_created', projectRef(row.id as string), { kind: input.kind, editorialRef: input.editorialRef ?? null });
        await kit.emitEvent(tx, s, ctx, 'production.project_created', projectRef(row.id as string), { kind: input.kind });
        await insertRevision(tx, ctx, row, prepared, '', null);
        return toProject(await projectRow(tx, ctx, row.id as string)) as unknown as Json;
      })) as unknown as Promise<Project>;
    },
    async createProjectFromEditorial(ctx, input) {
      cap(ctx, 'write');
      invariant(isObj(input) && PROJECT_KINDS.includes(input.kind), 'invalid_input', `kind must be one of ${PROJECT_KINDS.join(', ')}`);
      const ed = normalizeEditorial(input.editorial);
      const doc = await pipeline(input.kind).fromEditorial(ed, isObj(input.options) ? input.options : {});
      return engine.createProject(ctx, { kind: input.kind, title: input.title ?? ed.title, doc, editorialRef: ed.ref, sources: ed.sources, ...(input.compartment === undefined ? {} : { compartment: input.compartment }), ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }) });
    },
    async getProject(ctx, productionId) { cap(ctx, 'read'); return toProject(await projectRow(sql, ctx, productionId)); },
    async listProjects(ctx, options = {}) {
      cap(ctx, 'read');
      const rows = await sql.query(`select * from ${s}.projects where tenant_id=$1 and project_id=$2 and ($3::text is null or kind=$3) and (compartment is null or compartment = any($4)) order by created_at desc limit ${Math.min(Math.max(options.limit ?? 100, 1), 500)}`, [ctx.tenantId, ctx.projectId, options.kind ?? null, [...ctx.compartments]]);
      return rows.map(toProject);
    },
    async updateProjectLinks(ctx, input) {
      cap(ctx, 'write');
      invariant(input.editorialRef === undefined || isUref(input.editorialRef), 'invalid_input', 'editorialRef must be a universal reference');
      const sources = input.sources === undefined ? undefined : urefs(input.sources);
      return sql.tx(async (tx) => {
        const row = await projectRow(tx, ctx, input.productionId, true);
        const reasons = input.resolveStale === true ? (row.reasons as Reason[]).filter((r) => BLOCKING.includes(r.kind)) : row.reasons as Reason[];
        await tx.query(`update ${s}.projects set editorial_ref=coalesce($2, editorial_ref), sources=coalesce($3, sources), stale=$4, reasons=$5::jsonb, updated_at=$6 where id=$1`, [row.id, input.editorialRef ?? null, sources ?? null, input.resolveStale === true ? false : row.stale, J(reasons), ctx.now]);
        await kit.appendAudit(tx, s, ctx, 'production.project_links_updated', projectRef(row.id as string), { editorialRef: input.editorialRef ?? null, resolveStale: input.resolveStale === true });
        return toProject(await projectRow(tx, ctx, row.id as string));
      });
    },
    async saveRevision(ctx, input) {
      cap(ctx, 'write');
      return sql.tx((tx) => kit.idempotent(tx, s, ctx, input.idempotencyKey, { op: 'saveRevision', ...input }, async () => {
        const row = await projectRow(tx, ctx, input.productionId, true);
        if (input.baseRevision !== undefined && input.baseRevision !== row.head_revision) throw new DomainError('revision_conflict', `The project is at revision ${String(row.head_revision)}, not ${input.baseRevision}`);
        return (await insertRevision(tx, ctx, row, await prepareDoc(tx, ctx, row.kind as ProjectKind, input.doc), str(input.summary), null)) as unknown as Json;
      })) as unknown as Promise<RevisionInfo>;
    },
    async applyOperations(ctx, input) {
      cap(ctx, 'write');
      invariant(Array.isArray(input.operations) && input.operations.length > 0 && input.operations.length <= 500 && input.operations.every(isObj), 'invalid_input', 'operations must be a non-empty array of objects');
      return sql.tx((tx) => kit.idempotent(tx, s, ctx, input.idempotencyKey, { op: 'applyOperations', ...input }, async () => {
        const row = await projectRow(tx, ctx, input.productionId, true);
        if (input.baseRevision !== undefined && input.baseRevision !== row.head_revision) throw new DomainError('revision_conflict', `The project is at revision ${String(row.head_revision)}, not ${input.baseRevision}`);
        const p = pipeline(row.kind as string); let doc = (await revisionRow(tx, ctx, row.id as string, row.head_revision as number)).doc as Doc;
        for (const [i, op] of input.operations.entries()) {
          const next = applyGenericOp(doc, op) ?? await p.applyOp(doc, op, helpers(tx, ctx));
          if (next === null) throw new DomainError('invalid_input', `operations[${i}]: unknown operation "${str(op.op)}" for a ${String(row.kind)} project`);
          doc = p.validate(next);
        }
        const summary = str(input.summary) || input.operations.map((o) => str(o.op)).slice(0, 8).join(', ');
        return (await insertRevision(tx, ctx, row, await prepareDoc(tx, ctx, row.kind as ProjectKind, doc), summary, null)) as unknown as Json;
      })) as unknown as Promise<RevisionInfo>;
    },
    async getRevision(ctx, productionId, revision) {
      cap(ctx, 'read'); const row = await projectRow(sql, ctx, productionId);
      const r = await revisionRow(sql, ctx, row.id as string, revision ?? row.head_revision as number);
      return { ...toRevInfo(r), doc: r.doc as Doc };
    },
    async listRevisions(ctx, productionId) {
      cap(ctx, 'read'); const row = await projectRow(sql, ctx, productionId);
      return (await sql.query(`select * from ${s}.project_revisions where production_id=$1 and tenant_id=$2 and project_id=$3 order by revision`, [row.id, ctx.tenantId, ctx.projectId])).map(toRevInfo);
    },
    async diffRevisions(ctx, productionId, from, to) {
      cap(ctx, 'read'); const row = await projectRow(sql, ctx, productionId);
      const a = await revisionRow(sql, ctx, row.id as string, from), b = await revisionRow(sql, ctx, row.id as string, to);
      const entries = diffDocs(a.doc as Json, b.doc as Json);
      return { from, to, entries, summary: diffSummary(entries) };
    },
    async restoreRevision(ctx, input) {
      cap(ctx, 'write');
      return sql.tx((tx) => kit.idempotent(tx, s, ctx, input.idempotencyKey, { op: 'restoreRevision', ...input }, async () => {
        const row = await projectRow(tx, ctx, input.productionId, true);
        invariant(input.revision !== row.head_revision, 'invalid_input', 'That revision is already the current one');
        const old = await revisionRow(tx, ctx, row.id as string, input.revision);
        return (await insertRevision(tx, ctx, row, await prepareDoc(tx, ctx, row.kind as ProjectKind, old.doc), `Restored revision ${input.revision}`, input.revision)) as unknown as Json;
      })) as unknown as Promise<RevisionInfo>;
    },
    async validateProject(ctx, productionId, revision) {
      cap(ctx, 'read'); const row = await projectRow(sql, ctx, productionId);
      const r = await revisionRow(sql, ctx, row.id as string, revision ?? row.head_revision as number);
      const p = pipeline(row.kind as string); const problems: Problem[] = [...(p.check?.(r.doc as Doc) ?? [])];
      for (const ref of p.assetRefs(r.doc as Doc)) {
        try { const a = await loadAsset(sql, ctx, ref.assetId); if (a.blocked) problems.push({ level: 'error', message: `Asset "${a.name}" is blocked`, at: a.ref }); else if (a.approval === 'rejected') problems.push({ level: 'error', message: `Asset "${a.name}" was rejected`, at: a.ref }); else if (a.approval === 'pending') problems.push({ level: 'warning', message: `Asset "${a.name}" is not yet approved`, at: a.ref }); }
        catch { problems.push({ level: 'error', message: `Missing asset ${ref.assetId}` }); }
      }
      if (row.stale === true) problems.push({ level: 'warning', message: `Project is stale: ${(row.reasons as Reason[]).map((x) => x.reason).join('; ')}` });
      return { ok: !problems.some((x) => x.level === 'error'), problems };
    },

    // ── assets ──
    async importAsset(ctx, input) { cap(ctx, 'write'); invariant(isObj(input), 'invalid_input', 'Asset input required'); return storeAssetVersion(ctx, input, null); },
    async addAssetVersion(ctx, input) { cap(ctx, 'write'); invariant(isObj(input), 'invalid_input', 'Asset input required'); await assetRow(sql, ctx, input.assetId); return storeAssetVersion(ctx, input, input.assetId); },
    async setAssetRights(ctx, input) {
      cap(ctx, 'write'); const rights = normalizeRights(input.rights);
      return sql.tx(async (tx) => {
        const row = await assetRow(tx, ctx, input.assetId, true); const versions = await assetVersions(tx, ctx, row.id as string); const head = versions[versions.length - 1] as AssetVersion;
        const key = (await tx.query<{ object_key: string }>(`select object_key from ${s}.asset_versions where asset_id=$1 and version=$2`, [row.id, head.version]))[0]?.object_key as string;
        const version = head.version + 1;
        // Same bytes, new rights record: a new version so earlier manifests keep pointing at what they used.
        await tx.query(`insert into ${s}.asset_versions (asset_id, version, tenant_id, project_id, object_key, sha256, size, media_type, filename, media_info, provenance, rights, sources, actor_id, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15)`,
          [row.id, version, ctx.tenantId, ctx.projectId, key, head.sha256, head.size, head.mediaType, head.filename, J(head.mediaInfo), J({ ...head.provenance, note: `Rights updated${input.note === undefined ? '' : `: ${input.note.slice(0, 300)}`}` }), J(rights), head.sources, ctx.actor.id, ctx.now]);
        await tx.query(`update ${s}.assets set head_version=$2, blocked=false, stale=false, approval='pending', reasons=$3::jsonb where id=$1`, [row.id, version, J((row.reasons as Reason[]).map((r) => ({ ...r, resolvedAt: ctx.now })))]);
        await kit.appendAudit(tx, s, ctx, 'production.asset_rights_changed', assetRef(row.id as string, version), { rights: rights.kind, note: input.note ?? null });
        await kit.emitEvent(tx, s, ctx, 'production.asset_version_added', assetRef(row.id as string, version), { version, sha256: head.sha256, rightsChanged: true });
        return loadAsset(tx, ctx, row.id as string);
      });
    },
    async setAssetApproval(ctx, input) {
      cap(ctx, 'approve');
      invariant(['approved', 'rejected', 'pending'].includes(input.approval), 'invalid_input', 'approval must be approved, rejected or pending');
      if (ports.authorization !== undefined) { const a = await ports.authorization.authorize(ctx, { capability: 'production:approve', resource: assetRef(uuid(input.assetId)) }); if (!a.allowed) throw new DomainError('forbidden', 'Not authorized to approve assets'); }
      return sql.tx(async (tx) => {
        const row = await assetRow(tx, ctx, input.assetId, true);
        invariant(!(input.approval === 'approved' && row.blocked === true), 'invalid_state', 'A blocked asset cannot be approved; correct its rights first');
        await tx.query(`update ${s}.assets set approval=$2, approval_by=$3, approval_note=$4 where id=$1`, [row.id, input.approval, ctx.actor.id, input.note?.slice(0, 1000) ?? null]);
        await kit.appendAudit(tx, s, ctx, 'production.asset_approval_changed', assetRef(row.id as string, row.head_version as number), { approval: input.approval });
        await kit.emitEvent(tx, s, ctx, 'production.asset_approval_changed', assetRef(row.id as string, row.head_version as number), { approval: input.approval });
        return loadAsset(tx, ctx, row.id as string);
      });
    },
    async importRenderOutput(ctx, input) {
      cap(ctx, 'write'); cap(ctx, 'read');
      const r = toRender(await renderRow(sql, ctx, input.renderId));
      invariant(r.state === 'done' && !r.blocked, 'invalid_state', 'Only outputs of a completed, unblocked render can become assets');
      const file = await engine.getRenderOutput(ctx, r.id, input.output);
      const man = (await engine.getRenderManifest(ctx, r.id)) as Doc;
      return storeAssetVersion(ctx, { name: input.name ?? `${str((man.project as Doc).title)} — ${file.filename}`, filename: file.filename, bytes: file.bytes,
        rights: { kind: 'generated', license: 'project-owned', attribution: `Produced in this project (${r.ref})` },
        provenance: { sourceRefs: r.sources.filter((x) => !x.startsWith('E10:')), tool: 'E10 render', toolVersion: ENGINE_VERSION, params: { render: r.ref, output: file.filename, manifestDigest: r.manifestDigest }, parentAssets: (r.inputs as Doc[]).map((i) => i.ref as string), synthetic: arr(man.generated).some((x) => isObj(x) && x.synthetic === true) },
        sources: r.sources.filter((x) => !x.startsWith('E10:')), ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }) }, null);
    },
    async generateAsset(ctx, input) {
      cap(ctx, 'spend'); cap(ctx, 'write');
      invariant(isObj(input) && ['image', 'tts', 'music', 'singing'].includes(input.provider) && isObj(input.params), 'invalid_input', 'provider must be image, tts, music or singing, with params');
      if (ports.authorization !== undefined) { const a = await ports.authorization.authorize(ctx, { capability: 'production:spend' }); if (!a.allowed) throw new DomainError('forbidden', 'Not authorized to spend on generation'); }
      const status = providerStatus(config.providers)[input.provider];
      if (status === undefined || !status.configured) throw new DomainError('unavailable', `No ${input.provider} generation provider is configured`);
      let reservation: string | undefined;
      if (ports.budget !== undefined) reservation = (await ports.budget.reserve(ctx, { category: 'generation', amount: 1, unit: 'provider_request', subject: `E10:provider:${input.provider}`, idempotencyKey: `generate:${input.idempotencyKey ?? randomUUID()}` })).reservationId;
      try {
        const out = await runProvider(config.providers, input.provider, input.params);
        const asset = await storeAssetVersion(ctx, { name: input.name, filename: out.filename, bytes: out.bytes, rights: { kind: 'generated', license: out.license, attribution: `Generated with ${out.provider}` },
          provenance: { sourceRefs: urefs(input.sources), tool: out.provider, toolVersion: out.model, params: out.params, provider: out.provider, synthetic: true }, sources: urefs(input.sources), ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }) }, null);
        if (reservation !== undefined) await ports.budget?.commit(ctx, reservation, { amount: 1 });
        return asset;
      } catch (error) { if (reservation !== undefined) { try { await ports.budget?.release(ctx, reservation, 'generation failed'); } catch { /* ignore */ } } throw error; }
    },
    async getAsset(ctx, assetId) { cap(ctx, 'read'); return loadAsset(sql, ctx, assetId); },
    async listAssets(ctx, options = {}) {
      cap(ctx, 'read');
      const rows = await sql.query(`select * from ${s}.assets where tenant_id=$1 and project_id=$2 and ($3::text is null or class=$3) and (compartment is null or compartment = any($4)) order by created_at desc limit ${Math.min(Math.max(options.limit ?? 200, 1), 1000)}`, [ctx.tenantId, ctx.projectId, options.class ?? null, [...ctx.compartments]]);
      const out: Asset[] = []; for (const r of rows) out.push(toAsset(r, await assetVersions(sql, ctx, r.id as string)));
      return out;
    },
    async getAssetBytes(ctx, assetId, version) {
      cap(ctx, 'read'); const a = await loadAsset(sql, ctx, assetId);
      const v = a.versions.find((x) => x.version === (version ?? a.headVersion)); if (v === undefined) throw new DomainError('not_found', 'Not found');
      if (a.blocked) throw new DomainError('consent_denied', 'This asset is blocked for use');
      const key = (await sql.query<{ object_key: string }>(`select object_key from ${s}.asset_versions where asset_id=$1 and version=$2 and tenant_id=$3 and project_id=$4`, [a.id, v.version, ctx.tenantId, ctx.projectId]))[0]?.object_key as string;
      return { bytes: await objects().get(key), mediaType: v.mediaType, filename: v.filename, sha256: v.sha256 };
    },

    // ── renders ──
    async requestRender(ctx, input) {
      cap(ctx, 'render');
      invariant(isObj(input), 'invalid_input', 'Render request required');
      const profile: RenderProfile = input.profile ?? 'final'; invariant(profile === 'preview' || profile === 'final', 'invalid_input', 'profile must be preview or final');
      const options = isObj(input.options) ? input.options : {}; invariant(J(options).length <= 20_000, 'invalid_input', 'options too large');
      objects();
      const project = await projectRow(sql, ctx, input.productionId);
      const revision = input.revision ?? project.head_revision as number;
      const rev = await revisionRow(sql, ctx, project.id as string, revision);
      const p = pipeline(project.kind as string); const doc = rev.doc as Doc;
      await requireTools(p.tools);
      if (profile === 'final') { const errors = (p.check?.(doc) ?? []).filter((x) => x.level === 'error'); invariant(errors.length === 0, 'invalid_input', `The project has problems that stop a final render: ${errors.map((e) => e.message).slice(0, 5).join('; ')}`); }
      if (input.idempotencyKey !== undefined) {
        const prior = (await sql.query<{ result: Json | null }>(`select result from ${s}._idempotency where tenant_id=$1 and project_id=$2 and key=$3`, [ctx.tenantId, ctx.projectId, input.idempotencyKey]))[0];
        if (prior?.result !== undefined && prior.result !== null) return sql.tx((tx) => kit.idempotent(tx, s, ctx, input.idempotencyKey, { op: 'requestRender', ...input }, async () => prior.result as Json)) as unknown as Promise<Render>;
      }
      const g = await gate(ctx, 'adapt', await gateInputs(sql, ctx, p.assetRefs(doc)), [...new Set([...(project.sources as string[]), ...(rev.sources as string[])])], profile === 'final');
      const id = randomUUID(); let reservation: string | null = null;
      if (g.denied.length === 0 && ports.budget !== undefined) reservation = (await ports.budget.reserve(ctx, { category: 'render_compute', amount: Math.max(1, Math.round(p.estimateSeconds(doc, profile))), unit: 'compute_second', subject: renderRef(id), idempotencyKey: `render:${input.idempotencyKey ?? id}` })).reservationId;
      try {
        return await (sql.tx((tx) => kit.idempotent(tx, s, ctx, input.idempotencyKey, { op: 'requestRender', ...input }, async () => {
          await tx.query(`select id from ${s}.projects where id=$1 for update`, [project.id]);
          const seq = Number((await tx.query<{ n: string }>(`select coalesce(max(seq),0)+1 as n from ${s}.renders where production_id=$1`, [project.id]))[0]?.n ?? 1);
          const blocked = g.denied.length > 0;
          let jobId: string | null = null;
          if (!blocked) jobId = (await kit.enqueueJob(tx, s, ctx, { kind: 'production.render', payload: { renderId: id }, maxAttempts: 2 })).id;
          const row = (await tx.query(`insert into ${s}.renders (id, tenant_id, project_id, production_id, revision, seq, profile, state, job_id, options, decisions, error, blocked, reasons, reservation, requested_by, created_at, completed_at, stage) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,'[]',$14,$15,$16,$17,$8) returning *`,
            [id, ctx.tenantId, ctx.projectId, project.id, revision, seq, profile, blocked ? 'blocked' : 'queued', jobId, J(options), J(g.decisions), blocked ? g.denied.join(' | ').slice(0, 2000) : null, blocked, reservation, ctx.actor.id, ctx.now, blocked ? ctx.now : null]))[0] as kit.Row;
          const type = blocked ? 'production.render_blocked' : 'production.render_requested';
          await kit.appendAudit(tx, s, ctx, type, renderRef(id), { productionId: project.id as string, revision, profile, ...(blocked ? { reasons: g.denied.slice(0, 10) } : {}) });
          await kit.emitEvent(tx, s, ctx, type, renderRef(id), { productionId: project.id as string, revision, profile, ...(blocked ? { reason: g.denied[0]?.slice(0, 300) ?? '' } : {}) });
          return toRender(row) as unknown as Json;
        })) as unknown as Promise<Render>);
      } catch (error) { if (reservation !== null) { try { await ports.budget?.release(ctx, reservation, 'render request failed'); } catch { /* ignore */ } } throw error; }
    },
    async getRender(ctx, renderId) { cap(ctx, 'read'); return toRender(await renderRow(sql, ctx, renderId)); },
    async listRenders(ctx, options = {}) {
      cap(ctx, 'read');
      const rows = await sql.query(`select r.* from ${s}.renders r join ${s}.projects p on p.id=r.production_id where r.tenant_id=$1 and r.project_id=$2 and ($3::uuid is null or r.production_id=$3) and (p.compartment is null or p.compartment = any($4)) order by r.created_at desc, r.seq desc limit ${Math.min(Math.max(options.limit ?? 100, 1), 500)}`, [ctx.tenantId, ctx.projectId, options.productionId === undefined ? null : uuid(options.productionId), [...ctx.compartments]]);
      return rows.map(toRender);
    },
    async cancelRender(ctx, renderId) {
      cap(ctx, 'render');
      const row = await renderRow(sql, ctx, renderId);
      invariant(['queued', 'running'].includes(row.state as string), 'invalid_state', `A render in state ${String(row.state)} cannot be cancelled`);
      await sql.tx(async (tx) => {
        const cur = await renderRow(tx, ctx, renderId, true);
        invariant(['queued', 'running'].includes(cur.state as string), 'invalid_state', `A render in state ${String(cur.state)} cannot be cancelled`);
        await tx.query(`update ${s}.renders set state='cancelled', stage='cancelled', error='Cancelled', completed_at=$2 where id=$1`, [cur.id, ctx.now]);
        if (typeof cur.job_id === 'string') { try { await kit.controlJob(tx, s, ctx, cur.job_id, 'cancel'); } catch (error) { if (!(error instanceof DomainError && error.code === 'invalid_state')) throw error; } }
        await kit.appendAudit(tx, s, ctx, 'production.render_cancelled', renderRef(cur.id as string), {});
        await kit.emitEvent(tx, s, ctx, 'production.render_cancelled', renderRef(cur.id as string), { productionId: cur.production_id as string });
      });
      active.get(row.id as string)?.abort(); // kills the running subprocess in this worker; other workers notice the lost lease
      if (typeof row.reservation === 'string' && ports.budget !== undefined) { try { await ports.budget.release(ctx, row.reservation, 'cancelled'); } catch { /* ignore */ } }
      return toRender(await renderRow(sql, ctx, renderId));
    },
    async getRenderManifest(ctx, renderId) {
      cap(ctx, 'read'); const row = await renderRow(sql, ctx, renderId);
      if (row.manifest === null) throw new DomainError('invalid_state', `The render is ${String(row.state)}; no manifest exists`);
      return { ...(row.manifest as Doc), manifestDigest: row.manifest_digest as string, status: { stale: row.stale as boolean, blocked: row.blocked as boolean, reasons: row.reasons as Json } };
    },
    async getRenderOutput(ctx, renderId, name) {
      cap(ctx, 'read'); const r = toRender(await renderRow(sql, ctx, renderId));
      if (r.blocked) throw new DomainError('consent_denied', 'This render is blocked; its bytes are retained but not served');
      if (name === 'manifest.json' && r.state === 'done') { const bytes = await objects().get(scopeKey(ctx, 'renders', r.id, 'manifest.json')); return { bytes, mediaType: 'application/json', filename: 'manifest.json', sha256: sha256(bytes) }; }
      const o = r.outputs.find((x) => x.name === name); if (o === undefined) throw new DomainError('not_found', 'Not found');
      const bytes = await objects().get(scopeKey(ctx, 'renders', r.id, o.name));
      invariant(sha256(bytes) === o.sha256, 'integrity_failed', 'Stored output does not match its recorded digest');
      return { bytes, mediaType: o.mediaType, filename: o.name, sha256: o.sha256 };
    },
    async runQc(ctx, renderId) {
      cap(ctx, 'render'); const row = await renderRow(sql, ctx, renderId); const r = toRender(row);
      invariant(r.state === 'done', 'invalid_state', 'Only completed renders can be checked');
      const checks: Json[] = []; const store = objects();
      await withWorkdir(config.workRoot, async (dir) => {
        for (const o of r.outputs) {
          const bytes = await store.get(scopeKey(ctx, 'renders', r.id, o.name));
          checks.push({ check: `digest:${o.name}`, ok: sha256(bytes) === o.sha256, detail: o.sha256 });
          const path = join(dir, o.name); await writeFile(path, bytes);
          const info = await probeFile(path, o.mediaType);
          checks.push({ check: `reprobe:${o.name}`, ok: info.probe !== 'failed', detail: J(info).slice(0, 300) });
          if (o.mediaType === 'application/zip' || o.mediaType === 'application/epub+zip' || o.name.endsWith('.docx')) { const z = await run('unzip', ['-tqq', path], { allowFail: true }); checks.push({ check: `archive:${o.name}`, ok: z.code === 0, detail: z.code === 0 ? 'archive intact' : z.stderr.slice(0, 200) }); }
        }
      });
      const base = qcStatic(row.manifest as Doc, r.outputs); const all = [...base.checks, ...checks]; const ok = all.every((c) => (c as Doc).ok !== false);
      await sql.tx(async (tx) => {
        await tx.query(`update ${s}.renders set qc=$2::jsonb where id=$1`, [r.id, J({ ok, checks: all, at: ctx.now })]);
        await kit.appendAudit(tx, s, ctx, 'production.qc_run', r.ref, { ok });
        if (!ok) await kit.emitEvent(tx, s, ctx, 'production.qc_failed', r.ref, { failed: all.filter((c) => (c as Doc).ok === false).map((c) => (c as Doc).check as string) });
      });
      return { ok, checks: all };
    },

    // ── exports ──
    async createExport(ctx, input) {
      cap(ctx, 'export');
      const format = input.format ?? 'bundle'; invariant(format === 'bundle', 'invalid_input', 'format must be "bundle" (zip of outputs, manifest, credits and provenance sidecars)');
      if (ports.authorization !== undefined) { const a = await ports.authorization.authorize(ctx, { capability: 'production:export', resource: renderRef(uuid(input.renderId)) }); if (!a.allowed) throw new DomainError('forbidden', 'Not authorized to export'); }
      const row = await renderRow(sql, ctx, input.renderId); const r = toRender(row);
      invariant(r.state === 'done', 'invalid_state', 'Only completed renders can be exported');
      if (r.blocked) throw new DomainError('consent_denied', `This render is blocked: ${r.reasons.map((x) => x.reason).join('; ')}`);
      if (r.stale) throw new DomainError('stale', `This render is stale and must be re-rendered before export: ${r.reasons.map((x) => x.reason).join('; ')}`);
      invariant(r.profile === 'final', 'invalid_state', 'Preview renders cannot be exported');
      const gated = await gateInputs(sql, ctx, (r.inputs as Doc[]).map((i) => ({ assetId: i.assetId as string, version: i.version as number })));
      if (config.requireApprovedAssetsForExport !== false) { const pending = gated.filter((a) => a.approval !== 'approved'); invariant(pending.length === 0, 'approval_invalid', `Assets must be approved before export: ${pending.map((a) => a.name).join(', ')}`); }
      const g = await gate(ctx, 'reproduce', gated, r.sources.filter((x) => !x.startsWith('E10:') && !gated.some((a) => a.sources.includes(x) || (a.rights.kind === 'permission' && a.rights.ref === x))), true, { ...(input.audience === undefined ? {} : { audience: input.audience }), ...(input.destination === undefined ? {} : { destination: input.destination }) });
      if (g.denied.length > 0) throw new DomainError('consent_denied', g.denied.join(' | '));
      await requireTools(['zip']);
      const man = row.manifest as Doc; const store = objects(); const id = randomUUID();
      const base = safeName(`${str((man.project as Doc).title, 'production')}-v${r.seq}`).replace(/\.+$/, '');
      const exportManifest: Doc = { schema: 'production.export/v1', export: { ref: exportRef(id), format, createdAt: ctx.now, createdBy: ctx.actor.id, ...(input.audience === undefined ? {} : { audience: input.audience }), ...(input.destination === undefined ? {} : { destination: input.destination }) }, render: man.render as Json, renderManifestDigest: r.manifestDigest, project: man.project as Json, inputs: man.inputs as Json, sources: man.sources as Json, tools: man.tools as Json, disclosures: man.disclosures as Json, credits: man.credits as Json, decisions: g.decisions as unknown as Json, outputs: man.outputs as Json };
      const bytes = await withWorkdir(config.workRoot, async (dir) => {
        const names: string[] = [];
        for (const o of r.outputs) { const b = await store.get(scopeKey(ctx, 'renders', r.id, o.name)); invariant(sha256(b) === o.sha256, 'integrity_failed', 'Stored output does not match its recorded digest'); await writeFile(join(dir, o.name), b); names.push(o.name); }
        await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...man, manifestDigest: r.manifestDigest }, null, 2));
        await writeFile(join(dir, 'export.json'), JSON.stringify(exportManifest, null, 2));
        await writeFile(join(dir, 'CREDITS.txt'), [`${str((man.project as Doc).title)}`, '', 'Credits', ...arr(man.credits).map((c) => `- ${String(c)}`), '', 'Disclosures', ...(arr(man.disclosures) as Doc[]).map((d) => `- [${str(d.basis)}] ${str(d.text)}`), '', 'Sources', ...arr(man.sources).map((x) => `- ${String(x)}`), ''].join('\n'));
        for (const o of r.outputs.filter((x) => x.role === 'primary')) { const side = `${o.name}.provenance.json`; await writeFile(join(dir, side), JSON.stringify({ file: o.name, sha256: o.sha256, mediaType: o.mediaType, render: man.render, project: man.project, inputs: man.inputs, sources: man.sources, tools: man.tools, disclosures: man.disclosures, manifestDigest: r.manifestDigest }, null, 2)); names.push(side); }
        await run('zip', ['-q', '-X', '-r', 'bundle.zip', 'manifest.json', 'export.json', 'CREDITS.txt', ...names], { cwd: dir, timeoutMs: 300_000 });
        return readFile(join(dir, 'bundle.zip'));
      });
      const key = scopeKey(ctx, 'exports', id, `${base}.zip`); await store.put(key, bytes);
      return sql.tx((tx) => kit.idempotent(tx, s, ctx, input.idempotencyKey, { op: 'createExport', ...input }, async () => {
        const out = (await tx.query(`insert into ${s}.exports (id, tenant_id, project_id, render_id, format, object_key, sha256, size, filename, media_type, manifest, decisions, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'application/zip',$10::jsonb,$11::jsonb,$12,$13) returning *`,
          [id, ctx.tenantId, ctx.projectId, r.id, format, key, sha256(bytes), bytes.byteLength, `${base}.zip`, J(exportManifest), J(g.decisions), ctx.actor.id, ctx.now]))[0] as kit.Row;
        await kit.appendAudit(tx, s, ctx, 'production.export_created', exportRef(id), { render: r.ref, sha256: sha256(bytes) });
        await kit.emitEvent(tx, s, ctx, 'production.export_created', exportRef(id), { renderId: r.id, productionId: r.productionId, sha256: sha256(bytes) });
        return toExport(out) as unknown as Json;
      })) as unknown as Promise<Export>;
    },
    async getExport(ctx, exportId) { cap(ctx, 'read'); return toExport(await exportRow(sql, ctx, exportId)); },
    async listExports(ctx, options = {}) {
      cap(ctx, 'read');
      const rows = await sql.query(`select e.* from ${s}.exports e join ${s}.renders r on r.id=e.render_id join ${s}.projects p on p.id=r.production_id where e.tenant_id=$1 and e.project_id=$2 and ($3::uuid is null or e.render_id=$3) and (p.compartment is null or p.compartment = any($4)) order by e.created_at desc limit 500`, [ctx.tenantId, ctx.projectId, options.renderId === undefined ? null : uuid(options.renderId), [...ctx.compartments]]);
      return rows.map(toExport);
    },
    async getExportBytes(ctx, exportId) {
      cap(ctx, 'export'); const row = await exportRow(sql, ctx, exportId);
      if (row.blocked === true) throw new DomainError('consent_denied', 'This export is blocked; its bytes are retained but not served');
      const bytes = await objects().get(row.object_key as string);
      invariant(sha256(bytes) === row.sha256, 'integrity_failed', 'Stored export does not match its recorded digest');
      return { bytes, mediaType: 'application/zip', filename: row.filename as string, sha256: row.sha256 as string };
    },
    async previewInteractive(ctx, productionId, revision) {
      cap(ctx, 'read'); const project = await projectRow(sql, ctx, productionId);
      invariant(project.kind === 'interactive', 'invalid_input', 'Only interactive projects have a live preview');
      const rev = await revisionRow(sql, ctx, project.id as string, revision ?? project.head_revision as number);
      const { buildInteractivePreview } = await import('./interactive.ts');
      const store = objects();
      return buildInteractivePreview(rev.doc as Doc, async (assetId, version) => {
        const a = await loadAsset(sql, ctx, assetId); if (a.blocked) return null;
        const v = a.versions.find((x) => x.version === (version ?? a.headVersion)); if (v === undefined) return null;
        const key = (await sql.query<{ object_key: string }>(`select object_key from ${s}.asset_versions where asset_id=$1 and version=$2`, [a.id, v.version]))[0]?.object_key as string;
        return { bytes: await store.get(key), mediaType: v.mediaType, filename: v.filename, credit: `${a.name} — ${v.rights.kind === 'permission' ? (v.rights.attribution ?? 'used with permission') : v.rights.attribution}` };
      });
    },
    async providers(ctx) { cap(ctx, 'read'); return providerStatus(config.providers) as unknown as Json; },
    async runJobs(options = {}) { return kit.runJobsOnce(sql, s, { 'production.render': renderJob }, { worker: options.worker ?? `e10-${process.pid}`, limit: options.limit ?? 1, leaseMs: 60_000 }); },

    // ── standard surface ──
    async inspect(ctx, ref) {
      cap(ctx, 'read');
      let parsed; try { parsed = kit.parseUref(ref); } catch { return null; }
      if (parsed.engine !== 'E10' || !UUID.test(parsed.id)) return null;
      try {
        const history = async (subjectPrefix: string): Promise<Inspection['history']> => (await sql.query(`select at, actor_id, action, detail from ${s}._audit where tenant_id=$1 and project_id=$2 and (subject=$3 or subject like $4) order by seq limit 200`, [ctx.tenantId, ctx.projectId, subjectPrefix, `${likeEscape(subjectPrefix)}@%`])).map((h) => ({ at: iso(h.at), actorId: h.actor_id as string, action: h.action as string, detail: h.detail as Json }));
        if (parsed.kind === 'project') {
          const p = toProject(await projectRow(sql, ctx, parsed.id)); const revs = await engine.listRevisions(ctx, p.id); const renders = await engine.listRenders(ctx, { productionId: p.id });
          const head = revs[revs.length - 1] as RevisionInfo;
          return { ref: p.ref, kind: 'project', title: p.title, state: p.blocked ? 'blocked' : p.stale ? 'stale' : 'active', stale: p.stale, blocked: p.blocked, staleReasons: p.reasons.map((r) => r.reason), versions: revs.map((r) => ({ revision: r.revision, at: r.at, actorId: r.actorId, summary: r.summary })),
            sources: [...new Set([...(p.editorialRef === null ? [] : [p.editorialRef]), ...p.sources, ...head.sources, ...head.assetIds.map((a) => assetRef(a))])], dependents: renders.map((r) => r.ref), permissions: [], decisions: [], history: await history(p.ref), data: { kind: p.kind, headRevision: p.headRevision, editorialRef: p.editorialRef, reasons: p.reasons } as unknown as Json };
        }
        if (parsed.kind === 'asset') {
          const a = await loadAsset(sql, ctx, parsed.id); const head = a.versions[a.versions.length - 1] as AssetVersion;
          const users = await sql.query<{ id: string }>(`select distinct production_id as id from ${s}.project_revisions where tenant_id=$1 and project_id=$2 and $3 = any(asset_ids)`, [ctx.tenantId, ctx.projectId, a.id]);
          const renders = await sql.query<{ id: string }>(`select id from ${s}.renders where tenant_id=$1 and project_id=$2 and inputs @> $3::jsonb`, [ctx.tenantId, ctx.projectId, J([{ assetId: a.id }])]);
          return { ref: a.ref, kind: 'asset', title: a.name, state: a.blocked ? 'blocked' : a.stale ? 'stale' : a.approval, stale: a.stale, blocked: a.blocked, staleReasons: a.reasons.map((r) => r.reason), versions: a.versions.map((v) => ({ revision: v.version, at: v.at, actorId: v.actorId, summary: `${v.mediaType} ${v.sha256.slice(0, 12)}` })),
            sources: [...new Set([...head.sources, ...(head.rights.kind === 'permission' ? [head.rights.ref] : []), ...(head.provenance.parentAssets ?? [])])], dependents: [...users.map((u) => projectRef(u.id)), ...renders.map((r) => renderRef(r.id))], permissions: [head.rights as unknown as Json], decisions: [], history: await history(a.ref), data: { class: a.class, approval: a.approval, head: head as unknown as Json, reasons: a.reasons as unknown as Json } };
        }
        if (parsed.kind === 'render') {
          const row = await renderRow(sql, ctx, parsed.id); const r = toRender(row); const ex = await engine.listExports(ctx, { renderId: r.id });
          return { ref: r.ref, kind: 'render', title: `${str(((row.manifest as Doc | null)?.project as Doc | undefined)?.title, 'Render')} #${r.seq} (${r.profile})`, state: r.blocked ? 'blocked' : r.stale ? 'stale' : r.state, stale: r.stale, blocked: r.blocked, staleReasons: [...r.reasons.map((x) => x.reason), ...(r.state === 'blocked' && r.error !== null ? [r.error] : [])], versions: [{ revision: r.seq, at: r.completedAt ?? r.createdAt, actorId: r.requestedBy, summary: `project revision ${r.revision}` }],
            sources: [...new Set([projectRef(r.productionId, r.revision), ...r.sources, ...(r.inputs as Doc[]).map((i) => i.ref as string)])], dependents: ex.map((e) => e.ref), permissions: (r.inputs as Doc[]).map((i) => i.rights as Json), decisions: r.decisions as unknown as Json[], history: await history(r.ref), data: { state: r.state, progress: r.progress, stage: r.stage, outputs: r.outputs as unknown as Json, manifestDigest: r.manifestDigest, qc: r.qc, error: r.error } };
        }
        if (parsed.kind === 'export') {
          const e = toExport(await exportRow(sql, ctx, parsed.id));
          return { ref: e.ref, kind: 'export', title: e.filename, state: e.blocked ? 'blocked' : e.stale ? 'stale' : 'created', stale: e.stale, blocked: e.blocked, staleReasons: e.reasons.map((x) => x.reason), versions: [{ revision: 1, at: e.createdAt, actorId: e.createdBy }], sources: [renderRef(e.renderId)], dependents: [], permissions: [], decisions: e.decisions as unknown as Json[], history: await history(e.ref), data: { sha256: e.sha256, size: e.size, format: e.format } };
        }
      } catch (error) { if (error instanceof DomainError && error.code === 'not_found') return null; throw error; }
      return null;
    },
    async search(ctx, query) {
      cap(ctx, 'read');
      const q = str(query?.q).trim(); if (q === '') return [];
      const limit = Math.min(Math.max(query.limit ?? 20, 1), 100); const like = `%${likeEscape(q)}%`;
      const hits: SearchHit[] = [];
      for (const r of await sql.query(`select id, kind, title, search_text, stale, blocked from ${s}.projects where tenant_id=$1 and project_id=$2 and (compartment is null or compartment = any($4)) and (title ilike $3 or search_text ilike $3) order by updated_at desc limit ${limit}`, [ctx.tenantId, ctx.projectId, like, [...ctx.compartments]])) {
        const text = r.search_text as string; const at = text.toLowerCase().indexOf(q.toLowerCase());
        hits.push({ ref: projectRef(r.id as string), kind: 'project', title: r.title as string, snippet: at < 0 ? `${String(r.kind)} project` : text.slice(Math.max(0, at - 60), at + q.length + 60).replace(/\s+/g, ' '), state: r.blocked === true ? 'blocked' : r.stale === true ? 'stale' : 'active' });
      }
      for (const r of await sql.query(`select id, name, class, approval, blocked from ${s}.assets where tenant_id=$1 and project_id=$2 and (compartment is null or compartment = any($4)) and name ilike $3 order by created_at desc limit ${limit}`, [ctx.tenantId, ctx.projectId, like, [...ctx.compartments]]))
        hits.push({ ref: assetRef(r.id as string), kind: 'asset', title: r.name as string, snippet: `${String(r.class)} asset`, state: r.blocked === true ? 'blocked' : r.approval as string });
      return hits.slice(0, limit);
    },
    async audit(ctx, options = {}) { cap(ctx, 'audit'); return kit.listAudit(sql, s, ctx, options) as Promise<AuditRecord[]>; },
    async events(ctx, options = {}) { cap(ctx, 'events'); return (await kit.readEvents(sql, s, { ...options, tenantId: ctx.tenantId })).map((e): EngineEvent => ({ ...e, engine: 'E10' })); },
    async applyUpstreamChange(ctx, change) {
      cap(ctx, 'events');
      invariant(isObj(change) && typeof change.eventId === 'string' && change.eventId !== '' && change.eventId.length <= 200 && Array.isArray(change.refs) && change.refs.every(isUref) && manifest.consumes.includes(change.kind), 'invalid_input', 'Invalid upstream change');
      const blocking = BLOCKING.includes(change.kind); const flag = blocking ? 'blocked' : 'stale';
      const reason: Reason = { kind: change.kind, reason: str(change.reason, change.kind, 500) || change.kind, cause: change.eventId, refs: [...change.refs].slice(0, 50), at: ctx.now };
      return sql.tx(async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`e10-upstream:${ctx.tenantId}:${ctx.projectId}`]);
        const prior = (await tx.query<{ affected: string[] }>(`select affected from ${s}.upstream_changes where tenant_id=$1 and project_id=$2 and event_id=$3`, [ctx.tenantId, ctx.projectId, change.eventId]))[0];
        if (prior !== undefined) return { affected: prior.affected };
        const affected: string[] = []; const scope = [ctx.tenantId, ctx.projectId];
        const mark = async (table: string, id: string, ref: string, type: string, payload: Doc): Promise<void> => {
          await tx.query(`update ${s}.${table} set ${flag}=true, reasons=reasons || $2::jsonb where id=$1`, [id, J([reason])]);
          await kit.appendAudit(tx, s, ctx, `production.${type}_${flag}`, ref, { reason: reason.reason, cause: change.eventId, changeKind: change.kind });
          await kit.emitEvent(tx, s, ctx, `production.${type}_${flag}`, ref, { reason: reason.reason, cause: change.eventId, changeKind: change.kind, ...payload });
          affected.push(ref);
        };
        // Assets: the asset itself, its permission reference, its sources and provenance.
        const hitAssets = new Set<string>();
        for (const a of await tx.query(`select a.id, a.head_version, v.rights, v.sources, v.provenance, v.version from ${s}.assets a join ${s}.asset_versions v on v.asset_id=a.id where a.tenant_id=$1 and a.project_id=$2 order by a.id, v.version`, scope)) {
          if (hitAssets.has(a.id as string)) continue;
          const rights = a.rights as Rights; const prov = a.provenance as Provenance;
          const candidates = [assetRef(a.id as string, a.version as number), ...(rights.kind === 'permission' ? [rights.ref] : []), ...(a.sources as string[]), ...prov.sourceRefs];
          if (candidates.some((c) => affects(change, c))) hitAssets.add(a.id as string);
        }
        for (const id of hitAssets) await mark('assets', id, assetRef(id), 'asset', {});
        // Projects: editorial revision, declared sources, sources cited in the current document, or use of an affected asset.
        const hitProjects = new Set<string>();
        for (const p of await tx.query(`select p.id, p.editorial_ref, p.sources, r.sources as rev_sources, r.asset_ids, r.revision from ${s}.projects p join ${s}.project_revisions r on r.production_id=p.id and r.revision=p.head_revision where p.tenant_id=$1 and p.project_id=$2`, scope)) {
          const candidates = [...(p.editorial_ref === null ? [] : [p.editorial_ref as string]), ...(p.sources as string[]), ...(p.rev_sources as string[])];
          if (candidates.some((c) => affects(change, c)) || (p.asset_ids as string[]).some((a) => hitAssets.has(a))) { hitProjects.add(p.id as string); await mark('projects', p.id as string, projectRef(p.id as string, p.revision as number), 'project', {}); }
        }
        // Renders and their exports: bytes and prior versions are retained; nothing is deleted or rewritten.
        for (const r of await tx.query(`select id, production_id, revision, sources, inputs, state from ${s}.renders where tenant_id=$1 and project_id=$2 and state in ('done','queued','running')`, scope)) {
          const inputs = r.inputs as Doc[];
          if (!(r.sources as string[]).some((c) => affects(change, c)) && !inputs.some((i) => hitAssets.has(i.assetId as string)) && !(r.state !== 'done' && hitProjects.has(r.production_id as string))) continue;
          await mark('renders', r.id as string, renderRef(r.id as string), 'render', { productionId: r.production_id as string, revision: r.revision as number });
          for (const e of await tx.query(`select id from ${s}.exports where render_id=$1`, [r.id])) await mark('exports', e.id as string, exportRef(e.id as string), 'export', { renderId: r.id as string });
        }
        await tx.query(`insert into ${s}.upstream_changes (tenant_id, project_id, event_id, kind, refs, affected, at) values ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [ctx.tenantId, ctx.projectId, change.eventId, change.kind, [...change.refs], J(affected), ctx.now]);
        return { affected };
      });
    },
    async health() {
      const detail: Doc = { objects: deps.objects !== undefined, useDecisions: ports.useDecisions !== undefined ? 'port' : config.standalone?.useDecisions ?? 'deny', tools: {} };
      let ok = true;
      try { await sql.query('select 1'); detail.database = true; } catch { detail.database = false; ok = false; }
      for (const t of ['ffmpeg', 'ffprobe', 'rsvg-convert', 'convert', 'pandoc', 'soffice', 'fluidsynth', 'espeak-ng', 'sox', 'exiftool', 'zip']) (detail.tools as Doc)[t] = await toolVersion(t);
      return { ok, detail };
    },
  };
  return engine;
}

// ───────────────────────────── HTTP ─────────────────────────────
export function routes(engine: ProductionEngine): Route[] {
  const body = (r: kit.HttpRequest): Doc => { invariant(isObj(r.body), 'invalid_input', 'JSON body required'); return r.body; };
  const int = (v: string | null | undefined): number | undefined => { if (v === null || v === undefined || v === '') return undefined; const x = Number(v); invariant(Number.isInteger(x) && x >= 0, 'invalid_input', 'Invalid number'); return x; };
  const file = (f: FileResult, inline = false): kit.HttpResponse => ({ bytes: f.bytes, headers: { 'content-type': f.mediaType, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${f.filename}"`, 'x-content-sha256': f.sha256 } });
  const assetInput = (b: Doc): AssetImport => {
    invariant(typeof b.bytesBase64 === 'string' && /^[A-Za-z0-9+/=\s]*$/.test(b.bytesBase64), 'invalid_input', 'bytesBase64 is required');
    return { name: str(b.name), filename: str(b.filename), bytes: new Uint8Array(Buffer.from(b.bytesBase64, 'base64')), rights: b.rights as unknown as Rights, ...(isObj(b.provenance) ? { provenance: b.provenance as unknown as Partial<Provenance> } : {}), ...(Array.isArray(b.sources) ? { sources: b.sources as string[] } : {}), ...(typeof b.compartment === 'string' ? { compartment: b.compartment } : {}), ...(typeof b.idempotencyKey === 'string' ? { idempotencyKey: b.idempotencyKey } : {}) };
  };
  const E = engine; type H = Route['handler'];
  const defs: [Route['method'], string, H][] = [
    ['POST', '/v1/production/projects', async (r) => ({ status: 201, json: await E.createProject(r.ctx, body(r) as never) })],
    ['POST', '/v1/production/projects/from-editorial', async (r) => ({ status: 201, json: await E.createProjectFromEditorial(r.ctx, body(r) as never) })],
    ['GET', '/v1/production/projects', async (r) => (await E.listProjects(r.ctx, { ...(r.query.get('kind') === null ? {} : { kind: r.query.get('kind') as ProjectKind }) })) as unknown as Json],
    ['GET', '/v1/production/projects/:id', async (r) => (await E.getProject(r.ctx, r.params.id as string)) as unknown as Json],
    ['PATCH', '/v1/production/projects/:id/links', async (r) => (await E.updateProjectLinks(r.ctx, { ...body(r), productionId: r.params.id } as never)) as unknown as Json],
    ['GET', '/v1/production/projects/:id/revisions', async (r) => (await E.listRevisions(r.ctx, r.params.id as string)) as unknown as Json],
    ['POST', '/v1/production/projects/:id/revisions', async (r) => ({ status: 201, json: await E.saveRevision(r.ctx, { ...body(r), productionId: r.params.id } as never) })],
    ['POST', '/v1/production/projects/:id/operations', async (r) => ({ status: 201, json: await E.applyOperations(r.ctx, { ...body(r), productionId: r.params.id } as never) })],
    ['GET', '/v1/production/projects/:id/revisions/:rev', async (r) => (await E.getRevision(r.ctx, r.params.id as string, r.params.rev === 'head' ? undefined : int(r.params.rev))) as unknown as Json],
    ['GET', '/v1/production/projects/:id/diff', async (r) => (await E.diffRevisions(r.ctx, r.params.id as string, int(r.query.get('from')) ?? 1, int(r.query.get('to')) ?? 1)) as unknown as Json],
    ['POST', '/v1/production/projects/:id/restore', async (r) => ({ status: 201, json: await E.restoreRevision(r.ctx, { ...body(r), productionId: r.params.id } as never) })],
    ['GET', '/v1/production/projects/:id/validate', async (r) => (await E.validateProject(r.ctx, r.params.id as string, int(r.query.get('revision')))) as unknown as Json],
    ['GET', '/v1/production/projects/:id/preview', async (r) => ({ bytes: Buffer.from(await E.previewInteractive(r.ctx, r.params.id as string, int(r.query.get('revision')))), headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" } })],
    ['POST', '/v1/production/:id/qc', async (r) => (await E.runQc(r.ctx, r.params.id as string)) as unknown as Json],
    ['POST', '/v1/assets', async (r) => ({ status: 201, json: await E.importAsset(r.ctx, assetInput(body(r))) })],
    ['GET', '/v1/assets', async (r) => (await E.listAssets(r.ctx, { ...(r.query.get('class') === null ? {} : { class: r.query.get('class') as string }) })) as unknown as Json],
    ['POST', '/v1/assets/generate', async (r) => ({ status: 201, json: await E.generateAsset(r.ctx, body(r) as never) })],
    ['GET', '/v1/assets/:id', async (r) => (await E.getAsset(r.ctx, r.params.id as string)) as unknown as Json],
    ['POST', '/v1/assets/:id/versions', async (r) => ({ status: 201, json: await E.addAssetVersion(r.ctx, { ...assetInput(body(r)), assetId: r.params.id as string }) })],
    ['GET', '/v1/assets/:id/bytes', async (r) => file(await E.getAssetBytes(r.ctx, r.params.id as string, int(r.query.get('version'))))],
    ['POST', '/v1/assets/:id/rights', async (r) => (await E.setAssetRights(r.ctx, { ...body(r), assetId: r.params.id } as never)) as unknown as Json],
    ['POST', '/v1/assets/:id/approval', async (r) => (await E.setAssetApproval(r.ctx, { ...body(r), assetId: r.params.id } as never)) as unknown as Json],
    ['POST', '/v1/renders', async (r) => ({ status: 202, json: await E.requestRender(r.ctx, body(r) as never) })],
    ['GET', '/v1/renders', async (r) => (await E.listRenders(r.ctx, { ...(r.query.get('productionId') === null ? {} : { productionId: r.query.get('productionId') as string }) })) as unknown as Json],
    ['GET', '/v1/renders/:id', async (r) => (await E.getRender(r.ctx, r.params.id as string)) as unknown as Json],
    ['POST', '/v1/renders/:id/cancel', async (r) => (await E.cancelRender(r.ctx, r.params.id as string)) as unknown as Json],
    ['GET', '/v1/renders/:id/manifest', async (r) => E.getRenderManifest(r.ctx, r.params.id as string)],
    ['GET', '/v1/renders/:id/outputs/:name', async (r) => file(await E.getRenderOutput(r.ctx, r.params.id as string, r.params.name as string))],
    ['POST', '/v1/renders/:id/qc', async (r) => (await E.runQc(r.ctx, r.params.id as string)) as unknown as Json],
    ['POST', '/v1/renders/:id/to-asset', async (r) => ({ status: 201, json: await E.importRenderOutput(r.ctx, { ...body(r), renderId: r.params.id } as never) })],
    ['POST', '/v1/exports', async (r) => ({ status: 201, json: await E.createExport(r.ctx, body(r) as never) })],
    ['GET', '/v1/exports', async (r) => (await E.listExports(r.ctx, { ...(r.query.get('renderId') === null ? {} : { renderId: r.query.get('renderId') as string }) })) as unknown as Json],
    ['GET', '/v1/exports/:id', async (r) => (await E.getExport(r.ctx, r.params.id as string)) as unknown as Json],
    ['GET', '/v1/exports/:id/bytes', async (r) => file(await E.getExportBytes(r.ctx, r.params.id as string))],
    ['GET', '/v1/production/providers', async (r) => E.providers(r.ctx)],
  ];
  // The kit masks 5xx DomainErrors and unmapped codes as a bare 500; answer with the precise status and code instead.
  const wrap = (handler: H): H => async (request) => {
    try { return await handler(request); }
    catch (error) {
      if (error instanceof DomainError) { const status = HTTP_STATUS[error.code]; if (status !== undefined) return { status, json: { error: { code: error.code, message: error.message } } }; }
      throw error;
    }
  };
  return [...kit.standardRoutes(engine), ...defs.map(([method, path, handler]): Route => ({ method, path, handler: wrap(handler) }))];
}
export type { Doc, ProjectKind, Rights, Provenance, RenderProfile, DiffEntry, Disclosure, Pipeline } from './types.ts';
export { PIPELINES } from './pipelines.ts';
