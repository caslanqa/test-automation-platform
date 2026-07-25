/**
 * Shared, driver-neutral contracts for the embedded Mobile Inspector.
 *
 * These types are consumed by:
 * - `@pwtap/plugin-maestro`'s and `@pwtap/plugin-appium`'s `./inspector` adapters (Phase 2), which
 *   implement {@link MobileInspectorDriver} / {@link DriverSession} over their existing MCP /
 *   WebdriverIO sessions;
 * - this package's unified `MobileApp` fixture (`src/fixture.ts`), which routes calls through
 *   whichever adapter is selected via `test.use({ mobile: { driver, device } })`;
 * - the local inspector service/UI and code generator (Phase 3/4), which record a driver-neutral
 *   {@link MobileAction} timeline and can replay it against any adapter.
 *
 * Keep this module free of driver-specific imports (no `@pwtap/plugin-maestro` / `@pwtap/plugin-appium`
 * dependency here) — adapters depend on this package, never the other way around.
 */
import type { MobilePlatform } from '@pwtap/platform';

/** The mobile drivers the inspector currently understands. Adapters may extend this with new ids. */
export type MobileDriverId = 'maestro' | 'appium' | (string & {});

/** A device the inspector can connect to, as reported by a driver's `discoverDevices()`. */
export interface InspectorDevice {
  /** Driver-local device id (Android AVD name / iOS simulator UDID or name). */
  id: string;
  /** Human-friendly label for the device picker. */
  name: string;
  platform: MobilePlatform;
  /** Whether the device is already booted (vs. installed-but-off). */
  booted: boolean;
}

/** An installed application discovered on a connected/selected device, for the app picker. */
export interface InstalledApp {
  /** Android package name or iOS bundle id — what `ConnectOptions.appId` expects. */
  id: string;
  /** Human-friendly label when the platform can provide one; falls back to `id`. */
  name: string;
  platform: MobilePlatform;
  /** True for OS/system-provided apps (usually hidden or de-prioritized in the picker). */
  system: boolean;
}

/** One existing recorded test file discovered under the project, for the "append" save picker. */
export interface TestFileEntry {
  /** POSIX-style path relative to the project root, e.g. `tests/login.mobile.ts`. */
  relativePath: string;
  /** Basename only, for display. */
  name: string;
}

/**
 * One ranked locator candidate for a selected element, surfaced in the right-click menu. The engine
 * (see `src/locator.ts`) returns every valid strategy for a node, each with a deterministic score so
 * the UI can present them best-first and explain why a coordinate fallback is fragile.
 */
export interface LocatorCandidate {
  /** Which strategy this candidate uses — drives its icon/label and generated code. */
  strategy: 'accessibilityId' | 'resourceId' | 'text' | 'native' | 'point';
  /** The concrete locator this candidate would generate. */
  locator: MobileLocator;
  /** 0..100 deterministic stability score (higher is better). */
  score: number;
  /** Coarse confidence band derived from `score`, for at-a-glance UI. */
  confidence: 'high' | 'medium' | 'low';
  /** Whether exactly one node in the current hierarchy matches this candidate. */
  unique: boolean;
  /** Human-readable reasons this candidate may be fragile (empty when solid). */
  warnings: string[];
  /** Ready-to-copy TypeScript locator literal, e.g. `{ accessibilityId: "loginButton" }`. */
  display: string;
}

/** Options for {@link MobileInspectorDriver.connect}. */
export interface ConnectOptions {
  platform: MobilePlatform;
  /** Device id/name to target; when omitted, connect to an already-booted device for `platform`. */
  device?: string;
  /** Boot the device hidden (no simulator/emulator window) if it needs to be started. */
  headless?: boolean;
  /**
   * Android package name / iOS bundle id of the app to launch on connect. When `appSource` is also
   * given, this is the id the installed artifact registers as (used to launch it after install).
   * Optional for Appium (an omitted `appId` just attaches to whatever is already foregrounded, e.g.
   * the home screen) but effectively REQUIRED for Maestro: its MCP session scopes every single
   * command (including `tap`/`back`) to an app id and throws until `launchApp` has been called, so
   * without this the Maestro adapter cannot perform any action at all.
   */
  appId?: string;
  /**
   * Local build artifact path or http(s) URL (`.apk`/`.app`/`.ipa`/`.zip`-of-`.app`) to install
   * before launching. Omit when `appId` is already installed on the device. Appium installs this
   * itself via its `app` capability; Maestro has no install primitive of its own, so its adapter
   * installs it first (via the same `adb install` / `simctl install` helper the plugin's fixture
   * already uses) and then launches `appId`.
   */
  appSource?: string;
}

