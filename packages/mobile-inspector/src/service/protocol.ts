/**
 * The WebSocket protocol between the local inspector service (`server.ts`) and the bundled React UI
 * (`ui/`). Kept host-neutral on purpose (see `plan.md`'s "do not patch Playwright Inspector internals"
 * constraint) — a future VS Code webview or other host could speak the same protocol.
 *
 * Every message is a small JSON object with a `type` tag; the server validates every inbound message
 * against {@link ClientMessage} shapes and drops/`error`s anything else rather than trusting the payload.
 */
import type { MobilePlatform } from '@pwtap/platform';

import type {
  ActionResult,
  ConnectOptions,
  DriverCapabilities,
  InspectorDevice,
  InstalledApp,
  LocatorCandidate,
  MobileAction,
  MobileDriverId,
  MobileNode,
  ScreenFrame,
  TestFileEntry,
} from '../types.js';

/** One entry in the driver picker — a discovered adapter and what it supports. */
export interface DriverSummary {
  id: MobileDriverId;
  capabilities: DriverCapabilities;
}

// ----- client -> server -----

export type ClientMessage =
  | { type: 'listDrivers' }
  | { type: 'listDevices'; driver: MobileDriverId }
  /** Enumerate installed apps on the selected device (for the app picker). */
  | { type: 'listApps'; driver: MobileDriverId; platform: MobilePlatform; device?: string }
  | { type: 'connect'; driver: MobileDriverId; options: ConnectOptions }
  | { type: 'disconnect' }
  | { type: 'refreshFrame' }
  | { type: 'refreshHierarchy' }
  /** Hit-test a tap at device-pixel coordinates against the last hierarchy, record + perform it. */
  | { type: 'tapAt'; x: number; y: number; frameId: number }
  /** Hit-test WITHOUT acting — return the matched node and its ranked locator candidates. */
  | { type: 'inspectAt'; x: number; y: number; frameId: number }
  | { type: 'perform'; action: MobileAction }
  /** Add an action to the generated flow without executing it against the current device state. */
  | { type: 'record'; action: MobileAction }
  | { type: 'removeAction'; index: number }
  | { type: 'clearTimeline' }
  | { type: 'undo' }
  | { type: 'redo' }
  /** The user edited the authoritative source in the editor; `revision` guards against stale writes. */
  | { type: 'editCode'; source: string; revision: number }
  /** Enumerate existing recorded test files under the project, for the append save picker. */
  | { type: 'listTestFiles' }
  /** Save to a new project-relative path, or append to an existing test without overwriting it. */
  | {
      type: 'save';
      mode: 'new' | 'append';
      targetPath: string;
      testName: string;
      source: string;
    }
  /** Run the authoritative source through the project's Playwright binary. */
  | { type: 'run'; source: string }
  /** Cancel an in-flight run. */
  | { type: 'stopRun' };

// ----- server -> client -----

export type ServerMessage =
  | { type: 'drivers'; drivers: DriverSummary[] }
  | { type: 'devices'; driver: MobileDriverId; devices: InspectorDevice[] }
  | { type: 'apps'; driver: MobileDriverId; apps: InstalledApp[] }
  | { type: 'connecting' }
  | {
      type: 'connected';
      driver: MobileDriverId;
      device: InspectorDevice;
      capabilities: DriverCapabilities;
    }
  | { type: 'disconnected' }
  | { type: 'frame'; frame: ScreenFrame }
  | { type: 'hierarchy'; nodes: MobileNode[] }
  /** Response to `inspectAt`: the matched node (if any) and its ranked locator candidates. */
  | { type: 'inspected'; node: MobileNode | null; candidates: LocatorCandidate[] }
  | { type: 'actionResult'; action: MobileAction; result: ActionResult }
  | { type: 'timeline'; actions: MobileAction[] }
  /** The current authoritative source draft and its revision (bumped on every server-side change). */
  | { type: 'code'; source: string; revision: number }
  | { type: 'testFiles'; files: TestFileEntry[] }
  | { type: 'saved'; path: string }
  /** Streamed stdout/stderr chunk from a running test. */
  | { type: 'runOutput'; stream: 'stdout' | 'stderr'; chunk: string }
  /** Lifecycle of a run: started, or finished with an exit code (`null` when killed). */
  | { type: 'runStatus'; state: 'started' | 'finished'; exitCode?: number | null }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; message: string };

