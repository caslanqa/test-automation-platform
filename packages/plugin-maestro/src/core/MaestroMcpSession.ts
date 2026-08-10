import fs from 'node:fs';
import path from 'node:path';

import type { DiscoveredDevice } from '@pwtap/platform';
import { getPlatform } from '@pwtap/platform';

import { maestroError } from './maestroError.js';
import type { McpToolResult } from './McpClient.js';
import { McpClient } from './McpClient.js';
import { rowValue } from './screen.js';
import type { MaestroScreen, MaestroSelector } from './types.js';

/** How long to wait for a single streamed command; covers Maestro's ~17s element-lookup timeout. */
const COMMAND_TIMEOUT_MS = 60_000;
/** Default bound for `isVisible` — how long Maestro waits for the element before returning `false`. */
const DEFAULT_VISIBLE_TIMEOUT_MS = 2_000;
/** Cap for evidence-capture tool calls (screenshot/hierarchy) — best-effort, must not hang a run. */
const CAPTURE_TIMEOUT_MS = 30_000;

/**
 * Bound on Maestro's own animation wait. A screen that never stops moving — a spinner, a video, a blinking
 * caret — must not be able to stall every command for Maestro's default wait, and this is a settle after an
 * interaction, not an assertion: it is worth a fraction of a second, not five.
 */
const SETTLE_TIMEOUT_MS = 500;

/** Maestro's own wildcard config header — a flow that is not scoped to any one app. */
const ANY_APP = 'any';

/** Cardinal directions for `scroll`/`swipe`, matching Maestro's enum. */
export type MaestroDirection = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

/** Per-command modifiers shared by the interaction commands. */
export interface CommandOptions {
  /**
   * Return only once the screen has stopped moving, as part of the SAME command.
   *
   * Maestro runs every command as its own flow and charges roughly 420 ms for the privilege, so a caller
   * that wants "tap, then let the screen settle" pays that twice if it asks separately — and if it sleeps
   * instead, it pays a fixed delay whether the screen was still moving or had finished instantly. Appending
   * `waitForAnimationToEnd` to the command itself costs neither.
   */
  settle?: boolean;
}

/** Append Maestro's own animation wait to `commandYaml` so both travel in one `run` call. */
function withSettle(commandYaml: string, options?: CommandOptions): string {
  return options?.settle
    ? `${commandYaml}\n- waitForAnimationToEnd: ${json({ timeout: SETTLE_TIMEOUT_MS })}`
    : commandYaml;
}

/**
 * When to capture a device screenshot + view hierarchy (Playwright's `screenshot` for native mobile):
 * - `off` — never (fastest).
 * - `only-on-failure` — the real screen + hierarchy at the point a command fails (default).
 * - `on` — additionally after every successful command → a step-by-step visual timeline in both the
 *   HTML report and the trace viewer (costs one screenshot per command).
 */
export type ScreenshotMode = 'off' | 'only-on-failure' | 'on';

/**
 * Whether to attach a command's real log (the YAML sent + Maestro's raw response) even when it
 * SUCCEEDED, from `MOBILE_STEP_LOGS`. A failing command always attaches its log regardless of this
 * setting — this only controls the success-path noise.
 */
export function resolveVerboseStepLogs(): boolean {
  const value = process.env.MOBILE_STEP_LOGS?.trim();
  return value ? /^(1|true|yes|on)$/i.test(value) : false;
}

/**
 * Runs a step and returns its value — the fixture injects `(title, body) => test.step(title, body)`
 * so each imperative command shows up as a native Playwright step. Typed generically (not
 * `test.step`) so this core module stays free of a Playwright import.
 */
export type StepRunner = <T>(title: string, body: () => Promise<T>) => Promise<T>;

/** Hooks the fixture provides so the session can report steps and attach evidence, Playwright-free. */
export interface McpSessionHooks {
  /** Wrap a command as a report step. */
  step: StepRunner;
  /** Directory to write screenshots/hierarchy into (Playwright copies attachments from here). */
  outputDir: string;
  /**
   * Attach a file or inline value to the CURRENT step (maps to `testInfo.attach`) — so a failure
   * screenshot, the per-step timeline, or a command's real log shows in context, in both the HTML
   * report and the trace viewer. Either `path` or `body` (never both) — mirrors `TestInfo.attach`.
   */
  report: (
    name: string,
    attachment: { path?: string; body?: string | Buffer; contentType?: string },
  ) => Promise<void>;
}

