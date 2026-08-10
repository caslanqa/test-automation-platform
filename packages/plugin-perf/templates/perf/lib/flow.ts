/**
 * The journey every shape runs. **This is the file you replace.**
 *
 * All five shapes — smoke, load, stress, spike, soak — import this one function, so a change to what a virtual
 * user does happens once and every shape follows. That is the only sharing this layer needs: the shapes differ in
 * their ramp, not in what they ask the system to do.
 *
 * A load journey is usually **not** your Playwright test rewritten. At a few hundred requests a second you want
 * the HTTP calls underneath a user journey — with correlation and think time — not a click sequence. Model the
 * requests your app actually serves.
 *
 * @example
 * // A two-step journey with correlation, which is the shape most real ones take:
 * const login = http.post(`${baseUrl}api/login`, JSON.stringify({ user: 'demo' }), JSON_HEADERS);
 * const token = login.json('token') as string;
 * http.get(`${baseUrl}api/orders`, { headers: { authorization: `Bearer ${token}` } });
 */
import { check, sleep } from 'k6';
import http from 'k6/http';

/** Seconds a virtual user waits between steps. Real users pause; a journey with no think time is a benchmark. */
export const THINK_TIME_SECONDS = 1;

/**
 * How many virtual users an arrival-rate executor needs to sustain `rate` requests per second.
 *
 * A VU is occupied for a whole iteration, so the pool has to cover `rate × iteration duration` — and the think
 * time above dominates that duration far more than the response does. Under-provisioning does **not** slow the run
 * down gracefully: k6 reports `dropped_iterations`, which the load and soak scripts gate on, so a run against a
 * perfectly healthy target fails and the obvious next move is to delete the threshold — which throws away the only
 * check that tells you the generator, not the target, was the bottleneck.
 *
 * Measured while building this: `preAllocatedVUs: 50` at 50 req/s with a 1 s think time dropped 2 iterations
 * against a target answering in 6 ms. Allocating VUs mid-run is slow enough to lose iterations during a ramp, so
 * pre-allocate for the steady state rather than growing into it.
 *
 * The `+ 1` assumes a response can take up to a second on top of the think time. Raise it if your service is
 * slower than that, or lower the think time.
 */
export function vusFor(rate: number): number {
  return Math.ceil(rate * (THINK_TIME_SECONDS + 1));
}

export function journey(baseUrl: string): void {
  // `tags.name` groups metrics by endpoint instead of by URL, so a path with an id in it does not explode the
  // report into one row per id.
  const response = http.get(baseUrl, { tags: { name: 'GET target' } });

  // `http_req_failed` already gates transport and status failures for the whole run; a check adds per-step
  // visibility, which is what tells you WHICH step broke when a threshold goes red.
  check(response, {
    'target responded below 400': result => result.status > 0 && result.status < 400,
  });

  // With an arrival-rate executor this does not slow the arrival of new iterations — it holds a VU for longer, so
  // the run needs more of them. That is the honest model: think time costs concurrency, not throughput.
  sleep(THINK_TIME_SECONDS);
}
