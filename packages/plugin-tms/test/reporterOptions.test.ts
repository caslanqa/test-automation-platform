/**
 * The shard branch — the one decision this package makes that the vendor reporter cannot make for
 * itself, and the one whose failure mode is silent: shard 1 completes the run, shards 2..N write into a
 * closed one, and the suite is green with a third of its results missing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readConfig } from '../src/config.js';
import { QASE_DEFAULT_BASE_URL, type QaseConfig } from '../src/providers/qase/config.js';
import { qaseReporterOptions } from '../src/providers/qase/reporter.js';

const qase = (over: Partial<QaseConfig> = {}): QaseConfig => ({
  token: 'tok',
  project: 'DEMO',
  baseUrl: QASE_DEFAULT_BASE_URL,
  runId: '',
  ...over,
});

test('with no run id the reporter owns the run: it titles it and completes it', () => {
  const options = qaseReporterOptions(readConfig({ TEST_ENV: 'staging' }), qase());

  assert.equal(options.testops?.run?.id, undefined);
  assert.equal(options.testops?.run?.complete, true);
  assert.match(String(options.testops?.run?.title), /staging$/);
});

test('with a run id the reporter joins the run and must NOT complete it', () => {
  const options = qaseReporterOptions(readConfig({}), qase({ runId: '4321' }));

  assert.equal(options.testops?.run?.id, 4321);
  assert.equal(options.testops?.run?.complete, false);
  assert.equal(options.testops?.run?.title, undefined);
});

test('a non-numeric run id is ignored rather than sent as NaN', () => {
  const options = qaseReporterOptions(readConfig({}), qase({ runId: 'not-a-number' }));

  assert.equal(options.testops?.run?.id, undefined);
  assert.equal(options.testops?.run?.complete, true);
});

test('project, token and attachment upload reach the vendor options', () => {
  const options = qaseReporterOptions(readConfig({}), qase());

  assert.equal(options.mode, 'testops');
  assert.equal(options.testops?.project, 'DEMO');
  assert.equal(options.testops?.api?.token, 'tok');
  assert.equal(
    options.testops?.uploadAttachments,
    true,
    'this is what carries trace, video and screenshots',
  );
  assert.equal(options.framework.browser?.addAsParameter, true);
  assert.equal(options.framework.markAsFlaky, true);
});

test('a custom base URL becomes the vendor’s bare host, not a /v1 URL', () => {
  const options = qaseReporterOptions(
    readConfig({}),
    qase({ baseUrl: 'https://qase.internal.example.com/v1' }),
  );

  assert.equal(options.testops?.api?.host, 'qase.internal.example.com');
});
