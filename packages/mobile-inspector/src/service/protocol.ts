/**
 * The message contract between the local inspector service (`server.ts`) and the browser UI (`ui/`).
 *
 * The *shapes* are transport-neutral so another host (a VS Code webview) could speak them unchanged; the
 * wire is SSE + POST + an image endpoint, see `server.ts` and architecture.md ADR-013. Every message is a
 * small JSON object with a `type` tag, and the service validates every inbound one against
 * {@link ClientMessage} rather than trusting the payload — the renderer is untrusted even though it is
 * local.
 *
 * One deliberate asymmetry: a frame's *bytes* never travel through here. The recorder emits them
 * internally as a {@link RecorderEvent}, and the transport strips them into a store the UI fetches from
 * `GET /frame/<frameId>`. Base64 inside a JSON envelope inflates every frame by a third and forces a
 * multi-megabyte JSON parse on the UI thread; an `<img src>` decodes off-thread and caches for free.
 */
import type { MobilePlatform } from '@pwtap/platform';

import type {
  ActionResult,
  ConnectOptions,
  DriverCapabilities,
  DriverTestBinding,
  InspectorDevice,
  InstalledApp,
  LocatorCandidate,
  MobileAction,
  MobileDriverId,
  MobileNode,
  ScreenFrame,
  TestFileEntry,
} from '@pwtap/mobile-core';

/** A frame as it reaches the UI: everything except the image bytes, which come from `/frame/<frameId>`. */
export type ScreenFrameMeta = Omit<ScreenFrame, 'imageBase64'>;

/** One entry in the driver picker — a discovered adapter, what it supports, and where its tests live. */
export interface DriverSummary {
  id: MobileDriverId;
  capabilities: DriverCapabilities;
  /** So the UI can show the real file extension a save will produce instead of guessing one. */
  testBinding: DriverTestBinding;
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
  /** Hit-test a tap in the frame's interaction coordinate space, record + perform it. */
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
  /** Enumerate existing recorded test files under the project, for the "append" save picker. */
  | { type: 'listTestFiles' }
  /**
   * Save the authoritative source. `mode: 'new'` writes `targetPath` (project-relative) and refuses to
   * overwrite an existing file; `mode: 'append'` requires `targetPath` to already exist and merges the
   * recorded test into it (wrapped in its own `test.describe`) rather than overwriting it.
   */
  | { type: 'save'; mode: 'new' | 'append'; targetPath: string; testName: string; source: string }
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
  /** A new frame is available; fetch the image from `GET /frame/<frameId>`. */
  | { type: 'frame'; frame: ScreenFrameMeta }
  /**
   * The device produced a byte-identical frame, so there is nothing to fetch: `frameId` is the id the UI
   * is already showing. Without this, an idle screen would re-download the same megabytes every poll.
   */
  | { type: 'frameUnchanged'; frameId: number }
  | { type: 'hierarchy'; nodes: MobileNode[] }
  /** Response to `inspectAt`: the matched node (if any) and its ranked locator candidates. */
  | { type: 'inspected'; node: MobileNode | null; candidates: LocatorCandidate[] }
  | { type: 'actionResult'; action: MobileAction; result: ActionResult }
  | { type: 'timeline'; actions: MobileAction[] }
  /** The current authoritative source draft and its revision (bumped on every server-side change). */
  | { type: 'code'; source: string; revision: number }
  /** Response to `listTestFiles`. */
  | { type: 'testFiles'; files: TestFileEntry[] }
  | { type: 'saved'; path: string }
  /** Streamed stdout/stderr chunk from a running test. */
  | { type: 'runOutput'; stream: 'stdout' | 'stderr'; chunk: string }
  /** Lifecycle of a run: started, or finished with an exit code (`null` when killed). */
  | { type: 'runStatus'; state: 'started' | 'finished'; exitCode?: number | null }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; message: string };

/**
 * What the recording engine emits. Identical to {@link ServerMessage} except that a `frame` still carries
 * its image bytes: the engine captures them, and the transport is what decides how they reach a client
 * (see `frameStore.ts`). Keeping the two types distinct means a host cannot accidentally serialise
 * megabytes of base64 into an event stream.
 */
export type RecorderEvent =
  | Exclude<ServerMessage, { type: 'frame' } | { type: 'frameUnchanged' }>
  | { type: 'frame'; frame: ScreenFrame };

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

