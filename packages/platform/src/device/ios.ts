import { getPlatform } from '../platform.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface SimDevice {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
}

/** All simulators from `xcrun simctl list devices -j`, flattened across runtimes. */
async function listSimulators(): Promise<SimDevice[]> {
  const { stdout, code } = await getPlatform().simctl(['list', 'devices', '-j'], {
    timeoutMs: 15_000,
  });
  if (code !== 0) {
    return [];
  }
  try {
    const data = JSON.parse(stdout) as { devices?: Record<string, SimDevice[]> };
    return Object.values(data.devices ?? {}).flat();
  } catch {
    return [];
  }
}

/** Resolve an iOS simulator name OR UDID to its UDID (from `simctl list devices`). */
export async function resolveSimUdid(nameOrUdid: string): Promise<string | undefined> {
  const match = (await listSimulators()).find(
    d => d.isAvailable !== false && (d.udid === nameOrUdid || d.name === nameOrUdid),
  );
  return match?.udid;
}

/**
 * Boot an iOS simulator (by name or UDID) and wait until ready; returns the resolved UDID. Only the
 * runtime is booted (no window) — visibility is separate (`openSimulatorApp`/`quitSimulatorApp`).
 */
export async function bootIosSim(nameOrUdid: string, timeoutMs = 120_000): Promise<string> {
  const udid = await resolveSimUdid(nameOrUdid);
  if (!udid) {
    throw new Error(
      `[pwtap] iOS simulator '${nameOrUdid}' not found — check 'xcrun simctl list devices'`,
    );
  }
  const platform = getPlatform();
  // Boot; simctl returns non-zero when already booted, which `run` reports (not throws) — ignore it.
  await platform.simctl(['boot', udid], { timeoutMs: 30_000 });
  // Block until the simulator has fully booted.
  await platform.simctl(['bootstatus', udid, '-b'], { timeoutMs });
  return udid;
}

/** Shut down a booted simulator by UDID (used by teardown). */
export async function shutdownSim(udid: string): Promise<void> {
  await getPlatform().simctl(['shutdown', udid], { timeoutMs: 30_000 });
}

/** Show the Simulator app (makes booted sims headed). Convenience wrapper over the platform seam. */
export async function openSimulatorApp(): Promise<void> {
  await getPlatform().openSimulatorApp();
}

/** Quit the Simulator app (makes iOS headless). Convenience wrapper over the platform seam. */
export async function quitSimulatorApp(): Promise<void> {
  await getPlatform().quitSimulatorApp();
}

// Re-exported so callers can `await sleep(...)` if they compose these; kept internal otherwise.
export { sleep as _sleep };
