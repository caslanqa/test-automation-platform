/**
 * Device-name resolution tests.
 *
 * The value this produces is written into a generated test and replayed days or weeks later, so the whole
 * question is "does this handle still point at the same device after a reboot?". Android AVD names do;
 * `adb` serials do not. iOS simulator names usually do, except that they are not unique — two "iPhone 15"
 * runtimes are perfectly legal — so an ambiguous name must give way to the UDID. See ADR-003.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveStableDeviceName } from '../src/deviceDiscovery.js';
import type { InspectorDevice } from '../src/types.js';

const android = (id: string, name: string): InspectorDevice => ({
  id,
  name,
  platform: 'android',
  booted: true,
});

const ios = (id: string, name: string): InspectorDevice => ({
  id,
  name,
  platform: 'ios',
  booted: true,
});

test('Android pins the AVD name, not the ephemeral adb serial', () => {
  const connected = android('emulator-5554', 'Pixel_7_API_34');

  assert.deepEqual(resolveStableDeviceName(connected, [connected]), {
    device: 'Pixel_7_API_34',
  });
});

test('Android warns when only a serial is available, instead of hiding it', () => {
  // Discovery could not determine an AVD name, so `name` fell back to the serial.
  const connected = android('emulator-5554', 'emulator-5554');

  const resolved = resolveStableDeviceName(connected, [connected]);

  assert.equal(resolved.device, 'emulator-5554');
  assert.match(resolved.warning ?? '', /after a reboot/);
  assert.match(resolved.warning ?? '', /AVD name/, 'the warning must say how to fix it');
});

test('a connected serial is resolved through the device list, which knows its AVD name', () => {
  // Found in the field: the UI connects by adb serial (the only handle that addresses a LIVE emulator),
  // the adapter reported that serial as the device's name, and this function ignored the `known` list it
  // is handed — so the recording pinned `emulator-5554` and could not connect once that instance was gone.
  const connected = android('emulator-5554', 'emulator-5554');
  const known = [android('emulator-5554', 'pixel9'), android('pixel10', 'pixel10')];

  assert.deepEqual(resolveStableDeviceName(connected, known), { device: 'pixel9' });
});

test('the device list is consulted by serial, not by position', () => {
  const connected = android('emulator-5556', 'emulator-5556');
  const known = [android('emulator-5554', 'pixel9'), android('emulator-5556', 'galaxy21')];

  assert.deepEqual(resolveStableDeviceName(connected, known), { device: 'galaxy21' });
});

test('a device list that only echoes the serial still warns rather than pinning it silently', () => {
  const connected = android('emulator-5554', 'emulator-5554');
  const known = [android('emulator-5554', 'emulator-5554')];

  const resolved = resolveStableDeviceName(connected, known);

  assert.equal(resolved.device, 'emulator-5554');
  assert.match(resolved.warning ?? '', /after a reboot/);
});

test('an Android AVD name needs no device list to be trusted', () => {
  // AVD names are directory names, so they are unique by construction — no uniqueness check needed.
  assert.deepEqual(resolveStableDeviceName(android('emulator-5554', 'Pixel_9'), []), {
    device: 'Pixel_9',
  });
});

test('iOS pins the simulator name when it is unique', () => {
  const connected = ios('UDID-1', 'iPhone 15');
  const known = [connected, ios('UDID-2', 'iPad Air')];

  assert.deepEqual(resolveStableDeviceName(connected, known), { device: 'iPhone 15' });
});

test('iOS falls back to the UDID when the name is shared, and says why', () => {
  const connected = ios('UDID-1', 'iPhone 15');
  // Same display name, different runtime — legal, and fatal for a name-based pin.
  const known = [connected, ios('UDID-2', 'iPhone 15')];

  const resolved = resolveStableDeviceName(connected, known);

  assert.equal(resolved.device, 'UDID-1');
  assert.match(resolved.warning ?? '', /more than one iOS simulator is named/);
});

test('iOS prefers the unambiguous UDID when uniqueness cannot be verified', () => {
  const connected = ios('UDID-1', 'iPhone 15');

  const resolved = resolveStableDeviceName(connected, []);

  assert.equal(
    resolved.device,
    'UDID-1',
    'an unverifiable name could silently target another device',
  );
  assert.match(resolved.warning ?? '', /could not list iOS simulators/);
});

test('an Android device sharing a name with an iOS simulator does not confuse the check', () => {
  const connected = ios('UDID-1', 'Pixel_7_API_34');
  const known = [connected, android('emulator-5554', 'Pixel_7_API_34')];

  // Only iOS entries count towards iOS ambiguity.
  assert.deepEqual(resolveStableDeviceName(connected, known), { device: 'Pixel_7_API_34' });
});