/**
 * Layer 1 — the imperative (streaming) Maestro adapter. Holds ONE long-lived `maestro mcp` process
 * for a device and turns method calls into single Maestro commands sent over MCP. Because the device
 * driver stays warm across calls, `await maestro.tapOn(...)` has true per-command semantics (it
 * executes and fails at that exact line) and is cheap (no per-command process/driver spawn) — which
 * also enables branching in TypeScript on the live screen via {@link isVisible} / {@link inspectScreen}.
 *
 * The MCP process is spawned lazily on the first command, so tests that only use the batch
 * `maestro.run(flow)` path never pay for it. Exactly one process per device: the fixture holds the
 * device lock for the session's lifetime, so two sessions never target the same device at once
 * (which would kill the driver). {@link close} tears the process down before the lock is released.
 *
 * @example
 * await maestro.launchApp('com.example.app');
 * await maestro.tapOn('Login');
 * await maestro.inputText('John Doe');
 * if (await maestro.isVisible('Cookie banner')) await maestro.tapOn('Accept');
 * await maestro.assertVisible('Dashboard');
 */
/** Optional {@link MaestroMcpSession} construction settings — all have sane standalone defaults. */
export interface MaestroSessionOptions {
  /** When to capture screenshots + hierarchy. Default `'only-on-failure'`. */
  screenshotMode?: ScreenshotMode;
  /** Maestro executable. Default: `MAESTRO_BIN` env, or `maestro` on PATH. */
  binary?: string;
  /** Attach a command's real log even on success. Default: `MOBILE_STEP_LOGS` env. */
  verboseLogs?: boolean;
}

export class MaestroMcpSession {
  private client: McpClient | undefined;
  private appId: string | undefined;
  /** Counter for unique per-step screenshot names when the mode is `on`. */
  private shotCount = 0;
  private readonly device: DiscoveredDevice;
  private readonly hooks: McpSessionHooks;
  private readonly screenshotMode: ScreenshotMode;
  private readonly binary: string;
  private readonly verboseLogs: boolean;

  /**
   * @param device The booted device this session drives.
   * @param hooks Report/attachment hooks from the fixture.
   * @param options Screenshot mode / Maestro binary / verbose-log overrides — see
   *   {@link MaestroSessionOptions}. The fixture passes `screenshotMode` explicitly (resolved from
   *   Playwright's own `screenshot` option); bespoke callers can omit it for the standalone default.
   */
  constructor(
    device: DiscoveredDevice,
    hooks: McpSessionHooks,
    options: MaestroSessionOptions = {},
  ) {
    this.device = device;
    this.hooks = hooks;
    this.screenshotMode = options.screenshotMode ?? 'only-on-failure';
    this.binary = options.binary ?? (process.env.MAESTRO_BIN || 'maestro');
    this.verboseLogs = options.verboseLogs ?? resolveVerboseStepLogs();
  }

  /** Spawn `maestro mcp` and complete the MCP handshake on first use; reused on later calls. */
  private async ensureClient(): Promise<McpClient> {
    if (!this.client) {
      // On Android, inject the SDK env so Maestro (which shells out to adb) finds the device.
      const env = this.device.platform === 'android' ? getPlatform().androidEnv() : process.env;
      const client = new McpClient(this.binary, ['mcp', '--no-viewer'], env);
      await client.initialize();
      this.client = client;
    }
    return this.client;
  }

  /** Kill the MCP process (no-op if it was never spawned). Called by the fixture before unlocking. */
  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  // ----- app lifecycle -----

