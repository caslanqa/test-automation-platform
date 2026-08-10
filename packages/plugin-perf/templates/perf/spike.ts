/**
 * Spike — does it survive a sudden surge, **and does it recover?**
 *
 * Recovery is half of spike testing and is the half everyone forgets. A system that absorbs the surge but never
 * returns to baseline latency has still failed: the queue drained on paper while the connection pool stayed
 * exhausted, or the cache stayed cold, or the autoscaler never scaled back.
 *
 * So this runs two scenarios: the surge, then a quiet period afterwards. k6 tags every metric with its scenario,
 * which is what lets the threshold below judge **only** the recovery window — a run-wide `p(95)` would be
 * dominated by the spike and would say nothing about whether the system came back.
 *
 * @example npm run perf:spike
 */
import type { Options } from 'k6/options';

import { environment, requireTargetUrl } from './lib/env.ts';
import { journey, vusFor } from './lib/flow.ts';

const TARGET = requireTargetUrl();

/** The same expected peak the other shapes use. The surge is five times it, with no ramp. */
const PEAK_RATE = 50;
const SURGE_RATE = PEAK_RATE * 5;
/** Ordinary traffic, for the window after the surge. */
const BASELINE_RATE = Math.max(1, Math.round(PEAK_RATE / 5));

export const options: Options = {
  scenarios: {
    // No stages: the rate is there from the first second, which is what makes this a spike rather than a ramp.
    spike: {
      executor: 'constant-arrival-rate',
      rate: SURGE_RATE,
      timeUnit: '1s',
      duration: '20s',
      // A surge has no ramp to grow into, so the pool must be there from the first second — see `vusFor`.
      preAllocatedVUs: vusFor(SURGE_RATE),
      maxVUs: vusFor(SURGE_RATE) * 2,
    },
    // Starts after the surge has ended, with a gap so the two windows do not overlap.
    recovery: {
      executor: 'constant-arrival-rate',
      startTime: '25s',
      rate: BASELINE_RATE,
      timeUnit: '1s',
      duration: '45s',
      preAllocatedVUs: vusFor(BASELINE_RATE),
      maxVUs: vusFor(BASELINE_RATE) * 4,
    },
  },
  thresholds: {
    // Scoped to the recovery scenario by tag: this is the assertion that the system came BACK, and it is the
    // whole reason the second scenario exists.
    'http_req_duration{scenario:recovery}': ['p(95)<500'],
    'http_req_failed{scenario:recovery}': ['rate<0.01'],
    // The surge itself is allowed to hurt — shedding some load under a 5× spike is a legitimate design — but not
    // to fall over completely.
    'http_req_failed{scenario:spike}': ['rate<0.5'],
    // `dropped_iterations` is NOT gated here, for the same reason as in stress.ts: the surge is meant to overwhelm,
    // and a target that queues under it holds VUs long enough to drop iterations. That is the spike happening, not
    // the generator failing. `load.ts` and `soak.ts` gate it, because there the target is expected to keep up.
  },
};

export function setup(): void {
  console.log(
    `[perf] spike → ${TARGET}, ${SURGE_RATE} req/s surge then ${BASELINE_RATE} req/s recovery ` +
      `(environment: ${environment || 'none'})`,
  );
}

export default function (): void {
  journey(TARGET);
}
