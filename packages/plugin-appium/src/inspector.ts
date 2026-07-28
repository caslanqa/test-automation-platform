/**
 * Mobile Inspector driver adapter for Appium. Implements `@pwtap/mobile-inspector`'s
 * `MobileInspectorDriver`/`DriverSession` over the existing raw WebdriverIO session, Appium server
 * lifecycle, and `@pwtap/platform` device lifecycle — no inspector-specific device/session logic is
 * duplicated here. Exposed via this package's `"./inspector"` export so the shared registry can
 * discover it without any Appium-specific code living in `@pwtap/mobile-inspector` itself.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XMLParser } from 'fast-xml-parser';

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
  MobileTarget,
  ScreenFrame,
} from '@pwtap/mobile-core';
import { discoverMobileDevices, readImageSize } from '@pwtap/mobile-core';
import type { DiscoveredDevice, MobilePlatform } from '@pwtap/platform';
import {
  acquireDevice,
  acquireDeviceLock,
  deviceLockKey,
  recordBootedDevice,
  stopIosAutomation,
} from '@pwtap/platform';

import type { AppiumServerHandle } from './core/appiumServer.js';
import { assertPlatformSupported, ensureAppiumServer } from './core/appiumServer.js';
import { buildCapabilities } from './core/caps.js';
import { closeSession, createSession } from './core/session.js';

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
    pinch: true,
    pressKey: true,
    back: true, // Android only at runtime; iOS throws a clear error (no universal hardware back)
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

/** A selector accepted by WebdriverIO's `$` command. */
type AppiumSelector = Parameters<WebdriverIO.Browser['$']>[0];

/** Gap between visibility polls — see {@link AppiumDriverSession.isVisible}. */
const POLL_INTERVAL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Escape a value for embedding in a quoted string inside a selector expression (an NSPredicate literal or
 * a Java `UiSelector` argument). Both use backslash escaping, and both break outright on an unescaped
 * quote — which real UI text supplies routinely (`He said "hi"`, a Windows-style path, an apostrophe).
 */
function escapeSelectorString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Translate a driver-neutral locator into a WebdriverIO selector for `platform` (see docs/APPIUM_TESTING.md). */
export function toAppiumSelector(locator: MobileLocator, platform: MobilePlatform): AppiumSelector {
  if (locator.native !== undefined) {
    return locator.native as AppiumSelector;
  }
  if (locator.accessibilityId !== undefined) {
    return `~${locator.accessibilityId}`; // accessibility id works identically on both platforms
  }
  if (locator.resourceId !== undefined) {
    const id = escapeSelectorString(locator.resourceId);
    return platform === 'android'
      ? `android=new UiSelector().resourceId("${id}")`
      : `-ios predicate string:name == "${id}"`;
  }
  if (locator.text !== undefined) {
    const text = escapeSelectorString(locator.text);
    // iOS matches `label` OR `value` on purpose: `toMobileNode` fills a node's `text` from whichever of
    // `label`/`value` the XML supplies, so matching only `label` cannot find an element whose text came
    // from `value` — the locator would be un-resolvable the moment it was recorded.
    return platform === 'android'
      ? `android=new UiSelector().text("${text}")`
      : `-ios predicate string:label == "${text}" OR value == "${text}"`;
  }
  throw new Error(
    `[appium-inspector] locator has no accessibilityId/resourceId/text/native strategy: ${JSON.stringify(
      locator,
    )}`,
  );
}

const ANDROID_KEYCODES: Record<string, number> = {
  back: 4,
  home: 3,
  enter: 66,
  volumeUp: 24,
  volumeDown: 25,
};

const IOS_BUTTONS: Record<string, string> = {
  home: 'home',
  volumeUp: 'volumeUp',
  volumeDown: 'volumeDown',
};

/** Parsed XML attribute bag — `fast-xml-parser`'s `preserveOrder` node shape (`{ tag: [...], ':@': attrs }`). */
interface XmlNode {
  ':@'?: Record<string, string>;
  [tag: string]: unknown;
}

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true,
});

/** The element tag name of a `preserveOrder` node (every key except the `:@` attribute bag). */
function tagOf(node: XmlNode): string | undefined {
  return Object.keys(node).find(key => key !== ':@');
}

/** True for XML declarations (`?xml`), text/CDATA (`#text`), and comments — never real UI elements. */
function isElementTag(tag: string | undefined): tag is string {
  return tag !== undefined && !tag.startsWith('?') && !tag.startsWith('#');
}

