import type { MobilePlatform } from './core/types';

/** A named device the project can target. */
export interface DeviceSpec {
  platform: MobilePlatform;
  /** Android AVD name, or iOS simulator name/UDID. Omit to use any booted device of the platform. */
  device?: string;
}

/**
 * The project's device catalog — the single place device names live. Reference an entry in a test:
 *
 * @example
 * import { devices } from '@mobile/devices';
 * test.use({ mobile: devices.pixel7 }); // type-checked — only entries defined here are selectable
 *
 * Add a `device` (AVD name / iOS simulator name or UDID) to have it auto-booted on first use. Create
 * one from your installed SDK/Xcode with `npm run mobile:create-device`, then add it here.
 */
export const devices = {
  pixel7: { platform: 'android', device: 'Pixel_7_API_34' },
  iphone16: { platform: 'ios', device: 'iPhone 16 Pro' },
  android: { platform: 'android' }, // add device: 'Pixel_7_API_34' to auto-boot a specific AVD
  ios: { platform: 'ios' }, // add device: 'iPhone 16 Pro' to auto-boot a specific simulator
} as const satisfies Record<string, DeviceSpec>;
