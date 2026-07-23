/** OS identifiers the platform seam can represent. Only 'macos' is implemented today. */
export type OsId = 'macos' | 'windows' | 'linux';

/** A mobile platform a device belongs to. */
export type MobilePlatform = 'android' | 'ios';

export interface RunOptions {
  /** Kill the process after this many ms (default 15000). */
  timeoutMs?: number;
  /** Environment for the child process (defaults to the current process env). */
  env?: NodeJS.ProcessEnv;
  /** Working directory. */
  cwd?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code; 0 on success. A non-zero exit or a missing binary is reported here, never thrown. */
  code: number;
}

/** A booted device the framework can target. */
export interface DiscoveredDevice {
  /** adb serial (Android) or simulator UDID (iOS). */
  id: string;
  platform: MobilePlatform;
  /** Human-friendly name (AVD name / simulator name), when known. */
  name?: string;
}

/** A running screen recording, returned by `startAndroidRecording`/`startSimRecording`. */
export interface ScreenRecording {
  /**
   * Stop recording and finalize the video at the path it was started with. Best-effort — never
   * throws; returns whether a playable file was actually produced.
   */
  stop(): Promise<boolean>;
}

/**
 * The single OS seam. Every OS-specific command/path lives behind this interface, so supporting
 * another OS later means adding one implementation + one branch in `getPlatform()` — no changes to
 * plugins or the scaffolded core.
 */
export interface Platform {
  readonly os: OsId;
  homedir(): string;
  /** Resolve a command to an absolute path (PATH lookup), or `undefined` if not found. */
  which(cmd: string): string | undefined;
  /** Run a binary to completion. Never throws — a non-zero exit or missing binary lands in `code`. */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;

  // --- Android SDK resolution ---
  androidSdkRoot(): string | undefined;
  adbPath(): string;
  emulatorPath(): string;
  /** Env with `ANDROID_HOME`/`ANDROID_SDK_ROOT` set and `platform-tools` on PATH (when a SDK is found). */
  androidEnv(): NodeJS.ProcessEnv;

  // --- iOS simulator ---
  simctl(args: string[], opts?: RunOptions): Promise<RunResult>;
  openSimulatorApp(): Promise<void>;
  quitSimulatorApp(): Promise<void>;
}
