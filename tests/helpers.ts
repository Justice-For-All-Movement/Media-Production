// Shared test support: real PostgreSQL (disposable database), real object store on disk, fictional pilot content.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import * as kit from '../src/service-kit.ts';
import { createEngine, migrate } from '../src/engine/index.ts';
import type { EngineConfig, ProductionEngine, Render } from '../src/engine/index.ts';

export const ADMIN = process.env.TEST_DATABASE_URL ?? '';
export const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};
export const CAPS = ['production:read', 'production:write', 'production:render', 'production:approve', 'production:export', 'production:spend', 'production:events', 'production:audit'];
export const ctx = (over: Partial<kit.ServiceContext> = {}): kit.ServiceContext => ({ tenantId: 'tenant-a', projectId: 'floodfund', purpose: 'production', requestId: `req-${Math.random().toString(36).slice(2)}`, now: new Date().toISOString(), actor: { id: 'editor-1', kind: 'human', roles: ['producer'] }, capabilities: CAPS, compartments: [], ...over });

/** Controlled stand-in for E11: allows unless a subject is on the deny or review list. Records every request. */
export function usePort(): kit.UseDecisionPort & { deny: Set<string>; review: Set<string>; calls: { subjects: readonly string[]; action: string }[] } {
  const deny = new Set<string>(), review = new Set<string>(); const calls: { subjects: readonly string[]; action: string }[] = [];
  return { deny, review, calls, async decide(_c, request) {
    calls.push({ subjects: request.subjects, action: request.action });
    const d = request.subjects.filter((s) => deny.has(s) || deny.has(s.split('@')[0] as string)), r = request.subjects.filter((s) => review.has(s));
    return { decision: d.length > 0 ? 'deny' : r.length > 0 ? 'review' : 'allow', reasons: d.length > 0 ? d.map((s) => `permission withdrawn for ${s}`) : r.length > 0 ? ['rights review pending'] : [], permissionRefs: request.subjects.filter((s) => s.startsWith('E11:')), restrictions: [], decidedAt: new Date().toISOString() };
  } };
}
export type Harness = { engine: ProductionEngine; sql: kit.Sql; objects: kit.FsObjectStore; root: string; port: ReturnType<typeof usePort> };
export async function withEngine(fn: (h: Harness) => Promise<void>, options: { config?: EngineConfig; ports?: Parameters<typeof createEngine>[0]['ports']; noPort?: boolean } = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'e10-test-'));
  try {
    await kit.withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
      await migrate(sql);
      const objects = new kit.FsObjectStore(join(root, 'objects')); const port = usePort();
      const engine = createEngine({ sql, objects, ports: { ...(options.noPort === true ? {} : { useDecisions: port }), ...options.ports }, config: { workRoot: root, ...options.config } });
      await fn({ engine, sql, objects, root, port });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}
/** Runs the worker until the render leaves queued/running. */
export async function finish(engine: ProductionEngine, c: kit.ServiceContext, render: Render): Promise<Render> {
  for (let i = 0; i < 50; i++) {
    const r = await engine.getRender(c, render.id);
    if (!['queued', 'running'].includes(r.state)) return r;
    await engine.runJobs({ worker: 'test-worker' });
  }
  throw new Error('render did not finish: ' + JSON.stringify(await engine.getRender(c, render.id)));
}
export async function eventsOfType(engine: ProductionEngine, c: kit.ServiceContext, type: string, min = 1): Promise<kit.EngineEvent[]> {
  // The outbox feed withholds rows while older transactions are open on the shared server; poll.
  for (let i = 0; i < 100; i++) { const ev = (await engine.events(c, { limit: 1000 })).filter((e) => e.type === type); if (ev.length >= min) return ev; await new Promise((r) => setTimeout(r, 100)); }
  return [];
}
export const LICENSE = { kind: 'license', license: 'CC0-1.0', attribution: 'Pilot fixture, invented for testing' } as const;

/** A fictional ledger page drawn with ImageMagick: stands in for a scanned evidence page. */
export function ledgerPage(dir: string): Uint8Array {
  const p = join(dir, 'ledger.png');
  // Deterministic bytes: ImageMagick otherwise embeds creation/modification times, so two calls a second apart differ
  // (which made the idempotent-replay test depend on timing).
  execFileSync('convert', ['-size', '1000x1400', 'xc:#fbf8ef', '-font', 'DejaVu-Sans', '-fill', '#222222', '-pointsize', '38', '-annotate', '+70+120', 'LARKMOOR COUNCIL LEDGER', '-pointsize', '30',
    '-annotate', '+70+300', 'Pumps and hoses           12,400', '-annotate', '+70+380', 'Shelter hall               8,150', '-annotate', '+70+460', 'Unexplained transfer   31,000', '-annotate', '+70+540', 'Account 4471-889-ZQ', '-annotate', '+70+900', 'Signed: T. Brandt, treasurer', '-strip', '-define', 'png:exclude-chunks=all', p]);
  return new Uint8Array(readFileSync(p));
}
