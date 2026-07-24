/**
 * The unified `MobileApp` Playwright fixture. Generated inspector tests (and any hand-written test)
 * select a driver explicitly and get the same `app.tap(...)`/`app.fill(...)` surface regardless of
 * whether Maestro or Appium is running underneath:
 *
 * ```ts
 * import { test, expect } from '@pwtap/mobile-inspector';
 *
 * test.use({ mobile: { driver: 'maestro', device: 'Pixel_7_API_34' } });
 *
 * test('recorded flow', async ({ app }) => {
 *   await app.tap({ accessibilityId: 'loginButton' });
 *   await app.fill({ accessibilityId: 'username' }, 'John Doe');
 *   await app.waitFor({ text: 'Dashboard' });
 * });
 * ```
 *
 * This is additive: existing `maestro` (from `@pwtap/plugin-maestro`) and `app` (raw WebdriverIO, from
 * `@pwtap/plugin-appium`) fixtures are untouched and keep working — this fixture is a separate,
 * driver-neutral facade for inspector-generated tests.
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

/** Options this test object adds. */
export interface MobileInspectorOptions {
  /**
   * Driver/device selection for the unified `app` fixture. Set per file/describe with
   * `test.use({ mobile: { driver: 'maestro', device: 'Pixel_7_API_34' } })`.
   * - `driver` selects which installed adapter to use (`'maestro'` | `'appium'`); falls back to the
   *   `MOBILE_INSPECTOR_DRIVER` env var.
   * - `platform` falls back to `MOBILE_INSPECTOR_PLATFORM`, then `MOBILE_PLATFORM`/`APPIUM_PLATFORM`.
   * - `device` and `headless` behave like the Maestro/Appium plugins' own options.
   */
  mobile:
    | {
        driver?: MobileDriverId;
        platform?: MobilePlatform;
        device?: string;
        headless?: boolean;
      }
    | undefined;
}

interface MobileInspectorFixtures {
  app: MobileApp;
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
    async isVisible(locator: MobileLocator) {
      assertSupported('assertVisible');
      const value = await perform({ kind: 'assertVisible', locator });
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
  mobile: [undefined, { option: true }],

  app: [
    async ({ mobile }, use) => {
      const driverId = resolveDriverId(mobile?.driver);
      const drivers = await discoverDriverMap();
      const driver = drivers.get(driverId);
      if (!driver) {
        throw new DriverNotFoundError(driverId);
      }

      const session = await driver.connect({
        platform: resolvePlatform(mobile?.platform),
        device: mobile?.device,
        headless: resolveHeadless(mobile?.headless),
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
