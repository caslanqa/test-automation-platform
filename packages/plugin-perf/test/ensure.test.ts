/**
 * The k6 install hint, per platform.
 *
 * This exists because the first version of it hardcoded `brew install k6`, which is wrong on every Linux CI runner
 * and wrong on a Mac without Homebrew — an instruction that cannot work is worse than no instruction, because the
 * reader assumes it is their machine that is broken.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isOnPath, k6InstallHint } from '../src/ensure.js';

const nothingInstalled = (): boolean => false;
const everythingInstalled = (): boolean => true;
const only =
  (...available: string[]) =>
  (binary: string): boolean =>
    available.includes(binary);

test('macOS with Homebrew gets the brew command', () => {
  const hint = k6InstallHint('darwin', only('brew'));
  assert.match(hint, /brew install k6/);
});

test('macOS without Homebrew is told what was looked for, not just "install k6"', () => {
  const hint = k6InstallHint('darwin', nothingInstalled);
  assert.match(hint, /looked for brew/);
  assert.match(hint, /github\.com\/grafana\/k6\/releases/);
  assert.match(hint, /docker run/);
  assert.doesNotMatch(hint, /brew install/);
});

test('Debian gets the apt repository sequence, Fedora gets dnf', () => {
  assert.match(k6InstallHint('linux', only('apt-get')), /dl\.k6\.io\/deb stable main/);
  assert.match(
    k6InstallHint('linux', only('dnf')),
    /dnf install https:\/\/dl\.k6\.io\/rpm\/repo\.rpm/,
  );
});

test('a Linux box with both apt and dnf gets apt, the first listed route', () => {
  const hint = k6InstallHint('linux', only('apt-get', 'dnf'));
  assert.match(hint, /apt-get install k6/);
  assert.doesNotMatch(hint, /dnf install/);
});

test('yum is offered when dnf is absent', () => {
  const hint = k6InstallHint('linux', only('yum'));
  assert.match(hint, /sudo yum install/);
});

test('Windows prefers winget over choco, and falls back to choco', () => {
  assert.match(k6InstallHint('win32', only('winget', 'choco')), /winget install k6/);
  assert.match(k6InstallHint('win32', only('choco')), /choco install k6/);
});

test('an unknown platform says so rather than guessing a package manager', () => {
  const hint = k6InstallHint('sunos', everythingInstalled);
  assert.match(hint, /no package-manager route is known for platform "sunos"/);
  assert.match(hint, /docker run/);
});

test('every hint points at the official install docs', () => {
  for (const platform of ['darwin', 'linux', 'win32', 'sunos']) {
    for (const probe of [nothingInstalled, everythingInstalled]) {
      assert.match(k6InstallHint(platform, probe), /grafana\.com\/docs\/k6/);
    }
  }
});

test('isOnPath finds a binary that exists and not one that does not', () => {
  // `node` is running this test, so it is on PATH by definition.
  assert.equal(isOnPath('node'), true);
  assert.equal(isOnPath('pwtap-definitely-not-a-real-binary'), false);
});
