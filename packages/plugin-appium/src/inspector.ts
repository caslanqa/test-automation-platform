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
  MobileTarget,
  ScreenFrame,
} from '@pwtap/mobile-core';
import {
  ACTION_DEFAULTS,
  DeviceUnavailableError,
  deviceUnavailableMessage,
  discoverMobileDevices,
  orientCoordinateSpace,
  readImageSize,
} from '@pwtap/mobile-core';
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

/**
 * What this driver can do on the platform it is connected to. `back` is the case that forced this: Android has
 * a hardware back key and iOS has none, and one static declaration made before the platform is known can only
 * overstate it — which left the UI offering a button that always failed.
 */
function capabilitiesFor(platform: MobilePlatform): DriverCapabilities {
  return {
    ...CAPABILITIES,
    gestures: { ...CAPABILITIES.gestures, back: platform === 'android' },
  };
}

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

/** The resolved element WebdriverIO hands back, without naming one of its internal types. */
type AppiumElement = Awaited<ReturnType<WebdriverIO.Browser['$']>>;

/** BACK_SPACE in the W3C key set — how a partial erase is expressed when a driver can only clear a field. */
const BACKSPACE = '\uE003';

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
  /** Interaction coordinate space, read once and reconciled with each frame's orientation. */
  private windowSize: { width: number; height: number } | undefined;

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

  /** Narrows the driver's static declaration to this platform — see `capabilitiesFor`. */
  get capabilities(): DriverCapabilities {
    return capabilitiesFor(this.platform);
  }

  /**
   * The interaction coordinate space, read once.
   *
   * `getWindowSize()` is a WebDriver round trip, and the inspector captures on every action and every idle
   * poll — asking again per frame bought a number that only changes on rotation, which
   * {@link orientCoordinateSpace} resolves from the image itself.
   */
  private async coordinateSpace(): Promise<{ width: number; height: number }> {
    this.windowSize ??= await this.session.getWindowSize();
    return this.windowSize;
  }

  async captureScreen(): Promise<ScreenFrame> {
    // `takeScreenshot()` already returns base64. `saveScreenshot` + `readFile` wrote a PNG per frame into
    // a temp directory nothing ever emptied (hundreds of files in a ten-minute session, against a §11
    // budget of three) to arrive at the same string.
    const imageBase64 = await this.session.takeScreenshot();
    // ponytail: the decode is only here to read the PNG header — `ScreenFrame` carries base64 by contract.
    const size = readImageSize(Buffer.from(imageBase64, 'base64')) ?? { width: 0, height: 0 };
    const coordinateSize = orientCoordinateSpace(size, await this.coordinateSpace());
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

  /**
   * The element a locator addresses, honouring `locator.index`.
   *
   * Every element lookup goes through here so the ordinal is not something each call site can forget: `index`
   * selects among the matches (WebdriverIO's `$$` returns them in document order, which is the order the
   * locator engine counts in), and an index past the end fails by saying how many matched rather than
   * throwing `undefined is not an object` from inside the driver.
   */
  private async element(locator: MobileLocator): Promise<AppiumElement> {
    const selector = toAppiumSelector(locator, this.platform);
    if (locator.index === undefined) {
      return this.session.$(selector);
    }
    const matches = await this.session.$$(selector);
    const match = matches[locator.index];
    if (!match) {
      throw new Error(
        `[appium-inspector] index ${locator.index} is out of range — ${matches.length} element(s) match ` +
          `${JSON.stringify(selector)}`,
      );
    }
    return match;
  }

  /** Resolve a {@link MobileTarget} to `{ x, y }` — a locator via its element rect, or a raw point. */
  private async resolvePoint(target: MobileTarget): Promise<{ x: number; y: number }> {
    if ('x' in target && 'y' in target) {
      return target;
    }
    const element = await this.element(target);
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
        return (await this.element(action.locator)).click();
      case 'doubleTap': {
        const elementId = await elementIdOf(await this.element(action.locator));
        return this.platform === 'android'
          ? this.session.execute('mobile: doubleClickGesture', { elementId })
          : this.session.execute('mobile: doubleTap', { elementId });
      }
      case 'eraseText': {
        const element = await this.element(action.locator);
        const characters = action.options?.characters;
        if (characters === undefined) {
          return element.clearValue();
        }
        // `clearValue` empties the field, so a partial erase is keystrokes instead — focus first, since
        // `keys` goes to whatever has focus rather than to an element.
        await element.click();
        return this.session.keys(BACKSPACE.repeat(characters));
      }
      case 'hideKeyboard':
        // The `mobile:` extension rather than WebdriverIO's `hideKeyboard()`: both UiAutomator2 and XCUITest
        // implement it, and it is the one form that does not need per-platform strategy arguments.
        return this.session.execute('mobile: hideKeyboard');
      case 'scrollUntilVisible':
        return this.scrollUntilVisible(
          action.locator,
          action.options?.direction ?? 'down',
          action.options?.timeoutMs ?? ACTION_DEFAULTS.scrollUntilVisibleMs,
        );
      case 'fill':
        if (action.locator.point) {
          // No element to call `setValue` on for a bare point — tap to focus whatever is there,
          // then send keystrokes to the focused field. Best-effort: relies on a native/soft
          // keyboard accepting synthesized key events, unlike the element-targeted `setValue` path.
          await this.tapPoint(action.locator.point.x, action.locator.point.y);
          return this.session.keys(action.value);
        }
        return (await this.element(action.locator)).setValue(action.value);
      case 'longPress': {
        const durationMs = action.options?.durationMs ?? ACTION_DEFAULTS.longPressMs;
        if (action.locator.point) {
          const { x, y } = action.locator.point;
          return this.platform === 'android'
            ? this.session.execute('mobile: longClickGesture', { x, y, duration: durationMs })
            : this.session.execute('mobile: touchAndHold', { x, y, duration: durationMs / 1000 });
        }
        const element = await this.element(action.locator);
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
        return this.swipeWholeScreen(
          action.direction,
          action.options?.durationMs,
          action.options?.distance,
        );
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
        return (await this.element(action.locator)).waitForDisplayed({
          timeout: action.options?.timeoutMs ?? ACTION_DEFAULTS.waitForMs,
        });
      case 'isVisible':
        return this.isVisible(action.locator, action.options?.timeoutMs);
      case 'assertVisible': {
        const visible = await (
          await this.element(action.locator)
        ).waitForDisplayed({ timeout: 5000 });
        if (!visible) {
          throw new Error('[appium-inspector] element never became visible');
        }
        return true;
      }
      case 'assertNotVisible': {
        const element = await this.element(action.locator);
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
  private async isVisible(
    locator: MobileLocator,
    timeoutMs = ACTION_DEFAULTS.isVisibleMs,
  ): Promise<boolean> {
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

  /**
   * Scroll until an element is visible, or fail at the deadline.
   *
   * Maestro has a primitive for this; Appium does not, so it is a bounded loop of "look, then scroll". The
   * platform-specific alternatives were both worse: Android's `UiScrollable().scrollIntoView` only accepts a
   * `UiSelector`, so an accessibility-id or predicate locator could not use it, and iOS's `mobile: scroll`
   * with `predicateString` needs a container element the recording does not have. A loop over the two
   * primitives this adapter already implements works for every locator on both platforms.
   *
   * The visibility check is deliberately short-bounded per attempt: `isVisible`'s own default would spend
   * seconds per iteration waiting for something that is genuinely not on screen yet.
   */
  private async scrollUntilVisible(
    locator: MobileLocator,
    direction: MobileDirection,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (await this.isVisible(locator, POLL_INTERVAL_MS)) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `[appium-inspector] scrollUntilVisible gave up after ${timeoutMs}ms — ` +
            `${JSON.stringify(locator)} never came into view scrolling ${direction}`,
        );
      }
      await this.scrollScreen(direction);
    }
  }

  private async swipeWholeScreen(
    direction: MobileDirection,
    durationMs?: number,
    distance?: number,
  ): Promise<unknown> {
    const { width, height } = await this.session.getWindowSize();
    if (this.platform === 'android') {
      return this.session.execute('mobile: swipeGesture', {
        left: 0,
        top: 0,
        width,
        height,
        direction: direction as 'up' | 'down' | 'left' | 'right',
        percent: distance ?? ACTION_DEFAULTS.swipeDistance,
        speed: durationMs ? Math.round((height * 1000) / durationMs) : undefined,
      });
    }
    // XCUITest's `mobile: swipe` is direction-only, so a requested distance cannot be honoured. Refusing
    // beats swiping a different amount than the test asks for and calling it done.
    if (distance !== undefined) {
      throw new Error(
        '[appium-inspector] XCUITest swipes by direction only and cannot honour `distance` — record the ' +
          'swipe without it, or use a drag between two points',
      );
    }
    return this.session.execute('mobile: swipe', { direction });
  }

  private async scrollScreen(direction: MobileDirection, within?: MobileLocator): Promise<unknown> {
    if (this.platform === 'android') {
      const params: Record<string, unknown> = {
        direction,
        percent: ACTION_DEFAULTS.swipeDistance,
      };
      if (within) {
        params.elementId = await elementIdOf(await this.element(within));
      } else {
        const { width, height } = await this.session.getWindowSize();
        Object.assign(params, { left: 0, top: 0, width, height });
      }
      return this.session.execute('mobile: scrollGesture', params);
    }
    const params: Record<string, unknown> = { direction };
    if (within) {
      params.elementId = await elementIdOf(await this.element(within));
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
      // Best-effort: a leftover temp directory is untidy, not a failure, and must not mask a close error.
      await fs.rm(this.outputDir, { recursive: true, force: true }).catch(() => undefined);
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
    const progress = options.onProgress ?? ((): void => undefined);
    const release = await acquireDeviceLock(deviceLockKey(options.platform, options.device));
    let server: AppiumServerHandle | undefined;
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
          await deviceUnavailableMessage('appium', options.platform, options.device),
        );
      }
      progress('starting the Appium server');
      server = await ensureAppiumServer(0);
      // A local artifact installs (and launches) via the `app` capability — Appium handles install
      // itself, unlike Maestro. With no artifact, start a plain session (lands on the home screen)
      // and activate the already-installed `appId` afterwards via `mobile: activateApp`, since a bare
      // package/bundle id isn't a valid `appium:app` value (that capability expects a file path/URL).
      const capabilities = buildCapabilities({ device: acquired, app: options.appSource });
      // On iOS the first session of a machine builds WebDriverAgent, which is minutes, not seconds — the
      // single longest silence in the whole connect and the one users read as a hang.
      progress(
        options.appSource
          ? `installing ${options.appSource} and starting the driver session`
          : 'starting the driver session',
      );
      const session = await createSession({ baseUrl: server.baseUrl, capabilities });
      if (options.appId && !options.appSource) {
        progress(`activating ${options.appId}`);
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
/**
 * The core↔adapter contract this adapter implements (ADR-009). A literal on purpose: importing
 * `MOBILE_CORE_CONTRACT` would make it agree with whatever core is installed, which is the mismatch the
 * check exists to catch. Bumping the core's contract breaks this line's type until it is reviewed.
 */
export const contract: AdapterContract = 1;