// ----- action payload validation -----
//
// The trust boundary validates an action FIELD BY FIELD, not just by its `kind`: main/the service treats
// the renderer as untrusted, and a `fill` with no `value` or a `swipe` with a bogus `direction` used to
// sail straight through into a driver adapter. This is the table in architecture.md §5, executable.

type ActionFields = Record<string, unknown>;

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isPoint(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const point = value as ActionFields;
  return typeof point.x === 'number' && typeof point.y === 'number';
}

/** A locator must set at least one strategy, and every strategy it does set must be well typed. */
function isLocator(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const locator = value as ActionFields;
  let strategies = 0;
  for (const key of ['accessibilityId', 'resourceId', 'text'] as const) {
    if (locator[key] !== undefined) {
      if (typeof locator[key] !== 'string') {
        return false;
      }
      strategies += 1;
    }
  }
  if (locator.point !== undefined) {
    if (!isPoint(locator.point)) {
      return false;
    }
    strategies += 1;
  }
  if (locator.native !== undefined) {
    strategies += 1; // deliberately unvalidated — the adapter-specific escape hatch
  }
  if (!isOptionalString(locator.label)) {
    return false;
  }
  return strategies > 0;
}

/** A gesture target is either a locator or an explicit device-pixel point. */
function isTarget(value: unknown): boolean {
  return isPoint(value) || isLocator(value);
}

function isDirection(value: unknown): boolean {
  return value === 'up' || value === 'down' || value === 'left' || value === 'right';
}

/** An options bag is absent, or an object whose listed keys are numbers when present. */
function hasOptionalNumbers(value: unknown, keys: readonly string[]): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const options = value as ActionFields;
  return keys.every(key => options[key] === undefined || typeof options[key] === 'number');
}

function isSwipeOptions(value: unknown): boolean {
  if (!hasOptionalNumbers(value, ['distance', 'durationMs'])) {
    return false;
  }
  const distance = (value as ActionFields | undefined)?.distance;
  // `distance` is a fraction of the screen; anything outside 0..1 is a bug on the caller's side.
  return distance === undefined || (typeof distance === 'number' && distance >= 0 && distance <= 1);
}

function isScrollOptions(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const within = (value as ActionFields).within;
  return within === undefined || isLocator(within);
}

/**
 * One validator per action kind. Typed as a total `Record` over the union on purpose: adding a new
 * `MobileAction` kind without teaching the trust boundary how to validate it becomes a compile error
 * instead of a silently unvalidated payload.
 */
const ACTION_VALIDATORS: Record<MobileAction['kind'], (action: ActionFields) => boolean> = {
  tap: a => isLocator(a.locator),
  fill: a => isLocator(a.locator) && typeof a.value === 'string',
  longPress: a => isLocator(a.locator) && hasOptionalNumbers(a.options, ['durationMs']),
  swipe: a => isDirection(a.direction) && isSwipeOptions(a.options),
  scroll: a => isDirection(a.direction) && isScrollOptions(a.options),
  drag: a => isTarget(a.from) && isTarget(a.to),
  pinch: a =>
    typeof a.scale === 'number' &&
    a.scale > 0 &&
    Number.isFinite(a.scale) &&
    hasOptionalNumbers(a.options, ['durationMs']),
  pressKey: a => typeof a.key === 'string' && a.key.length > 0,
  back: () => true,
  waitFor: a => isLocator(a.locator) && hasOptionalNumbers(a.options, ['timeoutMs']),
  isVisible: a => isLocator(a.locator) && hasOptionalNumbers(a.options, ['timeoutMs']),
  assertVisible: a => isLocator(a.locator),
  assertNotVisible: a => isLocator(a.locator),
  screenshot: a => isOptionalString(a.name),
  aiAssert: a => typeof a.rubric === 'string' && a.rubric.length > 0 && isOptionalString(a.name),
};

function isMobileAction(value: unknown): value is MobileAction {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const action = value as ActionFields;
  if (typeof action.kind !== 'string' || !(action.kind in ACTION_VALIDATORS)) {
    return false;
  }
  return ACTION_VALIDATORS[action.kind as MobileAction['kind']](action);
}

/** Re-exported so the UI (which only imports from `protocol.ts`) doesn't need a separate types import. */
export type { MobilePlatform };
