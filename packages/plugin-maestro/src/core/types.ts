/**
 * Maestro-specific domain types. The shared device types (`DiscoveredDevice`, `MobilePlatform`) live
 * in `@pwtap/platform` so every mobile plugin discovers devices identically.
 */
import type { MobilePlatform } from '@pwtap/platform';

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

/**
 * An element selector for the imperative Maestro commands (`tapOn`, `assertVisible`, …). Either a
 * plain string — matched as Maestro's `text` (full-string, case-insensitive regex) — or a selector
 * object. Objects are passed through to Maestro verbatim, so any key its YAML accepts works; the
 * common ones are typed for convenience. Map an element's accessibility text to `text`, not a
 * separate key (see Maestro's `inspect_screen` guidance).
 */
export type MaestroSelector =
  | string
  | {
      text?: string;
      id?: string;
      index?: number;
      enabled?: boolean;
      checked?: boolean;
      focused?: boolean;
      selected?: boolean;
      below?: MaestroSelector;
      above?: MaestroSelector;
      leftOf?: MaestroSelector;
      rightOf?: MaestroSelector;
      containsChild?: MaestroSelector;
    };

/**
 * One element in a {@link MaestroScreen} tree. Keys are abbreviated exactly as Maestro's
 * `inspect_screen` emits them (documented under `ui_schema.abbreviations`), so a parsed node maps 1:1
 * to the payload. Use the `screen` query helpers (e.g. `rowValue`) rather than walking this by hand.
 */
export interface MaestroNode {
  /** bounds, `[x1,y1][x2,y2]`. */
  b?: string;
  /** text. */
  txt?: string;
  /** value — the right-hand side of a settings row. */
  val?: string;
  /** accessibilityText / content-desc. */
  a11y?: string;
  /** resource-id. */
  rid?: string;
  /** children. */
  c?: MaestroNode[];
}

/**
 * The compact view hierarchy returned by `maestro.inspectScreen()` (Maestro's `inspect_screen`
 * tool) — use it to branch in TypeScript on the live screen. `ui_schema` holds one-time key
 * abbreviations + per-platform attribute defaults; `elements` is the element tree (children nested
 * under `c`, keys abbreviated per `ui_schema`, e.g. `txt`=text, `rid`=resource-id, `a11y`=
 * accessibility text). Prefer the `screen` query helpers over hand-walking `elements`.
 */
export interface MaestroScreen {
  ui_schema?: unknown;
  elements?: MaestroNode[];
  [key: string]: unknown;
}
