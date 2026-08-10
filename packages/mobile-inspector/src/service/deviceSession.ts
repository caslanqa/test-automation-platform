/**
 * Owns the live device: connect/disconnect, the device lock the adapter holds, frame and hierarchy capture,
 * and when to capture. Knows nothing about source code or files (§6).
 *
 * Capture follows ADR-006 rather than a fixed timer: after an action, after a short settle, and — only while
 * idle and only if the driver claims cheap frames — on an interval derived from how long capture actually
 * takes, backing off when it fails.
 *
 * @example const device = new DeviceSession(emit); await device.connect(driver, { platform: 'android' });
 */
import {
  assignNodeIdentity,
  type ActionResult,
  type ConnectOptions,
  type DriverCapabilities,
  type DriverSession,
  type InspectorDevice,
  type MobileAction,
  type MobileInspectorDriver,
  type MobileNode,
} from '@pwtap/mobile-core';

import { createHash } from 'node:crypto';

import type { RecorderEvent } from './protocol.js';

/** How many capture durations feed the median that sets the interval. */
const DURATION_SAMPLES = 5;

/**
 * Capture timings (ADR-006). Injectable so tests can exercise the schedule in milliseconds instead of
 * sleeping through real seconds — the first version of those tests added eight seconds to the suite.
 */
export interface CaptureTiming {
  /** Wait after an action before looking, then once more if the screen moved. */
  settleMs: number;
  /** Bounds on the idle interval: live enough to feel current, slow enough not to saturate the device. */
  minPollMs: number;
  maxPollMs: number;
  /** Ceiling for the failure backoff — a device that has gone away is retried, not hammered. */
  maxBackoffMs: number;
}

export const DEFAULT_TIMING: CaptureTiming = {
  settleMs: 250,
  minPollMs: 750,
  maxPollMs: 5_000,
  maxBackoffMs: 30_000,
};

export class DeviceSession {
  private session: DriverSession | undefined;
  private capabilities: MobileInspectorDriver['capabilities'] | undefined;
  private lastHierarchy: MobileNode[] = [];
  /** Digest of the last tree that was SENT, so an unchanged one is not sent again. */
  private lastHierarchyDigest: string | undefined;
  private lastFrameId = -1;
  private lastFrameBytes: string | undefined;
  private frameRefresh: Promise<void> | undefined;
  private hierarchyRefresh: Promise<boolean> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private captureDurations: number[] = [];
  private consecutiveFailures = 0;

  private readonly emit: (event: RecorderEvent) => void;
  private readonly timing: CaptureTiming;

