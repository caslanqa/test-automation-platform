/**
 * The unified `MobileApp` Playwright fixture. Generated inspector tests (and any hand-written test)
 * select a driver explicitly and get the same `app.tap(...)`/`app.fill(...)` surface regardless of
 * whether Maestro or Appium is running underneath:
 *
 * ```ts
 * import { test, expect } from '@fixtures';
 *
 * test.use({
 *   mobileTarget: {
 *     driver: 'maestro',
 *     platform: 'android',
 *     device: 'Pixel_7_API_34',
 *     appId: 'com.example.app',
 *   },
 * });
 *
 * test('recorded flow', async ({ mobileApp }) => {
 *   await mobileApp.tap({ accessibilityId: 'loginButton' });
 *   await mobileApp.fill({ accessibilityId: 'username' }, 'John Doe');
 *   await expect.poll(() => mobileApp.isVisible({ text: 'Dashboard' })).toBe(true);
 * });
 * ```
 *
 * This is additive: existing `maestro` (from `@pwtap/plugin-maestro`) and `app` (raw WebdriverIO, from
 * `@pwtap/plugin-appium`) fixtures are untouched and keep working — this is a separate, driver-neutral
 * facade for inspector-generated tests, under names that collide with neither (ADR-003).
 */
import { test as base, expect } from '@playwright/test';

import type { MobilePlatform } from '@pwtap/platform';

import { discoverDriverMap } from './registry.js';
import type {
  DriverCapabilities,
  DriverSession,
  LongPressOptions,
  MobileAction,
  MobileApp,
  MobileDirection,
  MobileDriverId,
  MobileKey,
  MobileLocator,
  MobileTarget,
  PinchOptions,
  ScrollOptions,
  SwipeOptions,
  WaitOptions,
} from './types.js';
import { DriverNotFoundError, UnsupportedActionError } from './types.js';

/**
 * Driver/device/app selection for the {@link MobileApp} facade.
 *
 * The name is `mobileTarget`, not `mobile`, and the fixture below is `mobileApp`, not `app` — both of
 * the obvious names are already taken by the plugins this composes alongside (`@pwtap/plugin-maestro`
 * owns the `mobile` option, `@pwtap/plugin-appium` owns the `app` fixture), and in Playwright an option
 * *is* a fixture, so reusing either name is a merge conflict rather than an override. See
 * docs/mobile-inspector/architecture.md ADR-003.
 *
 * Not to be confused with `MobileTarget` in `types.ts`, which is an unrelated thing: the point-or-locator
 * a single *gesture* aims at (`drag(from, to)`). This type selects the device and app a whole test drives.
 */
export interface MobileTargetOptions {
  /** Which installed adapter to drive (`'maestro'` | `'appium'`); falls back to `MOBILE_INSPECTOR_DRIVER`. */
  driver?: MobileDriverId;
  /** Falls back to `MOBILE_INSPECTOR_PLATFORM`, then `MOBILE_PLATFORM`/`APPIUM_PLATFORM`. */
  platform?: MobilePlatform;
  /**
   * Stable device name — an Android AVD name or an iOS simulator name/UDID. Never an `adb` serial:
   * serials change across reboots and this value is replayed days later (ADR-003).
   */
  device?: string;
  headless?: boolean;
  /**
   * Android package name / iOS bundle id to launch. Effectively REQUIRED for Maestro, whose MCP session
   * scopes every command to an app id; without it a replayed test drives nothing.
   */
  appId?: string;
  /** Build artifact (`.apk`/`.app`/`.ipa`/`.zip`) or https URL to install before launching `appId`. */
  appSource?: string;
}

/** Options this test object adds. */
export interface MobileInspectorOptions {
  /**
   * Set per file or describe block:
   * `test.use({ mobileTarget: { driver: 'appium', platform: 'android', appId: 'com.example.app' } })`.
   */
  mobileTarget: MobileTargetOptions | undefined;
}

interface MobileInspectorFixtures {
  mobileApp: MobileApp;
}

function resolveDriverId(option?: MobileDriverId): string {
  const id = option ?? process.env.MOBILE_INSPECTOR_DRIVER;
  if (!id) {
    throw new Error(
      "[mobile-inspector] no driver selected — use test.use({ mobile: { driver: 'maestro' | 'appium' } }) " +
        'or set MOBILE_INSPECTOR_DRIVER in env/environments.json',
    );
  }
  return id;
}

function resolvePlatform(option?: MobilePlatform): MobilePlatform {
  const platform =
    option ??
    (process.env.MOBILE_INSPECTOR_PLATFORM as MobilePlatform | undefined) ??
    (process.env.MOBILE_PLATFORM as MobilePlatform | undefined) ??
    (process.env.APPIUM_PLATFORM as MobilePlatform | undefined);
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error(
      "[mobile-inspector] platform not set — use test.use({ mobile: { platform: 'android' | 'ios' } }) " +
        'or set MOBILE_INSPECTOR_PLATFORM in env/environments.json',
    );
  }
  return platform;
}

