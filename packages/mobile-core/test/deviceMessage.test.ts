/**
 * What a test is told when the device it pins is not on this machine.
 *
 * A recording pins a device by name so it is reproducible (ADR-003), so the first thing that happens on
 * another laptop or in CI is that the name does not resolve. The adapters answered `no android device
 * available to connect the inspector to`, which named neither the device asked for nor the ones present, said
 * nothing about how to proceed, and mentioned the inspector during a plain test run.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { deviceUnavailableMessage } from '../src/deviceMessage.js';

// Discovery shells out to adb/simctl. Stubbed here so the message is tested, not the machine.
const original = process.env.PATH;
after(() => {
  process.env.PATH = original;
});
process.env.PATH = '/nonexistent';

test('a device that was asked for is named, and so is the way out', async () => {
  const message = await deviceUnavailableMessage('maestro', 'android', 'pixel9');

  assert.match(message, /"pixel9"/, 'the request must be quoted back');
  assert.match(message, /MOBILE_INSPECTOR_DEVICE/, 'and the override that avoids editing the test');
  assert.match(message, /avdmanager|Device Manager/, 'and how to create one');
  assert.doesNotMatch(
    message,
    /inspector to/,
    'a plain test run must not be told about the inspector',
  );
});

test('the platform decides which tool the hint names', async () => {
  assert.match(await deviceUnavailableMessage('maestro', 'ios', 'iPhone 99'), /simctl|Xcode/);
  assert.doesNotMatch(await deviceUnavailableMessage('maestro', 'ios', 'iPhone 99'), /avdmanager/);
});

test('naming no device at all is a different problem, and says so', async () => {
  const message = await deviceUnavailableMessage('appium', 'android', undefined);

  assert.match(
    message,
    /none was named|has none/,
    'nothing to look for is not the same as not found',
  );
  assert.doesNotMatch(message, /"undefined"/, 'and must never quote a missing name back');
});

test('the driver is named, since two of them can produce this', async () => {
  assert.match(await deviceUnavailableMessage('appium', 'android', 'x'), /^\[appium\]/);
  assert.match(await deviceUnavailableMessage('maestro', 'android', 'x'), /^\[maestro\]/);
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
