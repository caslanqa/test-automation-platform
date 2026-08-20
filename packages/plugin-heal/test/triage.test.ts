/**
 * The classifier. Three of these are the properties that distinguish this engine from the official
 * Playwright healer, and each one is a separate assertion on purpose:
 *
 * 1. a retry that passed means **flaky**, and it outranks whatever the error text says;
 * 2. a value mismatch is **true-fail** and carries a veto, so nothing can auto-heal it;
 * 3. with no cross-run history the classifier **says so** and refuses to reach the act band.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FlakeStats } from '../src/history/flakeStats.js';
import { band, classify } from '../src/triage/classify.js';
import type { FailureRecord } from '../src/types.js';

const failure = (over: Partial<FailureRecord> = {}): FailureRecord => ({
  kind: 'presence-timeout',
  message: 'expect(locator).toBeVisible() failed',
  siteFingerprint: 'aaaaaaaaaaaa',
  errorFingerprint: 'bbbbbbbbbbbb',
  taxonomyVersion: 1,
  attachments: [],
  ...over,
});

const history = (over: Partial<FlakeStats> = {}): FlakeStats => ({
  runs: 20,
  fails: 0,
  flakyRuns: 0,
  flakeRate: 0,
  recoveryRate: 0,
  neverPassed: false,
  lastPassed: '2026-08-19T00:00:00.000Z',
  sites: [],
  ...over,
});

const settled = { history: history(), testFileChanged: false, topFrameFileChanged: false };

test('a retry that passed is flaky, and it overrides the error text', () => {
  // The error says value-mismatch, which on its own would be the strongest true-fail signal there is.
  const result = classify({
    outcome: 'flaky',
    failure: failure({ kind: 'value-mismatch', expected: '"a"', received: '"b"' }),
    ...settled,
  });
  assert.equal(result.class, 'flaky');
  assert.equal(result.confidence, 95);
  assert.ok(result.vetoes.includes('not-locator-drift'));
});

test('a value mismatch is true-fail and can never be auto-healed', () => {
  const result = classify({
    outcome: 'unexpected',
    failure: failure({ kind: 'value-mismatch', expected: '"Ada"', received: '"Grace"' }),
    ...settled,
  });
  assert.equal(result.class, 'true-fail');
  assert.ok(
    result.vetoes.some(veto => veto.startsWith('value-mismatch')),
    'the veto must name the reason, not just refuse',
  );
});

test('a locator that stopped resolving, with nothing changed in the repo, is locator-drift', () => {
  const result = classify({ outcome: 'unexpected', failure: failure(), ...settled });
  assert.equal(result.class, 'locator-drift');
  assert.equal(band(result.confidence), 'act');
});

test('a strict-mode violation is the strongest locator-drift signal', () => {
  const result = classify({
    outcome: 'unexpected',
    failure: failure({ kind: 'strict-mode' }),
    ...settled,
  });
  assert.equal(result.class, 'locator-drift');
  assert.ok(result.scores['locator-drift'] >= 45);
});

test('editing the test file vetoes any autofix and pushes towards true-fail', () => {
  const result = classify({
    outcome: 'unexpected',
    failure: failure(),
    history: history(),
    testFileChanged: true,
    topFrameFileChanged: false,
  });
  assert.ok(
    result.vetoes.some(veto => veto.startsWith('test-file-edited')),
    'a human just edited this spec',
  );
  assert.ok(result.scores['true-fail'] >= 25);
});

test('editing the page object in the failing frame vetoes too', () => {
  const result = classify({
    outcome: 'unexpected',
    failure: failure(),
    history: history(),
    testFileChanged: false,
    topFrameFileChanged: true,
  });
  assert.ok(result.vetoes.some(veto => veto.startsWith('source-edited')));
});

test('with no history the classifier says so and cannot reach the act band', () => {
  const result = classify({ outcome: 'unexpected', failure: failure(), diffUnknown: true });
  assert.ok(
    result.reasons.some(reason => reason.includes('no cross-run history')),
    'silence here is how a healer starts healing races',
  );
  assert.ok(result.confidence <= 70);
  assert.notEqual(band(result.confidence), 'act');
  assert.ok(result.vetoes.includes('no-history'));
});

test('a flake rate between the bounds is flaky, even without an in-run retry', () => {
  const result = classify({
    outcome: 'unexpected',
    failure: failure(),
    history: history({ runs: 18, fails: 6, flakeRate: 6 / 18, recoveryRate: 0.5 }),
    testFileChanged: false,
    topFrameFileChanged: false,
  });
  assert.equal(result.class, 'flaky');
});

test('a test that has never passed is unknown, with nothing to be equivalent to', () => {
  const result = classify({
    outcome: 'unexpected',
    failure: failure(),
    history: history({ neverPassed: true, lastPassed: undefined }),
    testFileChanged: false,
    topFrameFileChanged: false,
  });
  assert.ok(result.vetoes.some(veto => veto.startsWith('never-passed')));
});

test('a crash or a network error is env-infra, and a global error reinforces it', () => {
  assert.equal(
    classify({ outcome: 'unexpected', failure: failure({ kind: 'browser-crash' }), ...settled })
      .class,
    'env-infra',
  );
  const withGlobal = classify({
    outcome: 'unexpected',
    failure: failure({ kind: 'test-timeout' }),
    hadGlobalErrors: true,
    ...settled,
  });
  assert.equal(withGlobal.class, 'env-infra');
});

test('a fixture failure is env-infra — setup broke, the test never really ran', () => {
  const result = classify({
    outcome: 'unexpected',
    failure: failure({ kind: 'fixture-error' }),
    ...settled,
  });
  assert.equal(result.class, 'env-infra');
});

test('an unreadable failure is unknown at zero confidence, never a guess', () => {
  const noFailure = classify({ outcome: 'unexpected' });
  assert.equal(noFailure.class, 'unknown');
  assert.equal(noFailure.confidence, 0);

  const noSignal = classify({
    outcome: 'unexpected',
    failure: failure({ kind: 'test-timeout' }),
    history: history(),
    diffUnknown: true,
  });
  assert.equal(noSignal.class, 'unknown');
});

test('confidence reflects the margin, so a close call reports as a close call', () => {
  // count-zero contributes equally to two classes, which is exactly an ambiguous reading.
  const ambiguous = classify({
    outcome: 'unexpected',
    failure: failure({ kind: 'count-zero' }),
    history: history(),
    diffUnknown: true,
  });
  const clear = classify({
    outcome: 'unexpected',
    failure: failure({ kind: 'browser-crash' }),
    ...settled,
  });
  assert.ok(ambiguous.confidence < clear.confidence);
  assert.equal(band(ambiguous.confidence), 'ask');
});

test('the bands are 85 to act and 60 to advise', () => {
  assert.equal(band(85), 'act');
  assert.equal(band(84), 'advise');
  assert.equal(band(60), 'advise');
  assert.equal(band(59), 'ask');
});

test('retries of 0 is reported, because it means no in-run flake signal was possible', () => {
  const result = classify({
    outcome: 'unexpected',
    failure: failure(),
    configRetries: 0,
    ...settled,
  });
  assert.ok(result.reasons.some(reason => reason.includes('retries are 0')));
});
