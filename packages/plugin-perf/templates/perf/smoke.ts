/**
 * Smoke — **run this before every other shape.**
 *
 * One virtual user for twenty seconds. It answers one question: does the script itself work? A load test whose
 * journey is broken reports a fast, wrong number, and it reports it confidently — an endpoint that 404s in a
 * millisecond looks like excellent latency until somebody checks the status codes.
 *
 * @example npm run perf:smoke
 */
import type { Options } from 'k6/options';

import { environment, requireTargetUrl } from './lib/env.ts';
import { journey } from './lib/flow.ts';

// Resolved in the init context, so a missing PERF_TARGET_URL aborts before a single request is sent.
const TARGET = requireTargetUrl();

export const options: Options = {
  scenarios: {
    smoke: { executor: 'constant-vus', vus: 1, duration: '20s' },
  },
  thresholds: {
    // Strict on purpose: at one VU there is no load to blame, so any failure is the script or the target.
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export function setup(): void {
  console.log(`[perf] smoke → ${TARGET} (environment: ${environment || 'none'})`);
}

export default function (): void {
  journey(TARGET);
}
