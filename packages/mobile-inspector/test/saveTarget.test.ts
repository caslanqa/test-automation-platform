/**
 * Save-path resolution tests. The file extension is not cosmetic: it decides which Playwright project
 * collects the test, which env var gates it, which timeout applies and which teardown cleans up after it
 * (architecture.md §8). A Maestro recording saved as `*.appium.ts` would silently never run under
 * `npm run test:maestro`, so every branch here is asserted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveSaveExtension } from '../src/service/testWriter.js';

const MAESTRO = { extension: '.maestro.ts', project: 'maestro', gateEnv: 'MAESTRO' };
const APPIUM = { extension: '.appium.ts', project: 'appium', gateEnv: 'APPIUM' };
const BOTH = [MAESTRO.extension, APPIUM.extension];

test('a new file gets the extension of the driver it was recorded against', () => {
  assert.deepEqual(
    resolveSaveExtension({
      relative: 'tests/login',
      mode: 'new',
      extensions: BOTH,
      binding: MAESTRO,
    }),
    { relativePath: 'tests/login.maestro.ts' },
  );
  assert.deepEqual(
    resolveSaveExtension({
      relative: 'tests/login',
      mode: 'new',
      extensions: BOTH,
      binding: APPIUM,
    }),
    { relativePath: 'tests/login.appium.ts' },
  );
});

test('a name the user already suffixed correctly is left exactly as typed', () => {
  for (const relative of ['tests/login.maestro.ts', 'tests/login.appium.ts']) {
    assert.deepEqual(
      resolveSaveExtension({ relative, mode: 'new', extensions: BOTH, binding: MAESTRO }),
      { relativePath: relative },
      'must not double-suffix a path that already names its driver',
    );
  }
});

test('append mode never rewrites the path — the file exists and its name is the user’s', () => {
  assert.deepEqual(
    resolveSaveExtension({
      relative: 'tests/existing.appium.ts',
      mode: 'append',
      extensions: BOTH,
      binding: MAESTRO,
    }),
    { relativePath: 'tests/existing.appium.ts' },
  );
  // Even an unrecognised name is preserved: `save` separately requires the target to already exist.
  assert.deepEqual(
    resolveSaveExtension({
      relative: 'tests/legacy.mobile.ts',
      mode: 'append',
      extensions: BOTH,
      binding: undefined,
    }),
    { relativePath: 'tests/legacy.mobile.ts' },
  );
});

test('with no connected driver it refuses to guess, and says how to proceed', () => {
  const result = resolveSaveExtension({
    relative: 'tests/login',
    mode: 'new',
    extensions: BOTH,
    binding: undefined,
  });

  assert.ok('error' in result, 'guessing an extension would file the test under the wrong project');
  assert.match(result.error, /connect a device/);
  assert.match(result.error, /\.maestro\.ts/, 'the message must list the valid extensions');
  assert.match(result.error, /\.appium\.ts/);
});

test('with no driver plugin installed at all the error still reads sensibly', () => {
  const result = resolveSaveExtension({
    relative: 'tests/login',
    mode: 'new',
    extensions: [],
    binding: undefined,
  });

  assert.ok('error' in result);
  assert.match(result.error, /no driver plugin installed/);
});

test('a subdirectory path keeps its directories', () => {
  assert.deepEqual(
    resolveSaveExtension({
      relative: 'tests/mobile/checkout/happy-path',
      mode: 'new',
      extensions: BOTH,
      binding: APPIUM,
    }),
    { relativePath: 'tests/mobile/checkout/happy-path.appium.ts' },
  );
});
