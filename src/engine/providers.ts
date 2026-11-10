// Replaceable, authorised provider adapters for external generation (images, speech, music, singing synthesis).
// They are implemented against common HTTP shapes but NOT verified against a live provider in this repository.
// Nothing here runs unless the deployment configures a provider; secrets never appear in errors, logs or manifests.
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { isObj, str } from './types.ts';
import type { Doc } from './types.ts';

export type ProviderEndpoint = Readonly<{ baseUrl: string; apiKey: string; model?: string; voice?: string; license?: string; name?: string }>;
export type ProviderConfig = Readonly<{ image?: ProviderEndpoint; tts?: ProviderEndpoint; music?: ProviderEndpoint; singing?: ProviderEndpoint; timeoutMs?: number; pollIntervalMs?: number; maxBytes?: number }>;
export type ProviderKind = 'image' | 'tts' | 'music' | 'singing';
export type ProviderOutput = { bytes: Uint8Array; filename: string; provider: string; model: string; license: string; params: Json };
const ADAPTERS: Readonly<Record<ProviderKind, string>> = { image: 'openai-images-compatible (POST /images/generations)', tts: 'openai-speech-compatible (POST /audio/speech)', music: 'generic-generation-job (POST /generations, GET /generations/{id})', singing: 'generic-generation-job (POST /generations, GET /generations/{id})' };

