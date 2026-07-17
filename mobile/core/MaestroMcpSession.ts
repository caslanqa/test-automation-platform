import fs from 'fs';
import path from 'path';

import { androidEnv } from './android';
import { maestroError } from './maestroError';
import type { McpToolResult } from './McpClient';
import { McpClient } from './McpClient';
import { rowValue } from './screen';
import type { DiscoveredDevice, MaestroScreen, MaestroSelector } from './types';

/** How long to wait for a single streamed command; covers Maestro's ~17s element-lookup timeout. */
const COMMAND_TIMEOUT_MS = 60_000;
/** Default bound for `isVisible` — how long Maestro waits for the element before returning `false`. */
const DEFAULT_VISIBLE_TIMEOUT_MS = 2_000;
/** Cap for evidence-capture tool calls (screenshot/hierarchy) — best-effort, must not hang a run. */
const CAPTURE_TIMEOUT_MS = 30_000;

/** Cardinal directions for `scroll`/`swipe`, matching Maestro's enum. */
export type MaestroDirection = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

/**
 * When to capture a device screenshot + view hierarchy (Playwright's `screenshot` for native mobile):
 * - `off` — never (fastest).
 * - `only-on-failure` — the real screen + hierarchy at the point a command fails (default).
 * - `on` — additionally after every successful command → a step-by-step visual timeline in both the
 *   HTML report and the trace viewer (costs one screenshot per command).
 */
export type ScreenshotMode = 'off' | 'only-on-failure' | 'on';

