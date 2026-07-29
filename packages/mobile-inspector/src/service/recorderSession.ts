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
  ConnectOptions,
  DriverTestBinding,
  InspectorDevice,
  InstalledApp,
  MobileAction,
  MobileInspectorDriver,
  MobileNode,
} from '@pwtap/mobile-core';
import {
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
import { resolveAppSource } from './appSource.js';
import { insertStatementIntoTest, loadProjectTypeScript } from './ast.js';
import { generateTestSource, statementForAction, type GeneratedTarget } from './codegen.js';
import { DeviceSession, type CaptureTiming } from './deviceSession.js';
import { Draft } from './draft.js';
import type { ClientMessage, RecorderEvent } from './protocol.js';
import { Recorder } from './recorder.js';
import { TestRunner } from './testRunner.js';
import { TestWriter } from './testWriter.js';

export class RecorderSession {
  private drivers: Map<string, MobileInspectorDriver> | undefined;
  /**
   * What the last successful `connect` targeted — the driver, platform, stable device name and app that
   * codegen must bake into `test.use({ mobileTarget: … })`. Deliberately NOT cleared on disconnect: the
   * draft describes a recording that was made against this target, and `run` disconnects before it
   * spawns Playwright (see `run`), so clearing it here would erase the header of the very test being run.
   */
  private lastTarget: GeneratedTarget | undefined;
  /** Most recent device list, reused for the device-name uniqueness check (see `knownDevices`). */
  private lastDevices: InspectorDevice[] = [];
  /**
   * Locator strategies already proven to resolve on this device, so each is checked once per session
   * rather than once per tap. Translation bugs are systematic — if `{ text }` does not resolve for one
   * element it does not resolve for any — so one sample per strategy buys the whole guarantee.
   */
  private verifiedStrategies = new Set<string>();
  /** The `connected` event for the live session, replayed to a re-attaching client (see `snapshot`). */
  private connectedSummary: Extract<RecorderEvent, { type: 'connected' }> | undefined;
  private closed = false;
  private readonly device: DeviceSession;
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
  /**
   * @param timing Capture/settle delays, overridable so a load test can drive hundreds of interactions
   *   without spending the real settle delay on each one. Production always uses the defaults.
   */
  constructor(
    projectRoot: string,
    send: (event: RecorderEvent) => void,
    drivers?: Map<string, MobileInspectorDriver>,
    timing?: Partial<CaptureTiming>,
  ) {
    this.projectRoot = projectRoot;
    this.send = send;
    this.drivers = drivers;
    this.device = new DeviceSession(send, timing);
    this.runner = new TestRunner(projectRoot, send);
    this.writer = new TestWriter(projectRoot, send);
  }

  private async driverMap(): Promise<Map<string, MobileInspectorDriver>> {
    this.drivers ??= await discoverDriverMap(this.projectRoot, message =>
      this.send({ type: 'log', level: 'error', message }),
    );
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
    if (this.device.hierarchy.length > 0) {
      events.push({ type: 'hierarchy', nodes: this.device.hierarchy });
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
        case 'listDirs':
          return await this.writer.listDirs(message.path);
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
    // The browser chooses `appSource`, and it ends up at an installer, so it is validated here rather
    // than forwarded on trust (ADR-010). The normalised absolute path is what the adapter receives.
    let connectOptions = options;
    if (options.appSource) {
      const resolved = await resolveAppSource(options.appSource, this.projectRoot);
      if ('error' in resolved) {
        this.send({ type: 'error', message: resolved.error });
        return;
      }
      connectOptions = { ...options, appSource: resolved.appSource };
    }
    await this.disconnect(); // one live device per launch — replace, don't stack
    this.send({ type: 'connecting' });
    try {
      const device = await this.device.connect(driver, connectOptions);
      // Which handle is durable depends on the platform and on whether the name is ambiguous, so the shared
      // resolver decides (ADR-003) and a warning is surfaced when the pin is not durable.
      const stable = resolveStableDeviceName(device, await this.knownDevices(driver));
      if (stable.warning) {
        this.log('warn', stable.warning);
      }
      this.lastTarget = {
        driver: driverId,
        platform: device.platform,
        device: stable.device,
        // The app the session is ACTUALLY scoped to — a driver may have adopted the foreground app when the
        // user named none, and a recording that pinned nothing would launch nothing on replay.
        appId: this.device.appId ?? options.appId,
        // The value as the user typed it, not the absolute path the driver got: the generated test is
        // committed and replayed on other machines, so a relative artifact path must stay relative.
        appSource: options.appSource,
      };
      this.recorder.clear();
      this.draft.reset();
      this.verifiedStrategies.clear();
      // Retained so a re-attaching client learns what it is looking at without reconnecting (ADR-011).
      this.connectedSummary = {
        type: 'connected',
        driver: driverId,
        device,
        capabilities: driver.capabilities,
      };
      this.send(this.connectedSummary);
      this.sendTimelineAndCode();
    } catch (error) {
      this.send({ type: 'error', message: `connect failed: ${errorMessage(error)}` });
    }
  }

  async disconnect(): Promise<void> {
    this.connectedSummary = undefined;
    if (await this.device.disconnect()) {
      this.send({ type: 'disconnected' });
    }
  }

  async refreshFrame(): Promise<void> {
    await this.device.refreshFrame();
  }

  async refreshHierarchy(): Promise<boolean> {
    return this.device.refreshHierarchy();
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
    if (!this.device.connected) {
      return;
    }
    const fresh = await this.hierarchyForClick(frameId, 'tapped');
    const node = fresh ? hitTest(this.device.hierarchy, x, y) : undefined;
    const outOfApp = node && outOfAppWarning(node, this.lastTarget?.appId);
    if (outOfApp) {
      this.log('warn', `recorded an element that ${outOfApp}`);
    }
    const locator = node ? locatorForNode(node) : { point: { x, y }, label: 'coordinate tap' };
    // Record the element, drive the device by coordinate. Asking the driver to find the element again is a
    // second lookup of something already hit-tested locally, and it costs ~800 ms per tap on Maestro — that
    // is the whole difference between this and Maestro Studio. The locator is still proven to resolve, once
    // per strategy, below. (The locator menu is deliberately different: there the user is choosing a
    // specific locator, so that is what gets performed.)
    await this.performAs({ kind: 'tap', locator }, { kind: 'tap', locator: { point: { x, y } } });
  }

  /**
   * Confirm each locator strategy actually resolves on this driver — once per session, off the critical path.
   *
   * Driving the device by coordinate is what makes an interaction fast, but it stops proving that the locator
   * being written down would work, and that class of bug is real (an iOS text locator once read `value` while
   * the selector matched only `label`). So the strategy is sampled instead: it is systematic, so one element
   * answers for all of them. Run after the screen has settled and against the CURRENT tree, because the tap
   * is usually what changed the screen — checking the element that was just tapped would prove nothing.
   *
   * Never awaited by an interaction, and never fails a recording: an unresolvable strategy is a warning.
   */
  private async verifyStrategies(): Promise<void> {
    const strategies = [
      { key: 'accessibilityId', of: (n: MobileNode) => n.accessibilityId },
      { key: 'resourceId', of: (n: MobileNode) => n.resourceId },
      { key: 'text', of: (n: MobileNode) => n.text },
    ] as const;
    const used = new Set(
      this.recorder.actions.flatMap(action =>
        'locator' in action
          ? strategies.filter(s => action.locator[s.key] !== undefined).map(s => s.key)
          : [],
      ),
    );
    for (const strategy of strategies) {
      if (!used.has(strategy.key) || this.verifiedStrategies.has(strategy.key)) {
        continue;
      }
      const sample = firstNodeWith(this.device.hierarchy, node => Boolean(strategy.of(node)));
      if (!sample) {
        continue; // nothing on screen carries this attribute right now; try again after the next action
      }
      this.verifiedStrategies.add(strategy.key);
      const result = await this.device.perform({
        kind: 'isVisible',
        locator: { [strategy.key]: strategy.of(sample) },
      });
      if (result.ok && result.value !== true) {
        this.log(
          'warn',
          `this driver cannot resolve "${strategy.key}" locators, so tests recorded with them will not ` +
            'replay — pick another candidate from the right-click menu',
        );
      }
    }
  }

  /**
   * Record one action while performing another.
   *
   * They differ only for a device click: the recording names the element, the device is driven by coordinate.
   * A driver that cannot tap a raw point makes the action fail, get retracted and say so — deliberately, in
   * preference to a silent second attempt with the locator, which would hide the gap and double the latency
   * of every failure. Both shipped drivers tap points.
   */
  private async performAs(recorded: MobileAction, executed: MobileAction): Promise<void> {
    if (!this.device.connected) {
      this.send({ type: 'error', message: 'not connected to a device' });
      return;
    }
    this.recorder.append(recorded);
    this.sendTimelineAndCode(recorded);

    const result = await this.device.perform(executed);
    this.send({ type: 'actionResult', action: recorded, result });
    if (result.ok) {
      // Look again once the screen has had a moment, and once more if it is still moving (ADR-006).
      await this.device.settle();
      await this.verifyStrategies();
      return;
    }
    if (this.recorder.retract(recorded)) {
      this.sendTimelineAndCode();
    }
    this.log('error', `${recorded.kind} failed: ${result.error ?? 'unknown driver error'}`);
  }

  /**
   * Hit-test WITHOUT performing anything: return the matched node and its ranked locator candidates
   * so the UI can open its right-click "locator alternatives" menu. Stale frames are rejected the
   * same way `tapAt` rejects them. When nothing matches, returns a single coordinate candidate so the
   * user still has a (fragile) way to act on empty screen space.
   */
  async inspectAt(x: number, y: number, frameId: number): Promise<void> {
    if (!this.device.connected) {
      return;
    }
    const fresh = await this.hierarchyForClick(frameId, 'inspected');
    const node = fresh ? (hitTest(this.device.hierarchy, x, y) ?? null) : null;
    const candidates = node
      ? locatorCandidates(node, this.device.hierarchy, { appId: this.lastTarget?.appId })
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

  /**
   * The hierarchy to hit-test a click against.
   *
   * Re-reading the tree on every click used to be unconditional. It is only necessary when the screen has
   * moved on since the frame the user clicked: if the client's frame is the device's current one, the tree
   * already in hand IS the screen they clicked, and re-reading it costs a device round trip per interaction
   * for nothing. `frameId` stays advisory — a mismatch refreshes and notes it, never refuses (ADR-006).
   */
  private async hierarchyForClick(frameId: number, verb: string): Promise<boolean> {
    if (frameId === this.device.frameId && this.device.hierarchy.length > 0) {
      return true;
    }
    const fresh = await this.refreshHierarchy();
    if (frameId !== this.device.frameId) {
      this.log(
        'info',
        `${verb} frame ${frameId} while the device is on ${this.device.frameId}; ` +
          'hit-tested the current screen',
      );
    }
    return fresh;
  }

  /**
   * Record first, then drive the device — and retract if the device refuses.
   *
   * Waiting for the driver before showing anything made every interaction feel broken: a Maestro tap takes
   * ~1.3 s on its own, so the code appeared a second and a half after the click and users reported the
   * recorder as laggy. Nothing about the recording depends on the device answering first — the hit-test is
   * local — so the action goes into the timeline and the code immediately and is taken back out if the
   * driver rejects it, which the failure banner already explains. Retraction is by identity, because the
   * user can undo or delete something while the device is still thinking.
   */
  async perform(action: MobileAction): Promise<void> {
    await this.performAs(action, action);
  }

  /** Record a declarative step that cannot be true in the current UI state without executing it. */
  record(action: MobileAction): void {
    if (!this.device.connected) {
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
      void this.spliceStatement(appended);
    }
    this.emitCode();
  }

  /**
   * Splice a newly recorded action into a user-owned draft. Asynchronous because the project's TypeScript is
   * loaded on demand; without it the statement is appended at the end rather than dropped.
   */
  private async spliceStatement(action: MobileAction): Promise<void> {
    const statement = statementForAction(action);
    const ts = await loadProjectTypeScript(this.projectRoot);
    this.draft.spliceIntoUserDraft(source =>
      ts ? insertStatementIntoTest(ts, source, statement) : `${source.trimEnd()}\n${statement}\n`,
    );
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
    if (this.device.connected) {
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

/** The first node anywhere in the tree matching `predicate`, depth-first. */
function firstNodeWith(
  nodes: MobileNode[],
  predicate: (node: MobileNode) => boolean,
): MobileNode | undefined {
  for (const node of nodes) {
    if (predicate(node)) {
      return node;
    }
    const inChildren = firstNodeWith(node.children ?? [], predicate);
    if (inChildren) {
      return inChildren;
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
