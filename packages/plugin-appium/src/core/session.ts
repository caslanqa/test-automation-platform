import { remote } from 'webdriverio';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface AppiumSessionOptions {
  /** Appium server base URL, e.g. `http://127.0.0.1:4723`. */
  baseUrl: string;
  capabilities: Record<string, unknown>;
}

/** Open a raw WebdriverIO session against `baseUrl` with `capabilities`. */
export async function createSession(options: AppiumSessionOptions): Promise<WebdriverIO.Browser> {
  const url = new URL(options.baseUrl);
  const config = {
    protocol: url.protocol === 'https:' ? ('https' as const) : ('http' as const),
    hostname: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname || '/',
    capabilities: options.capabilities,
    logLevel: 'silent' as const,
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await remote(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = /UiAutomation not connected|instrumentation.*(?:not running|crashed)/i.test(
        message,
      );
      if (!transient || attempt >= 3) {
        throw error;
      }
      await sleep(attempt * 2_000);
    }
  }
}

/** Close the session — best-effort, never throws, never masks the real test result. */
export async function closeSession(browser: WebdriverIO.Browser | undefined): Promise<void> {
  if (!browser) {
    return;
  }
  try {
    await browser.deleteSession();
  } catch {
    /* best-effort */
  }
}
