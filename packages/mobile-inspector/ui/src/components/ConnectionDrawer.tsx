import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  ClientMessage,
  ConnectOptions,
  DriverSummary,
  InspectorDevice,
  InstalledApp,
  MobilePlatform,
} from '../protocol';

/**
 * The handle to connect with — and, through the recording, the one a generated test will pin.
 *
 * Discovery reports a *booted* Android emulator by its `adb` serial, so the picker used to send
 * `emulator-5554`: correct today, gone after a reboot, and the resolver then had to recover the AVD name
 * from the serial to keep the generated test durable (ADR-003). The AVD name is what `acquireDevice`
 * matches on either way, so sending it removes the recovery step entirely. iOS keeps the UDID: simulator
 * names are legally ambiguous, and the UDID is unambiguous by definition and stable across reboots.
 */
function deviceHandle(device: InspectorDevice): string {
  return device.platform === 'android' && device.name !== device.id ? device.name : device.id;
}

/**
 * Long enough to tell two identically named simulators apart, short enough to read in a dropdown. A UDID is
 * 36 characters; an `adb` serial is thirteen and is worth showing whole, since it is what `adb devices` says.
 */
const ID_TOO_LONG_TO_SHOW = 20;

/**
 * What a row says. **The device's own name leads, always** — picking a device is the entire purpose of this
 * list, and nobody recognises `69F9D9B8-CBAA-4D98-94CB-2B91B4EA4BD2`.
 *
 * This is what {@link deviceHandle} broke by accident: iOS pins the UDID, the label was built from the handle,
 * and so every simulator row became a UUID with no name in it. The id still appears after the name, because it
 * says something the name does not — a booted emulator's serial matches `adb devices`, and a UDID prefix is the
 * only way to tell five simulators called "iPhone 17 Pro" apart.
 */
function deviceLabel(device: InspectorDevice): string {
  const suffix = device.booted ? ' ● booted' : '';
  const name = device.name || device.id;
  if (name === device.id) {
    return `${name}${suffix}`;
  }
  const id = device.id.length > ID_TOO_LONG_TO_SHOW ? `${device.id.slice(0, 8)}…` : device.id;
  return `${name} (${id})${suffix}`;
}

interface ConnectionDrawerProps {
  open: boolean;
  onClose: () => void;
  drivers: DriverSummary[];
  devices: InspectorDevice[];
  apps: InstalledApp[];
  connected: { driver: string; device: InspectorDevice } | null;
  connecting: boolean;
  send: (message: ClientMessage) => void;
}

/**
 * Slide-over connection panel: driver, platform, device, and app selection live here (out of the top
 * bar). Supports installed-app discovery for the selected device, manual package/bundle id entry, and
 * a path to a local `.apk`/`.app`/`.ipa`/`.zip` artifact.
 *
 * When closed it is `inert`, not `aria-hidden`: the panel stays in the DOM for the slide transition,
 * and `aria-hidden` alone would leave its controls tabbable while hidden from screen readers.
 */
