/**
 * The Web Vitals arithmetic, which is where this plugin can be subtly wrong without anything failing.
 *
 * CLS in particular: a sum of every layout shift passes a naive test and reports a number far higher than the
 * metric defines on any long-lived page. The session-window cases below are the ones that separate the two.
 *
 * These run in Node with no browser, which is the whole reason `harvestVitalsInPage` only harvests and
 * `sampleOf` does the maths.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blockingTimeOf,
  clsOf,
  compareVitals,
  inpOf,
  sampleOf,
  type RawVitals,
} from '../src/core/vitals.js';

const CHROMIUM_TYPES = [
  'navigation',
  'paint',
  'largest-contentful-paint',
  'layout-shift',
  'longtask',
  'event',
];

test('cls sums the shifts inside one session', () => {
  const cls = clsOf([
    { startTime: 100, value: 0.05, hadRecentInput: false },
    { startTime: 400, value: 0.03, hadRecentInput: false },
  ]);
  assert.equal(Math.round(cls * 100) / 100, 0.08);
});

test('cls reports the WORST session, not the total, when a 1s gap splits them', () => {
  // 0.1 then 0.4 with a 2s gap. A sum would say 0.5; the metric says 0.4.
  const cls = clsOf([
    { startTime: 0, value: 0.1, hadRecentInput: false },
    { startTime: 2000, value: 0.4, hadRecentInput: false },
  ]);
  assert.equal(Math.round(cls * 100) / 100, 0.4);
});

test('cls starts a new session once one has run for 5s, even with no gap', () => {
  // Shifts every 900ms, so no gap ever exceeds 1s: only the 5s cap can split this.
  const shifts = Array.from({ length: 10 }, (_, index) => ({
    startTime: index * 900,
    value: 0.05,
    hadRecentInput: false,
  }));
  const cls = clsOf(shifts);
  // Entries at 0…4500 are the first session (6 shifts, 0.30); the rest start a new one.
  assert.equal(Math.round(cls * 100) / 100, 0.3);
});

test('cls ignores shifts the user caused', () => {
  const cls = clsOf([
    { startTime: 100, value: 0.9, hadRecentInput: true },
    { startTime: 200, value: 0.02, hadRecentInput: false },
  ]);
  assert.equal(Math.round(cls * 100) / 100, 0.02);
});

test('cls is 0 when nothing shifted — a real measurement, not a missing one', () => {
  assert.equal(clsOf([]), 0);
});

test('tbt counts only the part of each long task beyond 50ms, and only after fcp', () => {
  const tasks = [
    { startTime: 10, duration: 300 }, // before FCP: ignored entirely
    { startTime: 500, duration: 80 }, // 30ms of blocking
    { startTime: 900, duration: 40 }, // under the threshold: 0
    { startTime: 1200, duration: 150 }, // 100ms
  ];
  assert.equal(blockingTimeOf(tasks, 200), 130);
});

test('inp is the longest entry of the worst interaction, not the sum of the entries', () => {
  // One interaction (id 1) reported as pointerdown/pointerup/click; another (id 2) slower.
  const inp = inpOf([
    { interactionId: 1, duration: 40 },
    { interactionId: 1, duration: 120 },
    { interactionId: 1, duration: 90 },
    { interactionId: 2, duration: 200 },
  ]);
  assert.equal(inp, 200);
});

test('inp ignores event entries that are not interactions', () => {
  assert.equal(inpOf([{ interactionId: 0, duration: 5000 }]), undefined);
});

test('inp is undefined when nothing was interacted with, so a budget skips', () => {
  assert.equal(inpOf([]), undefined);
});

test('sampleOf leaves load undefined while the load event has not fired', () => {
  const raw: RawVitals = {
    supported: CHROMIUM_TYPES,
    navigation: { responseStart: 120, domContentLoadedEventEnd: 400, loadEventEnd: 0 },
  };
  const sample = sampleOf(raw);
  assert.equal(sample.ttfb, 120);
  assert.equal(sample.domContentLoaded, 400);
  assert.equal(sample.load, undefined);
});

test('sampleOf distinguishes an unsupported entry type from a supported one with no entries', () => {
  const unsupported = sampleOf({ supported: ['navigation'] });
  assert.equal(unsupported.cls, undefined);
  assert.equal(unsupported.longTasks, undefined);

  const supportedButQuiet = sampleOf({ supported: CHROMIUM_TYPES, shifts: [], longTasks: [] });
  assert.equal(supportedButQuiet.cls, 0);
  assert.equal(supportedButQuiet.longTasks, 0);
  assert.equal(supportedButQuiet.tbt, 0);
});

test('compareVitals reports a breach with both numbers and the right unit', () => {
  const { failures, unmeasurable } = compareVitals(
    { supported: CHROMIUM_TYPES, lcp: 3120.4, cls: 0.25 },
    { lcp: 2500, cls: 0.1 },
  );
  assert.equal(unmeasurable.length, 0);
  assert.deepEqual(failures, [
    'lcp 3120.4 ms exceeds the 2500 ms budget',
    'cls 0.25 exceeds the 0.1 budget',
  ]);
});

test('compareVitals passes a metric exactly on its budget', () => {
  const { failures } = compareVitals({ supported: CHROMIUM_TYPES, lcp: 2500 }, { lcp: 2500 });
  assert.deepEqual(failures, []);
});

test('compareVitals blames the browser when the entry type is unsupported', () => {
  const { failures, unmeasurable } = compareVitals(
    { supported: ['navigation', 'paint'] },
    { lcp: 2500 },
  );
  assert.deepEqual(failures, []);
  assert.equal(unmeasurable.length, 1);
  assert.match(unmeasurable[0]!, /does not support/);
  assert.match(unmeasurable[0]!, /Chromium/);
});

test('compareVitals blames the run when the browser supports the type but produced nothing', () => {
  // 'event' is in `supported`, but the run produced no interaction, so `inp` came back undefined.
  const { unmeasurable } = compareVitals({ supported: CHROMIUM_TYPES }, { inp: 200 });
  assert.equal(unmeasurable.length, 1);
  assert.match(unmeasurable[0]!, /needs a real interaction/);
});

test('compareVitals ignores a budget key set to undefined', () => {
  const { failures, unmeasurable } = compareVitals(
    { supported: CHROMIUM_TYPES, lcp: 9999 },
    { lcp: undefined, cls: undefined },
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(unmeasurable, []);
});
