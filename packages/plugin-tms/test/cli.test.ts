/**
 * The CLI, driven as a function rather than a process — `run(argv, cwd)` is a pure function of those
 * two things, which is the whole reason `bin/tms.mjs` is three lines.
 *
 * The network is never reached: every case here either fails before it would, or exercises the run-id
 * file, which is local by design.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { run } from '../src/cli/index.js';
import { DEFAULT_RUN_ID_FILE, readRunId, RUN_ID_KEY, writeRunId } from '../src/cli/runId.js';

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-tms-cli-'));
  dirs.push(dir);
  return dir;
}

/**
 * Swallow stdout/stderr for the duration, and hand back what was written.
 *
 * The environment is scrubbed of every `TMS_*` and `QASE_*` key first: a developer with real credentials
 * exported would otherwise make these tests reach the network, and the CI machine that has none would
 * pass while theirs failed. `TMS_MODE=off` is then the one thing set, so nothing here can publish.
 */
async function captured(body: () => Promise<number>): Promise<{ code: number; out: string }> {
  let text = '';
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const collect = (chunk: string | Uint8Array): boolean => {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  process.stdout.write = collect as typeof process.stdout.write;
  process.stderr.write = collect as typeof process.stderr.write;

  const savedEnv = process.env;
  const scrubbed = Object.fromEntries(
    Object.entries(savedEnv).filter(([key]) => !key.startsWith('TMS_') && !key.startsWith('QASE_')),
  );
  process.env = { ...scrubbed, TMS_MODE: 'off' };
  try {
    return { code: await body(), out: text };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    process.env = savedEnv;
  }
}

test('no command prints usage and exits 2', async () => {
  const { code, out } = await captured(() => run([], scratch()));
  assert.equal(code, 2);
  assert.match(out, /tms doctor/);
});

test('an unknown command names itself', async () => {
  const { code, out } = await captured(() => run(['sunc'], scratch()));
  assert.equal(code, 2);
  assert.match(out, /unknown command "sunc"/);
});

test('tms run without a subcommand says which two exist', async () => {
  const { code, out } = await captured(() => run(['run'], scratch()));
  assert.equal(code, 2);
  assert.match(out, /expected "create" or "complete"/);
});

test('run complete with no id anywhere refuses rather than guessing', async () => {
  const { code, out } = await captured(() => run(['run', 'complete'], scratch()));
  assert.equal(code, 2);
  assert.match(out, /no run id/);
});

test('doctor reports missing configuration without touching the network', async () => {
  const dir = scratch();
  const { code, out } = await captured(() => run(['doctor'], dir));
  assert.equal(code, 1);
  assert.match(out, /provider {5}qase/);
  assert.match(out, /mode {9}off/);
  assert.match(out, /missing: QASE_TESTOPS_API_TOKEN, QASE_TESTOPS_PROJECT/);
});

test('an unknown provider is named, and the known ones are listed', async () => {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, 'env'));
  fs.writeFileSync(
    path.join(dir, 'env', 'environments.json'),
    JSON.stringify({ common: { TMS_PROVIDER: 'testrail' } }),
    'utf8',
  );
  const { code, out } = await captured(() => run(['doctor'], dir));
  assert.equal(code, 1);
  assert.match(out, /unknown TMS_PROVIDER "testrail"/);
  assert.match(out, /known providers: qase/);
});

test('the run id file round-trips and leaves other keys alone', () => {
  const file = path.join(scratch(), DEFAULT_RUN_ID_FILE);
  fs.writeFileSync(file, 'OTHER=keep\n', 'utf8');

  writeRunId(file, '1234');
  assert.equal(readRunId(file), '1234');
  assert.match(fs.readFileSync(file, 'utf8'), /OTHER=keep/);

  writeRunId(file, '5678');
  assert.equal(readRunId(file), '5678');
  assert.equal(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.startsWith(`${RUN_ID_KEY}=`)).length,
    1,
    'a second create replaces the id rather than appending a line the reader would never reach',
  );
});

test('reading a run id from a file that has none is undefined, not empty string', () => {
  const file = path.join(scratch(), DEFAULT_RUN_ID_FILE);
  assert.equal(readRunId(file), undefined);
  fs.writeFileSync(file, `${RUN_ID_KEY}=\n`, 'utf8');
  assert.equal(readRunId(file), undefined);
});