  constructor(emit: (event: RecorderEvent) => void, timing: Partial<CaptureTiming> = {}) {
    this.emit = emit;
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  get connected(): boolean {
    return this.session !== undefined;
  }

  /** The app the driver is actually scoped to, when it resolved one the caller did not name. */
  get appId(): string | undefined {
    return this.session?.appId;
  }

  /** What the connected session can really do — narrowed to its platform when the driver narrows it. */
  get sessionCapabilities(): DriverCapabilities | undefined {
    return this.capabilities;
  }

  get device(): InspectorDevice | undefined {
    return this.session?.device;
  }

  get hierarchy(): MobileNode[] {
    return this.lastHierarchy;
  }

  get frameId(): number {
    return this.lastFrameId;
  }

  /** Connect, take a first frame and hierarchy, and start the idle schedule. Throws on failure. */
  async connect(driver: MobileInspectorDriver, options: ConnectOptions): Promise<InspectorDevice> {
    await this.disconnect();
    this.session = await driver.connect(options);
    this.capabilities = this.session.capabilities ?? driver.capabilities;
    this.lastHierarchy = [];
    this.lastHierarchyDigest = undefined;
    this.lastFrameId = -1;
    this.lastFrameBytes = undefined;
    this.captureDurations = [];
    this.consecutiveFailures = 0;
    // The driver is connected but the panel is still empty at this point, and on Maestro the first
    // hierarchy plus screenshot is another few hundred milliseconds of silence.
    options.onProgress?.('reading the first screen');
    await this.refreshHierarchy();
    await this.refreshFrame();
    this.scheduleIdlePoll();
    return this.session.device;
  }

  async disconnect(): Promise<boolean> {
    this.cancelPoll();
    const session = this.session;
    this.session = undefined;
    this.capabilities = undefined;
    this.frameRefresh = undefined;
    this.hierarchyRefresh = undefined;
    if (!session) {
      return false;
    }
    try {
      await session.close();
    } catch (error) {
      this.warn(`error while closing driver session: ${message(error)}`);
    }
    return true;
  }

  async perform(action: MobileAction): Promise<ActionResult> {
    if (!this.session) {
      return { ok: false, error: 'not connected to a device', durationMs: 0 };
    }
    this.cancelPoll(); // the user is driving; the idle schedule resumes after the action settles
    try {
      return await this.session.perform(action);
    } catch (error) {
      return { ok: false, error: message(error), durationMs: 0 };
    }
  }

  /**
   * Look at the screen after an action.
   *
   * One capture immediately: the device has already performed the action, so whatever moved is on screen
   * now, not only after a sleep — waiting the full settle before the FIRST look is what made a tap take
   * about half a second to show any visible effect. Identical frames are deduped, so a look that finds
   * nothing new costs a hash rather than a repaint.
   *
   * What follows depends on the driver. One that waited for the animation itself
   * (`ActionResult.settled` — Maestro sends `waitForAnimationToEnd` inside the same command) has already
   * answered the question the sleep was asking, so nothing more is needed. One that did not gets the
   * two-look schedule from ADR-006, but comparing the two **settled** looks rather than comparing against
   * the mid-animation frame: a tap always looks different a beat later, so the old comparison made the
   * third look unconditional and charged every interaction for it.
   *
   * @param alreadySettled The driver returned with the screen at rest (`ActionResult.settled`).
   */
  async settle(alreadySettled = false): Promise<void> {
    await this.refreshFrame();
    if (!alreadySettled) {
      const beforeSettle = this.lastFrameBytes;
      await sleep(this.timing.settleMs);
      await this.refreshFrame();
      if (this.lastFrameBytes !== beforeSettle) {
        // Still moving a settle later, so look once more. A third identical pair is not worth a round trip.
        await sleep(this.timing.settleMs);
        await this.refreshFrame();
      }
    }
    // The hierarchy is read ONCE, last. It is what the next click gets hit-tested against, so reading it
    // mid-animation — as the old schedule did, and then again at the end — bought a tree that was stale
    // before it arrived and paid for it twice.
    await this.refreshHierarchy();
    this.scheduleIdlePoll();
  }

  async refreshFrame(): Promise<void> {
    if (!this.session) {
      return;
    }
    if (this.frameRefresh) {
      return this.frameRefresh;
    }
    const session = this.session;
    const refresh = (async (): Promise<void> => {
      const startedAt = Date.now();
      try {
        const frame = await session.captureScreen();
        this.recordCaptureDuration(Date.now() - startedAt);
        if (this.session === session) {
          this.lastFrameId = frame.frameId;
          this.lastFrameBytes = frame.imageBase64;
          this.emit({ type: 'frame', frame });
        }
      } catch (error) {
        this.consecutiveFailures += 1;
        this.warn(`frame capture failed: ${message(error)}`);
      }
    })();
    this.frameRefresh = refresh;
    try {
      await refresh;
    } finally {
      if (this.frameRefresh === refresh) {
        this.frameRefresh = undefined;
      }
    }
  }

  async refreshHierarchy(): Promise<boolean> {
    if (!this.session) {
      return false;
    }
    if (this.hierarchyRefresh) {
      return this.hierarchyRefresh;
    }
    const session = this.session;
    const refresh = (async (): Promise<boolean> => {
      try {
        // Identity is assigned once, here, so hit-testing, the tree and the highlight share keys (ADR-007).
        const hierarchy = assignNodeIdentity(await session.inspectHierarchy());
        if (this.session !== session) {
          return false;
        }
        this.lastHierarchy = hierarchy;
        // Deduplicated the way frames are (ADR-006): an unchanged screen produces an identical tree, and
        // re-sending it makes the client rebuild its whole accessibility view for no new information —
        // which on a deep native tree is continuous main-thread work while the device sits idle.
        const digest = createHash('sha1').update(JSON.stringify(hierarchy)).digest('hex');
        if (digest !== this.lastHierarchyDigest) {
          this.lastHierarchyDigest = digest;
          this.emit({ type: 'hierarchy', nodes: hierarchy });
        }
        return true;
      } catch (error) {
        this.consecutiveFailures += 1;
        this.warn(`hierarchy read failed: ${message(error)}`);
        return false;
      }
    })();
    this.hierarchyRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.hierarchyRefresh === refresh) {
        this.hierarchyRefresh = undefined;
      }
    }
  }

  /** Interval for the next idle look: twice the median capture, clamped, doubled per consecutive failure. */
  private nextPollDelay(): number {
    const sorted = [...this.captureDurations].sort((a, b) => a - b);
    const median =
      sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : this.timing.minPollMs;
    const base = Math.min(this.timing.maxPollMs, Math.max(this.timing.minPollMs, median * 2));
    if (this.consecutiveFailures === 0) {
      return base;
    }
    return Math.min(this.timing.maxBackoffMs, base * 2 ** this.consecutiveFailures);
  }

  private scheduleIdlePoll(): void {
    this.cancelPoll();
    // A driver that cannot produce frames cheaply is not polled at all; its screen updates after actions.
    if (!this.session || this.capabilities?.liveFrames !== true) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      void (async () => {
        // An idle poll asks one question — "did the screen move?" — and the frame answers it. Reading the
        // hierarchy as well doubled the device work per tick for a tree that cannot have changed while the
        // pixels did not, and on Maestro that second round trip is ~110 ms of the device's attention that a
        // user interaction then has to queue behind.
        const before = this.lastFrameBytes;
        await this.refreshFrame();
        if (this.lastFrameBytes !== before) {
          await this.refreshHierarchy();
        }
        this.scheduleIdlePoll();
      })();
    }, this.nextPollDelay());
    // A forgotten session must not keep the process alive: this timer reschedules itself, so without
    // `unref` a caller that skips `disconnect` (a crash, a failed assertion) hangs the host forever.
    this.pollTimer.unref();
  }

  private cancelPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private recordCaptureDuration(ms: number): void {
    this.consecutiveFailures = 0;
    this.captureDurations = [...this.captureDurations, ms].slice(-DURATION_SAMPLES);
  }

  private warn(text: string): void {
    this.emit({ type: 'log', level: 'warn', message: text });
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
