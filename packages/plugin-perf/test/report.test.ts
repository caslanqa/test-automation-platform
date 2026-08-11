/**
 * The summary lines that end up next to a test in the HTML report.
 *
 * Worth testing rather than eyeballing once: these are the only form most people will ever read the numbers in, and
 * a line that says `lcp 508.40000001ms` or an empty one that reads like the fixture never ran are both failures of
 * the same job.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BenchResult } from '../src/core/bench.js';
import {
  benchSummary,
  benchesSummary,
  bytes,
  ms,
  resourcesSummary,
  vitalsSummary,
} from '../src/core/report.js';

const benchResult = (over: Partial<BenchResult> = {}): BenchResult => ({
  url: 'http://localhost:3000/api/health',
  p50: 4.2,
  p90: 9,
  p97_5: 18.6,
  p99: 44,
  mean: 6,
  max: 120,
  rps: 849.6,
  totalRequests: 1000,
  responses: 1000,
  errors: 0,
  timeouts: 0,
  non2xx: 0,
  errorRate: 0,
  ...over,
});

test('bytes uses the decimal units bundlers report', () => {
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1_500), '2 kB');
  assert.equal(bytes(900_000), '900 kB');
  assert.equal(bytes(1_252_000), '1.25 MB');
});

test('ms drops precision the measurement does not have', () => {
  assert.equal(ms(508.4000001), '508ms');
  assert.equal(ms(4.24), '4.2ms');
  assert.equal(ms(0), '0.0ms');
});

test('a vitals summary names only what was measured, in reading order', () => {
  const line = vitalsSummary({ supported: [], lcp: 508.4, cls: 0.0021, ttfb: 129, fcp: 268 });
  assert.equal(line, 'lcp 508ms · cls 0.002 · ttfb 129ms · fcp 268ms');
});

test('a vitals summary omits the metrics this browser could not produce', () => {
  const line = vitalsSummary({ supported: [], ttfb: 129, fcp: 268 });
  assert.doesNotMatch(line, /lcp|cls|inp|tbt/);
  assert.equal(line, 'ttfb 129ms · fcp 268ms');
});

test('a sample with nothing in it says so, rather than reading as an empty row', () => {
  assert.equal(vitalsSummary({ supported: [] }), 'nothing measured');
});

test('a resources summary leads with the totals and names the three heaviest types', () => {
  const line = resourcesSummary({
    totalBytes: 1_252_000,
    requests: 4,
    byType: {
      document: { bytes: 12_000, requests: 1 },
      script: { bytes: 1_200_000, requests: 2 },
      image: { bytes: 40_000, requests: 1 },
    },
  });
  assert.equal(line, '4 requests · 1.25 MB (script 1.20 MB, image 40 kB, document 12 kB)');
});

test('a page that loaded nothing still summarises cleanly', () => {
  assert.equal(resourcesSummary({ totalBytes: 0, requests: 0, byType: {} }), '0 requests · 0 B');
});

test('a bench summary always carries the error rate next to the percentiles', () => {
  // 18.6 is above the 10 ms threshold, so it rounds: precision the measurement does not have is noise.
  assert.equal(
    benchSummary(benchResult()),
    'p50 4.2ms · p97.5 19ms · p99 44ms · 850 req/s · 0.00% errors',
  );
  assert.match(benchSummary(benchResult({ errorRate: 0.0342 })), /3\.42% errors/);
});

test('one bench run reads as a bare line; several are labelled by path', () => {
  assert.doesNotMatch(benchesSummary([benchResult()]), /api\/health →/);

  const two = benchesSummary([
    benchResult(),
    benchResult({ url: 'http://localhost:3000/api/orders', p99: 210 }),
  ]);
  assert.match(two, /\/api\/health → /);
  assert.match(two, /\/api\/orders → /);
  assert.match(two, /p99 210ms/);
});

test('an unparseable url falls back to itself rather than throwing in a summary', () => {
  const line = benchesSummary([benchResult(), benchResult({ url: 'not a url' })]);
  assert.match(line, /not a url → /);
});