  /**
   * Target whatever is on screen instead of one app, using Maestro's own `appId: any` header.
   *
   * Every command Maestro runs needs a config header, which is why {@link launchApp} was the only way to make
   * a session usable — and why a caller with no app id had nothing to do but give up. `any` satisfies the
   * header without scoping the flow: verified on a simulator, `tapOn` by point and by text, `assertVisible`,
   * `extendedWaitUntil`, `swipe`, `waitForAnimationToEnd` and `back` all run under it. That is exactly what a
   * recorder wants, because the user taps whatever is in front of them — including the launcher, another app
   * and the status bar.
   *
   * Launches nothing, so it also does not restart the app the user is already looking at.
   */
  attachAnyApp(): void {
    this.appId = ANY_APP;
  }

  /**
   * Launch the app under test and make it the target of subsequent commands. Must be called before
   * element commands (`tapOn`, `inputText`, …), which need the app id — unless {@link attachAnyApp} set the
   * unscoped header instead.
   */
  async launchApp(
    appId: string,
    options?: { clearState?: boolean; stopApp?: boolean },
  ): Promise<void> {
    return this.hooks.step(`launchApp "${appId}"`, async () => {
      this.appId = appId;
      await this.runCommand(
        `- launchApp: ${json(compact({ appId, clearState: options?.clearState, stopApp: options?.stopApp }))}`,
      );
    });
  }

  // ----- interactions -----

  /** Tap an element. */
  async tapOn(selector: MaestroSelector, options?: CommandOptions): Promise<void> {
    return this.hooks.step(`tapOn ${label(selector)}`, () =>
      this.runCommand(withSettle(`- tapOn: ${json(selector)}`, options)),
    );
  }

  /**
   * Tap a field and type into it as ONE command.
   *
   * Maestro has no "fill this field" primitive, so this is a tap followed by an `inputText` — and sending
   * them as two `run` calls paid Maestro's per-flow overhead twice for one recorded action.
   */
  async fillOn(selector: MaestroSelector, text: string, options?: CommandOptions): Promise<void> {
    return this.hooks.step(`fill ${label(selector)} with "${truncate(text)}"`, () =>
      this.runCommand(
        withSettle(`- tapOn: ${json(selector)}\n- inputText: ${json(text)}`, options),
      ),
    );
  }

  /** Double-tap an element. */
  async doubleTapOn(selector: MaestroSelector, options?: CommandOptions): Promise<void> {
    return this.hooks.step(`doubleTapOn ${label(selector)}`, () =>
      this.runCommand(withSettle(`- doubleTapOn: ${json(selector)}`, options)),
    );
  }

  /**
   * Focus a field and erase from it as ONE command.
   *
   * {@link eraseText} acts on whatever is focused and takes no selector, so erasing a *named* field is a tap
   * plus an erase — two `run` calls, and two helpings of Maestro's per-call overhead, unless they are sent
   * together. Same shape as {@link fillOn}, for the same reason.
   */
  async eraseTextIn(
    selector: MaestroSelector,
    charactersToErase?: number,
    options?: CommandOptions,
  ): Promise<void> {
    const erase = charactersToErase == null ? '- eraseText' : `- eraseText: ${charactersToErase}`;
    return this.hooks.step(`eraseText in ${label(selector)}`, () =>
      this.runCommand(withSettle(`- tapOn: ${json(selector)}\n${erase}`, options)),
    );
  }

  /** Long-press an element. */
  async longPressOn(selector: MaestroSelector, options?: CommandOptions): Promise<void> {
    return this.hooks.step(`longPressOn ${label(selector)}`, () =>
      this.runCommand(withSettle(`- longPressOn: ${json(selector)}`, options)),
    );
  }

  /** Type text into the focused field. */
  async inputText(text: string): Promise<void> {
    return this.hooks.step(`inputText "${truncate(text)}"`, () =>
      this.runCommand(`- inputText: ${json(text)}`),
    );
  }

  /** Erase characters from the focused field (all, or the last `charactersToErase`). */
  async eraseText(charactersToErase?: number): Promise<void> {
    return this.hooks.step('eraseText', () =>
      this.runCommand(
        charactersToErase == null ? '- eraseText' : `- eraseText: ${charactersToErase}`,
      ),
    );
  }

  /** Press the system Back button (Android) / equivalent. */
  async back(options?: CommandOptions): Promise<void> {
    return this.hooks.step('back', () => this.runCommand(withSettle('- back', options)));
  }

