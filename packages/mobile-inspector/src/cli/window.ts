/**
 * Opens the inspector in an app-mode Chromium window, using the browser Playwright already installed.
 *
 * This is what replaced Electron (architecture.md ADR-001). Playwright's own Inspector, UI mode and Trace
 * Viewer are all browser-hosted local web apps opened exactly this way — a persistent context launched with
 * `--app=`, which gives a frameless window with no tabs or address bar — so the inspector gets the same feel
 * for none of the 296 MB Electron cost. `@playwright/test` is a peer dependency, so this resolves to the
 * browser the host project already downloaded.
 *
 * The launch token reaches the service as an `x-inspector-token` header set on the browser context, which
 * covers the navigation and every subresource it makes. Deliberately not in the URL: a URL is printed, ends up
 * in terminal scrollback and screenshots, and would also sit in the page's own `location` and in the browser
 * profile. It is not passed as `--app=<url>` either — that would put it in the process command line, where
 * any other user on the machine could read it out of `ps` — which is why the window still opens on a blank
 * `data:` URL and navigates afterwards.
 */
import type { BrowserContext } from '@playwright/test';

const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;

export interface InspectorWindow {
  /** Resolves when the user closes the window. */
  closed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Launch the window, or return `undefined` when no browser is available — the caller then falls back to
 * printing the URL, which is a perfectly usable inspector, rather than failing the launch outright.
 */
export async function openInspectorWindow(
  /** The service origin, with no credential in it — see this module's note. */
  origin: string,
  /** The launch token, sent as a header rather than being put in `origin`. */
  token: string,
  onUnavailable: (reason: string) => void,
  /**
   * Called with a closable handle the moment the browser exists, before it is navigated. Launching takes
   * a second or two, and a Ctrl-C inside that window used to leave an orphaned Chromium behind because the
   * caller had nothing to close yet.
   */
  onLaunched?: (window: InspectorWindow) => void,
): Promise<InspectorWindow | undefined> {
  let context: BrowserContext;
  try {
    const { chromium } = await import('@playwright/test');
    context = await chromium.launchPersistentContext('', {
      // An empty user-data dir means a throwaway profile, so the window never inherits or leaves state.
      headless: false,
      // Every request this context makes — the navigation, the assets, the event stream, each frame — carries
      // the launch token, so the URL never has to.
      extraHTTPHeaders: { 'x-inspector-token': token },
      // Without this the window wears Chromium's "controlled by automated software" infobar.
      ignoreDefaultArgs: ['--enable-automation'],
      // The window IS the viewport; a fixed one would letterbox the UI.
      viewport: null,
      args: [
        '--app=data:text/html,',
        `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
        '--test-type=', // suppresses the remaining automation warnings
      ],
    });
  } catch (error) {
    onUnavailable(
      `${error instanceof Error ? error.message : String(error)}\n` +
        'Install the browser with `npx playwright install chromium`, or open the URL below yourself.',
    );
    return undefined;
  }

  const closed = new Promise<void>(resolve => context.once('close', () => resolve()));
  const window: InspectorWindow = {
    closed,
    close: async () => {
      await context.close().catch(() => undefined);
    },
  };
  onLaunched?.(window);

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(origin);
  } catch (error) {
    // The browser went away mid-setup: a signal during launch, or the user closing the window at once.
    // Reported, not thrown — an unhandled rejection here used to crash the CLI before it could release the
    // device lock or delete its temp files, which is exactly the teardown ADR-011 requires.
    await window.close();
    onUnavailable(
      `${error instanceof Error ? error.message : String(error)}\nOpen the URL below yourself.`,
    );
    return undefined;
  }
  return window;
}
