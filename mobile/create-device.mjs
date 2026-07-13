#!/usr/bin/env node

/**
 * Create a local mobile device (Android AVD or iOS simulator) from your ALREADY-INSTALLED toolchain
 * (Android SDK / Xcode). It does NOT install Android Studio or Xcode — those are prerequisites; it
 * only creates a device (installing an Android system image if the chosen one is missing). After it
 * finishes, add the printed name to mobile/devices.ts.
 *
 * Usage:
 *   node mobile/create-device.mjs --platform android --name Pixel_7_API_34 [--api 34]
 *   node mobile/create-device.mjs --platform ios --name "iPhone 16 Pro Test" [--type "iPhone 16 Pro"]
 * Omitted --platform/--name are prompted for when run in a terminal.
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const log = {
  info: m => console.log(`\x1b[34mℹ\x1b[0m ${m}`),
  ok: m => console.log(`\x1b[32m✔\x1b[0m ${m}`),
  warn: m => console.log(`\x1b[33m⚠\x1b[0m ${m}`),
  err: m => console.log(`\x1b[31m✖\x1b[0m ${m}`),
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await new Promise(res => rl.question(question, res))).trim();
  } finally {
    rl.close();
  }
}

/** Android SDK root: $ANDROID_HOME, $ANDROID_SDK_ROOT, or the OS default. */
function androidSdkRoot() {
  const home = os.homedir();
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'darwin' && path.join(home, 'Library', 'Android', 'sdk'),
    process.platform === 'linux' && path.join(home, 'Android', 'Sdk'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  ].filter(Boolean);
  return candidates.find(dir => fs.existsSync(dir));
}

function sdkTool(sdk, subdir, name) {
  const exe = path.join(sdk, subdir, process.platform === 'win32' ? `${name}.bat` : name);
  return fs.existsSync(exe) ? exe : null;
}

function createAndroid(name, api) {
  const sdk = androidSdkRoot();
  if (!sdk) {
    log.err('Android SDK not found — install Android Studio, or set ANDROID_HOME.');
    process.exit(1);
  }
  const sdkmanager = sdkTool(sdk, 'cmdline-tools/latest/bin', 'sdkmanager');
  const avdmanager = sdkTool(sdk, 'cmdline-tools/latest/bin', 'avdmanager');
  if (!sdkmanager || !avdmanager) {
    log.err('sdkmanager/avdmanager not found — install the "Android SDK Command-line Tools" (Android Studio → SDK Manager).');
    process.exit(1);
  }

  const arch = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  const image = `system-images;android-${api};google_apis;${arch}`;
  const installed = path.join(sdk, 'system-images', `android-${api}`, 'google_apis', arch);

  if (!fs.existsSync(installed)) {
    log.warn(`System image ${image} not installed — downloading (~1 GB)...`);
    // `yes` accepts the SDK licenses non-interactively.
    execSync(`yes | "${sdkmanager}" "${image}"`, { stdio: 'inherit' });
  }

  log.info(`Creating AVD "${name}" from ${image}...`);
  // `no` declines the "custom hardware profile?" prompt.
  execSync(`echo no | "${avdmanager}" create avd -n "${name}" -k "${image}" --device pixel_7 --force`, {
    stdio: 'inherit',
  });
  log.ok(`Created AVD "${name}".`);
  log.info(`Add it to mobile/devices.ts, e.g.  myDevice: { platform: 'android', device: '${name}' }`);
}

function createIos(name, deviceType) {
  try {
    execFileSync('xcrun', ['--version'], { stdio: 'ignore' });
  } catch {
    log.err('xcrun not found — install Xcode (App Store) to get iOS simulators.');
    process.exit(1);
  }

  // Pick the newest installed iOS runtime.
  const runtimes = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'runtimes', '-j'], { encoding: 'utf8' }))
    .runtimes.filter(r => r.isAvailable && /iOS/.test(r.name))
    .sort((a, b) => (a.version < b.version ? 1 : -1));
  if (runtimes.length === 0) {
    log.err('No iOS runtime installed — add one in Xcode → Settings → Platforms.');
    process.exit(1);
  }
  const runtime = runtimes[0];

  log.info(`Creating simulator "${name}" (${deviceType}, ${runtime.name})...`);
  const udid = execFileSync('xcrun', ['simctl', 'create', name, deviceType, runtime.identifier], {
    encoding: 'utf8',
  }).trim();
  log.ok(`Created simulator "${name}" (${udid}).`);
  log.info(`Add it to mobile/devices.ts, e.g.  myDevice: { platform: 'ios', device: '${name}' }`);
}

async function main() {
  let platform = arg('platform');
  if (!platform && process.stdin.isTTY) {
    platform = (await prompt('Platform (android/ios): ')).toLowerCase();
  }
  if (platform !== 'android' && platform !== 'ios') {
    log.err('Pass --platform android|ios');
    process.exit(1);
  }

  let name = arg('name');
  if (!name && process.stdin.isTTY) {
    name = await prompt('Device name: ');
  }
  if (!name) {
    log.err('Pass --name <device name>');
    process.exit(1);
  }

  if (platform === 'android') {
    createAndroid(name, arg('api') ?? '34');
  } else {
    createIos(name, arg('type') ?? 'iPhone 16 Pro');
  }
}

main().catch(e => {
  log.err(e.message);
  process.exit(1);
});
