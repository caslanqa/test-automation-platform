/**
 * The provider surface: what `tms doctor` reads, and the two refusals that matter.
 *
 * `probe` must never throw — doctor prints every check, and the first thrown error would hide the rest,
 * which is exactly the run where someone has both a missing token and a wrong project code.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readConfig } from '../src/config.js';
import { resolveProvider } from '../src/providers/index.js';
import { QASE_DEFAULT_BASE_URL, type QaseConfig } from '../src/providers/qase/config.js';
import { createQaseProvider } from '../src/providers/qase/index.js';

const qase = (over: Partial<QaseConfig> = {}): QaseConfig => ({
  token: 'tok',
  project: 'DEMO',
  baseUrl: QASE_DEFAULT_BASE_URL,
  runId: '',
  ...over,
});

const ok = (body: unknown) => (): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify({ status: true, result: body })));

test('probe reports missing configuration before it tries the network', async () => {
  let called = false;
  const provider = createQaseProvider(readConfig({}), qase({ token: '', project: '' }), {
    fetch: () => {
      called = true;
      return Promise.reject(new Error('should never be reached'));
    },
  });

  const probe = await provider.probe();

  assert.equal(probe.ok, false);
  assert.equal(called, false);
  assert.match(probe.checks[0].detail, /QASE_TESTOPS_API_TOKEN, QASE_TESTOPS_PROJECT/);
});

test('probe reports an unreachable project as a failed check, not an exception', async () => {
  const provider = createQaseProvider(readConfig({}), qase(), {
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ status: false, errorMessage: 'Not Found' }), { status: 404 }),
      ),
    sleep: () => Promise.resolve(),
  });

  const probe = await provider.probe();

  assert.equal(probe.ok, false);
  assert.equal(probe.checks[0].ok, true, 'the configuration check still passed and still prints');
  assert.match(probe.checks[1].detail, /Not Found/);
});

test('a healthy probe names the project it reached', async () => {
  const provider = createQaseProvider(readConfig({}), qase(), {
    fetch: ok({ title: 'Demo Project' }),
  });

  const probe = await provider.probe();

  assert.equal(probe.ok, true);
  assert.match(probe.checks[1].detail, /Demo Project reachable/);
});

test('createRun marks the run as an autotest run and returns a link a human can open', async () => {
  let body: unknown;
  const provider = createQaseProvider(readConfig({}), qase(), {
    fetch: (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(JSON.stringify({ status: true, result: { id: 99 } })));
    },
  });

  const ref = await provider.createRun({ title: 'main · a1b2c3d', environment: 'staging' });

  assert.deepEqual(body, {
    title: 'main · a1b2c3d',
    environment_slug: 'staging',
    is_autotest: true,
  });
  assert.equal(ref.id, '99');
  assert.equal(ref.url, 'https://app.qase.io/run/DEMO/dashboard/99');
});

test('createReporter refuses to run half-configured', () => {
  const provider = createQaseProvider(readConfig({ TMS_MODE: 'testops' }), qase({ token: '' }));

  assert.throws(
    () => provider.createReporter(),
    /TMS_MODE=testops but QASE_TESTOPS_API_TOKEN is not set/,
  );
});

test('an unknown provider fails by name rather than resolving to undefined', () => {
  assert.throws(
    () => resolveProvider(readConfig({ TMS_PROVIDER: 'testrail' })),
    /unknown TMS_PROVIDER "testrail" — known providers: qase/,
  );
});