/** Narrow an arbitrary parsed JSON payload down to a well-formed {@link ClientMessage} or `null`. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
    return null;
  }
  const msg = raw as { type: unknown };
  if (typeof msg.type !== 'string') {
    return null;
  }
  switch (msg.type) {
    case 'listDrivers':
    case 'disconnect':
    case 'refreshFrame':
    case 'refreshHierarchy':
    case 'clearTimeline':
    case 'undo':
    case 'redo':
    case 'listTestFiles':
      return { type: msg.type };
    case 'listDevices': {
      const driver = (raw as { driver?: unknown }).driver;
      return typeof driver === 'string' ? { type: 'listDevices', driver } : null;
    }
    case 'listApps': {
      const r = raw as { driver?: unknown; platform?: unknown; device?: unknown };
      if (typeof r.driver !== 'string' || (r.platform !== 'android' && r.platform !== 'ios')) {
        return null;
      }
      const device = typeof r.device === 'string' ? r.device : undefined;
      return { type: 'listApps', driver: r.driver, platform: r.platform, device };
    }
    case 'connect': {
      const r = raw as { driver?: unknown; options?: unknown };
      if (typeof r.driver !== 'string' || typeof r.options !== 'object' || r.options === null) {
        return null;
      }
      const o = r.options as { platform?: unknown };
      if (o.platform !== 'android' && o.platform !== 'ios') {
        return null;
      }
      return { type: 'connect', driver: r.driver, options: r.options as ConnectOptions };
    }
    case 'tapAt': {
      const r = raw as { x?: unknown; y?: unknown; frameId?: unknown };
      if (typeof r.x !== 'number' || typeof r.y !== 'number' || typeof r.frameId !== 'number') {
        return null;
      }
      return { type: 'tapAt', x: r.x, y: r.y, frameId: r.frameId };
    }
    case 'inspectAt': {
      const r = raw as { x?: unknown; y?: unknown; frameId?: unknown };
      if (typeof r.x !== 'number' || typeof r.y !== 'number' || typeof r.frameId !== 'number') {
        return null;
      }
      return { type: 'inspectAt', x: r.x, y: r.y, frameId: r.frameId };
    }
    case 'perform': {
      const action = (raw as { action?: unknown }).action;
      return isMobileAction(action) ? { type: 'perform', action } : null;
    }
    case 'record': {
      const action = (raw as { action?: unknown }).action;
      return isMobileAction(action) ? { type: 'record', action } : null;
    }
    case 'removeAction': {
      const index = (raw as { index?: unknown }).index;
      return typeof index === 'number' ? { type: 'removeAction', index } : null;
    }
    case 'editCode': {
      const r = raw as { source?: unknown; revision?: unknown };
      if (typeof r.source !== 'string' || typeof r.revision !== 'number') {
        return null;
      }
      return { type: 'editCode', source: r.source, revision: r.revision };
    }
    case 'save': {
      const r = raw as {
        mode?: unknown;
        targetPath?: unknown;
        testName?: unknown;
        source?: unknown;
      };
      if (
        (r.mode !== 'new' && r.mode !== 'append') ||
        typeof r.targetPath !== 'string' ||
        typeof r.testName !== 'string' ||
        typeof r.source !== 'string'
      ) {
        return null;
      }
      return {
        type: 'save',
        mode: r.mode,
        targetPath: r.targetPath,
        testName: r.testName,
        source: r.source,
      };
    }
    case 'run': {
      const source = (raw as { source?: unknown }).source;
      return typeof source === 'string' ? { type: 'run', source } : null;
    }
    case 'stopRun':
      return { type: 'stopRun' };
    default:
      return null;
  }
}

const ACTION_KINDS = new Set<MobileAction['kind']>([
  'tap',
  'fill',
  'longPress',
  'swipe',
  'scroll',
  'drag',
  'pinch',
  'pressKey',
  'back',
  'waitFor',
  'assertVisible',
  'assertNotVisible',
  'screenshot',
  'aiAssert',
]);

function isMobileAction(value: unknown): value is MobileAction {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as { kind: unknown }).kind === 'string' &&
    ACTION_KINDS.has((value as { kind: MobileAction['kind'] }).kind)
  );
}

/** Re-exported so the UI (which only imports from `protocol.ts`) doesn't need a separate types import. */
export type { MobilePlatform };
