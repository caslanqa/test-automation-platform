/**
 * Parsing the foreground app out of `dumpsys window`.
 *
 * Found in the field: connecting the Maestro driver without an app id produced a session that could show the
 * screen and perform nothing, failing every interaction with an internal message. The fix adopts whatever app
 * the user is looking at, which makes this parse the thing standing between a working session and a broken
 * one — and `dumpsys` output varies enough (transient windows, no focus at all) to be worth pinning down.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { foregroundAndroidApp } from '../src/device/android.js';
import { setPlatform } from '../src/platform.js';
import type { Platform, RunResult } from '../src/types.js';

/** A Platform that answers `adb shell dumpsys window` with `stdout` and nothing else. */
function platformReturning(stdout: string, code = 0): Platform {
  const result: RunResult = { stdout, stderr: '', code };
  return {
    os: 'macos',
    homedir: () => '/home',
    which: () => undefined,
    run: async () => result,
    androidSdkRoot: () => '/sdk',
    adbPath: () => '/sdk/platform-tools/adb',
    emulatorPath: () => '/sdk/emulator/emulator',
    androidEnv: () => ({}),
    simctl: async () => result,
    openSimulatorApp: async () => undefined,
    quitSimulatorApp: async () => undefined,
  } as Platform;
}

after(() => setPlatform(undefined));

test('the focused window names the app', async () => {
  setPlatform(
    platformReturning(
      '  mCurrentFocus=Window{b53e25 u0 com.android.settings/com.android.settings.homepage.SettingsHomepageActivity}',
    ),
  );

  assert.equal(await foregroundAndroidApp('emulator-5554'), 'com.android.settings');
});

test('a transient window leaves mCurrentFocus unset, so mFocusedApp answers', async () => {
  setPlatform(
    platformReturning(
      [
        '  mCurrentFocus=null',
        '  mFocusedApp=ActivityRecord{fb1 u0 com.example.app/.MainActivity t213}',
      ].join('\n'),
    ),
  );

  assert.equal(await foregroundAndroidApp('emulator-5554'), 'com.example.app');
});

test('nothing focused reports nothing, rather than guessing', async () => {
  setPlatform(platformReturning('  mCurrentFocus=null\n  mFocusedApp=null'));

  assert.equal(await foregroundAndroidApp('emulator-5554'), undefined);
});

test('a failed adb call reports nothing', async () => {
  setPlatform(platformReturning('', 1));

  assert.equal(await foregroundAndroidApp('emulator-5554'), undefined);
});
