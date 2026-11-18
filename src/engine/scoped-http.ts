// Private bounded cross-engine HTTP transport. Decoded scope checks are not signature verification.
import { DomainError, invariant } from '../contracts.ts';
import type { ServiceContext } from '../service-kit.ts';
export type ScopedHttpOptions = Readonly<{ baseUrl: string; token?: string | (() => string); timeoutMs?: number; fetch?: typeof fetch }>;
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
function checkScope(ctx: ServiceContext, token: string | undefined, _engine: string): void {
  invariant(typeof token === 'string' && token.length <= 65536, 'unavailable', 'A scoped service credential is required');
  const payload = token.split('.')[1];
  invariant(payload !== undefined && /^[A-Za-z0-9_-]+$/.test(payload), 'unavailable', 'Invalid service credential');
  const claims: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(payload, 'base64url')));
  invariant(object(claims) && claims.tid === ctx.tenantId && claims.pid === ctx.projectId && claims.purpose === ctx.purpose
    && claims.kind === 'service' && Array.isArray(claims.cmp) && claims.cmp.length <= 256
    && claims.cmp.every((c: unknown) => typeof c === 'string' && ctx.compartments.includes(c)),
    'unavailable', 'Service credential scope or purpose differs');
}
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESPONSE_CHUNKS = 4096;

export async function scopedJson(o: ScopedHttpOptions, ctx: ServiceContext, engine: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const timeoutMs = o.timeoutMs ?? 15_000;
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 120_000,
    'invalid_config', 'HTTP port timeout must be an integer from 100 to 120000 milliseconds');
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const failed = () => new DomainError('unavailable', `The ${engine} engine request could not be completed`);
  const check = () => {
    if (controller.signal.aborted || performance.now() >= deadline) throw failed();
  };
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  // A synchronous credential or transport callback can expire before the first race is installed.
  void aborted.catch(() => {});
  const onAbort = () => rejectAbort(failed());
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const wait = async <T>(pending: Promise<T>): Promise<T> => {
    // A read is already begun when passed here; observe its eventual rejection even if admission expired.
    void pending.catch(() => {});
    check();
    const value = await Promise.race([pending, aborted]);
    check();
    return value;
  };
  const cancelBody = (response: Response) => {
    try { void response.body?.cancel().catch(() => {}); } catch { /* best-effort, never await a host cancel hook */ }
  };
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    check();
    // Rotation is observed once per request. The checked credential must also be sent below.
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    check();
    const token = typeof o.token === 'function' ? o.token() : o.token;
    check();
    checkScope(ctx, token, engine);
    const url = new URL(path, o.baseUrl);
    check();
    const transport = Promise.resolve().then(() => {
      check();
      return (o.fetch ?? fetch)(url, {
        method, redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(encoded === undefined ? {} : { body: encoded }),
      });
    });
    // An injected/noncooperative fetch may settle after this call has already timed out.
    void transport.then(late => {
      if (controller.signal.aborted || performance.now() >= deadline) cancelBody(late);
    }, () => {});
    response = await wait(transport);
    const status = response.status;
    const advertised = response.headers.get('content-length');
    if (advertised !== null && (!/^\d+$/.test(advertised) || !Number.isSafeInteger(Number(advertised)) || Number(advertised) > MAX_RESPONSE_BYTES)) throw failed();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body !== null) {
      reader = response.body.getReader();
      for (;;) {
        const part = await wait(reader.read());
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || chunks.length >= MAX_RESPONSE_CHUNKS || part.value.byteLength > MAX_RESPONSE_BYTES - bytes) throw failed();
        bytes += part.value.byteLength;
        // Buffer is a Uint8Array subclass whose slice() aliases the producer's backing storage.
        chunks.push(new Uint8Array(part.value));
        check();
      }
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    check();
    const json: unknown = text === '' ? null : JSON.parse(text);
    check();
    complete = true;
    return { status, json };
  } catch {
    // Host credential/fetch/stream/parse diagnostics may contain private data.
    throw failed();
  } finally {
    clearTimeout(timer);
    controller.abort();
    controller.signal.removeEventListener('abort', onAbort);
    if (reader !== undefined) {
      if (!complete) { try { void reader.cancel().catch(() => {}); } catch { /* best-effort */ } }
      try { reader.releaseLock(); } catch { /* a noncooperative host may still own a read */ }
    } else if (response !== undefined && !complete) cancelBody(response);
  }
}
