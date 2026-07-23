import { remote } from 'webdriverio';

export interface AppiumSessionOptions {
  /** Appium server base URL, e.g. `http://127.0.0.1:4723`. */
  baseUrl: string;
  capabilities: Record<string, unknown>;
}

/** Open a raw WebdriverIO session against `baseUrl` with `capabilities`. */
export async function createSession(options: AppiumSessionOptions): Promise<WebdriverIO.Browser> {
  const url = new URL(options.baseUrl);
  return remote({
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    hostname: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname || '/',
    capabilities: options.capabilities,
    logLevel: 'silent',
  });
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
