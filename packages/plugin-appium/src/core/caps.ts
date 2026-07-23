import type { DiscoveredDevice } from '@pwtap/platform';

export interface AppiumCapabilityOptions {
  device: DiscoveredDevice;
  /** Local app artifact path (or an already-installed bundle/package id), sets `appium:app`. */
  app?: string;
  /** Escape hatch — extra W3C capabilities, merged on top (these win over the computed ones). */
  capabilities?: Record<string, unknown>;
}

/**
 * Build W3C capabilities for `device`: `UiAutomator2` on Android, `XCUITest` on iOS, targeting the
 * exact booted device by its adb serial / simulator UDID. `options.capabilities` is an escape hatch
 * for anything this doesn't cover (e.g. `appium:noReset`, `appium:language`) — merged last, so it can
 * override the computed values too.
 */
export function buildCapabilities(options: AppiumCapabilityOptions): Record<string, unknown> {
  const { device, app, capabilities } = options;
  const base: Record<string, unknown> =
    device.platform === 'android'
      ? {
          platformName: 'Android',
          'appium:automationName': 'UiAutomator2',
          'appium:udid': device.id,
        }
      : {
          platformName: 'iOS',
          'appium:automationName': 'XCUITest',
          'appium:udid': device.id,
          'appium:deviceName': device.name ?? device.id,
        };
  if (app) {
    base['appium:app'] = app;
  }
  return { ...base, ...capabilities };
}
