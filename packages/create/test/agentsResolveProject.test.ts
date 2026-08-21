/**
 * Project resolution. A marketplace `command` source runs from the user's home directory and is not
 * one of the contexts that receives CLAUDE_PROJECT_DIR, so the chain — and the registry that backs
 * it — is the only reason capability gating can work at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { recordProject, registryPath, resolveProject } from '../src/agents/project.js';

const ENV_KEYS = ['PWTAP_HOME', 'PWTAP_PROJECT', 'CLAUDE_PROJECT_DIR'] as const;

let saved: Record<string, string | undefined>;
let home: string;
const dirs: string[] = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-home-'));
  dirs.push(home);
  process.env.PWTAP_HOME = home;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

const projectDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-proj-'));
  dirs.push(dir);
  return dir;
};

test.after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with nothing set at all, there is no project — a baseline render, not a failure', () => {
  assert.deepEqual(resolveProject(), { dir: null, source: 'none' });
});

test('--project wins over everything else', () => {
  const explicit = projectDir();
  process.env.PWTAP_PROJECT = projectDir();
  process.env.CLAUDE_PROJECT_DIR = projectDir();
  recordProject(projectDir());
  assert.deepEqual(resolveProject(explicit), { dir: explicit, source: '--project' });
});

test('PWTAP_PROJECT beats CLAUDE_PROJECT_DIR and the registry', () => {
  const wanted = projectDir();
  process.env.PWTAP_PROJECT = wanted;
  process.env.CLAUDE_PROJECT_DIR = projectDir();
  recordProject(projectDir());
  assert.deepEqual(resolveProject(), { dir: wanted, source: 'PWTAP_PROJECT' });
});

test('CLAUDE_PROJECT_DIR is used when present, and beats the registry', () => {
  const wanted = projectDir();
  process.env.CLAUDE_PROJECT_DIR = wanted;
  recordProject(projectDir());
  assert.deepEqual(resolveProject(), { dir: wanted, source: 'CLAUDE_PROJECT_DIR' });
});

test('an empty or whitespace env var counts as absent, not as the empty path', () => {
  process.env.PWTAP_PROJECT = '';
  process.env.CLAUDE_PROJECT_DIR = '   ';
  assert.deepEqual(resolveProject(), { dir: null, source: 'none' });
  assert.deepEqual(resolveProject(''), { dir: null, source: 'none' });
});

test('a relative --project is resolved to an absolute path', () => {
  const result = resolveProject('.');
  assert.equal(result.dir, path.resolve('.'));
});

test('one registered project is the common case and is used directly', () => {
  const only = projectDir();
  recordProject(only);
  assert.deepEqual(resolveProject(), { dir: only, source: 'registry' });
});

test('with several registered projects, the most recently seen wins', () => {
  const older = projectDir();
  const newer = projectDir();
  recordProject(older, 1_000);
  recordProject(newer, 2_000);
  assert.equal(resolveProject().dir, newer);

  // Re-registering the older one moves it to the front rather than duplicating it.
  recordProject(older, 3_000);
  assert.equal(resolveProject().dir, older);
  const registry = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as {
    projects: Array<{ dir: string }>;
  };
  assert.deepEqual(
    registry.projects.map(entry => entry.dir),
    [older, newer],
  );
});

test('a registered project that no longer exists is skipped and pruned', () => {
  const alive = projectDir();
  const gone = projectDir();
  recordProject(alive, 1_000);
  recordProject(gone, 2_000);
  fs.rmSync(gone, { recursive: true, force: true });

  assert.deepEqual(resolveProject(), { dir: alive, source: 'registry' });
  recordProject(alive, 3_000);
  const registry = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as {
    projects: Array<{ dir: string }>;
  };
  assert.deepEqual(
    registry.projects.map(entry => entry.dir),
    [alive],
  );
});

test('a corrupt registry resolves to nothing rather than throwing', () => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(registryPath(), 'not json at all');
  assert.deepEqual(resolveProject(), { dir: null, source: 'none' });
});

test('a registry of the wrong shape is ignored entry by entry', () => {
  const alive = projectDir();
  fs.writeFileSync(
    registryPath(),
    JSON.stringify({ projects: [{ dir: 42 }, { dir: alive, lastSeen: 5 }, { lastSeen: 9 }] }),
  );
  assert.deepEqual(resolveProject(), { dir: alive, source: 'registry' });
});

test('recordProject never throws, even when the home directory cannot be written', () => {
  // A file where the directory should be: mkdirSync then fails, which is the read-only-$HOME case.
  const blocked = path.join(os.tmpdir(), `pwtap-blocked-${process.pid}`);
  fs.writeFileSync(blocked, 'not a directory');
  dirs.push(blocked);
  process.env.PWTAP_HOME = blocked;
  assert.doesNotThrow(() => recordProject(projectDir()));
});
