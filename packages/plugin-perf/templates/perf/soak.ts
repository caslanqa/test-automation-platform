/**
 * Soak — does it leak? Memory, connections, file handles, disk.
 *
 * Modest load held for a long time. Nothing here is dramatic; that is the point. A leak shows up as a slow upward
 * drift in latency or memory over half an hour that no ten-minute run would reveal.
 *
 * **A soak run's real output is a time series, not the end-of-run summary.** The summary averages the healthy
 * first minutes together with the degraded last ones and can pass a run that was visibly dying. Capture the series
 * and look at its shape:
 *
 *     k6 run --out json=perf-soak.json perf/soak.ts
 *
 * The thresholds below still earn their place — they catch a system that falls over outright — but they are not
 * the measurement.
 *
 * **This is a nightly job, never a pull-request one.** Thirty minutes of CI time per commit buys nothing; thirty
 * minutes once a night against a consistent machine buys a trend.
 *
 * @example npm run perf:soak
 */
import type { Options } from 'k6/options';

import { environment, requireTargetUrl } from './lib/env.ts';
import { journey, vusFor } from './lib/flow.ts';

const TARGET = requireTargetUrl();

/** Comfortably below the expected peak: a soak is about duration, not pressure. */
const SOAK_RATE = 10;
/** Lengthen this for a real soak — hours is normal. Thirty minutes is the smallest run that shows a trend. */
const SOAK_DURATION = '30m';

export const options: Options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: SOAK_RATE,
      timeUnit: '1s',
      duration: SOAK_DURATION,
      preAllocatedVUs: vusFor(SOAK_RATE),
      maxVUs: vusFor(SOAK_RATE) * 4,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Deliberately looser than load.ts: over half an hour a single garbage-collection pause or a deploy on the
    // target would trip a tight bound, and a soak that cries wolf gets ignored.
    http_req_duration: ['p(99)<1500'],
    dropped_iterations: ['count<1'],
  },
};

export function setup(): void {
  console.log(
    `[perf] soak → ${TARGET} at ${SOAK_RATE} req/s for ${SOAK_DURATION} (environment: ${environment || 'none'})`,
  );
}

export default function (): void {
  journey(TARGET);
}