/**
 * A driver-neutral element locator. Exactly one strategy should be set; adapters translate whichever
 * is present into their native selector. The recorder ranks and fills these in order of stability
 * (see `plan.md`'s "Locator candidates are ranked" section) — accessibility id first, coordinates last.
 */
export interface MobileLocator {
  /** Accessibility id / content-desc / a11y label — the most stable cross-platform strategy. */
  accessibilityId?: string;
  /** Platform resource/name id (Android `resource-id`, iOS `name`). */
  resourceId?: string;
  /** Visible text (Maestro-style full-string, case-insensitive match). */
  text?: string;
  /** Platform-native selector escape hatch (e.g. an XPath or a Maestro selector object). */
  native?: unknown;
  /** Last-resort coordinate fallback — flagged fragile by the locator engine. */
  point?: { x: number; y: number };
  /** Free-form human label shown in the UI/generated code comment. */
  label?: string;
}

/** Cardinal direction for swipe/scroll gestures. */
export type MobileDirection = 'up' | 'down' | 'left' | 'right';

export interface LongPressOptions {
  durationMs?: number;
}

export interface SwipeOptions {
  /** 0..1 fraction of the screen the swipe should cover; adapter-specific default otherwise. */
  distance?: number;
  durationMs?: number;
}

export interface ScrollOptions {
  /** Locator of the scrollable container; omit to scroll the whole screen. */
  within?: MobileLocator;
}

/** A point-like target: a locator (resolved to its center) or explicit coordinates. */
export type MobileTarget = MobileLocator | { x: number; y: number };

export interface PinchOptions {
  durationMs?: number;
}

/** Keys the inspector can send via {@link MobileApp.pressKey}. */
export type MobileKey = 'back' | 'home' | 'enter' | 'volumeUp' | 'volumeDown' | (string & {});

export interface WaitOptions {
  timeoutMs?: number;
}

/**
 * The unified, Playwright-style runtime facade generated tests use. One implementation per selected
 * driver (see `src/fixture.ts`); existing `maestro`/`app` (raw WebdriverIO) fixtures are unaffected.
 */
export interface MobileApp {
  tap(locator: MobileLocator): Promise<void>;
  fill(locator: MobileLocator, value: string): Promise<void>;
  longPress(locator: MobileLocator, options?: LongPressOptions): Promise<void>;
  swipe(direction: MobileDirection, options?: SwipeOptions): Promise<void>;
  scroll(direction: MobileDirection, options?: ScrollOptions): Promise<void>;
  drag(from: MobileTarget, to: MobileTarget): Promise<void>;
  pinch(scale: number, options?: PinchOptions): Promise<void>;
  pressKey(key: MobileKey): Promise<void>;
  back(): Promise<void>;
  waitFor(locator: MobileLocator, options?: WaitOptions): Promise<void>;
  isVisible(locator: MobileLocator): Promise<boolean>;
  /** Save a screenshot and return its absolute path. */
  screenshot(name?: string): Promise<string>;
}

/** One normalized node in a device's UI hierarchy — Maestro's compact tree and Appium's XML both map here. */
export interface MobileNode {
  /** Bounds in the frame's interaction coordinate space. */
  bounds?: { x: number; y: number; width: number; height: number };
  text?: string;
  accessibilityId?: string;
  resourceId?: string;
  className?: string;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;
  children?: MobileNode[];
}

