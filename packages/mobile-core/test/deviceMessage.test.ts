/**
 * What a test is told when the device it pins is not on this machine.
 *
 * A recording pins a device by name so it is reproducible (ADR-003), so the first thing that happens on
 * another laptop or in CI is that the name does not resolve. The adapters answered `no android device
 * available to connect the inspector to`, which named neither the device asked for nor the ones present, said
 * nothing about how to proceed, and mentioned the inspector during a plain test run.
 *
 * The device list is INJECTED here. It used to be forced empty by setting `PATH=/nonexistent`, which stubbed
 * nothing — the emulator is invoked by absolute path inside the Android SDK — so the branch actually under test
 * was whichever one the developer's machine produced. On a laptop with AVDs the message named them and the
 * assertions passed; in CI there are none, the other branch ran, and every run failed for a week.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deviceUnavailableMessage, type DeviceLister } from '../src/deviceMessage.js';
import { DeviceUnavailableError, type InspectorDevice } from '../src/types.js';

const lister =
  (...devices: InspectorDevice[]): DeviceLister =>
  () =>
    Promise.resolve(devices);

const android = (name: string, booted = false): InspectorDevice => ({
  id: name,
  name,
  platform: 'android',
  booted,
});

const NONE = lister();
const SOME = lister(android('pixel8'), android('pixel9b', true));

test('a device that was asked for is named, and so are the ones present', async () => {
  const message = await deviceUnavailableMessage('maestro', 'android', 'pixel9', SOME);

  assert.match(message, /"pixel9"/, 'the request must be quoted back');
  assert.match(message, /pixel8/, 'and what this machine has instead');
  assert.match(message, /pixel9b \(booted\)/, 'with the booted one marked, since it needs no boot');
  assert.match(message, /MOBILE_INSPECTOR_DEVICE/, 'and the override that avoids editing the test');
});

test('with nothing to point at, the advice is to create one rather than to override', async () => {
  const message = await deviceUnavailableMessage('maestro', 'android', 'pixel9', NONE);

  assert.match(message, /"pixel9"/, 'the request is still quoted back');
  assert.match(message, /no android devices at all/);
  assert.match(message, /avdmanager|Device Manager/, 'and how to create one');
  // Offering an override here would be advice that cannot work: there is no device for it to name.
  assert.doesNotMatch(message, /MOBILE_INSPECTOR_DEVICE/);
});

test('no branch mentions the inspector, since a plain test run produces this too', async () => {
  for (const devices of [NONE, SOME]) {
    for (const requested of ['pixel9', undefined]) {
      const message = await deviceUnavailableMessage('maestro', 'android', requested, devices);
      assert.doesNotMatch(message, /inspector to/, `leaked the inspector for ${requested}`);
    }
  }
});

test('the platform decides which tool the hint names', async () => {
  const message = await deviceUnavailableMessage('maestro', 'ios', 'iPhone 99', NONE);
  assert.match(message, /simctl|Xcode/);
  assert.doesNotMatch(message, /avdmanager/);
});

test('naming no device at all is a different problem, and says so', async () => {
  const message = await deviceUnavailableMessage('appium', 'android', undefined, NONE);

  assert.match(
    message,
    /none was named|has none/,
    'nothing to look for is not the same as not found',
  );
  assert.doesNotMatch(message, /"undefined"/, 'and must never quote a missing name back');
});

test('naming none while devices exist says which one to boot', async () => {
  const message = await deviceUnavailableMessage('appium', 'android', undefined, SOME);

  assert.match(message, /Boot one of/);
  assert.match(message, /pixel8/);
  assert.doesNotMatch(message, /"undefined"/);
});

test('the driver is named, since two of them can produce this', async () => {
  assert.match(await deviceUnavailableMessage('appium', 'android', 'x', NONE), /^\[appium\]/);
  assert.match(await deviceUnavailableMessage('maestro', 'android', 'x', NONE), /^\[maestro\]/);
});

test('a lister that throws still produces an answer', async () => {
  // Discovery shells out, and a diagnostic must not throw over a diagnostic.
  const broken: DeviceLister = () => Promise.reject(new Error('adb exploded'));
  const message = await deviceUnavailableMessage('maestro', 'android', 'pixel9', broken);

  assert.match(message, /"pixel9"/);
  assert.match(message, /avdmanager|Device Manager/, 'it falls back to the no-devices advice');
});

test('the environment overrides a pinned device, unlike the other options', async () => {
  // Deliberately the reverse of driver/platform: which driver and platform are under test is the test's own
  // meaning and must not be changed by an environment. A device name is a fact about one machine, and the
  // alternative to an override is editing every recorded test per machine.
  const { resolveDeviceForTest } = await import('../src/fixture.js');
  const original = process.env.MOBILE_INSPECTOR_DEVICE;
  try {
    process.env.MOBILE_INSPECTOR_DEVICE = 'pixel9';
    assert.equal(resolveDeviceForTest('pixel42'), 'pixel9', 'the machine wins over the pin');
    delete process.env.MOBILE_INSPECTOR_DEVICE;
    assert.equal(
      resolveDeviceForTest('pixel42'),
      'pixel42',
      'and the pin stands when it is not set',
    );
    process.env.MOBILE_INSPECTOR_DEVICE = '   ';
    assert.equal(resolveDeviceForTest('pixel42'), 'pixel42', 'blank is not an override');
  } finally {
    if (original === undefined) delete process.env.MOBILE_INSPECTOR_DEVICE;
    else process.env.MOBILE_INSPECTOR_DEVICE = original;
  }
});

test('the unavailable-device failure carries its own type, because the caller reacts differently', async () => {
  // The `mobileApp` fixture skips on this and fails on everything else: a device that is not on this machine
  // is a fact about the machine (a recording pins one by name, ADR-003), while a missing CLI is a defect.
  const error = new DeviceUnavailableError(
    await deviceUnavailableMessage('maestro', 'android', 'pixel9', NONE),
  );

  assert.ok(error instanceof DeviceUnavailableError);
  assert.ok(error instanceof Error, 'it must still behave as an Error everywhere else');
  assert.equal(error.name, 'DeviceUnavailableError');
  assert.match(error.message, /pixel9/, 'and it carries the message that explains what to do');
});