  /** Press a hardware/system key (e.g. `Enter`, `Home`, `Back`, `Backspace`). */
  async pressKey(key: string, options?: CommandOptions): Promise<void> {
    return this.hooks.step(`pressKey ${key}`, () =>
      this.runCommand(withSettle(`- pressKey: ${json(key)}`, options)),
    );
  }

  /** Hide the on-screen keyboard. */
  async hideKeyboard(): Promise<void> {
    return this.hooks.step('hideKeyboard', () => this.runCommand('- hideKeyboard'));
  }

  /** Scroll down one screen. */
  async scroll(): Promise<void> {
    return this.hooks.step('scroll', () => this.runCommand('- scroll'));
  }

  /** Scroll (default down) until an element is visible, then stop. */
  async scrollUntilVisible(
    selector: MaestroSelector,
    options?: { direction?: MaestroDirection; timeout?: number },
  ): Promise<void> {
    const body = compact({
      element: selector,
      direction: options?.direction,
      timeout: options?.timeout,
    });
    return this.hooks.step(`scrollUntilVisible ${label(selector)}`, () =>
      this.runCommand(`- scrollUntilVisible: ${json(body)}`),
    );
  }

  /** Swipe by direction, or between two `x%,y%` points. */
  async swipe(
    options: {
      direction?: MaestroDirection;
      start?: string;
      end?: string;
      duration?: number;
    },
    command?: CommandOptions,
  ): Promise<void> {
    return this.hooks.step('swipe', () =>
      this.runCommand(withSettle(`- swipe: ${json(compact(options))}`, command)),
    );
  }

  /** Wait for on-screen animations to settle. */
  async waitForAnimationToEnd(): Promise<void> {
    return this.hooks.step('waitForAnimationToEnd', () =>
      this.runCommand('- waitForAnimationToEnd'),
    );
  }

  // ----- assertions -----

  /** Assert an element is visible (fails the step if it isn't within Maestro's lookup timeout). */
  async assertVisible(selector: MaestroSelector): Promise<void> {
    return this.hooks.step(`assertVisible ${label(selector)}`, () =>
      this.runCommand(`- assertVisible: ${json(selector)}`),
    );
  }

  /** Assert an element is NOT visible. */
  async assertNotVisible(selector: MaestroSelector): Promise<void> {
    return this.hooks.step(`assertNotVisible ${label(selector)}`, () =>
      this.runCommand(`- assertNotVisible: ${json(selector)}`),
    );
  }

  // ----- branching (queries — never fail the test) -----

  /**
   * Whether an element becomes visible within `timeout` ms (default 2000). Use it to branch in
   * TypeScript — e.g. dismiss a banner only if it's there. Uses Maestro's own matcher (via a bounded
   * `extendedWaitUntil`), so it agrees with `tapOn`/`assertVisible`; it returns `false` instead of
   * failing when the element is absent, and waits up to `timeout` in that case.
   */
  async isVisible(selector: MaestroSelector, options?: { timeout?: number }): Promise<boolean> {
    const timeout = options?.timeout ?? DEFAULT_VISIBLE_TIMEOUT_MS;
    return this.hooks.step(`isVisible ${label(selector)}`, async () => {
      const wait = { visible: selector, timeout: String(timeout) };
      const commandYaml = `- extendedWaitUntil: ${json(wait)}`;
      const result = await this.runYaml(commandYaml, timeout + COMMAND_TIMEOUT_MS);
      // `result.isError` here just means "not visible yet" — an expected outcome, not a real
      // failure — so log it only when verbose, never unconditionally like a genuine failure.
      if (this.verboseLogs) {
        await this.attachCommandLog(commandYaml, result);
      }
      return !result.isError;
    });
  }

  /**
   * The current screen's compact view hierarchy (Maestro's `inspect_screen`). Use it for richer
   * TypeScript branching than {@link isVisible} allows. Returns immediately (no element wait); does
   * not require {@link launchApp} first. For the common "value in a labelled row" case prefer
   * {@link rowValue}, which reads this for you.
   */
  async inspectScreen(): Promise<MaestroScreen> {
    return this.hooks.step('inspectScreen', () => this.fetchScreen());
  }