/** A captured device screen frame for the live viewport. */
export interface ScreenFrame {
  /** Monotonically increasing id — used to reject stale taps against an outdated frame. */
  frameId: number;
  /** PNG screenshot, base64-encoded. */
  imageBase64: string;
  /** Device pixel dimensions of `imageBase64`, for coordinate transforms in the UI. */
  width: number;
  height: number;
  /**
   * Coordinate space used by hierarchy bounds and pointer actions. This can differ from the encoded
   * image size (Maestro scales screenshots; iOS screenshots use Retina pixels while XCTest uses
   * logical points).
   */
  coordinateWidth?: number;
  coordinateHeight?: number;
  /** Device orientation at capture time. */
  orientation: 'portrait' | 'landscape';
  capturedAt: number;
}

/** The driver-neutral action IR — every recorded interaction and every generated statement. */
export type MobileAction =
  | { kind: 'tap'; locator: MobileLocator }
  | { kind: 'fill'; locator: MobileLocator; value: string }
  | { kind: 'longPress'; locator: MobileLocator; options?: LongPressOptions }
  | { kind: 'swipe'; direction: MobileDirection; options?: SwipeOptions }
  | { kind: 'scroll'; direction: MobileDirection; options?: ScrollOptions }
  | { kind: 'drag'; from: MobileTarget; to: MobileTarget }
  | { kind: 'pinch'; scale: number; options?: PinchOptions }
  | { kind: 'pressKey'; key: MobileKey }
  | { kind: 'back' }
  | { kind: 'waitFor'; locator: MobileLocator; options?: WaitOptions }
  | { kind: 'assertVisible'; locator: MobileLocator }
  | { kind: 'assertNotVisible'; locator: MobileLocator }
  | { kind: 'screenshot'; name?: string }
  | { kind: 'aiAssert'; rubric: string; name?: string };

/** Result of executing one {@link MobileAction} through a {@link DriverSession}. */
export interface ActionResult {
  ok: boolean;
  /** Populated for `screenshot`/`aiAssert` actions and for `isVisible`-style checks. */
  value?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * What a driver can and cannot do. The inspector UI must consult this rather than assume parity —
 * unsupported actions are disabled with an explanation, never silently downgraded (see `plan.md`'s
 * "Do not hide driver capability gaps").
 */
export interface DriverCapabilities {
  gestures: Partial<Record<MobileAction['kind'], boolean>>;
  /** Whether `inspectHierarchy()` returns a real tree (vs. screenshot-only). */
  hierarchy: boolean;
  /** Whether the driver can stream/poll live frames cheaply enough for continuous preview. */
  liveFrames: boolean;
}

/** A live, connected driver session — one per inspector recording session. */
export interface DriverSession {
  readonly driverId: MobileDriverId;
  readonly device: InspectorDevice;
  captureScreen(): Promise<ScreenFrame>;
  inspectHierarchy(): Promise<MobileNode[]>;
  perform(action: MobileAction): Promise<ActionResult>;
  close(): Promise<void>;
}

/** A driver adapter, discovered from an installed plugin's `./inspector` export. */
export interface MobileInspectorDriver {
  readonly id: MobileDriverId;
  readonly capabilities: DriverCapabilities;
  discoverDevices(): Promise<InspectorDevice[]>;
  connect(options: ConnectOptions): Promise<DriverSession>;
}

/** Thrown when a `MobileAction` isn't supported by the connected driver's capabilities. */
export class UnsupportedActionError extends Error {
  constructor(
    public readonly driverId: MobileDriverId,
    public readonly kind: MobileAction['kind'],
  ) {
    super(`[mobile-inspector] driver "${driverId}" does not support "${kind}" actions`);
    this.name = 'UnsupportedActionError';
  }
}

/** Thrown when no inspector driver adapter could be resolved (neither plugin installed, or bad id). */
export class DriverNotFoundError extends Error {
  constructor(driverId: string) {
    super(
      `[mobile-inspector] no driver adapter found for "${driverId}" — install ` +
        '@pwtap/plugin-maestro or @pwtap/plugin-appium (whichever exposes this driver id)',
    );
    this.name = 'DriverNotFoundError';
  }
}