function resolveHeadless(option?: boolean): boolean {
  if (typeof option === 'boolean') {
    return option;
  }
  const env = process.env.MOBILE_INSPECTOR_HEADLESS?.trim();
  return env ? /^(1|true|yes|on)$/i.test(env) : true;
}

/**
 * Wrap a raw {@link DriverSession} with the ergonomic `MobileApp` facade — translating each method
 * into a {@link MobileAction}, checking the driver's declared capabilities first (so unsupported
 * gestures fail fast with a clear error instead of silently no-op'ing), and unwrapping
 * `ActionResult`s (throwing on `ok: false`).
 */
function toMobileApp(
  session: DriverSession,
  driverId: MobileDriverId,
  capabilities: DriverCapabilities['gestures'],
): MobileApp {
  async function perform(action: MobileAction): Promise<unknown> {
    const result = await session.perform(action);
    if (!result.ok) {
      throw new Error(
        `[mobile-inspector] "${action.kind}" failed: ${result.error ?? 'unknown error'}`,
      );
    }
    return result.value;
  }

  function assertSupported(kind: MobileAction['kind']): void {
    if (capabilities[kind] === false) {
      throw new UnsupportedActionError(driverId, kind);
    }
  }

  return {
    async tap(locator: MobileLocator) {
      assertSupported('tap');
      await perform({ kind: 'tap', locator });
    },
    async fill(locator: MobileLocator, value: string) {
      assertSupported('fill');
      await perform({ kind: 'fill', locator, value });
    },
    async longPress(locator: MobileLocator, options?: LongPressOptions) {
      assertSupported('longPress');
      await perform({ kind: 'longPress', locator, options });
    },
    async swipe(direction: MobileDirection, options?: SwipeOptions) {
      assertSupported('swipe');
      await perform({ kind: 'swipe', direction, options });
    },
    async scroll(direction: MobileDirection, options?: ScrollOptions) {
      assertSupported('scroll');
      await perform({ kind: 'scroll', direction, options });
    },
    async drag(from: MobileTarget, to: MobileTarget) {
      assertSupported('drag');
      await perform({ kind: 'drag', from, to });
    },
    async pinch(scale: number, options?: PinchOptions) {
      assertSupported('pinch');
      await perform({ kind: 'pinch', scale, options });
    },
    async pressKey(key: MobileKey) {
      assertSupported('pressKey');
      await perform({ kind: 'pressKey', key });
    },
    async back() {
      assertSupported('back');
      await perform({ kind: 'back' });
    },
    async waitFor(locator: MobileLocator, options?: WaitOptions) {
      assertSupported('waitFor');
      await perform({ kind: 'waitFor', locator, options });
    },
    async isVisible(locator: MobileLocator, options?: WaitOptions) {
      // The dedicated boolean action, NOT `assertVisible`: the assertions throw when the element is
      // absent, so routing this through one made `isVisible()` unable to ever return `false` and broke
      // every generated visibility check (architecture.md ADR-004).
      assertSupported('isVisible');
      const value = await perform({ kind: 'isVisible', locator, options });
      return Boolean(value);
    },
    async screenshot(name?: string) {
      assertSupported('screenshot');
      const value = await perform({ kind: 'screenshot', name });
      return String(value);
    },
  };
}

/**
 * The unified, driver-neutral mobile test object. Extends the plain Playwright base (no browser
 * needed). Composed alongside — not instead of — the existing `maestro`/`app` fixtures.
 */
export const test = base.extend<MobileInspectorOptions & MobileInspectorFixtures>({
  mobileTarget: [undefined, { option: true }],

  mobileApp: [
    async ({ mobileTarget }, use) => {
      const driverId = resolveDriverId(mobileTarget?.driver);
      const drivers = await discoverDriverMap();
      const driver = drivers.get(driverId);
      if (!driver) {
        throw new DriverNotFoundError(driverId);
      }

      const session = await driver.connect({
        platform: resolvePlatform(mobileTarget?.platform),
        device: mobileTarget?.device,
        headless: resolveHeadless(mobileTarget?.headless),
        // Forwarded, not dropped: a recorded flow is meaningless if the replay never launches the app it
        // was recorded against — and Maestro's session refuses every command until an app id is set.
        appId: mobileTarget?.appId,
        appSource: mobileTarget?.appSource,
      });
      try {
        await use(toMobileApp(session, driver.id, driver.capabilities.gestures));
      } finally {
        await session.close();
      }
    },
    { box: true },
  ],
});

export { expect };
