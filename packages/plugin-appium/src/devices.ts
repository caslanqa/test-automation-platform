import type { MobilePlatform } from '@pwtap/platform';

/** A named device the project can target. */
export interface DeviceSpec {
  platform: MobilePlatform;
  /** Android AVD name, or iOS simulator name/UDID. Omit to use any booted device of the platform. */
  device?: string;
  /** Show the device (emulator window / Simulator GUI) with `false`. Default `true` (hidden) when the framework boots it. */
  headless?: boolean;
}

/**
 * A starter device catalog — a convenient place to name the devices your project targets. Reference
 * an entry in a test, or pass an inline spec:
 *
 * @example
 * import { test } from '@fixtures';
 * import { devices } from '@pwtap/plugin-appium';
 *
 * test.use({ appium: devices.pixel9 });                          // from the catalog
 * test.use({ appium: { platform: 'android', device: 'MyAvd' } }); // inline
 *
 * Add a `device` (AVD name / iOS simulator name or UDID) to have it auto-booted on first use. Create
 * one via Android Studio's AVD Manager / Xcode's Simulator app — or, if `@pwtap/plugin-maestro` is
 * also installed, its `npm run mobile:create-device` script. When a named device isn't present the
 * test SKIPS (never fails), so these examples are safe to keep.
 */
export const devices = {
  pixel9b: { platform: 'android', device: 'pixel9b' },
  pixel9: { platform: 'android', device: 'pixel9' },
  iphone16: { platform: 'ios', device: 'iPhone 16 Pro' },
  android: { platform: 'android' }, // add device: 'Pixel_7_API_34' to auto-boot a specific AVD
  ios: { platform: 'ios' }, // add device: 'iPhone 16 Pro' to auto-boot a specific simulator
} as const satisfies Record<string, DeviceSpec>;
