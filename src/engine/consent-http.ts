// E11 decision evaluation only; this port never records actual use or dispatches/publishes anything.
import { invariant } from '../contracts.ts';
import { parseUref } from '../service-kit.ts';
import type { UseDecisionPort, UseDecision } from '../service-kit.ts';
import { scopedJson } from './scoped-http.ts';
import type { ScopedHttpOptions } from './scoped-http.ts';
export type ConsentHttpOptions = ScopedHttpOptions;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const actions = ['investigate', 'preserve', 'cite', 'reproduce', 'adapt', 'publish', 'license', 'contact', 'process'];
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 2048 && v.every(x => typeof x === 'string' && x.length <= 4096);
/** Every call asks E11 afresh. No automatic retries, historical-decision replay or execution authority. */
export function httpUseDecisionPort(options: ConsentHttpOptions): UseDecisionPort {
  const url = new URL(options.baseUrl);
  invariant((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password,
    'invalid_config', 'Consent URL must be http(s) without embedded credentials');
  const configured = { ...options, baseUrl: url.toString() };
  return { async decide(ctx, input): Promise<UseDecision> {
    invariant(object(input) && Object.keys(input).every(k => ['subjects', 'action', 'purpose', 'audience', 'territory', 'destination'].includes(k)),
      'unavailable', 'An exact use-decision request is required');
    invariant(Array.isArray(input.subjects) && input.subjects.length > 0 && input.subjects.length <= 200
      && input.subjects.every(s => typeof s === 'string' && s.length <= 1024), 'unavailable', 'Invalid decision subjects');
    for (const subject of input.subjects) parseUref(subject);
    invariant(actions.includes(input.action) && input.purpose === ctx.purpose && input.purpose.length > 0 && input.purpose.length <= 120,
      'unavailable', 'Decision purpose or action differs');
    for (const field of ['audience', 'territory', 'destination'] as const) {
      const value = input[field];
      invariant(value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= (field === 'destination' ? 300 : 120)),
        'unavailable', 'Invalid use-decision field');
    }
    const request = { subjects: [...input.subjects], action: input.action, purpose: input.purpose,
      ...(input.audience === undefined ? {} : { audience: input.audience }), ...(input.territory === undefined ? {} : { territory: input.territory }),
      ...(input.destination === undefined ? {} : { destination: input.destination }) };
    invariant(Buffer.byteLength(JSON.stringify(request), 'utf8') <= 65536, 'unavailable', 'Use-decision request is too large');
    const scope = { ...ctx, compartments: [...ctx.compartments] };
    const response = await scopedJson(configured, scope, 'consent', 'POST', '/v1/use-decisions', request);
    invariant(response.status === 200 || response.status === 201, 'unavailable', 'Consent evaluation failed');
    const d = response.json;
    invariant(object(d) && ['allow', 'deny', 'review'].includes(d.decision as string)
      && strings(d.reasons) && strings(d.permissionRefs) && strings(d.restrictions)
      && typeof d.decidedAt === 'string' && d.decidedAt.length <= 128 && Number.isFinite(Date.parse(d.decidedAt)),
      'unavailable', 'Consent returned a malformed decision');
    return { decision: d.decision as UseDecision['decision'], reasons: [...d.reasons], permissionRefs: [...d.permissionRefs],
      restrictions: [...d.restrictions], decidedAt: d.decidedAt };
  } };
}
