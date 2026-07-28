import { useEffect, useMemo, useState } from 'react';

import type {
  ClientMessage,
  ConnectOptions,
  DriverSummary,
  InspectorDevice,
  InstalledApp,
  MobilePlatform,
} from '../protocol';

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
 * a native file picker for a local `.apk`/`.app`/`.ipa`/`.zip` artifact.
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

  const platformDevices = useMemo(
    () => devices.filter(d => d.platform === platform),
    [devices, platform],
  );
  const filteredApps = useMemo(() => {
    const q = appFilter.trim().toLowerCase();
    const list = apps.filter(a => a.platform === platform);
    return q
      ? list.filter(a => a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      : list;
  }, [apps, platform, appFilter]);

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
    <aside className={`drawer${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="drawer-header">
        <span>Connection</span>
        <button className="btn btn-small" onClick={onClose} aria-label="close">
          ✕
        </button>
      </div>

      <div className="drawer-body">
        <label className="field">
          Driver
          <select value={driverId} onChange={e => onDriverChange(e.target.value)}>
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
          <select value={platform} onChange={e => setPlatform(e.target.value as MobilePlatform)}>
            <option value="android">Android</option>
            <option value="ios">iOS</option>
          </select>
        </label>

        <label className="field">
          Device
          <select value={deviceId} onChange={e => setDeviceId(e.target.value)}>
            <option value="">first booted…</option>
            {platformDevices.map(d => (
              <option key={d.id} value={d.id}>
                {d.name} {d.booted ? '● booted' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          App id (package / bundle)
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
                {driverId ? 'no apps discovered for this device' : 'select a driver to list apps'}
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
