# Native Desktop Testing (Appium)

Native desktop tests drive **non-Electron OS apps** — macOS AppKit apps and Windows Win32/WPF/WinUI
apps — through [Appium](https://appium.io). It's the sixth engine alongside web, API, the AI Judge,
mobile, and Electron desktop.

> **Electron vs native.** If your app is **Electron**, use the [Electron layer](DESKTOP_TESTING.md)
> instead — its window is a real Playwright `Page`, so web POMs / `expect` / trace all work and the
> evidence is a genuine browser trace. This native layer is for apps Playwright **cannot** drive.

The key difference: Appium speaks the **WebDriver** protocol against a running **Appium server**, so a
window is a `webdriverio` session — **not** a Playwright `Page`. Playwright's `expect(locator)` and
trace do not apply. This engine therefore reads like the **mobile (Maestro)** engine: an imperative
command surface, screenshot + page-source evidence attached on failure, `test.skip` (not fail) when
the toolchain is missing, and the same multimodal `expectAi` fed a screenshot.

```typescript
import { expect, test } from '@fixtures/nativeFixtures';

test.use({ native: { app: 'textEdit' } }); // a catalog entry (native/apps.ts)

test('the app launches', async ({ app }) => {
  const source = await app.source(); // the accessibility/UI tree (XML)
  expect(source).toContain('XCUIElementType');

  await app.assertVisible({ xpath: '//XCUIElementTypeWindow' });
  const shot = await app.takeScreenshot('home'); // real screenshot → also feeds expectAi
});
```

## How it fits together

```text
tests/native/*.native.ts        Playwright specs: test.use({ native }) + the `app` fixture
        │
fixtures/nativeFixtures.ts       `native` option + `app` fixture (server → launch → teardown)
        │
native/core/NativeSession.ts     Layer 1: webdriverio remote() session, screenshot/source, evidence
native/core/appiumServer.ts      ensures a reachable Appium server (auto-starts a local one)
native/apps.ts                   the named app catalog (mirrors desktop/apps.ts)
```

- **Layer 1 — `NativeSession`** (`native/core/`): opens an Appium session via webdriverio's `remote()`,
  exposes imperative commands (`click`, `setValue`, `isVisible`, `assertVisible`, `takeScreenshot`,
  `source`, `execute`), and on failure attaches a screenshot + page-source XML. One session per test.
- **`appiumServer.ts`**: probes `NATIVE_SERVER_URL` (default `http://127.0.0.1:4723`); if nothing
  answers and the target is local, it best-effort starts the project's `appium` bin and reuses it for
  the run. If neither works, the test **skips**.
- **The fixtures** (`fixtures/nativeFixtures.ts`): `test.use({ native: { app } })` selects the app;
  `app` is the imperative facade (plus `app.raw` — the raw webdriverio session — as an escape hatch).

## Prerequisites

Native automation is **OS-locked** and needs a real desktop session (no headless).

- **`appium` + `webdriverio`** as devDependencies — the scaffolder adds them when you opt into native
  testing.
- **The platform driver**, installed into Appium once:

  ```bash
  npx appium driver install mac2       # macOS
  npx appium driver install windows    # Windows
  ```

- **macOS:** Xcode + its command-line tools, and **Accessibility permission** for the process running
  the tests (System Settings → Privacy & Security → Accessibility → enable your terminal / IDE).
  Without it the session can't see the UI.
- **Windows:** [WinAppDriver](https://github.com/microsoft/WinAppDriver/releases) installed, and
  **Developer Mode** enabled (Settings → Privacy & security → For developers).

You don't have to start Appium yourself — the fixture auto-starts a local one — but running `appium`
in a separate terminal is faster for iterative work (it's then reused).

## Running

```bash
npm run test:native      # NATIVE=1 playwright test --project=native --workers=1
```

The `native` project is **opt-in and gated** exactly like mobile/desktop: registered only when
`tests/native` exists **and** `NATIVE=1`, so a bare `npm test` stays web + API only. Runs serially by
default (one Appium session at a time).

If no Appium server/driver is available, the tests **skip with a clear message** rather than fail — so
the suite stays green on machines without the toolchain.

## Choosing the app

Apps live in **`native/apps.ts`** — the single place launch configs are defined:

```typescript
export const apps = {
  textEdit: { platform: 'mac', bundleId: 'com.apple.TextEdit' },
  notepad: { platform: 'windows', appPath: 'C:/Windows/System32/notepad.exe' },
  // Your macOS app (bundle id or a .app path):
  myMacApp: { platform: 'mac', bundleId: 'com.acme.MyApp' },
  // Your Windows app (an .exe path, or an AUMID):
  myWinApp: { platform: 'windows', appPath: 'C:/Program Files/Acme/MyApp.exe' },
} as const;
```

Select one per file/describe, or inline a config:

```typescript
test.use({ native: { app: 'myMacApp' } });                      // catalogued app
test.use({ native: { platform: 'mac', bundleId: 'com.acme.MyApp' } }); // inline (macOS)
test.use({ native: { platform: 'windows', appPath: 'C:/…/MyApp.exe' } }); // inline (Windows)
```

`app` / `platform` also fall back to the `NATIVE_APP` / `NATIVE_PLATFORM` env vars
(`env/environments.json`). Point at a remote Appium server with `serverUrl` or `NATIVE_SERVER_URL`.

## Authoring

The window is **not** a Playwright `Page`, so use the `app` fixture's imperative methods. Selectors are
either a structured object — `{ accessibilityId }` (→ `~id`) or `{ xpath }` — or a raw webdriverio
selector string for any other strategy:

```typescript
await app.assertVisible({ accessibilityId: 'loginButton' });
await app.setValue({ xpath: '//XCUIElementTypeTextField[1]' }, 'you@example.com');
await app.click({ accessibilityId: 'loginButton' });
const status = await app.getText({ accessibilityId: 'statusLabel' });

if (await app.isVisible({ accessibilityId: 'welcome' }, { timeout: 3000 })) {
  // branch on the live UI
}
```

Inspect the live UI tree with `await app.source()` (the driver's page-source XML) to find selectors.
For anything the facade doesn't cover, drop to the raw session: `await app.raw.$('~id').doubleClick()`,
or run a driver script: `await app.execute('macos: appleScript', { command: '…' })`.

## AI-judging a native screen

Screenshot the app and hand it to the multimodal judge — the same rubric engine used for web, mobile,
and Electron (see [AI_JUDGE.md](AI_JUDGE.md)):

```typescript
const shot = await app.takeScreenshot('dashboard');
await expectAi({ image: shot, rubric: 'A dashboard with a sidebar and a chart.' }).toPassRubric({
  minScore: 70,
});
```

`app.takeScreenshot(name)` writes the PNG to the test's output dir, attaches it, and returns the path.
The AI-judge spec (`tests/native/ai-judge.native.ts`) skips cleanly when no vision-capable provider is
configured.

## Report evidence

On failure the fixture attaches a **real** screenshot of the app plus its page-source XML (bound to the
failing step). There is no Playwright trace for a native app (it isn't a browser context) — the
screenshot + source are the evidence, exactly like the mobile engine.

## Windows notes

The Windows path (`windows` driver + WinAppDriver) shares the same `NativeSession` and `app` fixture —
only the capabilities differ. The `notepad` example runs only on Windows (the `textEdit` example only
on macOS); each skips on the other OS. Verify the Windows path on a Windows machine with WinAppDriver
installed and Developer Mode on.