  /**
   * The value shown in the settings row labelled `label` (e.g. `rowValue('Name')` → `'iPhone'` on the
   * iOS About page), or `undefined`. A convenience over {@link inspectScreen} so tests never walk the
   * hierarchy by hand — the walking lives in `screen.ts`.
   */
  async rowValue(label: string): Promise<string | undefined> {
    return this.hooks.step(`rowValue "${label}"`, async () =>
      rowValue(await this.fetchScreen(), label),
    );
  }

  /** Fetch + parse the current view hierarchy (no report step of its own). */
  private async fetchScreen(): Promise<MaestroScreen> {
    const client = await this.ensureClient();
    const result = await client.callTool('inspect_screen', { device_id: this.device.id });
    if (result.isError || this.verboseLogs) {
      await this.attachCommandLog('- inspect_screen', result);
    }
    if (result.isError) {
      throw maestroError(reason(result));
    }
    const payload = textOf(result);
    try {
      return JSON.parse(payload) as MaestroScreen;
    } catch {
      return { raw: payload } as MaestroScreen; // tolerate a non-JSON payload rather than throw
    }
  }

  // ----- media -----

  /**
   * Capture the current screen, attach it to the report as `<name>.jpg`, and RETURN the file path.
   * The path composes straight into the AI judge for multimodal assertions:
   * `await expect({ image: await maestro.takeScreenshot('home'), rubric }).toPassRubric()`.
   * Uses the MCP `take_screenshot` tool (image inline); does not require {@link launchApp} first.
   */
  async takeScreenshot(name: string): Promise<string> {
    return this.hooks.step(`takeScreenshot ${name}`, async () => {
      const file = await this.captureScreenshot(name);
      if (!file) {
        throw maestroError('[maestro] take_screenshot returned no image');
      }
      return file;
    });
  }

  /**
   * The current screen as base64 image bytes — no file written, no report attachment, no report step.
   *
   * {@link takeScreenshot} exists for *evidence*: it writes `<name>.jpg` into the output directory and
   * attaches it, which is what a failing command needs. A live viewport needs neither, and it captures on
   * every action and every idle poll — routing those through the file path wrote a screenshot per frame
   * (hundreds of files in a ten-minute session, against a §11 budget of three) and paid a decode, a disk
   * write and a disk read for bytes the MCP response already handed over as base64.
   */
  async screenshotBytes(): Promise<string> {
    const client = await this.ensureClient();
    const result = await client.callTool(
      'take_screenshot',
      { device_id: this.device.id },
      CAPTURE_TIMEOUT_MS,
    );
    const image = result.content.find(part => part.type === 'image' && part.data);
    if (result.isError || !image?.data) {
      throw maestroError('[maestro] take_screenshot returned no image');
    }
    return image.data;
  }

  // ----- internals -----

  /**
   * Run one command; throw a clean, frame-free error (the real Maestro reason) if it fails. On
   * failure it first captures the REAL screen + view hierarchy AT that point (unless mode is `off`)
   * so the report shows what was actually on screen, not a stale earlier capture. When the mode is
   * `on`, it also captures after a successful command to build a step-by-step visual timeline.
   */
  private async runCommand(commandYaml: string, timeoutMs?: number): Promise<void> {
    const result = await this.runYaml(commandYaml, timeoutMs);
    if (result.isError || this.verboseLogs) {
      await this.attachCommandLog(commandYaml, result);
    }
    if (result.isError) {
      if (this.screenshotMode !== 'off') {
        await this.captureScreenshot('failure');
        await this.captureHierarchy('failure-hierarchy');
      }
      throw maestroError(reason(result));
    }
    if (this.screenshotMode === 'on') {
      await this.captureScreenshot(`step-${++this.shotCount}`);
    }
  }

