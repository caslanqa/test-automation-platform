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

/** Boot an iOS simulator (by name or UDID) and wait until ready. Returns the resolved UDID. */
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
