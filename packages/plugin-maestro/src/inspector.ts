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
import { discoverMobileDevices, readImageSize, resolveTargetPoint } from '@pwtap/mobile-core';
import type { DiscoveredDevice } from '@pwtap/platform';
import {
  acquireDevice,
  acquireDeviceLock,
  bootIosSim,
  deviceLockKey,
  getAndroidViewportSize,
  getIosSimulatorViewportSize,
  recordBootedDevice,
} from '@pwtap/platform';

import { ensureAppInstalled } from './core/appInstaller.js';
import type { MaestroDirection, McpSessionHooks } from './core/MaestroMcpSession.js';
import { MaestroMcpSession } from './core/MaestroMcpSession.js';
import type { MaestroNode, MaestroScreen, MaestroSelector } from './core/types.js';

const CAPABILITIES: DriverCapabilities = {
  hierarchy: true,
  liveFrames: true,
  gestures: {
    tap: true,
    fill: true,
    longPress: true,
    swipe: true,
    scroll: true,
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

/** Translate a driver-neutral locator into a Maestro selector. */
function toMaestroSelector(locator: MobileLocator): MaestroSelector {
  if (locator.native !== undefined) {
    return locator.native as MaestroSelector;
  }
  if (locator.accessibilityId !== undefined) {
    // Maestro matches accessibility text via `text`, not a separate key (see core/types.ts).
    return { text: locator.accessibilityId };
  }
  if (locator.resourceId !== undefined) {
    return { id: locator.resourceId };
  }
  if (locator.text !== undefined) {
    return { text: locator.text };
  }
  throw new Error(
    '[maestro-inspector] locator has no accessibilityId/resourceId/text/native strategy Maestro ' +
      `can use: ${JSON.stringify(locator)}`,
  );
}

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
  private readonly coordinateSize: { width: number; height: number } | undefined;

  constructor(
    maestro: MaestroMcpSession,
    device: InspectorDevice,
    coordinateSize: { width: number; height: number } | undefined,
    release: () => void,
  ) {
    this.maestro = maestro;
    this.device = device;
    this.coordinateSize = coordinateSize;
    this.releaseLock = release;
  }

  async captureScreen(): Promise<ScreenFrame> {
    const name = `inspector-frame-${this.frameCounter}`;
    const filePath = await this.maestro.takeScreenshot(name);
    const buf = await fs.readFile(filePath);
    const size = readImageSize(buf) ?? { width: 0, height: 0 };
    const imageLandscape = size.width > size.height;
    const coordinatesLandscape =
      this.coordinateSize !== undefined && this.coordinateSize.width > this.coordinateSize.height;
    const coordinateSize =
      this.coordinateSize && imageLandscape !== coordinatesLandscape
        ? { width: this.coordinateSize.height, height: this.coordinateSize.width }
        : this.coordinateSize;
    return {
      frameId: this.frameCounter++,
      imageBase64: buf.toString('base64'),
      width: size.width,
      height: size.height,
      coordinateWidth: coordinateSize?.width,
      coordinateHeight: coordinateSize?.height,
      orientation: imageLandscape ? 'landscape' : 'portrait',
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
      const frame = await this.captureScreen();
      return { point: toPercentPoint(locator.point, frame) };
    }
    return toMaestroSelector(locator);
  }

  async perform(action: MobileAction): Promise<ActionResult> {
    const start = Date.now();
    try {
      const value = await this.execute(action);
      return { ok: true, value, durationMs: Date.now() - start };
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
        return this.maestro.tapOn(await this.resolveSelector(action.locator));
      case 'fill':
        // Maestro has no "fill a specific field" command — tap it to focus, then type.
        await this.maestro.tapOn(await this.resolveSelector(action.locator));
        return this.maestro.inputText(action.value);
      case 'longPress':
        return this.maestro.longPressOn(await this.resolveSelector(action.locator));
      case 'swipe':
        return this.maestro.swipe({
          direction: DIRECTION_MAP[action.direction],
          duration: action.options?.durationMs,
        });
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
        return this.maestro.swipe({
          direction: DIRECTION_MAP[SCROLL_TO_SWIPE[action.direction]],
        });
      case 'drag': {
        const hierarchy = await this.inspectHierarchy();
        const frame = await this.captureScreen();
        const from = resolveTargetPoint(action.from, hierarchy);
        const to = resolveTargetPoint(action.to, hierarchy);
        return this.maestro.swipe({
          start: toPercentPoint(from, frame),
          end: toPercentPoint(to, frame),
        });
      }
      case 'pinch':
        throw new Error('[maestro-inspector] pinch is not supported by the Maestro driver');
      case 'pressKey':
        return this.maestro.pressKey(toMaestroKey(action.key));
      case 'back':
        return this.maestro.back();
      case 'waitFor': {
        const visible = await this.maestro.isVisible(toMaestroSelector(action.locator), {
          timeout: action.options?.timeoutMs,
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
          timeout: action.options?.timeoutMs,
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
    const release = await acquireDeviceLock(deviceLockKey(options.platform, options.device));
    try {
      const acquired = await acquireDevice(options.platform, {
        deviceName: options.device,
        headless: options.headless ?? true,
        onBooted: recordBootedDevice,
      });
      if (!acquired) {
        throw new Error(
          `[maestro-inspector] no ${options.platform} device available to connect the inspector to`,
        );
      }
      const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pwtap-mobile-inspector-'));
      // Maestro has no install primitive of its own — install the build first (same helper the
      // plugin's own fixture uses) so `launchApp` below can find it.
      if (options.appSource) {
        await ensureAppInstalled(acquired, options.appSource);
      }
      const coordinateSize =
        acquired.platform === 'android'
          ? await getAndroidViewportSize(acquired.id)
          : await getIosSimulatorViewportSize(acquired.id);
      for (let attempt = 1; ; attempt += 1) {
        const maestro = new MaestroMcpSession(acquired, inspectorHooks(outputDir), {
          screenshotMode: 'off',
        });
        try {
          // Maestro initializes its device connection lazily on the first command. A freshly
          // released iOS driver can briefly report "not connected", so rebuild MCP once.
          if (options.appId) {
            await maestro.launchApp(options.appId);
          } else {
            await maestro.inspectScreen();
          }
          return new MaestroDriverSession(
            maestro,
            toInspectorDevice(acquired, true),
            coordinateSize,
            release,
          );
        } catch (error) {
          await maestro.close();
          const message = error instanceof Error ? error.message : String(error);
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
      release();
      throw error;
    }
  }
}

export const driver: MobileInspectorDriver = new MaestroInspectorDriver();
