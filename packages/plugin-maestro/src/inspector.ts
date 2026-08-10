/**
 * Mobile Inspector driver adapter for Maestro. Implements `@pwtap/mobile-inspector`'s
 * `MobileInspectorDriver`/`DriverSession` over the existing `MaestroMcpSession` (MCP) and
 * `@pwtap/platform` device lifecycle — no inspector-specific device/session logic is duplicated here.
 * Exposed via this package's `"./inspector"` export so the shared registry can discover it without
 * any Maestro-specific code living in `@pwtap/mobile-inspector` itself.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  ActionResult,
  AdapterContract,
  ConnectOptions,
  DriverCapabilities,
  DriverSession,
  InspectorDevice,
  MobileAction,
  MobileDirection,
  MobileInspectorDriver,
  MobileLocator,
  MobileNode,
  ScreenFrame,
} from '@pwtap/mobile-core';
import {
  ACTION_DEFAULTS,
  DeviceUnavailableError,
  deviceUnavailableMessage,
  discoverMobileDevices,
  orientCoordinateSpace,
  readImageSize,
  resolveTargetPoint,
} from '@pwtap/mobile-core';
import type { DiscoveredDevice } from '@pwtap/platform';
import {
  acquireDevice,
  acquireDeviceLock,
  bootIosSim,
  deviceLockKey,
  foregroundAndroidApp,
  getAndroidViewportSize,
  getIosSimulatorViewportSize,
  recordBootedDevice,
} from '@pwtap/platform';

import { ensureAppInstalled } from './core/appInstaller.js';
import type {
  CommandOptions,
  MaestroDirection,
  McpSessionHooks,
} from './core/MaestroMcpSession.js';
import { MaestroMcpSession } from './core/MaestroMcpSession.js';
import type { MaestroNode, MaestroScreen, MaestroSelector } from './core/types.js';

const CAPABILITIES: DriverCapabilities = {
  hierarchy: true,
  liveFrames: true,
  gestures: {
    tap: true,
    doubleTap: true,
    fill: true,
    eraseText: true,
    hideKeyboard: true,
    longPress: true,
    swipe: true,
    scroll: true,
    scrollUntilVisible: true,
    drag: true,
    pinch: false, // Maestro has no pinch primitive
    pressKey: true,
    back: true,
    waitFor: true,
    isVisible: true,
    assertVisible: true,
    assertNotVisible: true,
    screenshot: true,
    // Captured as a plain screenshot here; the rubric check itself runs in the GENERATED test via
    // @pwtap/plugin-ai-judge, not inside the driver session (see plan.md's codegen section).
    aiAssert: true,
  },
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** No-op step/report hooks for a standalone (non-Playwright-test) inspector session. */
function inspectorHooks(outputDir: string): McpSessionHooks {
  return {
    step: async (_title, body) => body(),
    outputDir,
    report: async () => {
      /* the inspector reads screenshots directly via captureScreen(); no test report to attach to */
    },
  };
}

/** Regex metacharacters, plus `$`, which Maestro also reads as the start of a variable reference. */
const MAESTRO_PATTERN_SPECIALS = /[\\^$.|?*+()[\]{}]/g;

/**
 * Escape a literal string for Maestro's `text`/`id` selectors, which are **regular expressions**
 * (full-string, case-insensitive) rather than literals.
 *
 * `MobileLocator.text` is the element's visible text and `resourceId` is its id — both literals by contract.
 * Passed through unescaped, any UI string containing regex syntax silently stops matching the element it was
 * recorded from: `Wi-Fi (2.4 GHz)`, `$150 in Cash`, `Storage [internal]`, `Continue?` are all ordinary
 * labels and all invalid-or-wrong as patterns. `MobileLocator.native` is deliberately NOT escaped — that is
 * the hand-authored escape hatch, and a caller reaching for it is authoring a Maestro selector on purpose.
 *
 * @example escapeMaestroPattern('Wi-Fi (2.4 GHz)') // 'Wi-Fi \\(2\\.4 GHz\\)'
 */
export function escapeMaestroPattern(value: string): string {
  return value.replace(MAESTRO_PATTERN_SPECIALS, '\\$&');
}