/** Resolve the screenshot mode from `MOBILE_SCREENSHOT` (default `only-on-failure`). */
export function resolveScreenshotMode(): ScreenshotMode {
  const value = process.env.MOBILE_SCREENSHOT?.trim().toLowerCase();
  return value === 'on' || value === 'off' || value === 'only-on-failure'
    ? value
    : 'only-on-failure';
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
   * Attach a file to the CURRENT step (maps to `testInfo.attach`) — so a failure screenshot / the
   * per-step timeline shows in context, in both the HTML report and the trace viewer.
   */
  report: (name: string, attachment: { path: string; contentType: string }) => Promise<void>;
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
 * await maestro.inputText('cihan');
 * if (await maestro.isVisible('Cookie banner')) await maestro.tapOn('Accept');
 * await maestro.assertVisible('Dashboard');
 */
export class MaestroMcpSession {
  private client: McpClient | undefined;
  private appId: string | undefined;
  /** Counter for unique per-step screenshot names when the mode is `on`. */
  private shotCount = 0;

  /**
   * @param device The booted device this session drives.
   * @param hooks Report/attachment hooks from the fixture.
   * @param screenshotMode When to capture screenshots + hierarchy; defaults to `MOBILE_SCREENSHOT`.
   * @param binary Maestro executable; defaults to `MAESTRO_BIN` env or `maestro` on PATH.
   */
  constructor(
    private readonly device: DiscoveredDevice,
    private readonly hooks: McpSessionHooks,
    private readonly screenshotMode: ScreenshotMode = resolveScreenshotMode(),
    private readonly binary: string = process.env.MAESTRO_BIN ?? 'maestro'
  ) {}

  /** Spawn `maestro mcp` and complete the MCP handshake on first use; reused on later calls. */
  private async ensureClient(): Promise<McpClient> {
    if (!this.client) {
      // On Android, inject the SDK env so Maestro (which shells out to adb) finds the device.
      const env = this.device.platform === 'android' ? androidEnv() : process.env;
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
   * Launch the app under test and make it the target of subsequent commands. Must be called before
   * element commands (`tapOn`, `inputText`, …), which need the app id.
   */
  async launchApp(
    appId: string,
    options?: { clearState?: boolean; stopApp?: boolean }
  ): Promise<void> {
    return this.hooks.step(`launchApp "${appId}"`, async () => {
      this.appId = appId;
      await this.runCommand(
        `- launchApp: ${json(compact({ appId, clearState: options?.clearState, stopApp: options?.stopApp }))}`
      );
    });
  }

  // ----- interactions -----

  /** Tap an element. */
  async tapOn(selector: MaestroSelector): Promise<void> {
    return this.hooks.step(`tapOn ${label(selector)}`, () =>
      this.runCommand(`- tapOn: ${json(selector)}`)
    );
  }

  /** Double-tap an element. */
  async doubleTapOn(selector: MaestroSelector): Promise<void> {
    return this.hooks.step(`doubleTapOn ${label(selector)}`, () =>
      this.runCommand(`- doubleTapOn: ${json(selector)}`)
    );
  }

  /** Long-press an element. */
  async longPressOn(selector: MaestroSelector): Promise<void> {
    return this.hooks.step(`longPressOn ${label(selector)}`, () =>
      this.runCommand(`- longPressOn: ${json(selector)}`)
    );
  }

  /** Type text into the focused field. */
  async inputText(text: string): Promise<void> {
    return this.hooks.step(`inputText "${truncate(text)}"`, () =>
      this.runCommand(`- inputText: ${json(text)}`)
    );
  }

  /** Erase characters from the focused field (all, or the last `charactersToErase`). */
  async eraseText(charactersToErase?: number): Promise<void> {
    return this.hooks.step('eraseText', () =>
      this.runCommand(
        charactersToErase == null ? '- eraseText' : `- eraseText: ${charactersToErase}`
      )
    );
  }

  /** Press the system Back button (Android) / equivalent. */
  async back(): Promise<void> {
    return this.hooks.step('back', () => this.runCommand('- back'));
  }

  /** Press a hardware/system key (e.g. `Enter`, `Home`, `Back`, `Backspace`). */
  async pressKey(key: string): Promise<void> {
    return this.hooks.step(`pressKey ${key}`, () => this.runCommand(`- pressKey: ${json(key)}`));
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
    options?: { direction?: MaestroDirection }
  ): Promise<void> {
    const body = compact({ element: selector, direction: options?.direction });
    return this.hooks.step(`scrollUntilVisible ${label(selector)}`, () =>
      this.runCommand(`- scrollUntilVisible: ${json(body)}`)
    );
  }

  /** Swipe by direction, or between two `x%,y%` points. */
  async swipe(options: {
    direction?: MaestroDirection;
    start?: string;
    end?: string;
    duration?: number;
  }): Promise<void> {
    return this.hooks.step('swipe', () => this.runCommand(`- swipe: ${json(compact(options))}`));
  }

  /** Wait for on-screen animations to settle. */
  async waitForAnimationToEnd(): Promise<void> {
    return this.hooks.step('waitForAnimationToEnd', () =>
      this.runCommand('- waitForAnimationToEnd')
    );
  }

  // ----- assertions -----

  /** Assert an element is visible (fails the step if it isn't within Maestro's lookup timeout). */
  async assertVisible(selector: MaestroSelector): Promise<void> {
    return this.hooks.step(`assertVisible ${label(selector)}`, () =>
      this.runCommand(`- assertVisible: ${json(selector)}`)
    );
  }

  /** Assert an element is NOT visible. */
  async assertNotVisible(selector: MaestroSelector): Promise<void> {
    return this.hooks.step(`assertNotVisible ${label(selector)}`, () =>
      this.runCommand(`- assertNotVisible: ${json(selector)}`)
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
      const result = await this.runYaml(
        `- extendedWaitUntil: ${json(wait)}`,
        timeout + COMMAND_TIMEOUT_MS
      );
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
      rowValue(await this.fetchScreen(), label)
    );
  }

  /** Fetch + parse the current view hierarchy (no report step of its own). */
  private async fetchScreen(): Promise<MaestroScreen> {
    const client = await this.ensureClient();
    const result = await client.callTool('inspect_screen', { device_id: this.device.id });
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
   * `await expectAi({ image: await maestro.takeScreenshot('home'), rubric }).toPassRubric()`.
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

  // ----- internals -----

  /**
   * Run one command; throw a clean, frame-free error (the real Maestro reason) if it fails. On
   * failure it first captures the REAL screen + view hierarchy AT that point (unless mode is `off`)
   * so the report shows what was actually on screen, not a stale earlier capture. When the mode is
   * `on`, it also captures after a successful command to build a step-by-step visual timeline.
   */
  private async runCommand(commandYaml: string, timeoutMs?: number): Promise<void> {
    const result = await this.runYaml(commandYaml, timeoutMs);
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
        CAPTURE_TIMEOUT_MS
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
        CAPTURE_TIMEOUT_MS
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
    timeoutMs = COMMAND_TIMEOUT_MS
  ): Promise<McpToolResult> {
    if (!this.appId) {
      throw maestroError('[maestro] call maestro.launchApp(appId) before other commands');
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
    Object.entries(object).filter(([, value]) => value !== undefined)
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
