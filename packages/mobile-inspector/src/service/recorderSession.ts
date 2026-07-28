/**
 * The recording engine: owns the connected `DriverSession`, the recorded `MobileAction` timeline (with
 * undo/redo), frame/hierarchy polling, the source draft, and the save/run workflows.
 *
 * One instance per service **launch**, not per connection (architecture.md ADR-011). A client attaching or
 * dropping is a re-sync, never a teardown — a browser reload must not cost the user their recording — so the
 * only thing that closes this is the launch itself, which is also what guarantees a device lock is never
 * leaked. See `server.ts` for the transport that owns it.
 */

import { type MobilePlatform } from '@pwtap/platform';

import type {
  ActionResult,
  ConnectOptions,
  DriverSession,
  DriverTestBinding,
  InspectorDevice,
  InstalledApp,
  MobileAction,
  MobileInspectorDriver,
  MobileNode,
} from '@pwtap/mobile-core';
import {
  assignNodeIdentity,
  discoverDriverMap,
  hitTest,
  listBootedAndroidDevices,
  listInstalledAndroidApps,
  listInstalledIosApps,
  locatorCandidates,
  locatorForNode,
  outOfAppWarning,
  resolveSimUdid,
  resolveStableDeviceName,
} from '@pwtap/mobile-core';
import { generateTestSource, statementForAction, type GeneratedTarget } from './codegen.js';
import { Draft } from './draft.js';
import type { ClientMessage, RecorderEvent } from './protocol.js';
import { Recorder } from './recorder.js';
import { TestRunner } from './testRunner.js';
import { TestWriter } from './testWriter.js';

const FRAME_POLL_MS = 1500;

export class RecorderSession {
  private drivers: Map<string, MobileInspectorDriver> | undefined;
  private session: DriverSession | undefined;
  /**
   * What the last successful `connect` targeted — the driver, platform, stable device name and app that
   * codegen must bake into `test.use({ mobileTarget: … })`. Deliberately NOT cleared on disconnect: the
   * draft describes a recording that was made against this target, and `run` disconnects before it
   * spawns Playwright (see `run`), so clearing it here would erase the header of the very test being run.
   */
  private lastTarget: GeneratedTarget | undefined;
  /** Most recent device list, reused for the device-name uniqueness check (see `knownDevices`). */
  private lastDevices: InspectorDevice[] = [];
  /** The `connected` event for the live session, replayed to a re-attaching client (see `snapshot`). */
  private connectedSummary: Extract<RecorderEvent, { type: 'connected' }> | undefined;
  private lastHierarchy: MobileNode[] = [];
  private lastFrameId = -1;
  private pollTimer: NodeJS.Timeout | undefined;
  private frameRefresh: Promise<void> | undefined;
  private hierarchyRefresh: Promise<boolean> | undefined;
  private closed = false;
  private readonly recorder = new Recorder();
  private readonly draft = new Draft();
  private readonly runner: TestRunner;
  private readonly writer: TestWriter;

  private readonly projectRoot: string;
  private readonly send: (event: RecorderEvent) => void;

  /**
   * `drivers` is a seam for tests: adapters are normally discovered from the project's `node_modules`
   * (see `registry.ts`), which makes the recording engine untestable without installing a real plugin and
   * attaching a real device. Injecting a fake driver map exercises this whole class in CI instead.
   */
  constructor(
    projectRoot: string,
    send: (event: RecorderEvent) => void,
    drivers?: Map<string, MobileInspectorDriver>,
  ) {
    this.projectRoot = projectRoot;
    this.send = send;
    this.drivers = drivers;
    this.runner = new TestRunner(projectRoot, send);
    this.writer = new TestWriter(projectRoot, send);
  }

  private async driverMap(): Promise<Map<string, MobileInspectorDriver>> {
    this.drivers ??= await discoverDriverMap(this.projectRoot);
    return this.drivers;
  }

  /**
   * The test binding (file extension, Playwright project, gate env) of the driver the current recording
   * targets. Everything that touches the filesystem or spawns Playwright needs it, and none of it can be
   * guessed: saving a Maestro recording as `*.appium.ts` would put it in a project that gates on a
   * different env var and applies a different timeout.
   */
  private async currentBinding(): Promise<DriverTestBinding | undefined> {
    const driverId = this.lastTarget?.driver;
    return driverId ? (await this.driverMap()).get(driverId)?.testBinding : undefined;
  }