export function ConnectionDrawer({
  open,
  onClose,
  drivers,
  devices,
  apps,
  connected,
  connecting,
  send,
}: ConnectionDrawerProps) {
  const [driverId, setDriverId] = useState('');
  const [platform, setPlatform] = useState<MobilePlatform>('android');
  const [deviceId, setDeviceId] = useState('');
  const [appId, setAppId] = useState('');
  const [appSource, setAppSource] = useState('');
  const [appFilter, setAppFilter] = useState('');
  const [headless, setHeadless] = useState(true);
  const asideRef = useRef<HTMLElement>(null);
  const driverRef = useRef<HTMLSelectElement>(null);

  const platformDevices = useMemo(
    () =>
      devices
        .filter(d => d.platform === platform)
        // Booted first, then by name: it is the device the user almost certainly means, and a machine with
        // thirty simulators across three runtimes would otherwise bury the running one mid-list.
        .sort((a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name)),
    [devices, platform],
  );
  const selectedDevice = useMemo(
    () => platformDevices.find(d => deviceHandle(d) === deviceId),
    [platformDevices, deviceId],
  );
  const filteredApps = useMemo(() => {
    const q = appFilter.trim().toLowerCase();
    const list = apps.filter(a => a.platform === platform);
    return q
      ? list.filter(a => a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      : list;
  }, [apps, platform, appFilter]);

  // Opening the panel moves focus to its first control; closing it hands focus back only if it was
  // inside the panel, so the auto-close on connect cannot yank focus out of whatever the user is doing.
  useEffect(() => {
    if (open) {
      driverRef.current?.focus();
      return;
    }
    const aside = asideRef.current;
    if (aside?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
  }, [open]);

  // The device list is a snapshot of another process's state, and it was taken once — when a driver was
  // picked — so booting or killing an emulator afterwards left the picker describing a machine that no
  // longer existed, and connecting to it failed with "device not found". Re-ask whenever the panel is
  // opened; the Refresh button below covers the case where it is already open.
  useEffect(() => {
    if (open && driverId) {
      send({ type: 'listDevices', driver: driverId });
    }
  }, [open, driverId, send]);

  // A failed connect is the strongest evidence the list is stale, so it is also a reason to re-read it.
  const wasConnecting = useRef(false);
  useEffect(() => {
    if (wasConnecting.current && !connecting && !connected && driverId) {
      send({ type: 'listDevices', driver: driverId });
    }
    wasConnecting.current = connecting;
  }, [connecting, connected, driverId, send]);

  // Refresh installed apps whenever the driver/platform/device selection changes.
  useEffect(() => {
    if (driverId) {
      send({ type: 'listApps', driver: driverId, platform, device: deviceId || undefined });
    }
  }, [driverId, platform, deviceId, send]);

  function onDriverChange(id: string): void {
    setDriverId(id);
    setDeviceId('');
    if (id) {
      send({ type: 'listDevices', driver: id });
    }
  }

  /**
   * A device selected for one platform cannot mean anything on another, and the selection used to survive
   * the switch — so picking an Android emulator and then flipping to iOS sent an `adb` serial as an iOS
   * simulator name and failed with "device not found".
   */
  function onPlatformChange(next: MobilePlatform): void {
    setPlatform(next);
    setDeviceId('');
  }

  function onConnect(): void {
    if (!driverId) {
      return;
    }
    const options: ConnectOptions = {
      platform,
      device: deviceId || undefined,
      headless,
      appId: appId.trim() || undefined,
      appSource: appSource.trim() || undefined,
    };
    send({ type: 'connect', driver: driverId, options });
  }

  return (
    <aside
      ref={asideRef}
      className={`drawer${open ? ' open' : ''}`}
      aria-label="Connection"
      inert={!open}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          onClose();
        }
      }}
    >
      <div className="drawer-header">
        <span>Connection</span>
        <button className="btn btn-small" onClick={onClose} aria-label="Close connection panel">
          ✕
        </button>
      </div>

      <div className="drawer-body">
        <label className="field">
          Driver
          <select ref={driverRef} value={driverId} onChange={e => onDriverChange(e.target.value)}>
            <option value="">select…</option>
            {drivers.map(d => (
              <option key={d.id} value={d.id}>
                {d.id}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          Platform
          <select
            value={platform}
            onChange={e => onPlatformChange(e.target.value as MobilePlatform)}
          >
            <option value="android">Android</option>
            <option value="ios">iOS</option>
          </select>
        </label>

        <div className="field">
          <div className="field-row field-row-between">
            <span>Device</span>
            <button
              className="btn btn-small"
              onClick={() => driverId && send({ type: 'listDevices', driver: driverId })}
              disabled={!driverId}
              title="Re-read the devices on this machine"
            >
              Refresh
            </button>
          </div>
          <select value={deviceId} onChange={e => setDeviceId(e.target.value)} aria-label="Device">
            <option value="">first booted…</option>
            {platformDevices.map(d => (
              <option key={d.id} value={deviceHandle(d)}>
                {deviceLabel(d)}
              </option>
            ))}
          </select>
          {platformDevices.length === 0 && driverId && (
            <span className="muted field-hint">
              no {platform} devices found on this machine — create one in{' '}
              {platform === 'android' ? 'Android Studio' : 'Xcode'}, then Refresh
            </span>
          )}
          {selectedDevice && !selectedDevice.booted && (
            <span className="muted field-hint">
              not running — connecting boots it, which takes a while, and its installed apps cannot
              be listed until it is up
            </span>
          )}
          {selectedDevice?.platform === 'android' && selectedDevice.name === selectedDevice.id && (
            <span className="warn field-hint">
              only an adb serial is known for this emulator, and a serial does not survive a reboot
              — the generated test will pin it and stop matching. Name the AVD in Android Studio, or
              edit `mobileTarget.device` afterwards.
            </span>
          )}
        </div>

        <div className="field">
          App id (package / bundle)
          {/* Users read this as "the only app I may touch" and got stuck trying to record a journey that
              starts on the home screen. It is neither a restriction nor optional: it is what the recorded
              test launches, and Maestro needs one for every command. */}
          <span className="muted field-hint">
            Launched on connect and pinned in the test. You can still tap anything on screen — press
            Home and tap your way in to record from the launcher.
          </span>
          <input
            value={appId}
            onChange={e => setAppId(e.target.value)}
            placeholder="com.example.app"
            list="installed-apps"
          />
          <datalist id="installed-apps">
            {filteredApps.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </datalist>
        </div>

        <div className="field">
          Installed apps ({filteredApps.length})
          <input
            value={appFilter}
            onChange={e => setAppFilter(e.target.value)}
            placeholder="filter installed apps…"
          />
          <div className="app-list">
            {filteredApps.slice(0, 100).map(a => (
              <button
                key={a.id}
                className={`app-row${appId === a.id ? ' active' : ''}`}
                onClick={() => setAppId(a.id)}
                title={a.id}
              >
                <span className="app-name">{a.name}</span>
                <span className="app-id muted">{a.id}</span>
              </button>
            ))}
            {filteredApps.length === 0 && (
              <div className="muted app-empty">
                {!driverId
                  ? 'select a driver to list apps'
                  : selectedDevice && !selectedDevice.booted
                    ? 'this device is not running, so its apps cannot be listed — boot it and Refresh, or ' +
                      'connect (which boots it) and type the app id below'
                    : 'no apps discovered for this device'}
              </div>
            )}
          </div>
        </div>

        <div className="field">
          Install from artifact (optional)
          <div className="field-row">
            <input
              value={appSource}
              onChange={e => setAppSource(e.target.value)}
              placeholder="./build/app.apk or https://…"
            />
          </div>
        </div>

        <label className="field field-checkbox">
          <input type="checkbox" checked={headless} onChange={e => setHeadless(e.target.checked)} />
          headless (boot device hidden)
        </label>
      </div>

      <div className="drawer-footer">
        {connected ? (
          <button className="btn btn-danger" onClick={() => send({ type: 'disconnect' })}>
            Disconnect
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={onConnect}
            disabled={!driverId || connecting}
          >
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>
    </aside>
  );
}
