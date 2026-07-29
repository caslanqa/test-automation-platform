/**
 * A scripted {@link MobileInspectorDriver} for tests.
 *
 * The recording engine's real drivers need an emulator, an Appium server or the Maestro CLI, which put
 * the whole of `RecorderSession` out of reach of CI. This fake stands in for one: a fixed sequence of
 * screens (hierarchy + canned screenshot), a record of every action that reached it, and switches to make
 * an action fail or a capture throw — so the engine's behaviour on the unhappy paths is testable too.
 *
 * Deliberately NOT shipped: it lives under `test/`, outside the package build (see
 * docs/mobile-inspector/architecture.md ADR-012).
 */
import type {
  ActionResult,
  ConnectOptions,
  DriverCapabilities,
  DriverSession,
  InspectorDevice,
  MobileAction,
  MobileInspectorDriver,
  MobileNode,
  ScreenFrame,
} from '@pwtap/mobile-core';

/** A minimal but valid PNG header — `readImageSize` only reads `IHDR`, and nothing decodes the pixels. */
export function pngOfSize(width: number, height: number, variant = 0): Buffer {
  const buf = Buffer.alloc(24 + (variant > 0 ? 1 : 0));
  if (variant > 0) {
    buf.writeUInt8(variant & 0xff, 24);
  }
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

export const SCREEN_WIDTH = 400;
export const SCREEN_HEIGHT = 800;

/** Screen 0: a login form. The button carries an accessibility id, the field a resource id. */
export const LOGIN_SCREEN: MobileNode[] = [
  {
    className: 'FrameLayout',
    bounds: { x: 0, y: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
    children: [
      {
        className: 'EditText',
        resourceId: 'com.example:id/email',
        bounds: { x: 20, y: 100, width: 360, height: 60 },
      },
      {
        className: 'Button',
        accessibilityId: 'loginButton',
        text: 'Log in',
        bounds: { x: 20, y: 200, width: 360, height: 60 },
        // An anonymous inner view, the shape that makes a naive "smallest node" hit-test pick garbage.
        children: [{ className: 'TextView', bounds: { x: 30, y: 215, width: 60, height: 30 } }],
      },
      {
        className: 'TextView',
        text: 'Forgot password?',
        bounds: { x: 20, y: 300, width: 200, height: 40 },
      },
    ],
  },
];

/** Screen 1: where the login button leads. */
export const DASHBOARD_SCREEN: MobileNode[] = [
  {
    className: 'FrameLayout',
    bounds: { x: 0, y: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
    children: [
      {
        className: 'TextView',
        text: 'Dashboard',
        accessibilityId: 'dashboardTitle',
        bounds: { x: 20, y: 40, width: 200, height: 40 },
      },
    ],
  },
];

const CAPABILITIES: DriverCapabilities = {
  hierarchy: true,
  liveFrames: true,
  gestures: {
    tap: true,
    fill: true,
    longPress: true,
    swipe: true,
    scroll: true,
    drag: true,
    pinch: false, // one unsupported gesture, so capability gaps are representable
    pressKey: true,
    back: true,
    waitFor: true,
    isVisible: true,
    assertVisible: true,
    assertNotVisible: true,
    screenshot: true,
    aiAssert: true,
  },
};

export interface FakeDriverOptions {
  /** Screens the session walks through; each successful action advances one, stopping at the last. */
  screens?: MobileNode[][];
  /** Make `connect` reject, to exercise the engine's connect-failure path. */
  failConnect?: string;
}

export class FakeDriverSession implements DriverSession {
  readonly driverId = 'fake';
  readonly device: InspectorDevice;
  /** Every action that actually reached the driver, in order. */
  readonly performed: MobileAction[] = [];
  /** Set to a message to make the next `perform` fail; cleared after it does. */
  failNextAction: string | undefined;
  /** Set to make `captureScreen` throw, to exercise the frame-failure path. */
  failCapture: string | undefined;
  closed = false;

  private frameCounter = 0;
  private screenIndex = 0;
  private readonly screens: MobileNode[][];

  constructor(device: InspectorDevice, screens: MobileNode[][]) {
    this.device = device;
    this.screens = screens;
  }

  get currentScreen(): MobileNode[] {
    return this.screens[Math.min(this.screenIndex, this.screens.length - 1)];
  }

  async captureScreen(): Promise<ScreenFrame> {
    if (this.failCapture) {
      throw new Error(this.failCapture);
    }
    // Bytes vary with the screen, so frame dedup and the post-action settle are exercisable: a fake whose
    // screenshot never changes makes every capture look identical no matter what the device did.
    const image = pngOfSize(SCREEN_WIDTH, SCREEN_HEIGHT, this.screenIndex);
    return {
      frameId: this.frameCounter++,
      imageBase64: image.toString('base64'),
      width: SCREEN_WIDTH,
      height: SCREEN_HEIGHT,
      coordinateWidth: SCREEN_WIDTH,
      coordinateHeight: SCREEN_HEIGHT,
      orientation: 'portrait',
      capturedAt: 0,
    };
  }

  async inspectHierarchy(): Promise<MobileNode[]> {
    return this.currentScreen;
  }

  async perform(action: MobileAction): Promise<ActionResult> {
    if (this.failNextAction) {
      const error = this.failNextAction;
      this.failNextAction = undefined;
      return { ok: false, error, durationMs: 1 };
    }
    this.performed.push(action);
    this.screenIndex += 1;
    const value = action.kind === 'isVisible' ? true : undefined;
    return { ok: true, value, durationMs: 1 };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeDriver implements MobileInspectorDriver {
  readonly id = 'fake';
  readonly capabilities = CAPABILITIES;
  readonly testBinding = { extension: '.fake.ts', project: 'fake', gateEnv: 'FAKE' };
  /** The session handed out by the most recent successful `connect`. */
  session: FakeDriverSession | undefined;
  /** Every `connect` call's options, so tests can assert what the fixture/UI forwarded. */
  readonly connects: ConnectOptions[] = [];

  private readonly options: FakeDriverOptions;

  constructor(options: FakeDriverOptions = {}) {
    this.options = options;
  }

  async discoverDevices(): Promise<InspectorDevice[]> {
    return [
      { id: 'emulator-5554', name: 'Pixel_7_API_34', platform: 'android', booted: true },
      { id: 'Pixel_9_API_35', name: 'Pixel_9_API_35', platform: 'android', booted: false },
    ];
  }

  async connect(options: ConnectOptions): Promise<DriverSession> {
    this.connects.push(options);
    if (this.options.failConnect) {
      throw new Error(this.options.failConnect);
    }
    const device: InspectorDevice = {
      // Mirrors real discovery: a booted Android emulator is addressed by its ephemeral adb serial while
      // `name` carries the stable AVD name — which is what codegen must emit (ADR-003).
      id: 'emulator-5554',
      name: options.device ?? 'Pixel_7_API_34',
      platform: options.platform,
      booted: true,
    };
    this.session = new FakeDriverSession(
      device,
      this.options.screens ?? [LOGIN_SCREEN, DASHBOARD_SCREEN],
    );
    return this.session;
  }
}

/** A driver map shaped like `discoverDriverMap`'s output, for `new RecorderSession(root, send, map)`. */
export function fakeDriverMap(options?: FakeDriverOptions): {
  map: Map<string, MobileInspectorDriver>;
  driver: FakeDriver;
} {
  const driver = new FakeDriver(options);
  return { map: new Map([[driver.id, driver]]), driver };
}
