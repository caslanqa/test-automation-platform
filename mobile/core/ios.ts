import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface SimDevice {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
}

/** All simulators from `xcrun simctl list devices -j`, flattened across runtimes. */
async function listSimulators(): Promise<SimDevice[]> {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '-j'], {
      timeout: 15_000,
    });
    const data = JSON.parse(stdout) as { devices?: Record<string, SimDevice[]> };
    return Object.values(data.devices ?? {}).flat();
  } catch {
    return [];
  }
}

/** Resolve an iOS simulator name OR UDID to its UDID (from `simctl list devices`). */
export async function resolveSimUdid(nameOrUdid: string): Promise<string | undefined> {
  const match = (await listSimulators()).find(
    d => d.isAvailable !== false && (d.udid === nameOrUdid || d.name === nameOrUdid)
  );
  return match?.udid;
}

/**
 * Boot an iOS simulator (by name or UDID) and wait until ready. Returns the resolved UDID. This only
 * boots the runtime (no window); visibility is a separate concern — the Simulator app — toggled via
 * `openSimulatorApp` / `quitSimulatorApp`, because it can be changed without rebooting the sim.
 */
export async function bootIosSim(nameOrUdid: string, timeoutMs = 120_000): Promise<string> {
  const udid = await resolveSimUdid(nameOrUdid);
  if (!udid) {
    throw new Error(
      `[mobile] iOS simulator '${nameOrUdid}' not found — check 'xcrun simctl list devices'`
    );
  }
  // Boot; ignore the error simctl throws when it is already booted.
  await execFileAsync('xcrun', ['simctl', 'boot', udid], { timeout: 30_000 }).catch(
    () => undefined
  );
  // Block until the simulator has fully booted.
  await execFileAsync('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeout: timeoutMs });
  return udid;
}

/**
 * Show the Simulator app (it displays whatever sims are booted) — makes a device headed. Idempotent,
 * so it's safe to call for a reused sim whose window was closed.
 */
export async function openSimulatorApp(): Promise<void> {
  await execFileAsync('open', ['-a', 'Simulator'], { timeout: 15_000 }).catch(() => undefined);
}

/**
 * Quit the Simulator app — makes iOS headless. Booted sims stay `Booted` (a `simctl boot` runtime is
 * independent of the app), so no reboot is needed to hide or later re-show them.
 */
export async function quitSimulatorApp(): Promise<void> {
  await execFileAsync('osascript', ['-e', 'tell application "Simulator" to quit'], {
    timeout: 10_000,
  }).catch(() => undefined);
}
