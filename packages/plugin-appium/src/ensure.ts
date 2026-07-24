import { getPlatform } from '@pwtap/platform';

const DRIVER_INSTALL_TIMEOUT_MS = 3 * 60_000;

/** Whether `appium driver list --installed` reports `name` as installed (best-effort text search). */
async function driverInstalled(bin: string, name: string): Promise<boolean> {
  const res = await getPlatform().run(bin, ['driver', 'list', '--installed'], {
    timeoutMs: 15_000,
  });
  // Appium's CLI logs the driver list to stderr (its spinner/logger output), not stdout.
  return res.code === 0 && `${res.stdout}${res.stderr}`.toLowerCase().includes(name);
}

/** Install a missing Appium driver — best-effort; a failure just falls back to an actionable warning. */
async function installDriver(
  bin: string,
  name: string,
  warn: (message: string) => void,
): Promise<void> {
  console.info(`[appium] installing the ${name} driver (appium driver install ${name})…`);
  const res = await getPlatform().run(bin, ['driver', 'install', name], {
    timeoutMs: DRIVER_INSTALL_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    warn(
      `failed to install the ${name} driver automatically — install it manually: ` +
        `appium driver install ${name}`,
    );
  }
}

/**
 * Advisory host check run after `create-pwtap add appium`. For the Appium drivers specifically, it
 * doesn't just warn — it installs the missing ones (`appium driver install uiautomator2` / `xcuitest`)
 * automatically, since a missing driver deterministically fails every session on that platform with
 * the same confusing WebDriver error ("Could not find a driver for automationName…"). Everything else
 * here (the Appium CLI itself, Android SDK / Xcode) only warns, never throws, so a missing tool can't
 * break scaffolding.
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
    await installDriver(bin, 'uiautomator2', warn);
  }
  if (!(await driverInstalled(bin, 'xcuitest'))) {
    await installDriver(bin, 'xcuitest', warn);
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