export function providerStatus(config: ProviderConfig | undefined): Record<string, { configured: boolean; adapter: string; verification: string; host?: string }> {
  const out: Record<string, { configured: boolean; adapter: string; verification: string; host?: string }> = {};
  for (const kind of Object.keys(ADAPTERS) as ProviderKind[]) {
    const e = config?.[kind]; let host: string | undefined;
    try { host = e === undefined ? undefined : new URL(e.baseUrl).host; } catch { host = undefined; }
    out[kind] = { configured: e !== undefined && host !== undefined && e.apiKey !== '', adapter: ADAPTERS[kind], verification: 'implemented, not verified against a live provider', ...(host === undefined ? {} : { host }) };
  }
  return out;
}
function endpoint(e: ProviderEndpoint, path: string): URL {
  const base = new URL(e.baseUrl); invariant(base.protocol === 'https:' || base.protocol === 'http:', 'invalid_config', 'Provider baseUrl must be http(s)');
  return new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base);
}
async function call(config: ProviderConfig, e: ProviderEndpoint, method: string, url: URL, body?: Json): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs ?? 120_000), headers: { authorization: `Bearer ${e.apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new DomainError('provider_unavailable', `Provider request to ${url.host} failed or timed out`); }
  if (response.status === 401 || response.status === 403) throw new DomainError('provider_unavailable', `Provider ${url.host} rejected the configured credentials (${response.status})`);
  if (response.status === 429) throw new DomainError('rate_limited', `Provider ${url.host} is rate limiting`);
  if (!response.ok) throw new DomainError('provider_unavailable', `Provider ${url.host} answered ${response.status}`);
  return response;
}
async function readBytes(config: ProviderConfig, response: Response): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  invariant(bytes.byteLength > 0, 'provider_unavailable', 'Provider returned an empty result');
  invariant(bytes.byteLength <= (config.maxBytes ?? 256 * 1024 * 1024), 'payload_too_large', 'Provider result is too large');
  return bytes;
}
/** A result URL is only followed on the provider's own origin, with no redirects (the response is untrusted data). */
async function download(config: ProviderConfig, e: ProviderEndpoint, link: string): Promise<Uint8Array> {
  let url: URL; try { url = new URL(link, e.baseUrl); } catch { throw new DomainError('provider_unavailable', 'Provider returned an invalid result link'); }
  invariant(url.origin === new URL(e.baseUrl).origin, 'provider_unavailable', 'Provider returned a result link on a different origin; refusing to fetch it');
  return readBytes(config, await call(config, e, 'GET', url));
}
const ext = (bytes: Uint8Array, fallback: string): string => {
  const h = Buffer.from(bytes.subarray(0, 12)).toString('latin1');
  return h.startsWith('\x89PNG') ? 'png' : h.startsWith('\xff\xd8') ? 'jpg' : h.startsWith('RIFF') && h.slice(8, 12) === 'WEBP' ? 'webp' : h.startsWith('RIFF') ? 'wav' : h.startsWith('fLaC') ? 'flac' : h.startsWith('OggS') ? 'ogg' : h.startsWith('ID3') ? 'mp3' : fallback;
};

export async function runProvider(config: ProviderConfig | undefined, kind: ProviderKind, params: Doc): Promise<ProviderOutput> {
  const e = config?.[kind];
  if (config === undefined || e === undefined || e.apiKey === '') throw new DomainError('unavailable', `No ${kind} generation provider is configured`);
  const host = new URL(e.baseUrl).host; const provider = e.name ?? host; const license = e.license ?? 'provider-terms';
  const prompt = str(params.prompt, '', 4000);
  if (kind === 'image') {
    invariant(prompt.trim() !== '', 'invalid_input', 'params.prompt is required');
    const model = e.model ?? 'default'; const size = /^\d{2,4}x\d{2,4}$/.test(str(params.size)) ? str(params.size) : '1024x1024';
    const r = await (await call(config, e, 'POST', endpoint(e, '/images/generations'), { model, prompt, size, n: 1, response_format: 'b64_json' })).json() as { data?: { b64_json?: string; url?: string }[] };
    const item = r.data?.[0]; invariant(item !== undefined, 'provider_unavailable', 'Provider returned no image');
    const bytes = typeof item.b64_json === 'string' ? new Uint8Array(Buffer.from(item.b64_json, 'base64')) : typeof item.url === 'string' ? await download(config, e, item.url) : null;
    invariant(bytes !== null && bytes.byteLength > 0, 'provider_unavailable', 'Provider returned no image');
    return { bytes, filename: `generated.${ext(bytes, 'png')}`, provider, model, license, params: { prompt, size } };
  }
  if (kind === 'tts') {
    const input = str(params.text, '', 8000); invariant(input.trim() !== '', 'invalid_input', 'params.text is required');
    const model = e.model ?? 'default'; const voice = str(params.voice, e.voice ?? 'default', 80);
    const bytes = await readBytes(config, await call(config, e, 'POST', endpoint(e, '/audio/speech'), { model, input, voice, response_format: 'wav' }));
    return { bytes, filename: `speech.${ext(bytes, 'wav')}`, provider, model, license, params: { text: input, voice } };
  }
  // music / singing: job protocol. Either the POST answers with audio directly, or with { id, status } to poll.
  const model = e.model ?? 'default';
  const request: Doc = { model, ...(prompt === '' ? {} : { prompt }), ...(typeof params.lyrics === 'string' ? { lyrics: params.lyrics.slice(0, 8000) } : {}), ...(typeof params.durationSeconds === 'number' ? { duration_seconds: params.durationSeconds } : {}), ...(typeof params.midiBase64 === 'string' ? { midi_base64: params.midiBase64 } : {}), ...(typeof params.seed === 'number' ? { seed: params.seed } : {}), ...(kind === 'singing' ? { voice: str(params.voice, e.voice ?? 'default', 80) } : {}) };
  invariant(prompt !== '' || typeof request.lyrics === 'string' || typeof request.midi_base64 === 'string', 'invalid_input', 'params need a prompt, lyrics or midiBase64');
  const first = await call(config, e, 'POST', endpoint(e, '/generations'), request);
  const done = (bytes: Uint8Array): ProviderOutput => ({ bytes, filename: `${kind}.${ext(bytes, 'wav')}`, provider, model, license, params: { ...request, midi_base64: typeof request.midi_base64 === 'string' ? '(supplied)' : null } });
  if ((first.headers.get('content-type') ?? '').startsWith('audio/')) return done(await readBytes(config, first));
  let job = await first.json() as Doc;
  for (let i = 0; i < 120; i++) {
    const status = str(job.status).toLowerCase();
    if (typeof job.audio_base64 === 'string') return done(new Uint8Array(Buffer.from(job.audio_base64, 'base64')));
    if (typeof job.audio_url === 'string') return done(await download(config, e, job.audio_url));
    if (['failed', 'error', 'cancelled'].includes(status)) throw new DomainError('provider_unavailable', `Provider job ${status}`);
    invariant(typeof job.id === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(job.id), 'provider_unavailable', 'Provider returned neither audio nor a job id');
    await new Promise((r) => setTimeout(r, config.pollIntervalMs ?? 2000));
    const next = await (await call(config, e, 'GET', endpoint(e, `/generations/${job.id}`))).json();
    invariant(isObj(next), 'provider_unavailable', 'Provider returned an invalid job status'); job = next;
  }
  throw new DomainError('provider_unavailable', 'Provider job did not finish in time');
}