function toBool(value: string | undefined): boolean | undefined {
  return value === undefined ? undefined : value === 'true';
}

/** Parse Android's `bounds="[x1,y1][x2,y2]"` attribute into the shared box shape. */
function parseAndroidBounds(
  bounds?: string,
): { x: number; y: number; width: number; height: number } | undefined {
  const match = bounds ? /\[(-?\d+),(-?\d+)]\[(-?\d+),(-?\d+)]/.exec(bounds) : null;
  if (!match) {
    return undefined;
  }
  const [x1, y1, x2, y2] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** iOS XCUITest XML carries numeric `x`/`y`/`width`/`height` attributes directly. */
function parseIosBounds(
  attrs: Record<string, string>,
): { x: number; y: number; width: number; height: number } | undefined {
  const { x, y, width, height } = attrs;
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
}

/** Normalize one parsed XML node (and its children) into the shared `MobileNode` model. */
function toMobileNode(node: XmlNode, platform: MobilePlatform): MobileNode | undefined {
  const tag = tagOf(node);
  if (!isElementTag(tag)) {
    return undefined; // skip XML declarations, text nodes, comments — not real UI elements
  }
  const attrs = node[':@'] ?? {};
  const childXmlNodes = node[tag];
  const children = (Array.isArray(childXmlNodes) ? childXmlNodes : [])
    .map(child => toMobileNode(child as XmlNode, platform))
    .filter((n): n is MobileNode => n !== undefined);

  return {
    bounds: platform === 'android' ? parseAndroidBounds(attrs.bounds) : parseIosBounds(attrs),
    text: attrs.text || attrs.label || attrs.value || undefined,
    // iOS accessibility identifier is its `name` attribute (see docs/APPIUM_TESTING.md).
    accessibilityId:
      platform === 'android' ? attrs['content-desc'] || undefined : attrs.name || undefined,
    resourceId: platform === 'android' ? attrs['resource-id'] || undefined : undefined,
    // Android reports the owning package per node; iOS page source is the app under test already.
    appPackage: platform === 'android' ? attrs.package || undefined : undefined,
    className: attrs.class || attrs.type || tag,
    enabled: toBool(attrs.enabled),
    focused: toBool(attrs.focused),
    selected: toBool(attrs.selected),
    checked: toBool(attrs.checked),
    children: children.length > 0 ? children : undefined,
  };
}

/** Parse Appium's `getPageSource()` XML into the shared node model. Tolerant of malformed XML. */
function xmlToMobileHierarchy(xml: string, platform: MobilePlatform): MobileNode[] {
  try {
    const parsed = XML_PARSER.parse(xml) as XmlNode[];
    // The root is the first real element (`hierarchy` on Android, `AppiumAUT` on iOS) — skip the
    // leading `?xml` declaration node (and any stray text/comment nodes) fast-xml-parser also emits
    // at the top level; its children are the real UI tree.
    const root = parsed.find(node => isElementTag(tagOf(node)));
    if (!root) {
      return [];
    }
    const rootTag = tagOf(root) as string;
    const rootChildren = root[rootTag];
    return (Array.isArray(rootChildren) ? rootChildren : [])
      .map(child => toMobileNode(child as XmlNode, platform))
      .filter((n): n is MobileNode => n !== undefined);
  } catch {
    return []; // malformed/unexpected page source — degrade to an empty tree rather than throw
  }
}

function toInspectorDevice(device: DiscoveredDevice, booted: boolean): InspectorDevice {
  return { id: device.id, name: device.name ?? device.id, platform: device.platform, booted };
}

/**
 * WebdriverIO's `Element.elementId` is typed `Promise<string>` on the chainable proto and `string`
 * on the resolved element depending on which overload TS picks up — accept either shape structurally
 * and `await` defensively so this adapter works regardless of which type TS infers at a call site.
 */
async function elementIdOf(el: { elementId: string | Promise<string> }): Promise<string> {
  return el.elementId;
}

class AppiumDriverSession implements DriverSession {
  readonly driverId = 'appium';
  private frameCounter = 0;
  private releaseLock: (() => void) | undefined;
  private closed = false;

  private readonly session: WebdriverIO.Browser;
  private readonly server: AppiumServerHandle;
  readonly device: InspectorDevice;
  private readonly outputDir: string;

  constructor(
    session: WebdriverIO.Browser,
    server: AppiumServerHandle,
    device: InspectorDevice,
    outputDir: string,
    release: () => void,
  ) {
    this.session = session;
    this.server = server;
    this.device = device;
    this.outputDir = outputDir;
    this.releaseLock = release;
  }

  private get platform(): MobilePlatform {
    return this.device.platform;
  }

  async captureScreen(): Promise<ScreenFrame> {
    const filePath = path.join(this.outputDir, `inspector-frame-${this.frameCounter}.png`);
    await this.session.saveScreenshot(filePath);
    const buf = await fs.readFile(filePath);
    const size = readImageSize(buf) ?? { width: 0, height: 0 };
    const coordinateSize = await this.session.getWindowSize();
    return {
      frameId: this.frameCounter++,
      imageBase64: buf.toString('base64'),
      width: size.width,
      height: size.height,
      coordinateWidth: coordinateSize.width,
      coordinateHeight: coordinateSize.height,
      orientation: size.width > size.height ? 'landscape' : 'portrait',
      capturedAt: Date.now(),
    };
  }

  async inspectHierarchy(): Promise<MobileNode[]> {
    return xmlToMobileHierarchy(await this.session.getPageSource(), this.platform);
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

  /** Resolve a {@link MobileTarget} to `{ x, y }` — a locator via its element rect, or a raw point. */
  private async resolvePoint(target: MobileTarget): Promise<{ x: number; y: number }> {
    if ('x' in target && 'y' in target) {
      return target;
    }
    const element = await this.session.$(toAppiumSelector(target, this.platform));
    const rect = await this.session.getElementRect(await elementIdOf(element));
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  }

  /**
   * Tap a raw device-pixel coordinate via the W3C pointer Actions API (works identically on Android
   * and iOS, unlike the `mobile:` gesture extensions). Needed because `locator.point`-only actions
   * reach here routinely: the recorder's tap-to-record flow falls back to a coordinate-only locator
   * whenever hit-testing the hierarchy finds no element under the tap (hierarchy not loaded yet, tap
   * in dead space, etc.), not just as a rare edge case.
   */
  private async tapPoint(x: number, y: number): Promise<void> {
    await this.session
      .action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x, y })
      .down()
      .up()
      .perform();
  }

  private async execute(action: MobileAction): Promise<unknown> {
    switch (action.kind) {
      case 'tap':
        if (action.locator.point) {
          return this.tapPoint(action.locator.point.x, action.locator.point.y);
        }
        return (await this.session.$(toAppiumSelector(action.locator, this.platform))).click();
      case 'fill':
        if (action.locator.point) {
          // No element to call `setValue` on for a bare point — tap to focus whatever is there,
          // then send keystrokes to the focused field. Best-effort: relies on a native/soft
          // keyboard accepting synthesized key events, unlike the element-targeted `setValue` path.
          await this.tapPoint(action.locator.point.x, action.locator.point.y);
          return this.session.keys(action.value);
        }
        return (await this.session.$(toAppiumSelector(action.locator, this.platform))).setValue(
          action.value,
        );
      case 'longPress': {
        const durationMs = action.options?.durationMs ?? 1000;
        if (action.locator.point) {
          const { x, y } = action.locator.point;
          return this.platform === 'android'
            ? this.session.execute('mobile: longClickGesture', { x, y, duration: durationMs })
            : this.session.execute('mobile: touchAndHold', { x, y, duration: durationMs / 1000 });
        }
        const element = await this.session.$(toAppiumSelector(action.locator, this.platform));
        const elementId = await elementIdOf(element);
        return this.platform === 'android'
          ? this.session.execute('mobile: longClickGesture', {
              elementId,
              duration: durationMs,
            })
          : this.session.execute('mobile: touchAndHold', {
              elementId,
              duration: durationMs / 1000,
            });
      }
      case 'swipe':
        return this.swipeWholeScreen(action.direction, action.options?.durationMs);
      case 'scroll':
        return this.scrollScreen(action.direction, action.options?.within);
      case 'drag': {
        const from = await this.resolvePoint(action.from);
        const to = await this.resolvePoint(action.to);
        return this.platform === 'android'
          ? this.session.execute('mobile: dragGesture', {
              startX: from.x,
              startY: from.y,
              endX: to.x,
              endY: to.y,
            })
          : this.session.execute('mobile: dragFromToForDuration', {
              fromX: from.x,
              fromY: from.y,
              toX: to.x,
              toY: to.y,
              duration: 1,
            });
      }
      case 'pinch':
        return this.pinch(action.scale, action.options?.durationMs);
      case 'pressKey':
        return this.pressKey(action.key);
      case 'back':
        if (this.platform !== 'android') {
          throw new Error('[appium-inspector] "back" has no iOS equivalent (no hardware back)');
        }
        return this.session.pressKeyCode(ANDROID_KEYCODES.back);
      case 'waitFor':
        return (
          await this.session.$(toAppiumSelector(action.locator, this.platform))
        ).waitForDisplayed({
          timeout: action.options?.timeoutMs ?? 5000,
        });
      case 'isVisible':
        return this.isVisible(action.locator, action.options?.timeoutMs);
      case 'assertVisible': {
        const visible = await (
          await this.session.$(toAppiumSelector(action.locator, this.platform))
        ).waitForDisplayed({ timeout: 5000 });
        if (!visible) {
          throw new Error('[appium-inspector] element never became visible');
        }
        return true;
      }
      case 'assertNotVisible': {
        const element = await this.session.$(toAppiumSelector(action.locator, this.platform));
        const displayed = (await element.isExisting()) && (await element.isDisplayed());
        if (displayed) {
          throw new Error('[appium-inspector] element is visible but expected not to be');
        }
        return true;
      }
      case 'screenshot': {
        const name = action.name ?? `screenshot-${Date.now()}`;
        const filePath = path.join(this.outputDir, `${name}.png`);
        await this.session.saveScreenshot(filePath);
        return filePath;
      }
      case 'aiAssert': {
        // Recording-time preview only: capture the screenshot the rubric will judge; the actual
        // rubric evaluation happens in the GENERATED test (via @pwtap/plugin-ai-judge), not here.
        const name = action.name ?? `ai-assert-${Date.now()}`;
        const filePath = path.join(this.outputDir, `${name}.png`);
        await this.session.saveScreenshot(filePath);
        return filePath;
      }
      default: {
        const exhaustiveCheck: never = action;
        throw new Error(`[appium-inspector] unhandled action: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  /**
   * Boolean visibility query that never throws on absence (architecture.md ADR-004). `waitForDisplayed`
   * is unusable here: it throws on timeout, which is exactly why the old `assertVisible`-backed
   * `isVisible()` could never answer `false` and made every generated "assert not visible" fail. This
   * polls `isExisting() && isDisplayed()` until the deadline instead, and a driver hiccup mid-poll is
   * treated as "no answer yet" rather than as an answer. A coordinate-only locator has no meaningful
   * answer at all, so `toAppiumSelector` is left to reject it loudly.
   */
  private async isVisible(locator: MobileLocator, timeoutMs = 5000): Promise<boolean> {
    const selector = toAppiumSelector(locator, this.platform);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      try {
        const element = await this.session.$(selector);
        if ((await element.isExisting()) && (await element.isDisplayed())) {
          return true;
        }
      } catch {
        // Transient driver error — keep polling until the deadline rather than reporting "not visible".
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  private async swipeWholeScreen(
    direction: MobileDirection,
    durationMs?: number,
  ): Promise<unknown> {
    const { width, height } = await this.session.getWindowSize();
    if (this.platform === 'android') {
      return this.session.execute('mobile: swipeGesture', {
        left: 0,
        top: 0,
        width,
        height,
        direction: direction as 'up' | 'down' | 'left' | 'right',
        percent: 0.75,
        speed: durationMs ? Math.round((height * 1000) / durationMs) : undefined,
      });
    }
    return this.session.execute('mobile: swipe', { direction });
  }

  private async scrollScreen(direction: MobileDirection, within?: MobileLocator): Promise<unknown> {
    if (this.platform === 'android') {
      const params: Record<string, unknown> = { direction, percent: 0.75 };
      if (within) {
        params.elementId = await elementIdOf(
          await this.session.$(toAppiumSelector(within, 'android')),
        );
      } else {
        const { width, height } = await this.session.getWindowSize();
        Object.assign(params, { left: 0, top: 0, width, height });
      }
      return this.session.execute('mobile: scrollGesture', params);
    }
    const params: Record<string, unknown> = { direction };
    if (within) {
      params.elementId = await elementIdOf(await this.session.$(toAppiumSelector(within, 'ios')));
    }
    return this.session.execute('mobile: scroll', params);
  }

  private async pinch(scale: number, durationMs?: number): Promise<unknown> {
    const { width, height } = await this.session.getWindowSize();
    const opening = scale > 1;
    if (this.platform === 'android') {
      const command = opening ? 'mobile: pinchOpenGesture' : 'mobile: pinchCloseGesture';
      return this.session.execute(command, {
        left: 0,
        top: 0,
        width,
        height,
        percent: Math.min(1, Math.abs(scale - 1)),
        speed: durationMs ? Math.round((height * 1000) / durationMs) : undefined,
      });
    }
    // iOS `mobile: pinch` needs a target element — default to the app's root element.
    const root = await this.session.$('-ios predicate string:type == "XCUIElementTypeApplication"');
    return this.session.execute('mobile: pinch', {
      elementId: await elementIdOf(root),
      scale,
      velocity: 1,
    });
  }

  private async pressKey(key: string): Promise<unknown> {
    if (this.platform === 'android') {
      const code = ANDROID_KEYCODES[key];
      if (code === undefined) {
        throw new Error(`[appium-inspector] unknown Android key "${key}"`);
      }
      return this.session.pressKeyCode(code);
    }
    const button = IOS_BUTTONS[key];
    if (!button) {
      throw new Error(`[appium-inspector] key "${key}" has no iOS equivalent`);
    }
    return this.session.execute('mobile: pressButton', { name: button });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const errors: unknown[] = [];
    try {
      await closeSession(this.session);
    } catch (error) {
      errors.push(error);
    }
    if (this.platform === 'ios') {
      try {
        await stopIosAutomation(this.device.id);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.server.stop();
    } catch (error) {
      errors.push(error);
    } finally {
      this.releaseLock?.();
      this.releaseLock = undefined;
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, '[appium-inspector] failed to close the driver session');
    }
  }
}

class AppiumInspectorDriver implements MobileInspectorDriver {
  readonly id = 'appium';
  readonly capabilities = CAPABILITIES;
  /** Must stay in step with this plugin's `manifest.ts` Playwright project block. */
  readonly testBinding = {
    extension: '.appium.ts',
    project: 'appium',
    gateEnv: 'APPIUM',
  };

  /** Delegates to the shared cross-adapter device discovery helper (see `deviceDiscovery.ts`). */
  async discoverDevices(): Promise<InspectorDevice[]> {
    return discoverMobileDevices();
  }

  async connect(options: ConnectOptions): Promise<DriverSession> {
    assertPlatformSupported(options.platform);
    const release = await acquireDeviceLock(deviceLockKey(options.platform, options.device));
    let server: AppiumServerHandle | undefined;
    try {
      const acquired = await acquireDevice(options.platform, {
        deviceName: options.device,
        headless: options.headless ?? true,
        onBooted: recordBootedDevice,
      });
      if (!acquired) {
        throw new Error(
          `[appium-inspector] no ${options.platform} device available to connect the inspector to`,
        );
      }
      server = await ensureAppiumServer(0);
      // A local artifact installs (and launches) via the `app` capability — Appium handles install
      // itself, unlike Maestro. With no artifact, start a plain session (lands on the home screen)
      // and activate the already-installed `appId` afterwards via `mobile: activateApp`, since a bare
      // package/bundle id isn't a valid `appium:app` value (that capability expects a file path/URL).
      const capabilities = buildCapabilities({ device: acquired, app: options.appSource });
      const session = await createSession({ baseUrl: server.baseUrl, capabilities });
      if (options.appId && !options.appSource) {
        await session.execute(
          'mobile: activateApp',
          options.platform === 'android' ? { appId: options.appId } : { bundleId: options.appId },
        );
      }
      const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pwtap-mobile-inspector-'));
      return new AppiumDriverSession(
        session,
        server,
        toInspectorDevice(acquired, true),
        outputDir,
        release,
      );
    } catch (error) {
      let cleanupError: unknown;
      try {
        await server?.stop();
      } catch (caught) {
        cleanupError = caught;
      } finally {
        release();
      }
      if (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          '[appium-inspector] connection and server cleanup failed',
        );
      }
      throw error;
    }
  }
}

export const driver: MobileInspectorDriver = new AppiumInspectorDriver();
