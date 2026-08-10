/**
 * The parts of `bench` that do not need a server: URL resolution, threshold comparison, and the reachability
 * probe against a real loopback server started here.
 *
 * `runBench` itself is not unit tested — it is a thin call into autocannon, and a test that stubbed autocannon
 * would only assert that the stub was called. It is verified against a live server instead.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import {
  compareBench,
  hasBenchThreshold,
  probeTarget,
  resolveBenchUrl,
  type BenchResult,
} from '../src/core/bench.js';

const RESULT: BenchResult = {
  url: 'http://localhost:1/health',
  p50: 10,
  p90: 25,
  p97_5: 60,
  p99: 120,
  mean: 14,
  max: 300,
  rps: 850,
  totalRequests: 1000,
  responses: 990,
  errors: 5,
  timeouts: 5,
  non2xx: 20,
  errorRate: 0.03,
};

test('an absolute url wins over a path', () => {
  const resolved = resolveBenchUrl(
    { url: 'http://other/health', path: '/ignored' },
    'http://base/',
  );
  assert.deepEqual(resolved, { url: 'http://other/health' });
});

test('a path resolves against baseURL', () => {
  assert.deepEqual(resolveBenchUrl({ path: '/api/health' }, 'http://base:3000/app/'), {
    url: 'http://base:3000/api/health',
  });
});

test('a path with no baseURL says how to fix it rather than throwing', () => {
  const resolved = resolveBenchUrl({ path: '/api/health' }, undefined);
  assert.ok('reason' in resolved);
  assert.match(resolved.reason, /needs a baseURL/);
  assert.match(resolved.reason, /playwright\.config\.ts/);
});

test('neither url nor path is reported as a reason, not a crash', () => {
  const resolved = resolveBenchUrl({}, 'http://base/');
  assert.ok('reason' in resolved);
  assert.match(resolved.reason, /needs a url or a path/);
});

test('an unparseable baseURL is reported as a reason', () => {
  const resolved = resolveBenchUrl({ path: '/health' }, 'not a url');
  assert.ok('reason' in resolved);
  assert.match(resolved.reason, /not a valid URL/);
});

test('compareBench reports each breached percentile with both numbers', () => {
  const failures = compareBench(RESULT, { p99: 100, p50: 5 });
  assert.deepEqual(failures, [
    'p50 10.0 ms exceeds the 5 ms budget',
    'p99 120.0 ms exceeds the 100 ms budget',
  ]);
});

test('an error-rate breach names the errors, timeouts and non-2xx behind it', () => {
  const failures = compareBench(RESULT, { errorRate: 0.01 });
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /error rate 3\.00% exceeds the 1\.00% budget/);
  assert.match(failures[0]!, /5 errors, 5 timeouts, 20 non-2xx of 1000/);
});

test('rps is a floor, not a ceiling', () => {
  assert.deepEqual(compareBench(RESULT, { rps: 500 }), []);
  assert.deepEqual(compareBench(RESULT, { rps: 1000 }), [
    'throughput 850 req/s is below the 1000 req/s floor',
  ]);
});

test('run parameters in the budget gate nothing on their own', () => {
  assert.deepEqual(compareBench(RESULT, { duration: 3, connections: 50 }), []);
  // Which is why `bench.assert()` refuses such a budget instead of passing: it would verify nothing.
  assert.equal(hasBenchThreshold({ duration: 3, connections: 50, amount: 100 }), false);
  assert.equal(hasBenchThreshold({}), false);
});

test('hasBenchThreshold accepts any real threshold, including a zero one', () => {
  assert.equal(hasBenchThreshold({ errorRate: 0 }), true);
  assert.equal(hasBenchThreshold({ p99: 800 }), true);
  assert.equal(hasBenchThreshold({ rps: 100 }), true);
  assert.equal(hasBenchThreshold({ duration: 3, p50: 10 }), true);
});

test('probeTarget accepts any HTTP response, including a 404', async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.end('nope');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    // A wrong path is the benchmark's business to report as non2xx; only a transport failure skips.
    assert.equal(await probeTarget(`http://127.0.0.1:${port}/missing`), null);
  } finally {
    server.close();
  }
});

test('probeTarget returns a reason when nothing is listening', async () => {
  // Port 1 on loopback: reserved, and never bound by anything in a test environment.
  const reason = await probeTarget('http://127.0.0.1:1/health', 2000);
  assert.ok(reason !== null);
  assert.match(reason, /could not reach http:\/\/127\.0\.0\.1:1\/health/);
});
