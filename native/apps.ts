import type { NativePlatform } from './core/types';

/** A launchable native app in the project's catalog. */
export interface NativeAppSpec {
  /** Target platform for this app. */
  platform?: NativePlatform;
  /** macOS: bundle identifier (e.g. `com.apple.TextEdit`). */
  bundleId?: string;
  /** macOS: absolute path to a `.app` bundle (or a Windows `.exe` path). */
  appPath?: string;
  /** Windows: app id (AUMID) or `.exe` path (falls back to `appPath`). */
  windowsApp?: string;
  /** Extra CLI args. */
  args?: string[];
  /** Extra environment variables (macOS). */
  env?: Record<string, string>;
}

/**
 * The project's native desktop app catalog — the single place launch configs live. Reference an entry
 * by name in a test:
 *
 * @example
 * import { test } from '@fixtures/nativeFixtures';
 * test.use({ native: { app: 'textEdit' } }); // type-checked — only entries defined here are selectable
 *
 * Add your own app: point `bundleId`/`appPath` (macOS) or `windowsApp`/`appPath` (Windows) at it. See
 * docs/NATIVE_TESTING.md.
 */
export const apps = {
  // Built-in OS apps every machine has, so the layer runs out-of-box on each platform's example test.
  textEdit: { platform: 'mac', bundleId: 'com.apple.TextEdit' },
  notepad: { platform: 'windows', appPath: 'C:/Windows/System32/notepad.exe' },
} as const satisfies Record<string, NativeAppSpec>;
