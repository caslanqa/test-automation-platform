/**
 * Stress — where is the ceiling, and what breaks first?
 *
 * Climb past the expected peak in steps and keep going. The point is to find the breaking point, so **there is no
 * latency threshold here**: gating `p99` would fail the run at exactly the moment it starts producing the answer
 * you asked for. Read the per-stage percentiles in the summary instead and note where they turn.
 *
 * What IS gated: a hard error-rate ceiling with `abortOnFail`, so the run stops once the system is clearly broken
 * rather than spending minutes hammering something that is already returning 500s.
 *
 * **`dropped_iterations` is deliberately NOT gated here**, unlike in `load.ts`. It counts iterations k6 could not
 * start on schedule, which happens for two different reasons: the VU pool was too small, or the target got so slow
 * that VUs piled up waiting on it. The second is the finding a stress test exists to produce, so gating on the
 * metric would fail the run at exactly the moment it answers the question. The pool below is sized for the top
 * stage so the first reason is ruled out, which leaves the count meaning what you want it to mean: read it in the
 * summary, and where it starts climbing is where the system stopped keeping up.
 *
 * @example npm run perf:stress
 */
import type { Options } from 'k6/options';

import { environment, requireTargetUrl } from './lib/env.ts';
import { journey, vusFor } from './lib/flow.ts';

const TARGET = requireTargetUrl();

/** The same expected peak `load.ts` uses. The stages below climb to four times it. */
const PEAK_RATE = 50;

export const options: Options = {
  scenarios: {
    stress: {
      executor: 'ramping-arrival-rate',
      startRate: PEAK_RATE,
      timeUnit: '1s',
      // Pre-allocated for the TOP stage, not the starting one, even though most of the run does not need it.
      // Growing the pool mid-run loses iterations to allocation lag — measured: 113 of them here, against a
      // target answering in 5 ms with plenty of headroom left. With the pool ready up front, a `dropped_iterations`
      // count means the target held VUs longer than expected, which is the reading this shape is for.
      preAllocatedVUs: vusFor(PEAK_RATE * 4),
      maxVUs: vusFor(PEAK_RATE * 4) * 2,
      stages: [
        { target: PEAK_RATE, duration: '30s' },
        { target: PEAK_RATE * 2, duration: '30s' },
        { target: PEAK_RATE * 3, duration: '30s' },
        { target: PEAK_RATE * 4, duration: '30s' },
        { target: 0, duration: '15s' },
      ],
    },
  },
  thresholds: {
    // Stop early once a quarter of the traffic is failing — the ceiling has been found by then, and the rest of
    // the run only adds noise and load.
    http_req_failed: [{ threshold: 'rate<0.25', abortOnFail: true }],
  },
};

export function setup(): void {
  console.log(
    `[perf] stress → ${TARGET}, ${PEAK_RATE} to ${PEAK_RATE * 4} req/s (environment: ${environment || 'none'})`,
  );
}

export default function (): void {
  journey(TARGET);
}
