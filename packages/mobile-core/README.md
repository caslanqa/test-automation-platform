# @pwtap/mobile-core

Driver-neutral mobile contracts for the [Playwright Test Automation Platform](https://www.npmjs.com/package/@pwtap/create) — one `mobileApp` fixture that runs the same test body on Maestro or Appium.

[![npm](https://img.shields.io/npm/v/@pwtap/mobile-core)](https://www.npmjs.com/package/@pwtap/mobile-core)

This is the only mobile package a **test** loads at runtime. Its single dependency is [`@pwtap/platform`](https://www.npmjs.com/package/@pwtap/platform); the recorder that writes these tests is [`@pwtap/mobile-inspector`](https://www.npmjs.com/package/@pwtap/mobile-inspector) and is deliberately absent from this graph.

## Install

Installed for you with either driver plugin:

```bash
npx @pwtap/create add maestro   # or: add appium
```

## Write a test

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
  if (await mobileApp.isVisible({ text: 'Cookie banner' })) {
    await mobileApp.tap({ text: 'Accept' });
  }
});
```

Change `driver: 'maestro'` to `'appium'` and the body is unchanged. `mobileTarget` is a Playwright option, so it can be set per file, per `describe`, or in a project.

## The surface

`tap`, `doubleTap`, `fill`, `eraseText`, `hideKeyboard`, `longPress`, `swipe`, `scroll`, `scrollUntilVisible`, `drag`, `pinch`, `pressKey`, `back`, `waitFor`, `isVisible`, `screenshot`.

`isVisible` returns a boolean and never throws, so a test can branch on it — the assertions (`assertVisible` / `assertNotVisible`) are what fail. An action the connected driver cannot perform throws `UnsupportedActionError` naming the driver and the action, rather than failing somewhere inside an adapter.

## Locators

One driver-neutral shape, translated by each adapter:

```ts
{ accessibilityId: 'loginButton' }        // most durable
{ resourceId: 'com.example:id/email' }    // Android id / iOS identifier
{ text: 'Log in' }                        // exact text
{ text: 'Log in', index: 1 }              // nth match, 0-based — for a repeated list row
{ point: { x: 200, y: 230 } }             // last resort
```

`locatorCandidates()` ranks every option for an element with a confidence and warnings (non-unique match, element belongs to another app), which is what the inspector's right-click menu shows.

## When a mobile test fails

The `mobileApp` fixture captures the element tree into a `mobile-hierarchy` attachment — on failure, and
only on failure. A green run pays one comparison; a red one leaves the screen it failed on in the report,
where Playwright would have written an ARIA snapshot for a web test.

That attachment is also what lets [`@pwtap/plugin-heal`](https://www.npmjs.com/package/@pwtap/plugin-heal)
rank locator replacements after the run, with no device and no second connection.

## Driver adapters

A driver is a package exposing an `./inspector` export with a `driver` implementing `MobileInspectorDriver` and the contract version it was built against:

```ts
import type { AdapterContract, MobileInspectorDriver } from '@pwtap/mobile-core';

export const driver: MobileInspectorDriver = new MyDriver();
export const contract: AdapterContract = 1;
```

`discoverDrivers()` resolves the known adapter packages from the project's own `node_modules` — no filesystem scanning, no executing arbitrary packages. An adapter whose contract this core does not accept is skipped and reported with the package to upgrade, rather than loaded and left to fail later on a missing method.

The driver also declares how its tests are named and run (`testBinding`: file extension, Playwright project, gate variable), so adding a driver needs no change anywhere else.

## Device names

`resolveStableDeviceName()` decides what a generated test should pin. The handle a booted device reports is ephemeral (an adb serial, a simulator UDID for a device that may be recreated), so a test pins the durable name — the AVD name, the simulator name — and gets a warning when the name is ambiguous instead of a value that silently stops resolving.

## License

MIT
