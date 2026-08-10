# @pwtap/mobile-inspector

Mobile test recorder for the [Playwright Test Automation Platform](https://www.npmjs.com/package/@pwtap/create). Tap around a real device, get a Playwright test you can run and commit.

[![npm](https://img.shields.io/npm/v/@pwtap/mobile-inspector)](https://www.npmjs.com/package/@pwtap/mobile-inspector)

It is a **dev tool**: nothing here is loaded by a test at runtime. The contracts a generated test needs live in [`@pwtap/mobile-core`](https://www.npmjs.com/package/@pwtap/mobile-core), and the device work is done by whichever driver plugin you have installed — [`@pwtap/plugin-maestro`](https://www.npmjs.com/package/@pwtap/plugin-maestro) or [`@pwtap/plugin-appium`](https://www.npmjs.com/package/@pwtap/plugin-appium).

## Open it

```bash
npx mobile-inspect            # the current project
npx mobile-inspect ./my-app   # or a specific one
```

It prints a loopback URL and opens it in an app-mode window using the Chromium **Playwright already installed** — there is no Electron in the dependency graph. If no browser is available it just prints the URL, which is an equally usable inspector in any browser. One inspector per project: a second launch is refused and points at the first.

## Record a test

1. **Connection** → pick a driver, platform, device and app (installed apps are listed for the selected device; you can also point at a local `.apk`/`.app`/`.ipa`/`.zip` or an `https:` artifact URL).
2. **Tap the device screen to drive it; ⌘/Ctrl + tap to record the step.** Dragging works the same way — a plain drag swipes, a modifier-drag records the swipe. Getting to the screen you came to record takes the same clicks as recording it, so the two are separated: turn on **Record** in the Device panel if you want every interaction written down (the modifier then does the reverse for one gesture). Back / Home / Enter / Screenshot sit under the viewport, under the same rule.
3. **Right-click any element** for its attributes and its ranked locator alternatives, with Tap / Fill / Long press / Wait / Assert visible / Assert not visible / Is visible / Screenshot / AI assert, scrolling inside that element, copy-as-code and reveal-in-tree. Anything the connected driver cannot do is disabled with the reason, and a checkbox writes a step down without running it.
4. **The editor is yours.** Type in it and the recording splices new actions into what you wrote instead of overwriting it; completion offers `mobileApp`'s methods and locators for the elements on screen right now. Undo/redo work on the timeline, not just the text — and clicking a recorded step shows the screen it produced.
5. **Run** executes the draft through the project's own Playwright, in the driver's project with its gate variable set, and streams the output back.
6. **Save…** writes a new file (browse the project's real directories) or appends to an existing recording, merging imports and keeping the file's existing tests.

A recording is saved with its driver's extension — `*.maestro.ts` or `*.appium.ts` — because the extension is what decides which Playwright project collects the test, which env var gates it and which timeout applies. Saved into the wrong one, a test would silently never run; `git mv` to the other extension is all it takes to move it.

## What a generated test looks like

```ts
import { test, expect } from '@fixtures';

test.use({
  mobileTarget: {
    driver: 'maestro',
    platform: 'android',
    device: 'Pixel_7_API_34',
    appId: 'com.example.app',
  },
});

test('sign in', async ({ mobileApp }) => {
  await mobileApp.tap({ accessibilityId: 'emailField' });
  await mobileApp.fill({ accessibilityId: 'emailField' }, 'demo@example.com');
  await mobileApp.tap({ text: 'Log in' });
  await expect(mobileApp).toBeVisible({ text: 'Dashboard' });
});
```

Driver-neutral by construction: the same test body runs under either driver — `mobileTarget.driver` is the only thing that changes. The device is pinned by its **stable** name (an AVD name, a simulator name), never the ephemeral adb serial, so the test still finds the device after a reboot.

## Locators

Every element is offered as a ranked list rather than one guess, scored by how durable it is: accessibility id → resource id → exact text → index-qualified text → coordinates, with penalties for non-unique matches and for elements that belong to another app (a status bar, a system dialog). The confidence badge and the warnings are the point — a coordinate locator works today and breaks on the next layout change, and the UI says so instead of hiding it.

## Trust boundary

The service binds to loopback on a random port with a per-launch token, and treats the browser as untrusted even though it is local: every command is validated field by field, file writes and directory listings are confined to the project (by path segment, and following symlinks), the artifact path is validated before it reaches an installer, and runs are argv-only `spawn` with an explicit environment. Closing the window releases the device lock, kills any run and removes the temp files; merely losing the connection does not — reload the page and the recording is still there.

## Design

The decision record is [`docs/mobile-inspector/architecture.md`](https://github.com/caslanqa/test-automation-platform/blob/main/docs/mobile-inspector/architecture.md) in the repository: 14 ADRs covering the loopback-service host, the driver-neutral action IR, node identity, the capture schedule, the trust boundary and the dependency policy.

## License

MIT
