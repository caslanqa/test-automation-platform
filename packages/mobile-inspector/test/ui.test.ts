/**
 * The layer the test strategy was missing: the real UI, in a real browser, driving the real service.
 *
 * Both defects reported from a live installation lived exactly here and nothing in this suite could see
 * them — the service tests speak the protocol correctly by construction, and the engine tests never load a
 * page. A recorder is a browser application; the browser has to be in the loop somewhere.
 *
 * No device is needed: the fake driver supplies the screens, and every property asserted here is about the
 * seam between the page and the service. Skips (loudly) when the UI bundle has not been built or no Chromium
 * is installed, which is also why CI does both before running this.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Browser, Page } from '@playwright/test';

import { startInspectorService, type InspectorServiceHandle } from '../src/service/server.js';
import { fakeDriverMap, type FakeDriver } from './fakes/fakeDriver.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_BUNDLE = path.join(PACKAGE_ROOT, 'ui-dist', 'index.html');
/** Centre of the fake login button as a fraction of its 400x800 screen. */
const LOGIN_BUTTON = { fx: 0.5, fy: 230 / 800 };

const open: Array<{ browser: Browser; service: InspectorServiceHandle; dir: string }> = [];
after(async () => {
  for (const { browser, service, dir } of open) {
    await browser.close().catch(() => undefined);
    await service.close().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  service: InspectorServiceHandle;
  browser: Browser;
  driver: FakeDriver;
  /** A page attached to the service, already showing the UI. */
  view: () => Promise<Page>;
}

/** A service with the fake driver plus a browser, or `undefined` when this machine cannot run the UI. */
async function harness(): Promise<Harness | undefined> {
  if (!fs.existsSync(UI_BUNDLE)) {
    return undefined;
  }
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch().catch(() => undefined);
  if (!browser) {
    return undefined;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-ui-'));
  const { map, driver } = fakeDriverMap();
  const service = await startInspectorService({
    projectRoot: dir,
    drivers: map,
    skipInstanceLock: true,
  });
  open.push({ browser, service, dir });
  return {
    service,
    browser,
    driver,
    view: async () => {
      const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
      await page.goto(service.url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.app', { timeout: 20_000 });
      return page;
    },
  };
}

/**
 * Connect the fake driver through the drawer, exactly as a user does — including PICKING THE DEVICE from
 * the list rather than leaving it on "first booted", because the device the picker sends is the whole
 * subject of one of these tests.
 */
async function connect(page: Page): Promise<void> {
  // A second option in the driver select means the list arrived, which only happens over the event
  // stream — so this also proves the stream is live. Waited for with locators rather than `evaluate`:
  // this project deliberately has no DOM types, and it reads better anyway.
  // `attached`, not the default `visible`: an <option> is never "visible" to Playwright.
  const drivers = page.locator('.drawer select').first();
  await drivers.locator('option').nth(1).waitFor({ state: 'attached', timeout: 20_000 });
  await drivers.selectOption('fake');
  const devices = page.locator('.drawer select').nth(2);
  await devices.locator('option').nth(1).waitFor({ state: 'attached', timeout: 20_000 });
  // The AVD name, not the `adb` serial: the picker offers the handle that survives a reboot, which is also
  // the one a generated test can still resolve days later (ADR-003).
  await devices.selectOption('Pixel_7_API_34');
  await page.locator('.drawer-footer .btn-primary').click();
  await page.waitForSelector('.device-viewport-frame img', { timeout: 30_000 });
}

/** Wait until the timeline tab reports exactly `count` recorded actions. */
async function waitForTimeline(page: Page, count: number): Promise<void> {
  await page
    .locator('.bottom-tabs .tab', { hasText: `Timeline (${count})` })
    .waitFor({ timeout: 20_000 });
}

const timeline = async (page: Page): Promise<number> =>
  Number(/\((\d+)\)/.exec(await page.locator('.bottom-tabs .tab').first().innerText())?.[1] ?? -1);

/**
 * Poll a condition about the SERVICE side (the fake driver), which Playwright's own waiting cannot see.
 * Fails by name rather than hanging until the test timeout, where the reason would be lost.
 */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * Click the fake login button on the device image.
 *
 * `record` holds ⌘/Ctrl, which is what turns an interaction into a test step (§9): the viewport drives the
 * device by default, because it is also how the user reaches the screen they came to record.
 */
async function tapDevice(page: Page, dy = 0, options: { record?: boolean } = {}): Promise<void> {
  const image = page.locator('.device-viewport-frame img');
  const box = await image.boundingBox();
  assert.ok(box, 'the device image should be laid out');
  await image.click({
    position: { x: box.width * LOGIN_BUTTON.fx, y: box.height * LOGIN_BUTTON.fy + dy },
    modifiers: options.record ? ['ControlOrMeta'] : [],
  });
}

test('the window authenticates with a header, so the address carries no token', async t => {
  const h = await harness();
  if (!h) {
    t.skip('needs a built ui-dist and an installed Chromium');
    return;
  }
  // Exactly what `bin/inspect.mjs` does: the token goes on the browser context, and the page is navigated to
  // the bare origin. The whole app has to come up from that — the document, the bundle, the event stream and
  // every frame — because none of those requests can fall back to a query token that is not there.
  const context = await h.browser.newContext({
    viewport: { width: 1200, height: 800 },
    extraHTTPHeaders: { 'x-inspector-token': h.service.token },
  });
  const page = await context.newPage();
  const origin = new URL(h.service.url).origin;
  const response = await page.goto(origin, { waitUntil: 'domcontentloaded' });

  assert.equal(response?.status(), 200, 'the navigation itself must be authorised by the header');
  assert.doesNotMatch(
    page.url(),
    /token=/,
    'no credential in what the window shows as its address',
  );
  await page.waitForSelector('.app', { timeout: 20_000 });
  // The driver list only ever arrives over the event stream, so seeing it proves /events and /command were
  // authorised by the header too.
  await page
    .locator('.drawer select')
    .first()
    .locator('option')
    .nth(1)
    .waitFor({ state: 'attached', timeout: 20_000 });
  await context.close();
});

test('the device picker shows names, not UDIDs, and still tells same-named simulators apart', async t => {
  const h = await harness();
  if (!h) {
    t.skip('needs a built ui-dist and an installed Chromium');
    return;
  }
  const page = await h.view();
  const drivers = page.locator('.drawer select').first();
  await drivers.locator('option').nth(1).waitFor({ state: 'attached', timeout: 20_000 });
  await drivers.selectOption('fake');
  await page.locator('.drawer select').nth(1).selectOption('ios');

  const options = page.locator('.drawer select').nth(2).locator('option');
  await options.nth(1).waitFor({ state: 'attached', timeout: 20_000 });
  const labels = await options.allInnerTexts();
  const values = await options.evaluateAll(nodes =>
    nodes.map(node => (node as { value: string }).value),
  );

  // The regression this guards: iOS pins the UDID, the label was built from that handle, and every simulator
  // row became a UUID with no name in it — leaving nothing to pick by.
  const simulators = labels.slice(1);
  assert.ok(
    simulators.every(label => label.startsWith('iPhone 16 Pro')),
    `every row must lead with the device name; saw ${JSON.stringify(simulators)}`,
  );
  assert.ok(
    !simulators.some(label => label.includes('69F9D9B8-CBAA-4D98-94CB-2B91B4EA4BD2')),
    'a full UDID is unreadable in a dropdown, so only a prefix belongs there',
  );
  assert.equal(
    new Set(simulators).size,
    2,
    'two same-named simulators must still be distinguishable',
  );
  assert.ok(simulators[0].includes('booted'), 'and the running one comes first');
  // The value is still the durable, unambiguous handle — only the label changed.
  assert.ok(
    values.includes('69F9D9B8-CBAA-4D98-94CB-2B91B4EA4BD2'),
    `the option value must stay the UDID; saw ${JSON.stringify(values)}`,
  );
  await page.close();
});

test('a reloaded page keeps recording', async t => {
  const h = await harness();
  if (!h) {
    t.skip('needs a built ui-dist and an installed Chromium');
    return;
  }
  const page = await h.view();
  await connect(page);
  await tapDevice(page, 0, { record: true });
  await waitForTimeline(page, 1);

  // Exactly what F5 does. The command sequence used to be launch-scoped, so every command from here on came
  // back `409 command 1 arrived after N` while frames kept arriving — the page looked alive and recorded
  // nothing. That is the defect users reported as taps that never became code.
  const refused: string[] = [];
  page.on('response', response => {
    if (response.url().includes('/command') && response.status() !== 202) {
      refused.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.device-viewport-frame img', { timeout: 30_000 });

  const before = await timeline(page);
  await tapDevice(page, 30, { record: true });
  await waitForTimeline(page, before + 1);

  assert.deepEqual(refused, [], 'a reloaded page must not have its commands refused');
  assert.equal(await timeline(page), before + 1, 'the recording continues after a reload');
  await page.close();
});

test('the picker connects by the durable handle, and that is what the test pins', async t => {
  const h = await harness();
  if (!h) {
    t.skip('needs a built ui-dist and an installed Chromium');
    return;
  }
  const page = await h.view();
  await connect(page);

  // Discovery reports a booted emulator BY SERIAL, and the picker used to forward that — correct today, gone
  // after a reboot, and only recoverable because the resolver mapped it back to the AVD name before codegen.
  // The AVD name addresses a live emulator just as well, so the picker sends it and the round trip is gone.
  // Either way the committed test must never contain the serial (ADR-003).
  assert.equal(
    h.driver.connects.at(-1)?.device,
    'Pixel_7_API_34',
    'the UI connects by the handle that survives a reboot',
  );
  const code = await page.locator('.cm-content').innerText();
  assert.match(code, /device: "Pixel_7_API_34"/, 'codegen must pin the durable AVD name');
  assert.doesNotMatch(
    code,
    /emulator-5554/,
    'an ephemeral serial must never reach a committed test',
  );
  await page.close();
});

test('an action the driver refuses is stated on screen, not just logged', async t => {
  const h = await harness();
  if (!h) {
    t.skip('needs a built ui-dist and an installed Chromium');
    return;
  }
  const page = await h.view();
  await connect(page);
  const session = h.driver.session;
  assert.ok(session, 'connect should have handed out a session');
  session.failNextAction = 'element went away';

  await tapDevice(page, 0, { record: true });

  // A refused action is deliberately not recorded, so without this the user sees a click that did nothing
  // and the reason lives only in a log tab they have to know to open.
  const banner = page.locator('.banner-failure');
  await banner.waitFor({ timeout: 20_000 });
  assert.match(await banner.innerText(), /element went away/);
  assert.equal(await banner.getAttribute('role'), 'alert', 'it must be announced, not just drawn');
  assert.equal(await timeline(page), 0, 'and nothing may be recorded');
  await page.close();
});

test('a plain click drives the device without recording; ⌘/Ctrl+click records', async t => {
  const h = await harness();
  if (!h) {
    t.skip('needs a built ui-dist and an installed Chromium');
    return;
  }
  const page = await h.view();
  await connect(page);

  // Reaching the screen you came to record is done with the same clicks as recording it, so recording every
  // click meant deleting the journey afterwards. A plain click must still DRIVE the device, though — the
  // point is not to disable it.
  await tapDevice(page);
  await eventually(
    () => h.driver.session?.performed.length === 1,
    'the plain click to reach the driver',
  );
  assert.equal(h.driver.session?.performed.length, 1, 'a plain click still taps the device');
  assert.equal(await timeline(page), 0, 'and it must not become a test step');

  await tapDevice(page, 0, { record: true });
  await waitForTimeline(page, 1);
  assert.equal(h.driver.session?.performed.length, 2, 'the recorded click taps the device too');

  // The mode toggle is the keyboard-reachable equivalent: with it on, a plain click records.
  await page.locator('.pane-left .panel-title-actions button').click();
  await tapDevice(page, 30);
  await waitForTimeline(page, 2);
  await page.close();
});

test('a recorded step remembers the screen it produced', async t => {
  const h = await harness();
  if (!h) {
    t.skip('needs a built ui-dist and an installed Chromium');
    return;
  }
  const page = await h.view();
  await connect(page);
  await tapDevice(page, 0, { record: true });
  await waitForTimeline(page, 1);

  // Clicking the step shows the screen as it was once that step had run, and freezes the viewport while it
  // does: a click translated against a screen the device has left would land on whatever now occupies it.
  const step = page.locator('.timeline-step').first();
  await step.click();
  const banner = page.locator('.viewport-pinned');
  await banner.waitFor({ timeout: 20_000 });
  assert.match(await banner.innerText(), /step 1/);

  const performedWhilePinned = h.driver.session?.performed.length ?? 0;
  await tapDevice(page);
  assert.equal(
    h.driver.session?.performed.length,
    performedWhilePinned,
    'a pinned step is read-only — clicking it must not drive the device',
  );

  await page.locator('.timeline-toolbar .btn-primary').click();
  assert.equal(await banner.count(), 0, 'and "back to live" releases it');
  await page.close();
});

test('a second view takes over, and the displaced one says so and can take it back', async t => {
  const h = await harness();
  if (!h) {
    t.skip('needs a built ui-dist and an installed Chromium');
    return;
  }
  const first = await h.view();
  await connect(first);

  const second = await h.view();

  // Refusing the newcomer was the wrong end to cut: `mobile-inspect` opens a window AND prints the URL, and
  // an EventSource that receives a non-200 never retries, so opening that URL produced a permanently deaf
  // page. The session belongs to the launch (ADR-011), so the newest view wins.
  await first.locator('.banner-displaced').waitFor({ timeout: 20_000 });
  assert.equal(
    await first.locator('.banner-displaced .btn').count(),
    1,
    'it must offer a way back',
  );
  await second.waitForSelector('.device-viewport-frame img', { timeout: 30_000 });

  await first.locator('.banner-displaced .btn').click();
  await first.waitForSelector('.device-viewport-frame img', { timeout: 30_000 });
  await second.locator('.banner-displaced').waitFor({ timeout: 20_000 });
  // The displaced client closes its own stream; a server-side close alone reads as a retryable drop and the
  // two views would displace each other forever.
  await first.waitForTimeout(1500);
  assert.equal(
    await first.locator('.banner-displaced').count(),
    0,
    'no ping-pong between the two views',
  );
  await first.close();
  await second.close();
});
