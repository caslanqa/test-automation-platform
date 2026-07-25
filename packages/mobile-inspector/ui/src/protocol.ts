/**
 * Mirror of `../../src/service/protocol.ts`'s message shapes for the browser UI. Kept as a small,
 * standalone duplicate rather than a cross-project import: the UI is a separate esbuild/Vite build
 * target from the Node service (`tsc -b`'s composite project), and the wire protocol is the
 * intentional host-neutral boundary between them (see `plan.md`) — the UI should never need Node-only
 * types to compile. Keep this in sync with `protocol.ts` by hand; it's a small, stable surface.
 */

export type MobilePlatform = 'android' | 'ios';

export interface MobileLocator {
  accessibilityId?: string;
  resourceId?: string;
  text?: string;
  native?: unknown;
  point?: { x: number; y: number };
  label?: string;
}

export type MobileDirection = 'up' | 'down' | 'left' | 'right';
export type MobileTarget = MobileLocator | { x: number; y: number };
export type MobileKey = 'back' | 'home' | 'enter' | 'volumeUp' | 'volumeDown' | (string & {});

export type MobileAction =
  | { kind: 'tap'; locator: MobileLocator }
  | { kind: 'fill'; locator: MobileLocator; value: string }
  | { kind: 'longPress'; locator: MobileLocator; options?: { durationMs?: number } }
  | {
      kind: 'swipe';
      direction: MobileDirection;
      options?: { distance?: number; durationMs?: number };
    }
  | { kind: 'scroll'; direction: MobileDirection; options?: { within?: MobileLocator } }
  | { kind: 'drag'; from: MobileTarget; to: MobileTarget }
  | { kind: 'pinch'; scale: number; options?: { durationMs?: number } }
  | { kind: 'pressKey'; key: MobileKey }
  | { kind: 'back' }
  | { kind: 'waitFor'; locator: MobileLocator; options?: { timeoutMs?: number } }
  | { kind: 'assertVisible'; locator: MobileLocator }
  | { kind: 'assertNotVisible'; locator: MobileLocator }
  | { kind: 'screenshot'; name?: string }
  | { kind: 'aiAssert'; rubric: string; name?: string };

export interface MobileNode {
  bounds?: { x: number; y: number; width: number; height: number };
  text?: string;
  accessibilityId?: string;
  resourceId?: string;
  className?: string;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;
  children?: MobileNode[];
}

export interface ScreenFrame {
  frameId: number;
  imageBase64: string;
  width: number;
  height: number;
  coordinateWidth?: number;
  coordinateHeight?: number;
  orientation: 'portrait' | 'landscape';
  capturedAt: number;
}

export interface InspectorDevice {
  id: string;
  name: string;
  platform: MobilePlatform;
  booted: boolean;
}

export interface DriverCapabilities {
  gestures: Partial<Record<MobileAction['kind'], boolean>>;
  hierarchy: boolean;
  liveFrames: boolean;
}

export interface DriverSummary {
  id: string;
  capabilities: DriverCapabilities;
}

/** An installed application discovered on the connected/selected device, for the app picker. */
export interface InstalledApp {
  id: string;
  name: string;
  platform: MobilePlatform;
  system: boolean;
}

export interface TestFileEntry {
  relativePath: string;
  name: string;
}

/** One ranked locator candidate for a selected element, surfaced in the right-click menu. */
export interface LocatorCandidate {
  strategy: 'accessibilityId' | 'resourceId' | 'text' | 'native' | 'point';
  locator: MobileLocator;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  unique: boolean;
  warnings: string[];
  display: string;
}

export interface ConnectOptions {
  platform: MobilePlatform;
  device?: string;
  headless?: boolean;
  appId?: string;
  appSource?: string;
}

export interface ActionResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  durationMs: number;
}

export type ClientMessage =
  | { type: 'listDrivers' }
  | { type: 'listDevices'; driver: string }
  | { type: 'listApps'; driver: string; platform: MobilePlatform; device?: string }
  | { type: 'connect'; driver: string; options: ConnectOptions }
  | { type: 'disconnect' }
  | { type: 'refreshFrame' }
  | { type: 'refreshHierarchy' }
  | { type: 'tapAt'; x: number; y: number; frameId: number }
  | { type: 'inspectAt'; x: number; y: number; frameId: number }
  | { type: 'perform'; action: MobileAction }
  | { type: 'record'; action: MobileAction }
  | { type: 'removeAction'; index: number }
  | { type: 'clearTimeline' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'editCode'; source: string; revision: number }
  | { type: 'save'; fileName: string; testName: string; source?: string }
  | { type: 'run'; source: string }
  | { type: 'stopRun' };

export type ServerMessage =
  | { type: 'drivers'; drivers: DriverSummary[] }
  | { type: 'devices'; driver: string; devices: InspectorDevice[] }
  | { type: 'apps'; driver: string; apps: InstalledApp[] }
  | { type: 'connecting' }
  | { type: 'connected'; driver: string; device: InspectorDevice; capabilities: DriverCapabilities }
  | { type: 'disconnected' }
  | { type: 'frame'; frame: ScreenFrame }
  | { type: 'hierarchy'; nodes: MobileNode[] }
  | { type: 'inspected'; node: MobileNode | null; candidates: LocatorCandidate[] }
  | { type: 'actionResult'; action: MobileAction; result: ActionResult }
  | { type: 'timeline'; actions: MobileAction[] }
  | { type: 'code'; source: string; revision: number }
  | { type: 'saved'; path: string }
  | { type: 'runOutput'; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'runStatus'; state: 'started' | 'finished'; exitCode?: number | null }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; message: string };
