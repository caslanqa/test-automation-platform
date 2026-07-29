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
  await devices.selectOption('emulator-5554');
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

/** Click the fake login button on the device image. */
async function tapDevice(page: Page, dy = 0): Promise<void> {
  const box = await page.locator('.device-viewport-frame img').boundingBox();
  assert.ok(box, 'the device image should be laid out');
  await page.mouse.click(
    box.x + box.width * LOGIN_BUTTON.fx,
    box.y + box.height * LOGIN_BUTTON.fy + dy,
  );
}

test('a reloaded page keeps recording', async t => {
  const h = await harness();
  if (!h) {
    t.skip('needs a built ui-dist and an installed Chromium');
    return;
  }
  const page = await h.view();
  await connect(page);
  await tapDevice(page);
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
  await tapDevice(page, 30);
  await waitForTimeline(page, before + 1);

  assert.deepEqual(refused, [], 'a reloaded page must not have its commands refused');
  assert.equal(await timeline(page), before + 1, 'the recording continues after a reload');
  await page.close();
});

test('the recorded test pins the AVD name even though the picker connects by serial', async t => {
  const h = await harness();
  if (!h) {
    t.skip('needs a built ui-dist and an installed Chromium');
    return;
  }
  const page = await h.view();
  await connect(page);

  // The picker sends `device.id` — the adb serial — because that is the only handle that addresses a LIVE
  // emulator. The serial must still be resolved back to the AVD name before codegen, or the generated test
  // fails with "no android device available" as soon as that emulator instance is gone (ADR-003).
  assert.equal(h.driver.connects.at(-1)?.device, 'emulator-5554', 'the UI connects by serial');
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

  await tapDevice(page);

  // A refused action is deliberately not recorded, so without this the user sees a click that did nothing
  // and the reason lives only in a log tab they have to know to open.
  const banner = page.locator('.banner-failure');
  await banner.waitFor({ timeout: 20_000 });
  assert.match(await banner.innerText(), /element went away/);
  assert.equal(await banner.getAttribute('role'), 'alert', 'it must be announced, not just drawn');
  assert.equal(await timeline(page), 0, 'and nothing may be recorded');
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