/** Translate a driver-neutral locator into a Maestro selector. */
export function toMaestroSelector(locator: MobileLocator): MaestroSelector {
  if (locator.native !== undefined) {
    return locator.native as MaestroSelector;
  }
  // Maestro's own `index`, which counts matches the same 0-based way the IR does.
  const index = locator.index === undefined ? {} : { index: locator.index };
  if (locator.accessibilityId !== undefined) {
    // Maestro matches accessibility text via `text`, not a separate key (see core/types.ts).
    return { text: escapeMaestroPattern(locator.accessibilityId), ...index };
  }
  if (locator.resourceId !== undefined) {
    return { id: escapeMaestroPattern(locator.resourceId), ...index };
  }
  if (locator.text !== undefined) {
    return { text: escapeMaestroPattern(locator.text), ...index };
  }
  throw new Error(
    '[maestro-inspector] locator has no accessibilityId/resourceId/text/native strategy Maestro ' +
      `can use: ${JSON.stringify(locator)}`,
  );
}

/** Passed to every command below that should return with the screen at rest. */
const SETTLE: CommandOptions = { settle: true };

/**
 * Actions whose Maestro command is sent together with `waitForAnimationToEnd`, and which therefore return
 * with the screen already at rest. Kept beside the `execute` switch that passes {@link SETTLE}; the two must
 * agree, because claiming `settled` without waiting would make the recorder capture mid-animation.
 */
const SETTLES_ON_DEVICE = new Set<MobileAction['kind']>([
  'tap',
  'doubleTap',
  'fill',
  'eraseText',
  'longPress',
  'swipe',
  'scroll',
  'drag',
  'pressKey',
  'back',
]);

const DIRECTION_MAP: Record<MobileDirection, MaestroDirection> = {
  up: 'UP',
  down: 'DOWN',
  left: 'LEFT',
  right: 'RIGHT',
};

/** Scrolling down means swiping up: the finger travels opposite to the content. */
const SCROLL_TO_SWIPE: Record<MobileDirection, MobileDirection> = {
  down: 'up',
  up: 'down',
  right: 'left',
  left: 'right',
};

/** Maestro key names differ in casing from the shared `MobileKey` union; pass unknown keys through. */
function toMaestroKey(key: string): string {
  const known: Record<string, string> = {
    back: 'Back',
    home: 'Home',
    enter: 'Enter',
    volumeUp: 'VolumeUp',
    volumeDown: 'VolumeDown',
  };
  return known[key] ?? key;
}

/**
 * Start and end points for a swipe of `distance` (a fraction of the swept axis), centred on the screen and
 * expressed in Maestro's `x%,y%` form. The finger travels in the direction asked for.
 */
function swipeSpan(direction: MobileDirection, distance: number): { start: string; end: string } {
  const half = Math.min(Math.max(distance, 0), 1) / 2;
  const from = 50 - half * 100;
  const to = 50 + half * 100;
  switch (direction) {
    case 'up':
      return { start: `50%,${to}%`, end: `50%,${from}%` };
    case 'down':
      return { start: `50%,${from}%`, end: `50%,${to}%` };
    case 'left':
      return { start: `${to}%,50%`, end: `${from}%,50%` };
    default:
      return { start: `${from}%,50%`, end: `${to}%,50%` };
  }
}