  /**
   * The devices this driver knows about, for the name-uniqueness check in {@link resolveStableDeviceName}.
   * Reuses whatever the device picker already fetched; falls back to asking the driver, and to an empty
   * list if that fails — the resolver treats "unknown" as "cannot verify" and pins the unambiguous handle.
   */
  private async knownDevices(driver: MobileInspectorDriver): Promise<InspectorDevice[]> {
    if (this.lastDevices.length > 0) {
      return this.lastDevices;
    }
    try {
      this.lastDevices = await driver.discoverDevices();
    } catch {
      this.lastDevices = [];
    }
    return this.lastDevices;
  }

  /** Every installed driver's test-file extension, for the "append to existing file" picker. */
  private async knownExtensions(): Promise<string[]> {
    return [...(await this.driverMap()).values()].map(driver => driver.testBinding.extension);
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.send({ type: 'log', level, message });
  }

  /**
   * Everything a freshly attached — or re-attached — client needs to render the current state, without
   * touching the device.
   *
   * This is what makes a browser reload survivable (ADR-011): the recording session belongs to the service
   * launch, not to the connection, so pressing F5 must cost nothing. Frames are deliberately absent; the
   * transport owns those and replays the last one from its own store.
   */
  snapshot(): RecorderEvent[] {
    const events: RecorderEvent[] = [];
    if (this.connectedSummary) {
      events.push(this.connectedSummary);
    }
    if (this.lastHierarchy.length > 0) {
      events.push({ type: 'hierarchy', nodes: this.lastHierarchy });
    }
    const { source, revision } = this.draft.state;
    events.push({ type: 'timeline', actions: this.recorder.actions });
    events.push({ type: 'code', source, revision });
    if (this.runner.running) {
      events.push({ type: 'runStatus', state: 'started' });
    }
    return events;
  }

