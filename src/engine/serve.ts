// Standalone server for the media production engine: migrations, HTTP API and the render worker loop.
// Env: DATABASE_URL, PORT (default 8110), HOST (default 127.0.0.1), IDENTITY_PUBLIC_KEYS (JSON map kid→PEM) or
// IDENTITY_JWKS_FILE (JSON file with the same map), IDENTITY_ISSUER (optional), OBJECT_STORE / OBJECT_STORE_PATH / S3_*,
// PRODUCTION_WORK_ROOT (render workspaces; default OS temp), PRODUCTION_WORKER (default on; "off" serves the API only),
// PRODUCTION_STANDALONE=declared-rights (accept declared asset rights when no consent engine is configured),
// CONSENT_URL + CONSENT_TOKEN_FILE (HTTP UseDecisionPort to E11 `POST /v1/use-decisions`),
// PRODUCTION_{IMAGE,TTS,MUSIC,SINGING}_PROVIDER_URL + _KEY_FILE (+ _MODEL): optional generation providers,
// E10_SOUNDFONT (General MIDI SoundFont path).
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { DomainError } from '../contracts.ts';
import { createHttpHandler, createTokenVerifier, objectStoreFromEnv, pgSql, serve } from '../service-kit.ts';
import type { UseDecision, UseDecisionPort } from '../service-kit.ts';
import { createEngine, manifest, migrate, routes } from './index.ts';
import type { ProviderEndpoint } from './providers.ts';

/** UseDecisionPort over HTTP. The token is a service credential for one tenant/project scope; under PAM the host supplies the port directly. */
export function httpUseDecisionPort(options: { baseUrl: string; token: string; timeoutMs?: number }): UseDecisionPort {
  return { async decide(_ctx, request) {
    let response: Response;
    try { response = await fetch(new URL('/v1/use-decisions', options.baseUrl), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 15_000), headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) }); }
    catch { throw new DomainError('unavailable', 'The consent engine could not be reached'); }
    if (!response.ok) throw new DomainError('unavailable', `The consent engine answered ${response.status}`);
    const d = await response.json() as UseDecision;
    if (!['allow', 'deny', 'review'].includes(d.decision)) throw new DomainError('unavailable', 'The consent engine returned an invalid decision');
    return { decision: d.decision, reasons: d.reasons ?? [], permissionRefs: d.permissionRefs ?? [], restrictions: d.restrictions ?? [], decidedAt: d.decidedAt ?? new Date().toISOString() };
  } };
}

async function main(): Promise<void> {
  const env = process.env;
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const keysJson = env.IDENTITY_PUBLIC_KEYS ?? (env.IDENTITY_JWKS_FILE ? await readFile(env.IDENTITY_JWKS_FILE, 'utf8') : undefined);
  if (keysJson === undefined) throw new Error('IDENTITY_PUBLIC_KEYS or IDENTITY_JWKS_FILE is required: the server never runs without token verification');
  const publicKeys = JSON.parse(keysJson) as Record<string, string>;
  const secret = async (file: string | undefined): Promise<string | undefined> => (file ? (await readFile(file, 'utf8')).trim() : undefined);
  const provider = async (name: string): Promise<ProviderEndpoint | undefined> => { const baseUrl = env[`PRODUCTION_${name}_PROVIDER_URL`]; const apiKey = await secret(env[`PRODUCTION_${name}_PROVIDER_KEY_FILE`]); const model = env[`PRODUCTION_${name}_PROVIDER_MODEL`]; return baseUrl && apiKey ? { baseUrl, apiKey, ...(model ? { model } : {}) } : undefined; };
  const [image, tts, music, singing] = await Promise.all(['IMAGE', 'TTS', 'MUSIC', 'SINGING'].map(provider));
  const consentToken = await secret(env.CONSENT_TOKEN_FILE);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
  const sql = pgSql(pool);
  await migrate(sql);
  const engine = createEngine({
    sql, objects: objectStoreFromEnv(env, './data/objects'),
    ports: { ...(env.CONSENT_URL && consentToken ? { useDecisions: httpUseDecisionPort({ baseUrl: env.CONSENT_URL, token: consentToken }) } : {}) },
    config: { ...(env.PRODUCTION_WORK_ROOT ? { workRoot: env.PRODUCTION_WORK_ROOT } : {}), ...(env.PRODUCTION_STANDALONE === 'declared-rights' ? { standalone: { useDecisions: 'declared-rights' as const } } : {}),
      providers: { ...(image ? { image } : {}), ...(tts ? { tts } : {}), ...(music ? { music } : {}), ...(singing ? { singing } : {}) } },
  });
  const handler = createHttpHandler({
    name: manifest.name, version: manifest.version, routes: routes(engine), health: () => engine.health(), maxBodyBytes: 512 * 1024 * 1024,
    verify: createTokenVerifier({ publicKeys, ...(env.IDENTITY_ISSUER ? { issuer: env.IDENTITY_ISSUER } : {}) }),
    onError: (error, info) => console.error(JSON.stringify({ level: 'error', requestId: info.requestId, method: info.method, path: info.path, error: error instanceof Error ? error.name : 'error' })),
  });
  const server = await serve(handler, Number(env.PORT ?? 8110), env.HOST ?? '127.0.0.1');
  console.log(JSON.stringify({ level: 'info', message: 'media production engine listening', address: server.address() }));
  let running = env.PRODUCTION_WORKER !== 'off';
  const worker = (async (): Promise<void> => {
    while (running) {
      try { if (await engine.runJobs({ worker: `e10-${process.pid}` }) === 0) await new Promise((r) => setTimeout(r, 1000)); }
      catch (error) { console.error(JSON.stringify({ level: 'error', message: 'render worker pass failed', error: error instanceof Error ? error.name : 'error' })); await new Promise((r) => setTimeout(r, 5000)); }
    }
  })();
  const stop = (): void => { running = false; server.close(); void worker.then(() => pool.end()).then(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : 'startup failed'); process.exit(1); });
