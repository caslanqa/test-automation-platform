# Desktop Testing (Electron)

Desktop tests drive [Electron](https://www.electronjs.org/) apps through **Playwright's native
`_electron` engine** — no extra tool, no external server. It's the fifth engine alongside web, API,
the AI Judge, and mobile.

The key idea: an Electron window **is a Chromium page**, so Playwright returns it as a real `Page`.
Everything you already know from the web tests works unchanged — locators, `expect`, Page Object
Models — and, unlike the mobile engine, the **trace / screenshot / video evidence is genuine** (it's
a browser context under the hood), not empty. You can also judge a screenshot of the window with the
same multimodal `expectAi`.

```typescript
import { expect, test } from '@fixtures/desktopFixtures';

test.use({ desktop: { app: 'example' } });

test('the window renders and reacts to a click', async ({ window, electron }) => {
  await expect(window).toHaveTitle('Playwright AI Desktop Example'); // `window` is a Playwright Page
  await window.getByRole('button', { name: 'Greet' }).click();
  await expect(window.locator('#status')).toHaveText('Hello from Electron!');

  const isPackaged = await electron.app.evaluate(({ app }) => app.isPackaged); // main-process eval
  expect(isPackaged).toBe(false);
});
```

## How it fits together

```text
tests/desktop/*.desktop.ts        Playwright specs: test.use({ desktop }) + the `window` / `electron` fixtures
        │
fixtures/desktopFixtures.ts       `desktop` option + `electron` fixture (launch/teardown) + `window` Page
        │
desktop/core/ElectronSession.ts   Layer 1: _electron.launch(), real trace, failure screenshot, close
desktop/apps.ts                   the named app catalog (mirrors mobile/devices.ts)
desktop/example-app/              a tiny, build-free Electron app so the example runs out-of-box
```

- **Layer 1 — `ElectronSession`** (`desktop/core/`): launches the app with `_electron.launch`, starts a
  real Chromium trace over the Electron context, and on failure stops it into the report along with a
  final screenshot. One session per test.
- **The fixtures** (`fixtures/desktopFixtures.ts`): `test.use({ desktop: { app } })` selects the app;
  `window` is its first window as a `Page` (author exactly like a web test), and `electron` is the
  facade `{ app, window, screenshot(name) }` — `electron.app` is the `ElectronApplication` handle for
  main-process `evaluate` and multi-window access.
- **The specs** (`tests/desktop/*.desktop.ts`): read just like the UI tests, and are picked up only by
  the opt-in `desktop` project.

## Prerequisites

- **`electron`** installed as a devDependency (`npm i -D electron`). The scaffolder adds it
  automatically when you opt into desktop testing; the example app runs against this binary.
- **Linux / CI:** Electron needs a display. On headless Linux, wrap the run with `xvfb`:
  `xvfb-run -a npm run test:desktop`. macOS and Windows need nothing extra.

## Running

```bash
npm run test:desktop     # DESKTOP=1 playwright test --project=desktop
```

The `desktop` project is **opt-in and gated** exactly like mobile: it's registered only when
`tests/desktop` exists **and** `DESKTOP=1` (set by the script above), so a bare `npm test` stays
web + API only.

## Choosing the app

Apps live in **`desktop/apps.ts`** — the single place launch configs are defined:

```typescript
export const apps = {
  example: { main: 'desktop/example-app/main.cjs' },
  // Your app, unpackaged (an Electron main script, launched with the installed `electron`):
  myapp: { main: 'src/main.js' },
  // Or a packaged build (point at the platform executable):
  packaged: { executablePath: 'dist/mac/MyApp.app/Contents/MacOS/MyApp' },
} as const;
```

Select one per file/describe, or inline a config:

```typescript
test.use({ desktop: { app: 'myapp' } }); // catalogued app
test.use({ desktop: { main: 'src/main.js', args: ['--dev'] } }); // inline
test.use({ desktop: { executablePath: '/path/to/App' } }); // packaged build
```

The default (`DESKTOP_APP` in `env/environments.json`, shipped as `example`) is used when a test sets
no `desktop` option. `app` / `executablePath` / `main` may also come from that env var.

## Authoring

Because `window` is a `Page`, everything from the web layer applies — locators, auto-waiting
assertions, and Page Object Models:

```typescript
await window.getByLabel('Email').fill('you@example.com');
await window.getByRole('button', { name: 'Sign in' }).click();
await expect(window.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
```

Reach into the **main process** through the `electron.app` handle:

```typescript
const version = await electron.app.evaluate(({ app }) => app.getVersion());
```

Multiple windows: `electron.app.windows()` lists open windows, and `electron.app.waitForEvent('window')`
waits for a new one — each is a `Page`.

## AI-judging a desktop screen

Screenshot the window and hand it to the multimodal judge — the same rubric engine used for web and
mobile (see [AI_JUDGE.md](AI_JUDGE.md)):

```typescript
const shot = await electron.screenshot('dashboard');
await expectAi({ image: shot, rubric: 'A dashboard with a sidebar and a chart.' }).toPassRubric({
  minScore: 70,
});
```

`electron.screenshot(name)` writes the PNG to the test's output dir, attaches it to the report, and
returns the path. The AI-judge spec (`tests/desktop/ai-judge.desktop.ts`) skips cleanly when no
vision-capable provider is configured.

## Report evidence

On failure the fixture attaches a **real** Playwright trace (open it with the "View trace" button in
the HTML report, or `npx playwright show-trace`) and a final screenshot of the window — the same
first-class artifacts you get from a web test. On success nothing is attached.

## Native (non-Electron) desktop apps

This layer covers **Electron**, where the window is a real Playwright `Page`. For native OS apps
(Win32/WPF/WinUI, macOS AppKit) — which Playwright can't drive — use the separate **[native testing
layer](NATIVE_TESTING.md)** (Appium via `appium-mac2-driver` / `appium-windows-driver`). It's heavier
and OS-locked, uses the WebDriver protocol rather than the Page API, and is a different engine with its
own imperative API — so pick by your app: **Electron → this layer; anything else → native.**
