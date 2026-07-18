import fs from 'fs';
import path from 'path';

import type { TestInfo } from '@playwright/test';

import { apps, type NativeAppSpec } from '../apps';
import { nativeError } from './nativeError';
import type { NativeAppConfig, NativePlatform, NativeSelector } from './types';

/** How the fixture lets the session write evidence into the Playwright report. */
export interface NativeSessionHooks {
  /** Directory for this test's artifacts (screenshots, page source). */
  outputDir: string;
  /** Attach a file/body to the report, bound to the current step (usually `testInfo.attach`). */
  report(
    name: string,
    attachment: { path?: string; body?: Buffer | string; contentType: string }
  ): Promise<void>;
}

// ── Minimal structural typing of the slice of webdriverio we use ──────────────────────────────────
// webdriverio is a devDependency of the GENERATED project only (the scaffolder injects it when the
// native module is opted in), never of this repo — so we must NOT `import` it at compile time: that
// would make this repo's own `tsc` depend on an uninstalled package AND leak it into every scaffold
// (baseDevDependencies is read from this repo's package.json). Instead we load it at runtime via a
// dynamic import whose specifier is widened to `string` (so TS types it as `any` and never resolves
// the module), and type the tiny surface we touch ourselves. Same spirit as the Electron engine,
// which avoids a hard `electron` dep by importing only Playwright's `_electron`.
interface NativeElement {
  click(): Promise<void>;
  setValue(value: string): Promise<void>;
  addValue(value: string): Promise<void>;
  clearValue(): Promise<void>;
  getText(): Promise<string>;
  waitForDisplayed(options?: { timeout?: number; reverse?: boolean }): Promise<boolean>;
}

/** The webdriverio session surface this engine relies on (see the note above). */
export interface NativeDriver {
  $(selector: string): NativeElement;
  takeScreenshot(): Promise<string>;
  getPageSource(): Promise<string>;
  deleteSession(): Promise<void>;
  execute<T = unknown>(script: string, ...args: unknown[]): Promise<T>;
  pause(ms: number): Promise<void>;
}

interface RemoteOptions {
  hostname: string;
  port: number;
  path: string;
  logLevel: string;
  capabilities: Record<string, unknown>;
}
type RemoteFn = (options: RemoteOptions) => Promise<NativeDriver>;

/** Resolve a {@link NativeSelector} to a webdriverio selector string. */
function toWdioSelector(selector: NativeSelector): string {
  if (typeof selector === 'string') {
    return selector;
  }
  if (selector.accessibilityId) {
    return `~${selector.accessibilityId}`;
  }
  if (selector.xpath) {
    return selector.xpath;
  }
  throw nativeError('[native] selector must set `accessibilityId` or `xpath` (or be a raw string)');
}

/**
 * Layer-1 native-desktop adapter: opens an Appium (WebDriver) session against a running Appium server
 * and drives a native OS app (macOS via the `mac2` driver, Windows via the `windows` driver). Unlike
 * the Electron engine the window is NOT a Playwright `Page`, so assertions use these imperative methods
 * plus `expectAi` on a screenshot; evidence (screenshot + page-source XML) is bridged into the report
 * on failure, like the mobile engine. One session per test.
 */
export class NativeSession {
  private driver?: NativeDriver;
  private platform: NativePlatform = 'mac';

  constructor(
    private readonly hooks: NativeSessionHooks,
    private readonly baseUrl: string
  ) {}

  /** The platform this session resolved to (after `launch`). */
  get platformName(): NativePlatform {
    return this.platform;
  }

  /** The raw webdriverio session — escape hatch for driver-specific commands. Throws if not launched. */
  requireDriver(): NativeDriver {
    if (!this.driver) {
      throw nativeError('[native] no active session — launch() was not called or it failed');
    }
    return this.driver;
  }

  /** Resolve the config to a platform + W3C capabilities for `remote()`. */
  private resolve(config: NativeAppConfig | undefined): {
    platform: NativePlatform;
    caps: Record<string, unknown>;
  } {
    const spec: NativeAppSpec | undefined = config?.app
      ? apps[config.app as keyof typeof apps]
      : undefined;
    if (config?.app && !spec) {
      throw nativeError(
        `[native] unknown app '${config.app}' — add it to native/apps.ts (known: ${Object.keys(apps).join(', ')})`
      );
    }
    const platform =
      config?.platform ??
      spec?.platform ??
      (process.env.NATIVE_PLATFORM as NativePlatform | undefined) ??
      'mac';
    const bundleId = config?.bundleId ?? spec?.bundleId;
    const appPath = config?.appPath ?? spec?.appPath;
    const windowsApp = config?.windowsApp ?? spec?.windowsApp ?? appPath;
    const args = config?.args ?? spec?.args;
    const env = { ...(spec?.env ?? {}), ...(config?.env ?? {}) };

    if (platform === 'windows') {
      if (!windowsApp) {
        throw nativeError(
          '[native] no Windows app to launch — set `windowsApp`/`appPath`, a catalog entry, or NATIVE_APP'
        );
      }
      return {
        platform,
        caps: {
          platformName: 'Windows',
          'appium:automationName': 'Windows',
          'appium:app': windowsApp,
          ...(args && args.length ? { 'appium:appArguments': args.join(' ') } : {}),
        },
      };
    }

    if (!bundleId && !appPath) {
      throw nativeError(
        '[native] no macOS app to launch — set `bundleId`/`appPath`, a catalog entry, or NATIVE_APP'
      );
    }
    return {
      platform,
      caps: {
        platformName: 'Mac',
        'appium:automationName': 'Mac2',
        ...(bundleId ? { 'appium:bundleId': bundleId } : {}),
        ...(appPath ? { 'appium:appPath': appPath } : {}),
        ...(args && args.length ? { 'appium:arguments': args } : {}),
        ...(Object.keys(env).length ? { 'appium:environment': env } : {}),
      },
    };
  }

