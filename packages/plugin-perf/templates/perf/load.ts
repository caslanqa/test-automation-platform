/**
 * Load — does the system meet its SLO at the traffic we actually get?
 *
 * Ramp to the expected peak, hold it, ramp down. `ramping-arrival-rate` is an **open** model: requests arrive on
 * schedule whether or not the previous ones finished, so a slowdown builds a queue the way real traffic does. The
 * closed alternative (`ramping-vus`) quietly reduces load exactly when the system starts struggling, which is why
 * so many load tests flatter their target.
 *
 * The numbers live here rather than in an environment variable, deliberately: the peak, the hold and the
 * thresholds are one statement about what "acceptable" means, and it belongs in version control next to the
 * scenario it gates.
 *
 * @example npm run perf:load
 */
import type { Options } from 'k6/options';

import { environment, requireTargetUrl } from './lib/env.ts';
import { journey, vusFor } from './lib/flow.ts';

const TARGET = requireTargetUrl();

/** Requests per second at the plateau. **Set this to the peak your service actually receives.** */
const PEAK_RATE = 50;

export const options: Options = {
  scenarios: {
    load: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      // Sized by `vusFor`, not by the rate — see its note. A VU is held for the whole iteration, think time
      // included, so `preAllocatedVUs: PEAK_RATE` is roughly half of what 50 req/s actually needs and loses
      // iterations during the ramp.
      preAllocatedVUs: vusFor(PEAK_RATE),
      maxVUs: vusFor(PEAK_RATE) * 3,
      stages: [
        { target: PEAK_RATE, duration: '30s' }, // ramp
        { target: PEAK_RATE, duration: '1m' }, // hold — this is the part the thresholds judge
        { target: 0, duration: '15s' }, // ramp down
      ],
    },
  },
  thresholds: {
    // Never gate latency without gating errors: a service that is fast because it rejects half the traffic
    // reports excellent percentiles.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(99)<800'],
    // The coordinated-omission guard. This counts iterations k6 could not START on schedule, so the run fails
    // when the GENERATOR was the bottleneck instead of the target. Without it, a saturated laptop reports
    // excellent latency and the number is a lie.
    dropped_iterations: ['count<1'],
  },
};

export function setup(): void {
  console.log(
    `[perf] load → ${TARGET} at ${PEAK_RATE} req/s (environment: ${environment || 'none'})`,
  );
}

export default function (): void {
  journey(TARGET);
}
