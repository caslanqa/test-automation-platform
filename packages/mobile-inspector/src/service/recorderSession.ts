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

import {
  listBootedAndroidDevices,
  listInstalledAndroidApps,
  listInstalledIosApps,
  resolveSimUdid,
  type MobilePlatform,
} from '@pwtap/platform';
import prettier from 'prettier';

import { hitTest, locatorCandidates, locatorForNode } from '../locator.js';
import { discoverDriverMap } from '../registry.js';
import type {
  ActionResult,
  ConnectOptions,
  DriverSession,
  InstalledApp,
  MobileAction,
  MobileDriverId,
  MobileInspectorDriver,
  MobileNode,
  TestFileEntry,
} from '../types.js';
import { generateTestSource, statementForAction } from './codegen.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

const FRAME_POLL_MS = 1500;

export class RecorderSession {
  private drivers: Map<string, MobileInspectorDriver> | undefined;
  private connectedDriverId: MobileDriverId | undefined;
  private session: DriverSession | undefined;
  private timeline: MobileAction[] = [];
  private redoStack: MobileAction[] = [];
  private lastHierarchy: MobileNode[] = [];
  private lastFrameId = -1;
  private pollTimer: NodeJS.Timeout | undefined;
  private busy = false;
  private closed = false;
  /** Authoritative editable source draft and its monotonic revision (see `editCode`/`run`/`save`). */
  private draftSource = '';
  private draftRevision = 0;
  /** True once the user has manually edited the draft — stops timeline changes from clobbering it. */
  private draftDirty = false;
  /** The in-flight `playwright test` child, if any (see `run`/`stopRun`). */
  private runChild: ChildProcess | undefined;

  constructor(
    private readonly projectRoot: string,
    private readonly send: (message: ServerMessage) => void,
  ) {}

  private async driverMap(): Promise<Map<string, MobileInspectorDriver>> {
    this.drivers ??= await discoverDriverMap(this.projectRoot);
    return this.drivers;
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
          return await this.refreshHierarchy();
        case 'inspectAt':
          return this.inspectAt(message.x, message.y, message.frameId);
        case 'tapAt':
          return await this.tapAt(message.x, message.y, message.frameId);
        case 'perform':
          return await this.perform(message.action);
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
      drivers: [...drivers.values()].map(d => ({ id: d.id, capabilities: d.capabilities })),
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
      this.connectedDriverId = driverId;
      this.timeline = [];
      this.redoStack = [];
      this.draftDirty = false;
      this.draftSource = '';
      this.send({
        type: 'connected',
        driver: driverId,
        device: this.session.device,
        capabilities: driver.capabilities,
      });
      this.sendTimelineAndCode();
      await this.refreshFrame();
      await this.refreshHierarchy();
      this.pollTimer = setInterval(() => void this.refreshFrame(), FRAME_POLL_MS);
    } catch (error) {
      this.send({ type: 'error', message: `connect failed: ${errorMessage(error)}` });
    }
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.session) {
      try {
        await this.session.close();
      } catch (error) {
        this.log('warn', `error while closing driver session: ${errorMessage(error)}`);
      }
      this.session = undefined;
      this.connectedDriverId = undefined;
      this.send({ type: 'disconnected' });
    }
  }

  async refreshFrame(): Promise<void> {
    if (!this.session || this.busy) {
      return;
    }
    this.busy = true;
    try {
      const frame = await this.session.captureScreen();
      this.lastFrameId = frame.frameId;
      this.send({ type: 'frame', frame });
    } catch (error) {
      this.log('warn', `frame capture failed: ${errorMessage(error)}`);
    } finally {
      this.busy = false;
    }
  }

  async refreshHierarchy(): Promise<void> {
    if (!this.session) {
      return;
    }
    try {
      this.lastHierarchy = await this.session.inspectHierarchy();
      this.send({ type: 'hierarchy', nodes: this.lastHierarchy });
    } catch (error) {
      this.log('warn', `hierarchy read failed: ${errorMessage(error)}`);
    }
  }

  /** Hit-test a device-pixel tap against the last known hierarchy, then record+perform it as `tap`. */
  async tapAt(x: number, y: number, frameId: number): Promise<void> {
    if (!this.session) {
      return;
    }
    if (frameId !== this.lastFrameId) {
      this.log('warn', 'ignored tap against a stale frame — refresh and try again');
      return;
    }
    const node = hitTest(this.lastHierarchy, x, y);
    const locator = node ? locatorForNode(node) : { point: { x, y }, label: 'coordinate tap' };
    await this.perform({ kind: 'tap', locator });
  }

  /**
   * Hit-test WITHOUT performing anything: return the matched node and its ranked locator candidates
   * so the UI can open its right-click "locator alternatives" menu. Stale frames are rejected the
   * same way `tapAt` rejects them. When nothing matches, returns a single coordinate candidate so the
   * user still has a (fragile) way to act on empty screen space.
   */
  inspectAt(x: number, y: number, frameId: number): void {
    if (!this.session) {
      return;
    }
    if (frameId !== this.lastFrameId) {
      this.log('warn', 'ignored inspect against a stale frame — refresh and try again');
      this.send({ type: 'inspected', node: null, candidates: [] });
      return;
    }
    const node = hitTest(this.lastHierarchy, x, y) ?? null;
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
    }
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
      // Clean draft: regenerate authoritatively from the timeline.
      this.draftSource = generateTestSource({
        driver: this.connectedDriverId ?? 'maestro',
        device: this.session?.device.id,
        testName: 'recorded flow',
        actions: this.timeline,
      });
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
        } else if (entry.isFile() && entry.name.endsWith('.mobile.ts')) {
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
    const finalRelative =
      mode === 'new' && !relative.endsWith('.mobile.ts') ? `${relative}.mobile.ts` : relative;
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
    let pwBin: string;
    try {
      pwBin = resolvePlaywrightBin(this.projectRoot);
    } catch (error) {
      this.send({ type: 'error', message: errorMessage(error) });
      return;
    }
    const testsDir = path.resolve(this.projectRoot, 'tests');
    await fs.mkdir(testsDir, { recursive: true });
    const tmpFile = path.join(testsDir, `.inspector-run-${Date.now()}.spec.ts`);
    await fs.writeFile(tmpFile, source, 'utf8');

    const child = spawn(pwBin, ['test', tmpFile], {
      cwd: this.projectRoot,
      env: process.env,
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