  /**
   * Transport-neutral command dispatch: the single entry point for every already-validated
   * {@link ClientMessage}, whatever host delivered it. Errors are reported as `error` events rather than
   * thrown, which keeps the transport a thin, dumb pipe and is what lets a VS Code webview speak the same
   * protocol later without touching this class.
   */
  async dispatch(message: ClientMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'listDrivers':
          return await this.listDrivers();
        case 'listDevices':
          return await this.listDevices(message.driver);
        case 'listApps':
          return await this.listApps(message.driver, message.platform, message.device);
        case 'connect':
          return await this.connect(message.driver, message.options);
        case 'disconnect':
          return await this.disconnect();
        case 'refreshFrame':
          return await this.refreshFrame();
        case 'refreshHierarchy':
          await this.refreshHierarchy();
          return;
        case 'inspectAt':
          return await this.inspectAt(message.x, message.y, message.frameId);
        case 'tapAt':
          return await this.tapAt(message.x, message.y, message.frameId);
        case 'perform':
          return await this.perform(message.action);
        case 'record':
          return this.record(message.action);
        case 'removeAction':
          return this.removeAction(message.index);
        case 'clearTimeline':
          return this.clearTimeline();
        case 'undo':
          return this.undo();
        case 'redo':
          return this.redo();
        case 'editCode':
          return this.editCode(message.source, message.revision);
        case 'listTestFiles':
          return await this.listTestFiles();
        case 'save':
          return await this.save(
            message.mode,
            message.targetPath,
            message.testName,
            message.source,
          );
        case 'run':
          return await this.run(message.source);
        case 'stopRun':
          return this.stopRun();
      }
    } catch (error) {
      this.send({ type: 'error', message: errorMessage(error) });
    }
  }

  async listDrivers(): Promise<void> {
    const drivers = await this.driverMap();
    this.send({
      type: 'drivers',
      drivers: [...drivers.values()].map(d => ({
        id: d.id,
        capabilities: d.capabilities,
        testBinding: d.testBinding,
      })),
    });
  }

  async listDevices(driverId: string): Promise<void> {
    const driver = (await this.driverMap()).get(driverId);
    if (!driver) {
      this.send({ type: 'error', message: `driver "${driverId}" is not installed` });
      return;
    }
    try {
      const devices = await driver.discoverDevices();
      this.lastDevices = devices;
      this.send({ type: 'devices', driver: driverId, devices });
    } catch (error) {
      this.send({ type: 'error', message: `failed to list devices: ${errorMessage(error)}` });
    }
  }

  async connect(driverId: string, options: ConnectOptions): Promise<void> {
    const driver = (await this.driverMap()).get(driverId);
    if (!driver) {
      this.send({ type: 'error', message: `driver "${driverId}" is not installed` });
      return;
    }
    await this.disconnect(); // one live session per socket — replace, don't stack
    this.send({ type: 'connecting' });
    try {
      this.session = await driver.connect(options);
      // Which handle is durable depends on the platform and on whether the name is ambiguous, so it is
      // resolved by the shared helper rather than guessed here (ADR-003). `knownDevices` is consulted for
      // the uniqueness check; a warning is surfaced rather than swallowed when the pin isn't durable.
      const stable = resolveStableDeviceName(this.session.device, await this.knownDevices(driver));
      if (stable.warning) {
        this.log('warn', stable.warning);
      }
      this.lastTarget = {
        driver: driverId,
        // The platform and app are known right here; not emitting them is what made generated tests
        // throw "platform not set" and replay against no app at all (ADR-003).
        platform: this.session.device.platform,
        device: stable.device,
        appId: options.appId,
        appSource: options.appSource,
      };
      this.recorder.clear();
      this.draft.reset();
      this.lastHierarchy = [];
      this.lastFrameId = -1;
      // Retained so a re-attaching client can be told what it is looking at without reconnecting the
      // device (see `snapshot`, ADR-011).
      this.connectedSummary = {
        type: 'connected',
        driver: driverId,
        device: this.session.device,
        capabilities: driver.capabilities,
      };
      this.send(this.connectedSummary);
      this.sendTimelineAndCode();
      await this.refreshHierarchy();
      await this.refreshFrame();
      this.pollTimer = setInterval(() => {
        void this.refreshFrame();
        void this.refreshHierarchy();
      }, FRAME_POLL_MS);
    } catch (error) {
      this.send({ type: 'error', message: `connect failed: ${errorMessage(error)}` });
    }
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    const session = this.session;
    this.session = undefined;
    this.connectedSummary = undefined;
    this.frameRefresh = undefined;
    this.hierarchyRefresh = undefined;
    if (session) {
      try {
        await session.close();
      } catch (error) {
        this.log('warn', `error while closing driver session: ${errorMessage(error)}`);
      }
      this.send({ type: 'disconnected' });
    }
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
      try {
        const frame = await session.captureScreen();
        if (this.session === session) {
          this.lastFrameId = frame.frameId;
          this.send({ type: 'frame', frame });
        }
      } catch (error) {
        this.log('warn', `frame capture failed: ${errorMessage(error)}`);
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
        // Identity is assigned once, here, so every consumer (hit-test, UI selection, highlight) sees the
        // same keys for one read of the tree (ADR-007).
        const hierarchy = assignNodeIdentity(await session.inspectHierarchy());
        if (this.session === session) {
          this.lastHierarchy = hierarchy;
          this.send({ type: 'hierarchy', nodes: hierarchy });
          return true;
        }
        return false;
      } catch (error) {
        this.log('warn', `hierarchy read failed: ${errorMessage(error)}`);
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

  /**
   * Hit-test a tap against a fresh hierarchy, then record and perform it.
   *
   * `frameId` is advisory: it is never a reason to refuse (ADR-006). It used to be — an interaction whose
   * frame id had moved on was dropped with nothing but a `warn` — which meant the frame poll silently
   * invalidated the user's clicks, and byte-identical frames make the mismatch routine rather than rare.
   * The hierarchy is re-read here anyway, so acting on the freshest tree is both safer and honest; a
   * mismatch is worth a note, not a refusal.
   */
  async tapAt(x: number, y: number, frameId: number): Promise<void> {
    if (!this.session) {
      return;
    }
    const fresh = await this.refreshHierarchy();
    if (frameId !== this.lastFrameId) {
      this.log(
        'info',
        `tapped against frame ${frameId} while the device is on ${this.lastFrameId}; ` +
          'hit-tested the current screen',
      );
    }
    const node = fresh ? hitTest(this.lastHierarchy, x, y) : undefined;
    const outOfApp = node && outOfAppWarning(node, this.lastTarget?.appId);
    if (outOfApp) {
      this.log('warn', `recorded an element that ${outOfApp}`);
    }
    const locator = node ? locatorForNode(node) : { point: { x, y }, label: 'coordinate tap' };
    await this.perform({ kind: 'tap', locator });
  }

  /**
   * Hit-test WITHOUT performing anything: return the matched node and its ranked locator candidates
   * so the UI can open its right-click "locator alternatives" menu. Stale frames are rejected the
   * same way `tapAt` rejects them. When nothing matches, returns a single coordinate candidate so the
   * user still has a (fragile) way to act on empty screen space.
   */
  async inspectAt(x: number, y: number, frameId: number): Promise<void> {
    if (!this.session) {
      return;
    }
    // Advisory, exactly as in `tapAt`: right-clicking must always answer with the current screen's
    // candidates rather than an empty menu because a frame id moved on (ADR-006).
    const fresh = await this.refreshHierarchy();
    if (frameId !== this.lastFrameId) {
      this.log(
        'info',
        `inspected frame ${frameId} while the device is on ${this.lastFrameId}; ` +
          'hit-tested the current screen',
      );
    }
    const node = fresh ? (hitTest(this.lastHierarchy, x, y) ?? null) : null;
    const candidates = node
      ? locatorCandidates(node, this.lastHierarchy, { appId: this.lastTarget?.appId })
      : [
          {
            strategy: 'point' as const,
            locator: { point: { x, y } },
            score: 12,
            confidence: 'low' as const,
            unique: false,
            warnings: ['coordinate fallback — no element found under this point'],
            display: `{ point: { x: ${x}, y: ${y} } }`,
          },
        ];
    this.send({ type: 'inspected', node, candidates });
  }

  async perform(action: MobileAction): Promise<void> {
    if (!this.session) {
      this.send({ type: 'error', message: 'not connected to a device' });
      return;
    }
    let result: ActionResult;
    try {
      result = await this.session.perform(action);
    } catch (error) {
      result = { ok: false, error: errorMessage(error), durationMs: 0 };
    }
    this.send({ type: 'actionResult', action, result });
    if (result.ok) {
      this.recorder.append(action);
      this.sendTimelineAndCode(action);
      await this.refreshHierarchy();
      await this.refreshFrame();
    } else {
      this.log('error', `${action.kind} failed: ${result.error ?? 'unknown driver error'}`);
    }
  }

  /** Record a declarative step that cannot be true in the current UI state without executing it. */
  record(action: MobileAction): void {
    if (!this.session) {
      this.send({ type: 'error', message: 'not connected to a device' });
      return;
    }
    this.recorder.append(action);
    this.sendTimelineAndCode(action);
  }

  removeAction(index: number): void {
    if (this.recorder.remove(index)) {
      this.sendTimelineAndCode();
    }
  }

  clearTimeline(): void {
    this.recorder.clear();
    this.sendTimelineAndCode();
  }

  undo(): void {
    if (this.recorder.undo()) {
      this.sendTimelineAndCode();
    }
  }

  redo(): void {
    const action = this.recorder.redo();
    if (action) {
      this.sendTimelineAndCode(action);
    }
  }

  private sendTimelineAndCode(appended?: MobileAction): void {
    const actions = this.recorder.actions;
    this.send({ type: 'timeline', actions });
    const target = this.lastTarget;
    const regenerated = this.draft.regenerate(() =>
      // With no target (nothing connected yet) there is nothing honest to generate: guessing a driver
      // produces a test that silently targets the wrong thing.
      target
        ? generateTestSource({ target, testName: 'recorded flow', actions })
        : '// Connect a device to start recording.\n',
    );
    if (!regenerated && appended) {
      // The user owns the buffer, so their edits win — but a newly recorded action is spliced in rather
      // than dropped. Non-append changes (remove/undo/clear) cannot be reconciled with arbitrary edits.
      this.draft.spliceIntoUserDraft(source =>
        insertStatementIntoTest(source, statementForAction(appended)),
      );
    }
    this.emitCode();
  }

  private emitCode(): void {
    const { source, revision } = this.draft.state;
    this.send({ type: 'code', source, revision });
  }

  /**
   * Accept a manual edit to the authoritative source from the editor. `revision` is the revision the
   * client based its edit on; if the server has since moved past it (a newer generated draft), the
   * edit is stale and we resend the current draft instead of silently clobbering newer content.
   */
  editCode(source: string, revision: number): void {
    // A refused edit still gets an answer: the current draft, so the editor can reconcile instead of
    // silently losing what was typed.
    this.draft.takeOver(source, revision);
    this.emitCode();
  }

  /**
   * Enumerate installed apps on the selected device for the app picker. Resolves `device` (an AVD
   * name/serial for Android, a simulator name/UDID for iOS) to the concrete device id the OS tooling
   * needs, then reads the installed-app list through the platform seam. Never throws — a failure
   * (Xcode/adb missing, no device) reports an empty list plus a log so the picker degrades to the
   * manual-id/file entry the UI always offers.
   */
  async listApps(driverId: string, platform: MobilePlatform, device?: string): Promise<void> {
    try {
      let apps: InstalledApp[] = [];
      if (platform === 'android') {
        const booted = await listBootedAndroidDevices();
        const match = device
          ? booted.find(d => d.serial === device || d.avdName === device)
          : booted[0];
        if (!match) {
          this.log('warn', 'no booted Android device to enumerate apps from');
        } else {
          const raw = await listInstalledAndroidApps(match.serial);
          apps = raw.map(a => ({ id: a.id, name: a.id, platform, system: a.system }));
        }
      } else {
        const udid = device ? await resolveSimUdid(device) : undefined;
        if (!udid && device) {
          this.log('warn', `iOS simulator "${device}" not found for app discovery`);
        } else if (udid) {
          const raw = await listInstalledIosApps(udid);
          apps = raw.map(a => ({ id: a.id, name: a.name, platform, system: a.system }));
        }
      }
      apps.sort((a, b) => a.name.localeCompare(b.name));
      this.send({ type: 'apps', driver: driverId, apps });
    } catch (error) {
      this.log('warn', `app discovery failed: ${errorMessage(error)}`);
      this.send({ type: 'apps', driver: driverId, apps: [] });
    }
  }

  /** Existing recordings under the project, for the "append to existing file" picker. */
  async listTestFiles(): Promise<void> {
    await this.writer.listTestFiles(await this.knownExtensions());
  }

  async save(
    mode: 'new' | 'append',
    targetPath: string,
    testName: string,
    source: string,
  ): Promise<void> {
    await this.writer.save({
      mode,
      targetPath,
      testName,
      source,
      extensions: await this.knownExtensions(),
      binding: await this.currentBinding(),
    });
  }

  /**
   * A live inspector session and a Playwright run cannot drive the same device, so the device is released
   * first — which is exactly why the draft must survive a disconnect (ADR-011).
   */
  async run(source: string): Promise<void> {
    if (this.runner.running) {
      this.send({ type: 'error', message: 'a run is already in progress' });
      return;
    }
    if (this.session) {
      this.log('info', 'disconnecting the live inspector session before running the test');
      await this.disconnect();
    }
    const binding = await this.currentBinding();
    if (!binding) {
      this.send({
        type: 'error',
        message: 'cannot tell which driver to run this test with — connect a device first',
      });
      return;
    }
    await this.runner.run(source, binding);
  }

  stopRun(): void {
    this.runner.stop();
  }

  /** Called once when the owning WebSocket closes — never leaves a device/lock/server behind. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopRun();
    await this.disconnect();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Insert one new generated statement into an existing test draft without regenerating the whole file.
 * This keeps manual edits intact while still reflecting newly recorded actions.
 */
function insertStatementIntoTest(source: string, statement: string): string {
  const insertion = `  ${statement}`;
  const closingMarker = '\n});\n';
  const closingIndex = source.lastIndexOf(closingMarker);
  if (closingIndex >= 0) {
    return `${source.slice(0, closingIndex)}\n${insertion}${source.slice(closingIndex)}`;
  }
  const trimmed = source.trimEnd();
  return `${trimmed}\n${insertion}\n`;
}
