/** Mobile-testing domain types. The mobile engine is Maestro (invoked as a CLI). */

/** Supported mobile platforms. */
export type MobilePlatform = 'android' | 'ios';

/** A booted device discovered on the host (Android emulator/device or iOS simulator). */
export interface DiscoveredDevice {
  /** adb serial (e.g. `emulator-5554`) or iOS simulator UDID. */
  id: string;
  platform: MobilePlatform;
  /** Human-readable name, when known. */
  name?: string;
}

/** Options for a single Maestro flow run. */
export interface MaestroRunOptions {
  /** Device id to target (`maestro --device <id>`). */
  device: string;
  /** Target platform — used to inject the Android SDK env for Maestro when running on Android. */
  platform: MobilePlatform;
  /** Directory for Maestro artifacts (JUnit report, screenshots, debug output). */
  outputDir: string;
  /** Optional Maestro tags to include (`--include-tags`). */
  tags?: string[];
}

/** Result of a Maestro flow run (the fixture decides pass/fail from `exitCode`). */
export interface MaestroRunResult {
  /** Maestro process exit code (0 = pass). */
  exitCode: number;
  /** The directory Maestro wrote artifacts to. */
  outputDir: string;
  /** Path to the JUnit report (present only if Maestro wrote it). */
  junitPath: string;
  stdout: string;
  stderr: string;
}
