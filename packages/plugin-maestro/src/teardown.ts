import { shutdownEmulator, shutdownSim } from '@pwtap/platform';

import { clearBootedDevices, readBootedDevices } from './core/booted.js';

/**
 * Shut down the devices the framework AUTO-BOOTED this run (recorded via the fixture's `onBooted`
 * hook) so emulators/simulators don't linger. Devices you booted yourself are never recorded, so
 * they're left running. Set `MOBILE_KEEP_DEVICES=1` to keep the auto-booted ones too (faster
 * iterative reruns). A no-op when nothing was booted. Invoked by `npm run mobile:stop-devices`, and
 * usable as a Playwright `globalTeardown` (default export).
 */
export async function stopBootedDevices(): Promise<void> {
  const booted = readBootedDevices();
  if (booted.length === 0) {
    return;
  }
  if (!process.env.MOBILE_KEEP_DEVICES) {
    for (const device of booted) {
      if (device.platform === 'android') {
        await shutdownEmulator(device.id);
      } else {
        await shutdownSim(device.id);
      }
    }
  }
  clearBootedDevices();
}

export default stopBootedDevices;