  /**
   * Attach the command sent + Maestro's raw MCP response to the CURRENT step as `maestro-step-log` —
   * the real, unedited record of what ran and what came back, alongside the synthesized step title.
   * Best-effort: a logging failure must never mask the actual command result.
   */
  private async attachCommandLog(commandYaml: string, result: McpToolResult): Promise<void> {
    try {
      await this.hooks.report('maestro-step-log', {
        body: formatMcpLog(commandYaml, result),
        contentType: 'text/plain',
      });
    } catch {
      /* best-effort — never let log attachment mask the real result */
    }
  }

  /**
   * Take a device screenshot via MCP, attach it to the current step as `<name>.jpg`, and return the
   * written file path (or `undefined` if no image was produced). Best-effort for evidence captures:
   * it swallows errors so a capture failure never masks the real test failure it's documenting.
   */
  private async captureScreenshot(name: string): Promise<string | undefined> {
    try {
      const client = await this.ensureClient();
      const result = await client.callTool(
        'take_screenshot',
        { device_id: this.device.id },
        CAPTURE_TIMEOUT_MS,
      );
      const image = result.content.find(part => part.type === 'image' && part.data);
      if (result.isError || !image?.data) {
        return undefined;
      }
      const file = path.join(this.hooks.outputDir, `${name}.jpg`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
      await this.hooks.report(`${name}.jpg`, { path: file, contentType: 'image/jpeg' });
      return file;
    } catch {
      return undefined; // evidence capture is best-effort — never let it throw over the real failure
    }
  }

  /** Dump the current view hierarchy (Maestro's `inspect_screen`) to `<name>.json` on the step. */
  private async captureHierarchy(name: string): Promise<void> {
    try {
      const client = await this.ensureClient();
      const result = await client.callTool(
        'inspect_screen',
        { device_id: this.device.id },
        CAPTURE_TIMEOUT_MS,
      );
      if (result.isError) {
        return;
      }
      const file = path.join(this.hooks.outputDir, `${name}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, textOf(result));
      await this.hooks.report(`${name}.json`, { path: file, contentType: 'application/json' });
    } catch {
      /* best-effort — see captureScreenshot */
    }
  }

  /**
   * Send `commandYaml` (the flow body after the `---`) as a one-command flow to the warm driver.
   * Every command carries the `appId` config header (Maestro's `run` requires the config section);
   * the header sets the target app but does NOT relaunch it, so app state is preserved across calls.
   */
  private async runYaml(
    commandYaml: string,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<McpToolResult> {
    if (!this.appId) {
      throw maestroError(
        '[maestro] call maestro.launchApp(appId) — or maestro.attachAnyApp() to target whatever is on ' +
          'screen — before other commands',
      );
    }
    const client = await this.ensureClient();
    const flow = `appId: ${json(this.appId)}\n---\n${commandYaml}\n`;
    return client.callTool('run', { device_id: this.device.id, yaml: flow }, timeoutMs);
  }
}

/** Serialize a value as a compact JSON scalar/mapping — valid YAML, since YAML is a JSON superset. */
function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Drop `undefined` entries so optional command fields are simply omitted from the YAML. */
function compact<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** The first text content part of a tool result (`''` if none). */
function textOf(result: McpToolResult): string {
  return result.content.find(part => part.type === 'text')?.text ?? '';
}

/** A clean failure reason from an error result — strip Maestro's `run`-tool wrapper prefix. */
function reason(result: McpToolResult): string {
  return (
    textOf(result)
      .replace(/^Failed to run flow:\s*/, '')
      .trim() || '[maestro] command failed'
  );
}

/** The real, unedited record of one MCP round-trip: the command sent + Maestro's raw response. */
function formatMcpLog(commandYaml: string, result: McpToolResult): string {
  return [
    'Command sent to `maestro mcp`:',
    commandYaml.trim(),
    '',
    `Result: ${result.isError ? 'ERROR' : 'OK'}`,
    textOf(result).trim() || '(no response text)',
  ].join('\n');
}

/** A short step-title fragment for a selector (`"text"`, or the object's key value / JSON). */
function label(selector: MaestroSelector): string {
  if (typeof selector === 'string') {
    return `"${truncate(selector)}"`;
  }
  const value = selector.text ?? selector.id ?? selector.index;
  return value != null ? `"${truncate(String(value))}"` : json(selector);
}

/** Trim long values for readable step titles. */
function truncate(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
