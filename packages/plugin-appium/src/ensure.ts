import { getPlatform } from '@pwtap/platform';

/** Whether `appium driver list --installed` reports `name` as installed (best-effort text search). */
async function driverInstalled(bin: string, name: string): Promise<boolean> {
  const res = await getPlatform().run(bin, ['driver', 'list', '--installed'], {
    timeoutMs: 15_000,
  });
  // Appium's CLI logs the driver list to stderr (its spinner/logger output), not stdout.
  return res.code === 0 && `${res.stdout}${res.stderr}`.toLowerCase().includes(name);
}

/**
 * Advisory host check run after `create-pwtap add appium` — it only warns, never throws, so a
 * missing tool can't break scaffolding. Flags the externally-installed prerequisites Appium needs:
 * the Appium CLI, the `uiautomator2`/`xcuitest` drivers, and an Android SDK / Xcode for the platform
 * you target.
 */
export async function ensure(): Promise<void> {
  const p = getPlatform();
  const warn = (message: string): void => console.warn(`[appium] ${message}`);
  const bin = process.env.APPIUM_BIN || 'appium';

  if (!p.which(bin)) {
    warn(
      `Appium CLI not found ('${bin}' not on PATH) — install it: npm install -g appium ` +
        '(see https://appium.io).',
    );
    return; // driver checks below need the CLI itself
  }
  if (!(await driverInstalled(bin, 'uiautomator2'))) {
    warn(
      'the UiAutomator2 driver is not installed — needed for Android: appium driver install uiautomator2',
    );
  }
  if (!(await driverInstalled(bin, 'xcuitest'))) {
    warn('the XCUITest driver is not installed — needed for iOS: appium driver install xcuitest');
  }
  if (!p.androidSdkRoot() && !p.which('adb')) {
    warn(
      'Android SDK / adb not found — needed for Android runs. Install Android Studio or set ANDROID_HOME.',
    );
  }
  if (!p.which('xcrun')) {
    warn('Xcode command-line tools not found — needed for iOS simulator runs. Install Xcode.');
  }
}
