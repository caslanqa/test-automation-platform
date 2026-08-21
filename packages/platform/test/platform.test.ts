/**
 * The host seam: which SDK a host looks for, what it does with the tools it finds, and what the Linux host
 * answers when asked about iOS. The Android emulator moved to Linux CI runners for the hypervisor, so these are
 * the paths that decide whether adb is found there at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { LinuxPlatform, MacPlatform, getPlatform, setPlatform } from '../src/platform.js';

let sdk: string;
const saved = { ...process.env };

/** A fake SDK tree with the two tools the framework resolves out of it. */
function fakeSdk(root: string): string {
  for (const [subdir, name] of [
    ['platform-tools', 'adb'],
    ['emulator', 'emulator'],
  ]) {
    fs.mkdirSync(path.join(root, subdir), { recursive: true });
    fs.writeFileSync(path.join(root, subdir, name), '');
  }
  return root;
}

beforeEach(() => {
  sdk = fakeSdk(fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-sdk-')));
  delete process.env.ANDROID_HOME;
  delete process.env.ANDROID_SDK_ROOT;
});

afterEach(() => {
  fs.rmSync(sdk, { recursive: true, force: true });
  process.env = { ...saved };
  setPlatform(undefined);
});

test('each host names itself', () => {
  assert.equal(new MacPlatform().os, 'macos');
  assert.equal(new LinuxPlatform().os, 'linux');
});

test('ANDROID_HOME wins over the host default, on both hosts', () => {
  process.env.ANDROID_HOME = sdk;
  for (const platform of [new MacPlatform(), new LinuxPlatform()]) {
    assert.equal(platform.androidSdkRoot(), sdk);
    assert.equal(platform.adbPath(), path.join(sdk, 'platform-tools', 'adb'));
    assert.equal(platform.emulatorPath(), path.join(sdk, 'emulator', 'emulator'));
  }
});

test('a Linux host falls back to the runner SDK path when the env says nothing', () => {
  // The candidate list is what makes adb resolvable on a runner image that stopped exporting ANDROID_HOME.
  const linux = new LinuxPlatform();
  const candidates = (linux as unknown as { androidSdkCandidates(): Array<string | undefined> })
    .androidSdkCandidates()
    .filter((dir): dir is string => Boolean(dir));
  assert.ok(candidates.includes(path.join(os.homedir(), 'Android', 'Sdk')));
  assert.ok(candidates.includes('/usr/local/lib/android/sdk'));
  assert.ok(
    !candidates.some(dir => dir.includes('Library/Android')),
    'the macOS location has no business in a Linux search',
  );
});

test('a missing SDK leaves the bare tool names, so PATH still decides', () => {
  // Every candidate has to be absent for this to mean anything, and a host cannot be assumed to lack an SDK:
  // the first version of this test only emptied ANDROID_HOME and passed here while failing on a GitHub runner,
  // where /usr/local/lib/android/sdk exists and the fallback correctly found it.
  class NoSdkHost extends LinuxPlatform {
    protected override androidSdkCandidates(): Array<string | undefined> {
      return [path.join(sdk, 'nope'), path.join(sdk, 'also-nope')];
    }
  }
  const platform = new NoSdkHost();
  assert.equal(platform.androidSdkRoot(), undefined);
  assert.equal(platform.adbPath(), 'adb');
  assert.equal(platform.emulatorPath(), 'emulator');
  assert.equal(platform.androidEnv(), process.env, 'no SDK means no env to synthesize');
});

test('androidEnv puts platform-tools on PATH without dropping the rest of it', () => {
  process.env.ANDROID_HOME = sdk;
  process.env.PATH = '/usr/bin';
  const env = new LinuxPlatform().androidEnv();
  assert.equal(env.ANDROID_HOME, sdk);
  assert.equal(env.ANDROID_SDK_ROOT, sdk);
  assert.equal(env.PATH, `${path.join(sdk, 'platform-tools')}${path.delimiter}/usr/bin`);
});

test('asking a Linux host about iOS fails with a reason, and never throws', async () => {
  const linux = new LinuxPlatform();
  const result = await linux.simctl(['list', 'devices', '-j']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /iOS simulators need macOS/);
  // Discovery and the pickers call these unconditionally; a throw would take down a UI that was only asking.
  await linux.openSimulatorApp();
  await linux.quitSimulatorApp();
});

test('run reports a missing binary instead of throwing', async () => {
  const result = await new LinuxPlatform().run(path.join(sdk, 'not-a-binary'), []);
  assert.equal(result.code, 1);
  assert.notEqual(result.stderr, '');
});

test('which finds a real binary and returns undefined for nonsense', () => {
  const platform = getPlatform();
  assert.ok(platform.which('node')?.length);
  assert.equal(platform.which('pwtap-definitely-not-a-command'), undefined);
});

test('getPlatform follows the host, and caches one instance', () => {
  const platform = getPlatform();
  assert.equal(platform.os, process.platform === 'darwin' ? 'macos' : 'linux');
  assert.equal(getPlatform(), platform);
});

test('an unsupported host names the file to add', () => {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    setPlatform(undefined);
    assert.throws(() => getPlatform(), /no Platform implementation for 'win32'.*win32\.ts/s);
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
    setPlatform(undefined);
  }
});

test('a Linux host is selected on Linux, whatever host runs this test', () => {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    setPlatform(undefined);
    assert.equal(getPlatform().os, 'linux');
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
    setPlatform(undefined);
  }
});
