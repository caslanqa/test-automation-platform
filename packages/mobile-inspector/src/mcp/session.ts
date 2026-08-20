/**
 * One device session per server process, and the two timers that keep it from becoming a problem.
 *
 * **The server never takes the device lock itself.** Both adapters acquire it inside `connect()` and
 * release it inside `close()`; taking a second one here would deadlock against the adapter. The server's
 * only job is to guarantee `close()` actually runs — which is why `bin/mcp.mjs` hangs teardown off stdin
 * EOF rather than `process.on('exit')`, a hook that cannot await anything.
 *
 * **The idle timer is the one genuinely new mechanism here, and it earns its place.** A person forgets an
 * agent session open; the device lock then blocks their own `npm run test:maestro` for up to thirty
 * minutes with no explanation anywhere. Every tool call resets it, and `PWTAP_MCP_IDLE_MS` (default ten
 * minutes) closes the session on its own.
 *
 * `RecorderSession` is deliberately not used. Its 780 lines are draft state, undo/redo, saving and AST
 * insertion — an MCP server has no draft, and `DeviceSession` is the class that actually owns
 * connect/capture/perform.
 *
 * @example
 * const session = new McpMobileSession(projectDir);
 * await session.connect({ driver: 'maestro', platform: 'android', appId: 'com.example.app' });
 */
import {
  discoverDriverMap,
  type ConnectOptions,
  type InspectorDevice,
  type MobileInspectorDriver,
  type MobileNode,
  type ScreenFrame,
} from '@pwtap/mobile-core';

import { DeviceSession } from '../service/deviceSession.js';

/** How long a session may sit unused before it releases the device. */
export const DEFAULT_IDLE_MS = 600_000;

/**
 * How long `mobile_connect` waits for the device lock.
 *
 * Two minutes, not the platform's thirty. A tool call blocked for half an hour is indistinguishable from
 * a hang, and there is no way for the caller to cancel it.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 120_000;

export interface ConnectRequest extends ConnectOptions {
  driver: string;
}

export class McpMobileSession {
  readonly projectDir: string;
  private device: DeviceSession | undefined;
  private driverId: string | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly idleMs: number;
  /** Problems `discoverDriverMap` reported, surfaced by `mobile_drivers` rather than thrown. */
  readonly driverProblems: string[] = [];
  /**
   * The most recent frame, kept from the event stream rather than re-captured.
   *
   * `DeviceSession` already emits every frame it takes; keeping the last one is what turns the dropped
   * push channel into a pull. Re-capturing for `mobile_screen` would take a second screenshot of a
   * device that just produced one.
   */
  private lastFrame: ScreenFrame | undefined;

  /**
   * Injected discovery, for tests.
   *
   * The real one resolves adapters out of a project's `node_modules`, so testing the tools against it
   * would mean a real driver and a real device. `DeviceSession` takes an injectable `CaptureTiming` for
   * exactly this reason; this is the same seam one level up.
   */
  private readonly discover: () => Promise<Map<string, MobileInspectorDriver>>;

  constructor(
    projectDir: string,
    idleMs = readIdleMs(),
    discover?: () => Promise<Map<string, MobileInspectorDriver>>,
  ) {
    this.projectDir = projectDir;
    this.idleMs = idleMs;
    this.discover =
      discover ??
      (() => discoverDriverMap(this.projectDir, message => this.driverProblems.push(message)));
  }

  get connected(): boolean {
    return this.device?.connected === true;
  }

  get driver(): string | undefined {
    return this.driverId;
  }

  get hierarchy(): MobileNode[] {
    return this.device?.hierarchy ?? [];
  }

  get appId(): string | undefined {
    return this.device?.appId;
  }

  get frame(): ScreenFrame | undefined {
    return this.lastFrame;
  }

  get deviceInfo(): InspectorDevice | undefined {
    return this.device?.device;
  }

  /** Discover the drivers this project has installed, recording problems instead of throwing them. */
  async drivers(): Promise<Map<string, MobileInspectorDriver>> {
    this.driverProblems.length = 0;
    return this.discover();
  }

  /** Called by the dispatcher on every tool call: activity is what keeps the device reserved. */
  touch(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
    }
    if (this.idleMs <= 0 || !this.connected) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      void this.disconnect();
    }, this.idleMs);
    // Never hold the process open on its own account.
    this.idleTimer.unref?.();
  }

  async connect(request: ConnectRequest): Promise<{ device: unknown; capabilities: unknown }> {
    const drivers = await this.drivers();
    const driver = drivers.get(request.driver);
    if (driver === undefined) {
      const known = [...drivers.keys()];
      throw new Error(
        known.length === 0
          ? 'no mobile driver is installed in this project — add @pwtap/plugin-maestro or @pwtap/plugin-appium'
          : `unknown driver '${request.driver}' — this project has ${known.join(', ')}`,
      );
    }

    // Replacing a session rather than refusing: a caller that reconnects wants the new device, and
    // leaving the old one reserved while telling them to disconnect first is a worse answer.
    await this.disconnect();

    // Frames are kept, hierarchy pushes are dropped, and nothing is streamed: there is no client-push
    // channel implemented, and pushing frames into a model's context would be a token catastrophe.
    const session = new DeviceSession(event => {
      if (event.type === 'frame') {
        this.lastFrame = event.frame;
      }
    });
    const { driver: _driver, ...options } = request;
    const info = await session.connect(driver, {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    });
    this.device = session;
    this.driverId = driver.id;
    this.touch();
    return { device: info, capabilities: session.sessionCapabilities ?? driver.capabilities };
  }

  /** Idempotent: a second call is a clean no-op, which is what an interrupted agent tends to produce. */
  async disconnect(): Promise<boolean> {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const session = this.device;
    if (session === undefined) {
      return false;
    }
    this.device = undefined;
    this.driverId = undefined;
    this.lastFrame = undefined;
    return session.disconnect();
  }

  /** The live session, or a refusal naming the tool that would have fixed it. */
  require(): DeviceSession {
    if (this.device === undefined || !this.device.connected) {
      throw new Error('not connected — call mobile_connect first');
    }
    return this.device;
  }
}

function readIdleMs(): number {
  const raw = Number(process.env.PWTAP_MCP_IDLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_IDLE_MS;
}
