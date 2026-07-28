/**
 * Per-connection recording session: owns the connected `DriverSession`, the recorded `MobileAction`
 * timeline (with undo/redo), frame/hierarchy polling, and the save-to-file workflow. One instance per
 * WebSocket connection (see `server.ts`) — closing the socket always tears this down so a crashed or
 * closed browser tab never leaks a device lock or a booted-by-us device.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { type MobilePlatform } from '@pwtap/platform';
import prettier from 'prettier';

import { resolveStableDeviceName } from '../deviceDiscovery.js';
import { hitTest, locatorCandidates, locatorForNode } from '../locator.js';
import {
  listBootedAndroidDevices,
  listInstalledAndroidApps,
  listInstalledIosApps,
  resolveSimUdid,
} from '../platformCompat.js';
import { discoverDriverMap } from '../registry.js';
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
  TestFileEntry,
} from '../types.js';
import { generateTestSource, statementForAction, type GeneratedTarget } from './codegen.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

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
  private timeline: MobileAction[] = [];
  private redoStack: MobileAction[] = [];
  private lastHierarchy: MobileNode[] = [];
  private lastFrameId = -1;
  private pollTimer: NodeJS.Timeout | undefined;
  private frameRefresh: Promise<void> | undefined;
  private hierarchyRefresh: Promise<boolean> | undefined;
  private closed = false;
  /** Authoritative editable source draft and its monotonic revision (see `editCode`/`run`/`save`). */
  private draftSource = '';
  private draftRevision = 0;
  /** True once the user has manually edited the draft — stops timeline changes from clobbering it. */
  private draftDirty = false;
  /** The in-flight `playwright test` child, if any (see `run`/`stopRun`). */
  private runChild: ChildProcess | undefined;

  private readonly projectRoot: string;
  private readonly send: (message: ServerMessage) => void;

  /**
   * `drivers` is a seam for tests: adapters are normally discovered from the project's `node_modules`
   * (see `registry.ts`), which makes the recording engine untestable without installing a real plugin and
   * attaching a real device. Injecting a fake driver map exercises this whole class in CI instead.
   */
  constructor(
    projectRoot: string,
    send: (message: ServerMessage) => void,
    drivers?: Map<string, MobileInspectorDriver>,
  ) {
    this.projectRoot = projectRoot;
    this.send = send;
    this.drivers = drivers;
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
   * Transport-neutral command dispatch. Both the (legacy) WebSocket server and the Electron main
   * process route every already-validated {@link ClientMessage} through here, so the recording
   * engine has exactly one entry point regardless of host. Errors are reported as `error` events
   * rather than thrown, keeping the transport layer a thin, dumb pipe.
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
      this.timeline = [];
      this.redoStack = [];
      this.lastHierarchy = [];
      this.lastFrameId = -1;
      this.draftDirty = false;
      this.draftSource = '';
      this.send({
        type: 'connected',
        driver: driverId,
        device: this.session.device,
        capabilities: driver.capabilities,
      });
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
        const hierarchy = await session.inspectHierarchy();
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

  /** Hit-test a tap against a fresh hierarchy, then record and perform it. */
  async tapAt(x: number, y: number, frameId: number): Promise<void> {
    if (!this.session) {
      return;
    }
    if (frameId !== this.lastFrameId) {
      this.log('warn', 'ignored tap against a stale frame — refresh and try again');
      return;
    }
    const fresh = await this.refreshHierarchy();
    if (frameId !== this.lastFrameId) {
      this.log('warn', 'ignored tap after the frame changed during hierarchy refresh');
      return;
    }
    const node = fresh ? hitTest(this.lastHierarchy, x, y) : undefined;
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
    if (frameId !== this.lastFrameId) {
      this.log('warn', 'ignored inspect against a stale frame — refresh and try again');
      this.send({ type: 'inspected', node: null, candidates: [] });
      return;
    }
    const fresh = await this.refreshHierarchy();
    if (frameId !== this.lastFrameId) {
      this.log('warn', 'ignored inspect after the frame changed during hierarchy refresh');
      this.send({ type: 'inspected', node: null, candidates: [] });
      return;
    }
    const node = fresh ? (hitTest(this.lastHierarchy, x, y) ?? null) : null;
    const candidates = node
      ? locatorCandidates(node, this.lastHierarchy)
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
      this.timeline.push(action);
      this.redoStack = [];
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
    this.timeline.push(action);
    this.redoStack = [];
    this.sendTimelineAndCode(action);
  }

  removeAction(index: number): void {
    if (index >= 0 && index < this.timeline.length) {
      this.timeline.splice(index, 1);
      this.sendTimelineAndCode();
    }
  }

  clearTimeline(): void {
    this.timeline = [];
    this.redoStack = [];
    this.sendTimelineAndCode();
  }

  undo(): void {
    const action = this.timeline.pop();
    if (action) {
      this.redoStack.push(action);
      this.sendTimelineAndCode();
    }
  }

  redo(): void {
    const action = this.redoStack.pop();
    if (action) {
      this.timeline.push(action);
      this.sendTimelineAndCode(action);
    }
  }

  private sendTimelineAndCode(appended?: MobileAction): void {
    this.send({ type: 'timeline', actions: this.timeline });
    if (!this.draftDirty) {
      // Clean draft: regenerate authoritatively from the timeline. With no target yet (nothing has been
      // connected in this session) there is nothing honest to generate — the driver, platform and app are
      // unknown and guessing one produces a test that silently targets the wrong thing.
      this.draftSource = this.lastTarget
        ? generateTestSource({
            target: this.lastTarget,
            testName: 'recorded flow',
            actions: this.timeline,
          })
        : '// Connect a device to start recording.\n';
      this.draftRevision += 1;
    } else if (appended) {
      // Hand-edited draft: preserve the user's edits and splice the newly recorded action's statement
      // in before the test's closing brace, rather than dropping it. Non-append timeline changes
      // (remove/undo/clear) can't be safely reconciled with arbitrary manual edits, so they leave the
      // edited draft untouched (manual edits win).
      this.draftSource = insertStatementIntoTest(this.draftSource, statementForAction(appended));
      this.draftRevision += 1;
    }
    this.emitCode();
  }

  private emitCode(): void {
    this.send({ type: 'code', source: this.draftSource, revision: this.draftRevision });
  }

  /**
   * Accept a manual edit to the authoritative source from the editor. `revision` is the revision the
   * client based its edit on; if the server has since moved past it (a newer generated draft), the
   * edit is stale and we resend the current draft instead of silently clobbering newer content.
   */
  editCode(source: string, revision: number): void {
    if (revision < this.draftRevision) {
      this.emitCode(); // stale — client edited an out-of-date draft; give it the current one
      return;
    }
    this.draftSource = source;
    this.draftDirty = true;
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

  /**
   * Enumerate existing recorded test files anywhere under the project (any `*.mobile.ts`), for the
   * "append to existing file" save picker. Best-effort recursive scan skipping VCS/build/dependency
   * directories and hidden folders, capped at a sane file count so a huge/misconfigured project can't
   * make this hang.
   */
  async listTestFiles(): Promise<void> {
    const SKIP_DIRS = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      'ui-dist',
      'coverage',
      'test-results',
      'playwright-report',
    ]);
    const MAX_FILES = 500;
    const files: TestFileEntry[] = [];
    // Every installed driver's extension, not one hard-coded suffix — a project can hold both
    // `*.maestro.ts` and `*.appium.ts` recordings and the picker must offer both.
    const extensions = await this.knownExtensions();

    const walk = async (dir: string): Promise<void> => {
      if (files.length >= MAX_FILES) {
        return;
      }
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) {
          return;
        }
        if (entry.name.startsWith('.')) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) {
            continue;
          }
          await walk(full);
        } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
          const relativePath = path.relative(this.projectRoot, full).split(path.sep).join('/');
          files.push({ relativePath, name: entry.name });
        }
      }
    };
    await walk(this.projectRoot);
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    this.send({ type: 'testFiles', files });
  }

  /**
   * Write the authoritative `source` to `targetPath` (a project-relative path — possibly including
   * subdirectories — chosen via the location/file pickers in the UI). Confined to the project root
   * only (no `..` escape). Per `plan.md`'s "explicit confirmation" decision, neither mode silently
   * clobbers the wrong thing:
   * - `mode: 'new'` — `targetPath` must NOT already exist (`.mobile.ts` is appended if missing).
   * - `mode: 'append'` — `targetPath` MUST already exist; the recorded test is merged into it (see
   *   {@link mergeIntoExistingTest}) rather than overwritten, so existing tests are preserved.
   */
  async save(
    mode: 'new' | 'append',
    targetPath: string,
    testName: string,
    source: string,
  ): Promise<void> {
    const relative = targetPath.trim().replace(/^[/\\]+/, '');
    if (!relative) {
      this.send({ type: 'error', message: 'no target file specified' });
      return;
    }
    const resolved = resolveSaveExtension({
      relative,
      mode,
      extensions: await this.knownExtensions(),
      binding: await this.currentBinding(),
    });
    if ('error' in resolved) {
      this.send({ type: 'error', message: resolved.error });
      return;
    }
    const finalRelative = resolved.relativePath;
    const target = path.resolve(this.projectRoot, finalRelative);
    if (!target.startsWith(this.projectRoot + path.sep)) {
      this.send({ type: 'error', message: 'save location must be inside the project' });
      return;
    }

    const exists = await fs
      .access(target)
      .then(() => true)
      .catch(() => false);

    if (mode === 'new' && exists) {
      this.send({
        type: 'error',
        message: `${finalRelative} already exists — choose "append to existing file" or a different name`,
      });
      return;
    }
    if (mode === 'append' && !exists) {
      this.send({
        type: 'error',
        message: `${finalRelative} does not exist — choose "new file" to create it`,
      });
      return;
    }

    const body =
      mode === 'append'
        ? mergeIntoExistingTest(await fs.readFile(target, 'utf8'), source, testName)
        : source;

    let formatted = body;
    try {
      const config = (await prettier.resolveConfig(target)) ?? undefined;
      formatted = await prettier.format(body, { ...config, filepath: target });
    } catch (error) {
      this.log('warn', `prettier formatting skipped: ${errorMessage(error)}`);
    }
    // Atomic write: write to a temp file in the same dir, then rename over the target.
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
    await fs.writeFile(tmp, formatted, 'utf8');
    await fs.rename(tmp, target);
    this.send({ type: 'saved', path: target });
  }

  /**
   * Run the authoritative `source` through the project's own Playwright binary. To avoid two live
   * sessions fighting over one device, any inspector-owned driver session is disconnected first. The
   * source is written to a confined temporary `*.mobile.ts` under the project, executed with
   * `playwright test <file>` (no shell — argv only), its stdout/stderr streamed to the UI, and the
   * temp file removed when the run finishes or is cancelled.
   */
  async run(source: string): Promise<void> {
    if (this.runChild) {
      this.send({ type: 'error', message: 'a run is already in progress' });
      return;
    }
    // A live inspector session and a Playwright run can't drive the same device at once.
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
    let pwBin: string;
    try {
      pwBin = resolvePlaywrightBin(this.projectRoot);
    } catch (error) {
      this.send({ type: 'error', message: errorMessage(error) });
      return;
    }
    // A real, non-hidden path whose extension the target project's `testMatch` actually matches, in a
    // dedicated directory that gets swept on startup. Playwright filters CLI file arguments against the
    // files it collected, so a name the project does not match yields "no tests found", and a `.spec.ts`
    // name would instead be collected by the browser project (architecture.md §8).
    const runDir = path.resolve(this.projectRoot, 'tests', '__inspector__');
    await fs.mkdir(runDir, { recursive: true });
    await sweepStaleRuns(runDir);
    const tmpFile = path.join(runDir, `run-${Date.now()}${binding.extension}`);
    await fs.writeFile(tmpFile, source, 'utf8');

    const child = spawn(pwBin, ['test', tmpFile, `--project=${binding.project}`], {
      cwd: this.projectRoot,
      // The driver's project is env-gated, so without its gate variable the project does not even exist
      // in the resolved config and the run finds nothing to do.
      env: { ...process.env, [binding.gateEnv]: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.runChild = child;
    this.send({ type: 'runStatus', state: 'started' });

    child.stdout?.on('data', (buf: Buffer) =>
      this.send({ type: 'runOutput', stream: 'stdout', chunk: buf.toString() }),
    );
    child.stderr?.on('data', (buf: Buffer) =>
      this.send({ type: 'runOutput', stream: 'stderr', chunk: buf.toString() }),
    );
    child.on('error', err => {
      this.send({ type: 'error', message: `failed to start test run: ${errorMessage(err)}` });
    });
    child.on('close', code => {
      this.runChild = undefined;
      void fs.rm(tmpFile, { force: true });
      this.send({ type: 'runStatus', state: 'finished', exitCode: code });
    });
  }

  /** Cancel the in-flight run by killing exactly the child we spawned (no name-based kill). */
  stopRun(): void {
    if (!this.runChild) {
      return;
    }
    this.runChild.kill('SIGTERM');
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

/**
 * Delete leftover temporary run files. A crash (or a killed process) can leave one behind, and because it
 * lives under `tests/` with a real driver extension, a later plain `npm test` would happily collect and
 * run it. Best-effort: a sweep failure must never block the run the user asked for.
 */
async function sweepStaleRuns(runDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(runDir);
    await Promise.all(
      entries
        .filter(name => name.startsWith('run-'))
        .map(name => fs.rm(path.join(runDir, name), { force: true })),
    );
  } catch {
    // Nothing to sweep, or the directory is unreadable — either way the run proceeds.
  }
}

/**
 * Decide the final project-relative path a recording is saved to.
 *
 * The extension names the driver (architecture.md §8), so it comes from the driver the recording was made
 * against — never a fixed suffix. Saving a Maestro recording as `*.appium.ts` would file it under a
 * project that gates on a different env var and applies a different timeout, and it would silently never
 * run under `npm run test:maestro`. A name the user already suffixed correctly is left alone, and
 * `append` mode never rewrites the path at all: the target file exists and its name is the user's.
 */
export function resolveSaveExtension(input: {
  relative: string;
  mode: 'new' | 'append';
  extensions: string[];
  binding: DriverTestBinding | undefined;
}): { relativePath: string } | { error: string } {
  const { relative, mode, extensions, binding } = input;
  if (mode === 'append' || extensions.some(ext => relative.endsWith(ext))) {
    return { relativePath: relative };
  }
  if (!binding) {
    return {
      error:
        'cannot tell which driver this test targets — connect a device before saving, or give the file ' +
        `name one of these extensions: ${extensions.join(', ') || '(no driver plugin installed)'}`,
    };
  }
  return { relativePath: `${relative}${binding.extension}` };
}

/** Resolve the project-local Playwright CLI (`node_modules/.bin/playwright`) — throws if absent. */
function resolvePlaywrightBin(projectRoot: string): string {
  const bin = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'playwright.cmd' : 'playwright',
  );
  if (!fsSync.existsSync(bin)) {
    throw new Error(`Playwright CLI not found at ${bin} — run "npm install" in the project first`);
  }
  return bin;
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

/**
 * Merge a freshly generated/edited test `source` into an existing test file's content for the
 * "append" save mode. Concatenating the whole generated file would duplicate the `@fixtures` import
 * and let its top-level `test.use()` clobber the target file's own device/driver config for every test
 * that follows it in the file, so instead this extracts just the generated file's body (everything
 * after its leading `import` lines) and wraps it in its own `test.describe(testName, () => { ... })`
 * block — that keeps the appended test's `test.use()` scoped to itself, matching Playwright's scoping
 * rules. The `@fixtures` import line is only added if the target file doesn't already have one.
 */
function mergeIntoExistingTest(existingContent: string, source: string, testName: string): string {
  const lines = source.split('\n');
  let splitIndex = 0;
  while (
    splitIndex < lines.length &&
    (lines[splitIndex].startsWith('import ') || lines[splitIndex].trim() === '')
  ) {
    splitIndex += 1;
  }
  const importLines = lines.slice(0, splitIndex).filter(l => l.trim() !== '');
  const body = lines.slice(splitIndex).join('\n').trim();
  const indented = body
    .split('\n')
    .map(line => (line.trim() ? `  ${line}` : line))
    .join('\n');
  const block = `test.describe(${JSON.stringify(testName)}, () => {\n${indented}\n});\n`;

  const hasFixturesImport =
    existingContent.includes(`from '@fixtures'`) || existingContent.includes(`from "@fixtures"`);
  const header =
    importLines.length > 0 && !hasFixturesImport ? `${importLines.join('\n')}\n\n` : '';

  return `${header}${existingContent.trimEnd()}\n\n${block}`;
}
