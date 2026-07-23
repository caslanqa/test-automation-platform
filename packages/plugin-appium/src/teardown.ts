import { stopBootedDevices as platformStopBootedDevices } from '@pwtap/platform';

/**
 * Shut down the devices the framework AUTO-BOOTED this run (recorded via the fixture's `onBooted`
 * hook) so emulators/simulators don't linger. Devices you booted yourself are never recorded, so
 * they're left running. Set `APPIUM_KEEP_DEVICES=1` to keep the auto-booted ones too (faster
 * iterative reruns). A no-op when nothing was booted. Usable as a Playwright `globalTeardown`
 * (default export). Shares the same booted-device registry as `@pwtap/plugin-maestro` — running both
 * plugins in one project shuts down every framework-booted device exactly once either way.
 */
export async function stopBootedDevices(): Promise<void> {
  await platformStopBootedDevices({ keepDevices: Boolean(process.env.APPIUM_KEEP_DEVICES) });
}

export default stopBootedDevices;
