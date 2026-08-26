/**
 * Configuration reading, and the one rule that outranks every other: **`off` unless asked**.
 *
 * The env-file loader gets its own assertions because it is a second copy of the client template's
 * `config/loadEnv.ts` semantics, and a copy that drifts is worse than no copy — a `${TEST_ENV.X}` token
 * that silently resolves to empty here but not there would send results to the wrong project.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadEnvFile, readConfig, runTitle } from '../src/config.js';

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function projectWith(envFile: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-tms-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'env'));
  fs.writeFileSync(path.join(dir, 'env', 'environments.json'), JSON.stringify(envFile), 'utf8');
  return dir;
}

/** Run `body` with a scratch `process.env`, restored afterwards. */
function withEnv(env: NodeJS.ProcessEnv, body: () => void): void {
  const saved = process.env;
  process.env = { ...env };
  try {
    body();
  } finally {
    process.env = saved;
  }
}

test('mode is off unless TMS_MODE is exactly testops', () => {
  assert.equal(readConfig({}).mode, 'off');
  assert.equal(readConfig({ TMS_MODE: '' }).mode, 'off');
  assert.equal(readConfig({ TMS_MODE: 'on' }).mode, 'off');
  assert.equal(readConfig({ TMS_MODE: 'TestOps' }).mode, 'testops');
  assert.equal(readConfig({ TMS_MODE: ' testops ' }).mode, 'testops');
});

test('provider defaults to qase, and an empty value is not a provider name', () => {
  assert.equal(readConfig({}).provider, 'qase');
  assert.equal(readConfig({ TMS_PROVIDER: '  ' }).provider, 'qase');
  assert.equal(readConfig({ TMS_PROVIDER: 'testrail' }).provider, 'testrail');
});

test('the run title names the branch, the sha and the environment', () => {
  const config = readConfig({ TEST_ENV: 'staging' });
  assert.equal(runTitle(config, { branch: 'main', sha: 'a1b2c3d' }), 'main · a1b2c3d · staging');
  assert.equal(runTitle(config, { branch: '', sha: '' }), 'staging');
  assert.equal(runTitle(readConfig({}), { branch: '', sha: '' }), 'Playwright run');
});

test('loadEnvFile flattens common and the selected environment block', () => {
  const dir = projectWith({
    common: { QASE_TESTOPS_PROJECT: 'DEMO', DEFAULT_TEST_ENV: 'dev' },
    environments: {
      dev: { BASE_URL: 'https://dev.example.com' },
      prod: { BASE_URL: 'https://example.com' },
    },
  });

  withEnv({}, () => {
    assert.equal(loadEnvFile(dir), 'dev');
    assert.equal(process.env.QASE_TESTOPS_PROJECT, 'DEMO');
    assert.equal(process.env.BASE_URL, 'https://dev.example.com');
    assert.equal(process.env.TEST_ENV, 'dev');
  });
});

test('TEST_ENV selects the block, and ${TEST_ENV.X} tokens resolve against it', () => {
  const dir = projectWith({
    common: { API_URL: '${TEST_ENV.BASE_URL}/api', MISSING: '${TEST_ENV.NOPE}!' },
    environments: { prod: { BASE_URL: 'https://example.com' } },
  });

  withEnv({ TEST_ENV: 'prod' }, () => {
    loadEnvFile(dir);
    assert.equal(process.env.API_URL, 'https://example.com/api');
    assert.equal(
      process.env.MISSING,
      '!',
      'an unknown token degrades to empty rather than crashing',
    );
  });
});

test('an exported variable always wins over the file', () => {
  const dir = projectWith({ common: { QASE_TESTOPS_PROJECT: 'FROMFILE' } });

  withEnv({ QASE_TESTOPS_PROJECT: 'FROMCI' }, () => {
    loadEnvFile(dir);
    assert.equal(process.env.QASE_TESTOPS_PROJECT, 'FROMCI');
  });
});

test('a camelCase key becomes SCREAMING_SNAKE_CASE, and a documentation key is skipped', () => {
  const dir = projectWith({ common: { qaseTestopsProject: 'DEMO', _note: 'ignore me' } });

  withEnv({}, () => {
    loadEnvFile(dir);
    assert.equal(process.env.QASE_TESTOPS_PROJECT, 'DEMO');
    assert.equal(process.env._NOTE, undefined);
  });
});

test('a missing or malformed env file is not an error — the caller may be fully env-configured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-tms-'));
  dirs.push(dir);
  withEnv({}, () => {
    assert.equal(loadEnvFile(dir), '');
  });

  fs.mkdirSync(path.join(dir, 'env'));
  fs.writeFileSync(path.join(dir, 'env', 'environments.json'), '{ not json', 'utf8');
  withEnv({}, () => {
    assert.equal(loadEnvFile(dir), '');
  });
});
