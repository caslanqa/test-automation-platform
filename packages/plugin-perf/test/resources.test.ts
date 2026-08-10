/**
 * Resource budgets: the totals, and the part that decides whether a failure is useful — naming the culprit.
 *
 * A budget failure that says only "1.7 MB exceeds 1.5 MB" sends the reader to the network tab to find out which
 * dependency grew, so the assertions below check the message content, not just that it failed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareResources,
  hasResourceCheck,
  totalsOf,
  type ResourceRecord,
} from '../src/core/resources.js';

const RECORDS: ResourceRecord[] = [
  { url: 'https://app/index.html', resourceType: 'document', bytes: 12_000 },
  { url: 'https://app/vendor.js', resourceType: 'script', bytes: 900_000 },
  { url: 'https://app/app.js', resourceType: 'script', bytes: 300_000 },
  { url: 'https://app/logo.png', resourceType: 'image', bytes: 40_000 },
];

test('totalsOf adds up overall and per type', () => {
  const totals = totalsOf(RECORDS);
  assert.equal(totals.requests, 4);
  assert.equal(totals.totalBytes, 1_252_000);
  assert.deepEqual(totals.byType.script, { bytes: 1_200_000, requests: 2 });
  assert.deepEqual(totals.byType.image, { bytes: 40_000, requests: 1 });
});

test('totalsOf handles a page that made no requests', () => {
  assert.deepEqual(totalsOf([]), { totalBytes: 0, requests: 0, byType: {} });
});

test('a totalBytes breach names the largest resources, biggest first', () => {
  const failures = compareResources(RECORDS, { totalBytes: 1_000_000 });
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /total transfer 1\.25 MB exceeds the 1\.00 MB budget/);
  // vendor.js before app.js — the ordering is the point of the message.
  assert.match(
    failures[0]!,
    /script https:\/\/app\/vendor\.js \(900 kB\).*script https:\/\/app\/app\.js/,
  );
});

test('a request-count breach breaks the count down by type', () => {
  const failures = compareResources(RECORDS, { requests: 2 });
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /4 requests exceed the 2 budget/);
  assert.match(failures[0]!, /script 2/);
});

test('a per-type breach names only that type’s resources', () => {
  const failures = compareResources(RECORDS, { byType: { script: 500_000 } });
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /script transfer 1\.20 MB exceeds the 500 kB budget/);
  assert.doesNotMatch(failures[0]!, /logo\.png/);
});

test('a per-type budget for a type the page never loaded passes', () => {
  assert.deepEqual(compareResources(RECORDS, { byType: { font: 1 } }), []);
});

test('every breached budget is reported, not just the first', () => {
  const failures = compareResources(RECORDS, {
    totalBytes: 1_000_000,
    requests: 2,
    byType: { script: 100_000, image: 10_000 },
  });
  assert.equal(failures.length, 4);
});

test('totals exactly on the budget pass', () => {
  assert.deepEqual(compareResources(RECORDS, { totalBytes: 1_252_000, requests: 4 }), []);
});

test('an explicitly undefined per-type limit is skipped, not compared against undefined', () => {
  assert.deepEqual(compareResources(RECORDS, { byType: { script: undefined } }), []);
  // A real limit alongside it still applies.
  assert.equal(compareResources(RECORDS, { byType: { script: 1, image: undefined } }).length, 1);
});

// `budget.assert()` throws on a budget that checks nothing, and a nested `byType` is where "defined" stops
// meaning "checks something". Reported by review on PR #45: `{ byType: {} }` used to pass silently.
test('hasResourceCheck sees through an empty or all-undefined byType', () => {
  assert.equal(hasResourceCheck({}), false);
  assert.equal(hasResourceCheck({ byType: {} }), false);
  assert.equal(hasResourceCheck({ byType: { script: undefined } }), false);
  assert.equal(hasResourceCheck({ totalBytes: undefined, requests: undefined }), false);
});

test('hasResourceCheck accepts any real limit, including one nested in byType', () => {
  assert.equal(hasResourceCheck({ totalBytes: 1 }), true);
  assert.equal(hasResourceCheck({ requests: 0 }), true);
  assert.equal(hasResourceCheck({ byType: { script: 0 } }), true);
  assert.equal(hasResourceCheck({ byType: { script: undefined, image: 10 } }), true);
});
