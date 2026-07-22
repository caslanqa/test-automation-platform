import { getPlatform } from '@pwtap/platform';

/** Whether a JDK 17+ is on PATH (Maestro requires it). `java -version` prints to stderr. */
async function javaOk(): Promise<boolean> {
  const res = await getPlatform().run('java', ['-version'], { timeoutMs: 10_000 });
  const match = /version "?(\d+)/.exec(`${res.stderr}${res.stdout}`);
  return res.code === 0 && match ? Number(match[1]) >= 17 : false;
}

/**
 * Advisory host check run after `create-pwtap add maestro` — it only warns, never throws, so a
 * missing tool can't break scaffolding. Flags the externally-installed prerequisites Maestro needs:
 * the Maestro CLI, a JDK 17+, and an Android SDK / Xcode for the platform you target.
 */
export async function ensure(): Promise<void> {
  const p = getPlatform();
  const warn = (message: string): void => console.warn(`[maestro] ${message}`);

  if (!p.which(process.env.MAESTRO_BIN || 'maestro')) {
    warn(
      'Maestro CLI not found — install it: `curl -fsSL "https://get.maestro.mobile.dev" | bash` ' +
        '(see https://maestro.mobile.dev). Then reopen your shell.',
    );
  }
  if (!(await javaOk())) {
    warn('a JDK 17+ was not detected — Maestro needs Java 17 or newer (e.g. Temurin 17).');
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