/** Parse Maestro's `[x1,y1][x2,y2]` bounds string into the shared box shape. */
function parseBounds(
  bounds?: string,
): { x: number; y: number; width: number; height: number } | undefined {
  const match = bounds ? /\[(\d+),(\d+)]\[(\d+),(\d+)]/.exec(bounds) : null;
  if (!match) {
    return undefined;
  }
  const [x1, y1, x2, y2] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Owning package, inferred from an Android resource id like `com.android.settings:id/title`. Maestro's
 * compact node carries no package field, so this is the only free signal — and it is absent for nodes with
 * no resource id, which is why §7 still lists app-scope detection as partial.
 */
function packageFromResourceId(rid: string | undefined): string | undefined {
  const separator = rid?.indexOf(':id/') ?? -1;
  return separator > 0 ? rid?.slice(0, separator) : undefined;
}

/**
 * Normalize one Maestro node (and its children) into the shared `MobileNode` model. `cls` and `enabled` were
 * previously dropped, which left every Maestro node unlabelled in the accessibility tree and weakened the
 * node identity key; `val` is folded into `text` the way the Appium adapter already folds iOS `value`, so a
 * row identified only by its right-hand value still gets a text locator.
 */
function toMobileNode(node: MaestroNode): MobileNode {
  return {
    bounds: parseBounds(node.b),
    text: node.txt ?? node.val,
    accessibilityId: node.a11y,
    resourceId: node.rid,
    className: node.cls,
    enabled: node.enabled,
    appPackage: packageFromResourceId(node.rid),
    children: node.c?.map(toMobileNode),
  };
}

function toMobileHierarchy(screen: MaestroScreen): MobileNode[] {
  return (screen.elements ?? []).map(toMobileNode);
}

/** Percentage point string Maestro's `swipe`/`point` selector accepts, e.g. `"42%,80%"`. Maestro's
 * point parser rejects decimal percentages (`Integer.parseInt` throws on e.g. `"49.9"`), so this
 * rounds to whole percent rather than keeping sub-percent precision. */
function toPercentPoint(
  point: { x: number; y: number },
  frame: {
    width: number;
    height: number;
    coordinateWidth?: number;
    coordinateHeight?: number;
  },
): string {
  const width = frame.coordinateWidth ?? frame.width;
  const height = frame.coordinateHeight ?? frame.height;
  const px = width > 0 ? Math.min(100, Math.max(0, (point.x / width) * 100)) : 0;
  const py = height > 0 ? Math.min(100, Math.max(0, (point.y / height) * 100)) : 0;
  return `${Math.round(px)}%,${Math.round(py)}%`;
}

function toInspectorDevice(device: DiscoveredDevice, booted: boolean): InspectorDevice {
  return { id: device.id, name: device.name ?? device.id, platform: device.platform, booted };
}

class MaestroDriverSession implements DriverSession {
  readonly driverId = 'maestro';
  private frameCounter = 0;
  private releaseLock: (() => void) | undefined;

  private readonly maestro: MaestroMcpSession;
  readonly device: InspectorDevice;
  /**
   * The app this session is scoped to — the one requested, or the one adopted from the foreground.
   *
   * `undefined` when the session attached to whatever is on screen instead (Maestro's `appId: any`), which is
   * the only thing possible on iOS without an app id. Codegen then pins no app, and the engine warns that the
   * recording needs one before it can replay — rather than baking in `any`, which is a flow-header wildcard
   * and not a bundle id anything could launch.
   */
  readonly appId: string | undefined;
  private readonly coordinateSize: { width: number; height: number } | undefined;
  /** Temp directory this session's evidence screenshots go to; removed on close so nothing accumulates. */
  private readonly outputDir: string;
  /**
   * The coordinate space of the most recent capture, orientation already resolved. Kept so converting a
   * point locator into Maestro's `x%,y%` does not need a fresh screenshot — the inspector captures on every
   * action and on every poll, so this is never stale by more than one frame, and taking another screenshot
   * added ~180 ms to every coordinate tap for a number already in hand.
   */
  private lastCoordinateSpace: { width: number; height: number } | undefined;

  constructor(
    maestro: MaestroMcpSession,
    device: InspectorDevice,
    coordinateSize: { width: number; height: number } | undefined,
    release: () => void,
    appId: string | undefined,
    outputDir: string,
  ) {
    this.maestro = maestro;
    this.device = device;
    this.coordinateSize = coordinateSize;
    this.releaseLock = release;
    this.appId = appId;
    this.outputDir = outputDir;
  }

  async captureScreen(): Promise<ScreenFrame> {
    const imageBase64 = await this.maestro.screenshotBytes();
    // ponytail: one base64 decode remains, and only to read the image header. `ScreenFrame` carries the
    // image as base64 by contract, so passing the Buffer straight through would be an adapter-contract
    // bump (ADR-009) for a few hundred microseconds.
    const size = readImageSize(Buffer.from(imageBase64, 'base64')) ?? { width: 0, height: 0 };
    const coordinateSize = orientCoordinateSpace(size, this.coordinateSize);
    this.lastCoordinateSpace = coordinateSize ?? { width: size.width, height: size.height };
    return {
      frameId: this.frameCounter++,
      imageBase64,
      width: size.width,
      height: size.height,
      coordinateWidth: coordinateSize?.width,
      coordinateHeight: coordinateSize?.height,
      orientation: size.width > size.height ? 'landscape' : 'portrait',
      capturedAt: Date.now(),
    };
  }

  async inspectHierarchy(): Promise<MobileNode[]> {
    return toMobileHierarchy(await this.maestro.inspectScreen());
  }

  /**
   * Resolve a locator to a Maestro selector, additionally supporting `locator.point` (a raw
   * device-pixel coordinate) via Maestro's `tapOn: { point: "x%,y%" }` syntax — the recorder's
   * tap-to-record flow falls back to a coordinate-only locator whenever hit-testing the hierarchy
   * finds no element under the tap (e.g. the hierarchy hasn't loaded yet, or the tap lands in dead
   * space), so this path is reached routinely, not just as a rare edge case.
   */
  private async resolveSelector(locator: MobileLocator): Promise<MaestroSelector> {
    if (locator.point !== undefined) {
      const space = this.lastCoordinateSpace ?? (await this.captureScreen());
      return { point: toPercentPoint(locator.point, space) };
    }
    return toMaestroSelector(locator);
  }

  async perform(action: MobileAction): Promise<ActionResult> {
    const start = Date.now();
    try {
      const value = await this.execute(action);
      // The commands below carry `waitForAnimationToEnd` in the same `run` call, so the caller is spared
      // its own sleep-and-look-again cycle (see `ActionResult.settled`).
      return {
        ok: true,
        value,
        durationMs: Date.now() - start,
        settled: SETTLES_ON_DEVICE.has(action.kind),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      };
    }
  }

  private async execute(action: MobileAction): Promise<unknown> {
    switch (action.kind) {
      case 'tap':
        return this.maestro.tapOn(await this.resolveSelector(action.locator), SETTLE);
      case 'doubleTap':
        return this.maestro.doubleTapOn(await this.resolveSelector(action.locator), SETTLE);
      case 'eraseText':
        // Maestro's `eraseText` acts on the FOCUSED field and takes no selector, so the field is tapped
        // first — both lines in one call, the same way `fill` does it.
        return this.maestro.eraseTextIn(
          await this.resolveSelector(action.locator),
          action.options?.characters,
          SETTLE,
        );
      case 'hideKeyboard':
        return this.maestro.hideKeyboard();
      case 'scrollUntilVisible':
        // Maestro's own command, which stops as soon as the element is visible. `timeout` is forwarded, not
        // dropped: a device run proved it silently ignored otherwise, and an option a driver reads as nothing
        // is exactly what §5 forbids — the caller asked for four seconds and Maestro spent twenty.
        return this.maestro.scrollUntilVisible(toMaestroSelector(action.locator), {
          direction: action.options?.direction
            ? DIRECTION_MAP[action.options.direction]
            : undefined,
          timeout: action.options?.timeoutMs,
        });
      case 'fill':
        // Maestro has no "fill a specific field" command — tap to focus, then type — but both lines go in
        // ONE `run` call, because Maestro's per-flow overhead is charged per call, not per line.
        return this.maestro.fillOn(
          await this.resolveSelector(action.locator),
          action.value,
          SETTLE,
        );
      case 'longPress':
        if (action.options?.durationMs !== undefined) {
          // Maestro's `longPressOn` takes the same properties as `tapOn` and no duration (its own cheat
          // sheet). Silently holding for Maestro's own time would generate a test that reads as a 3-second
          // press and is not one — the same reason `scroll` refuses `within` below.
          throw new Error(
            '[maestro-inspector] Maestro cannot vary how long a long-press holds — record it without ' +
              '`durationMs`, or use the Appium driver',
          );
        }
        return this.maestro.longPressOn(await this.resolveSelector(action.locator), SETTLE);
      case 'swipe': {
        // A direction-only swipe has no distance in Maestro, so a requested one is expressed as start/end
        // percentage points — the same form `drag` uses. Without this, `distance` was accepted by the IR and
        // read by nobody.
        const distance = action.options?.distance;
        if (distance !== undefined) {
          const { start, end } = swipeSpan(action.direction, distance);
          return this.maestro.swipe({ start, end, duration: action.options?.durationMs }, SETTLE);
        }
        return this.maestro.swipe(
          {
            direction: DIRECTION_MAP[action.direction],
            duration: action.options?.durationMs,
          },
          SETTLE,
        );
      }
      case 'scroll':
        if (action.options?.within) {
          // Maestro's swipe has no element target. Refusing beats silently scrolling the whole screen and
          // generating a test that only appears to scroll the container the user picked.
          throw new Error(
            '[maestro-inspector] Maestro cannot scroll inside a specific element — record the scroll ' +
              'without `within`, or use the Appium driver',
          );
        }
        // Maestro's bare `scroll()` always scrolls down, so the recorded direction used to be discarded.
        // A swipe carries direction, inverted because the finger moves opposite to the content.
        return this.maestro.swipe(
          {
            direction: DIRECTION_MAP[SCROLL_TO_SWIPE[action.direction]],
          },
          SETTLE,
        );
      case 'drag': {
        const hierarchy = await this.inspectHierarchy();
        const frame = await this.captureScreen();
        const from = resolveTargetPoint(action.from, hierarchy);
        const to = resolveTargetPoint(action.to, hierarchy);
        return this.maestro.swipe(
          {
            start: toPercentPoint(from, frame),
            end: toPercentPoint(to, frame),
          },
          SETTLE,
        );
      }
      case 'pinch':
        throw new Error('[maestro-inspector] pinch is not supported by the Maestro driver');
      case 'pressKey':
        return this.maestro.pressKey(toMaestroKey(action.key), SETTLE);
      case 'back':
        return this.maestro.back(SETTLE);
      case 'waitFor': {
        const visible = await this.maestro.isVisible(toMaestroSelector(action.locator), {
          timeout: action.options?.timeoutMs ?? ACTION_DEFAULTS.waitForMs,
        });
        if (!visible) {
          throw new Error('[maestro-inspector] waitFor timed out — element never became visible');
        }
        return undefined;
      }
      case 'isVisible':
        // Maestro's own query already answers with a boolean rather than asserting, so this is the one
        // driver where the boolean action needs no extra machinery. `toMaestroSelector` (not
        // `resolveSelector`) on purpose: "is this coordinate visible?" has no meaningful answer, so a
        // point-only locator must fail loudly instead of silently reporting `true`.
        return this.maestro.isVisible(toMaestroSelector(action.locator), {
          timeout: action.options?.timeoutMs ?? ACTION_DEFAULTS.isVisibleMs,
        });
      case 'assertVisible':
        await this.maestro.assertVisible(toMaestroSelector(action.locator));
        return true;
      case 'assertNotVisible':
        await this.maestro.assertNotVisible(toMaestroSelector(action.locator));
        return true;
      case 'screenshot':
        return this.maestro.takeScreenshot(action.name ?? `screenshot-${Date.now()}`);
      case 'aiAssert':
        // Recording-time preview only: capture the screenshot the rubric will judge; the actual
        // rubric evaluation happens in the GENERATED test (via @pwtap/plugin-ai-judge), not here.
        return this.maestro.takeScreenshot(action.name ?? `ai-assert-${Date.now()}`);
      default: {
        const exhaustiveCheck: never = action;
        throw new Error(`[maestro-inspector] unhandled action: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  async close(): Promise<void> {
    await this.maestro.close();
    // Best-effort: a leftover temp directory is untidy, not a failure, and it must not mask a close error.
    await fs.rm(this.outputDir, { recursive: true, force: true }).catch(() => undefined);
    this.releaseLock?.();
    this.releaseLock = undefined;
  }
}

class MaestroInspectorDriver implements MobileInspectorDriver {
  readonly id = 'maestro';
  readonly capabilities = CAPABILITIES;
  /** Must stay in step with this plugin's `manifest.ts` Playwright project block. */
  readonly testBinding = {
    extension: '.maestro.ts',
    project: 'maestro',
    gateEnv: 'MAESTRO',
  };

  /** Delegates to the shared cross-adapter device discovery helper (see `deviceDiscovery.ts`). */
  async discoverDevices(): Promise<InspectorDevice[]> {
    return discoverMobileDevices();
  }

  async connect(options: ConnectOptions): Promise<DriverSession> {
    const progress = options.onProgress ?? ((): void => undefined);
    const release = await acquireDeviceLock(deviceLockKey(options.platform, options.device));
    // Declared out here so a connect that fails AFTER creating it still removes it. Only a session's `close`
    // did, and a connect that never returned a session therefore left an empty directory behind every time —
    // a refused app id, a device that went away, a driver that would not start.
    let outputDir: string | undefined;
    try {
      progress(
        options.device ? `acquiring ${options.device}` : `acquiring an ${options.platform} device`,
      );
      const acquired = await acquireDevice(options.platform, {
        deviceName: options.device,
        headless: options.headless ?? true,
        onBooted: recordBootedDevice,
      });
      if (!acquired) {
        throw new DeviceUnavailableError(
          await deviceUnavailableMessage('maestro', options.platform, options.device),
        );
      }
      outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pwtap-mobile-inspector-'));
      // Maestro has no install primitive of its own — install the build first (same helper the
      // plugin's own fixture uses) so `launchApp` below can find it.
      if (options.appSource) {
        progress(`installing ${options.appSource}`);
        await ensureAppInstalled(acquired, options.appSource);
      }
      progress('reading the device viewport');
      const coordinateSize =
        acquired.platform === 'android'
          ? await getAndroidViewportSize(acquired.id)
          : await getIosSimulatorViewportSize(acquired.id);
      // Every Maestro command needs a config header naming an app, so a session without one used to be
      // useless — the internal "call maestro.launchApp(appId) before other commands" on every interaction.
      // Android can usually say what is in the foreground, and adopting it gives the recording an app to pin.
      let appId = options.appId;
      if (!appId && acquired.platform === 'android') {
        progress('detecting the foreground app');
        appId = await foregroundAndroidApp(acquired.id);
      }
      if (!appId && !options.attachWithoutApp) {
        // A test replaying a recording: it is supposed to pin the app it was made against, and driving
        // whatever happens to be on screen instead would pass or fail for reasons unrelated to the test.
        // A recorder opts out of this with `attachWithoutApp` (see `ConnectOptions`).
        throw new Error(
          `[maestro-inspector] every Maestro command is scoped to an app, and no app id was given${
            acquired.platform === 'android' ? ' or detected on the device' : ''
          } — set \`mobileTarget.appId\` (e.g. com.example.app) to the app under test`,
        );
      }
      for (let attempt = 1; ; attempt += 1) {
        const maestro = new MaestroMcpSession(acquired, inspectorHooks(outputDir), {
          screenshotMode: 'off',
        });
        try {
          // Maestro initializes its device connection lazily on the first command. A freshly
          // released iOS driver can briefly report "not connected", so rebuild MCP once.
          if (appId) {
            progress(attempt === 1 ? `launching ${appId}` : `retrying: launching ${appId}`);
            await maestro.launchApp(appId);
          } else {
            // No app named and none detectable — which on iOS is *always*, since nothing there reports the
            // frontmost app (`launchctl list` names every running one and `simctl appinfo` names none, and the
            // view hierarchy's app label turned out not to be dependably present). Refusing here is what made
            // "connect failed: … no app id was given or could be detected" the only possible outcome of an iOS
            // connect without an app id. Maestro's own `appId: any` header satisfies the config section
            // without scoping the flow, so the session attaches to whatever is on screen instead.
            progress(
              attempt === 1
                ? 'attaching to whatever is on screen'
                : 'retrying: attaching to the screen',
            );
            maestro.attachAnyApp();
            // `attachAnyApp` sends nothing, and the retry above exists because Maestro connects lazily on the
            // FIRST command — so one real read is what makes a not-yet-ready driver fail here, where it is
            // retried, rather than on the user's first tap. The caller reads the hierarchy immediately anyway.
            await maestro.inspectScreen();
          }
          return new MaestroDriverSession(
            maestro,
            toInspectorDevice(acquired, true),
            coordinateSize,
            release,
            appId,
            outputDir,
          );
        } catch (error) {
          await maestro.close();
          const message = error instanceof Error ? error.message : String(error);
          // A detected app id is OUR guess, not the caller's instruction, so a guess that cannot be launched
          // must not take the whole connect down with it. The case that forced this: connecting while the
          // device sits on the home screen detects the launcher (`com.google.android.apps.nexuslauncher`),
          // which Maestro answers with `Unable to launch app …` — so opening the inspector on a device nobody
          // had touched yet simply failed. An app id the caller *named* is different: getting it wrong is
          // worth hearing about, so that one still throws.
          if (appId !== undefined && appId !== options.appId && options.attachWithoutApp) {
            progress(`could not launch ${appId} — attaching to whatever is on screen instead`);
            appId = undefined;
            attempt = 0; // the guess cost nothing; leave the not-connected retry below its full budget
            continue;
          }
          if (attempt >= 2 || !/not connected|failed to connect/i.test(message)) {
            throw error;
          }
          await sleep(2_000);
          if (acquired.platform === 'ios') {
            await bootIosSim(acquired.id);
          }
        }
      }
    } catch (error) {
      if (outputDir) {
        await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
      }
      release();
      throw error;
    }
  }
}

export const driver: MobileInspectorDriver = new MaestroInspectorDriver();
/**
 * The core↔adapter contract this adapter implements (ADR-009). A literal on purpose: importing
 * `MOBILE_CORE_CONTRACT` would make it agree with whatever core is installed, which is the mismatch the
 * check exists to catch. Bumping the core's contract breaks this line's type until it is reviewed.
 */
export const contract: AdapterContract = 1;