  /** Open the Appium session (which launches the app), leaving the session ready for commands. */
  async launch(config: NativeAppConfig | undefined): Promise<void> {
    const { platform, caps } = this.resolve(config);
    this.platform = platform;

    // Runtime-load webdriverio (see the structural-typing note above). Widened specifier → no compile
    // dependency; resolved from the generated project's node_modules at run time.
    const wdioSpecifier = 'webdriverio' as string;
    let remote: RemoteFn;
    try {
      ({ remote } = (await import(wdioSpecifier)) as { remote: RemoteFn });
    } catch (error) {
      const detail = (error as Error).message;
      throw nativeError(
        `[native] failed to load webdriverio — is it installed? Run \`npm i -D webdriverio\`.\n${detail}`
      );
    }

    const url = new URL(this.baseUrl);
    try {
      this.driver = await remote({
        hostname: url.hostname,
        port: Number(url.port || 4723),
        path: url.pathname || '/',
        logLevel: 'error',
        capabilities: caps,
      });
    } catch (error) {
      const driver = platform === 'windows' ? 'windows' : 'mac2';
      const detail = (error as Error).message;
      throw nativeError(
        `[native] failed to start the Appium session — check the driver is installed ` +
          `(\`appium driver install ${driver}\`) and OS automation permissions are granted.\n${detail}`
      );
    }
  }

  private element(selector: NativeSelector): NativeElement {
    return this.requireDriver().$(toWdioSelector(selector));
  }

  /** Click/press an element. */
  async click(selector: NativeSelector): Promise<void> {
    await this.element(selector).click();
  }

  /** Replace an editable element's value with `text`. */
  async setValue(selector: NativeSelector, text: string): Promise<void> {
    await this.element(selector).setValue(text);
  }

  /** Append `text` to an editable element. */
  async addValue(selector: NativeSelector, text: string): Promise<void> {
    await this.element(selector).addValue(text);
  }

  /** Clear an editable element. */
  async clear(selector: NativeSelector): Promise<void> {
    await this.element(selector).clearValue();
  }

  /** Read an element's text. */
  async getText(selector: NativeSelector): Promise<string> {
    return this.element(selector).getText();
  }

  /** Whether an element becomes displayed within `timeout` ms (default 2000) — never throws (branching). */
  async isVisible(selector: NativeSelector, options?: { timeout?: number }): Promise<boolean> {
    try {
      return await this.element(selector).waitForDisplayed({ timeout: options?.timeout ?? 2000 });
    } catch {
      return false;
    }
  }

  /** Assert an element is displayed within `timeout` ms (default 5000). */
  async assertVisible(selector: NativeSelector, options?: { timeout?: number }): Promise<void> {
    try {
      await this.element(selector).waitForDisplayed({ timeout: options?.timeout ?? 5000 });
    } catch {
      throw nativeError(`[native] expected element to be visible: ${JSON.stringify(selector)}`);
    }
  }

  /** Assert an element is NOT displayed within `timeout` ms (default 5000). */
  async assertNotVisible(selector: NativeSelector, options?: { timeout?: number }): Promise<void> {
    try {
      await this.element(selector).waitForDisplayed({
        timeout: options?.timeout ?? 5000,
        reverse: true,
      });
    } catch {
      throw nativeError(`[native] expected element to NOT be visible: ${JSON.stringify(selector)}`);
    }
  }

  /** Screenshot the app, write the PNG to the output dir, attach it, and return the file path. */
  async takeScreenshot(name: string): Promise<string> {
    const base64 = await this.requireDriver().takeScreenshot();
    const file = path.join(this.hooks.outputDir, `${name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    await this.hooks.report(name, { path: file, contentType: 'image/png' });
    return file;
  }

  /** The current UI tree as the driver's page-source XML (for branching / evidence). */
  async source(): Promise<string> {
    return this.requireDriver().getPageSource();
  }

  /** Run a driver command (escape hatch, e.g. `execute('macos: appleScript', { command })`). */
  async execute(script: string, ...args: unknown[]): Promise<unknown> {
    return this.requireDriver().execute(script, ...args);
  }

  /**
   * Tear down: on failure attach a final screenshot + the page-source XML; always delete the Appium
   * session. Safe to call more than once.
   */
  async close(testInfo: TestInfo): Promise<void> {
    if (!this.driver) {
      return;
    }
    const failed = testInfo.status !== testInfo.expectedStatus;
    try {
      if (failed) {
        try {
          const base64 = await this.driver.takeScreenshot();
          const shot = path.join(this.hooks.outputDir, 'failure.png');
          fs.writeFileSync(shot, Buffer.from(base64, 'base64'));
          await this.hooks.report('failure', { path: shot, contentType: 'image/png' });
        } catch {
          // The window may already be gone on a crash — failure evidence is best-effort.
        }
        try {
          const xml = await this.driver.getPageSource();
          await this.hooks.report('source', { body: xml, contentType: 'text/plain' });
        } catch {
          // best-effort
        }
      }
    } finally {
      try {
        await this.driver.deleteSession();
      } catch {
        // The session may have ended already.
      }
      this.driver = undefined;
    }
  }
}
