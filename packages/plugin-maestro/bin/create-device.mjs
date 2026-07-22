#!/usr/bin/env node

/**
 * Create a local mobile device from your ALREADY-INSTALLED toolchain — an Android AVD (needs the
 * Android SDK + at least one installed system image) or an iOS simulator (needs Xcode). It does not
 * install Android Studio / Xcode. Interactive by default; flags skip the prompts:
 *   node bin/create-device.mjs --platform android --name Pixel_API_35 --image "system-images;android-35;google_apis_playstore;arm64-v8a"
 *   node bin/create-device.mjs --platform ios --name "My iPhone" --type "iPhone 16 Pro" --runtime "iOS 18.2"
 * After it prints the device name, use it inline:  test.use({ mobile: { platform, device: '<name>' } })
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import readline from 'node:readline/promises';

const log = {
  info: m => console.log(`\x1b[34mℹ\x1b[0m ${m}`),
  ok: m => console.log(`\x1b[32m✔\x1b[0m ${m}`),
  warn: m => console.log(`\x1b[33m⚠\x1b[0m ${m}`),
  err: m => console.log(`\x1b[31m✖\x1b[0m ${m}`),
};

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

async function ask(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function pick(label, options) {
  if (options.length === 0) {
    return undefined;
  }
  console.log(`\n${label}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  const answer = await ask(`Select [1-${options.length}]: `);
  const idx = Number.parseInt(answer, 10) - 1;
  return idx >= 0 && idx < options.length ? options[idx] : undefined;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...opts });
}

function usage(platform, name) {
  log.ok(`Created ${platform} device "${name}".`);
  log.info(`Use it:  test.use({ mobile: { platform: '${platform}', device: '${name}' } })`);
}

// --- Android ------------------------------------------------------------------------------------

function androidSdkRoot() {
  const home = os.homedir();
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'darwin' && path.join(home, 'Library', 'Android', 'sdk'),
    process.platform === 'linux' && path.join(home, 'Android', 'Sdk'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  ]
    .filter(Boolean)
    .find(dir => fs.existsSync(dir));
}

function sdkTool(sdk, name) {
  const exe = process.platform === 'win32' ? `${name}.bat` : name;
  const cmdline = path.join(sdk, 'cmdline-tools');
  const dirs = [];
  if (fs.existsSync(cmdline)) {
    const versions = fs.readdirSync(cmdline).filter(d => d !== 'latest');
    for (const d of ['latest', ...versions]) {
      dirs.push(path.join(cmdline, d, 'bin'));
    }
  }
  dirs.push(path.join(sdk, 'tools', 'bin'));
  return dirs.map(d => path.join(d, exe)).find(fs.existsSync) ?? null;
}

/** Installed system images (`<sdk>/system-images/android-XX/tag/arch`), as `system-images;…` ids. */
function installedImages(sdk) {
  const root = path.join(sdk, 'system-images');
  if (!fs.existsSync(root)) {
    return [];
  }
  const out = [];
  for (const level of fs.readdirSync(root)) {
    if (!/^android-\d+$/.test(level)) {
      continue;
    }
    for (const tag of fs.readdirSync(path.join(root, level))) {
      for (const arch of fs.readdirSync(path.join(root, level, tag))) {
        if (fs.statSync(path.join(root, level, tag, arch)).isDirectory()) {
          out.push(`system-images;${level};${tag};${arch}`);
        }
      }
    }
  }
  return out;
}

async function createAndroid() {
  const sdk = androidSdkRoot();
  if (!sdk) {
    log.err('Android SDK not found — install Android Studio or set ANDROID_HOME.');
    process.exit(1);
  }
  const avdmanager = sdkTool(sdk, 'avdmanager');
  if (!avdmanager) {
    log.err('avdmanager not found — install the Android SDK command-line tools.');
    process.exit(1);
  }
  const images = installedImages(sdk);
  if (images.length === 0) {
    log.err(
      'No system image installed — add one in Android Studio (Device Manager → create a device), ' +
        'or install one with sdkmanager, then re-run.',
    );
    process.exit(1);
  }
  const image = arg('image') ?? (await pick('Installed system images:', images));
  if (!image) {
    log.err('No system image selected.');
    process.exit(1);
  }
  const name = (arg('name') ?? (await ask('AVD name: '))).replace(/\s+/g, '_');
  if (!name) {
    log.err('A name is required.');
    process.exit(1);
  }
  run(avdmanager, ['create', 'avd', '-n', name, '-k', image, '--force'], {
    input: 'no\n', // decline the "custom hardware profile?" prompt
    env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
  });
  usage('android', name);
}

// --- iOS ----------------------------------------------------------------------------------------

function simctlList(kind) {
  const data = JSON.parse(run('xcrun', ['simctl', 'list', kind, '-j']));
  return data;
}

async function createIos() {
  if (process.platform !== 'darwin') {
    log.err('iOS simulators require macOS + Xcode.');
    process.exit(1);
  }
  const runtimes = simctlList('runtimes')
    .runtimes.filter(r => r.isAvailable && /iOS/.test(r.name))
    .map(r => r.identifier);
  if (runtimes.length === 0) {
    log.err('No iOS runtime available — install one via Xcode → Settings → Components.');
    process.exit(1);
  }
  const runtimeArg = arg('runtime');
  const runtime =
    (runtimeArg && runtimes.find(r => r.includes(runtimeArg.replace(/[.\s]/g, '-')))) ??
    (runtimeArg ? undefined : await pick('iOS runtimes:', runtimes)) ??
    runtimes[0];
  const types = simctlList('devicetypes')
    .devicetypes.filter(d => /iPhone|iPad/.test(d.name))
    .map(d => d.name);
  const type = arg('type') ?? (await pick('Device types:', types)) ?? 'iPhone 16 Pro';
  const name = arg('name') ?? type;
  run('xcrun', ['simctl', 'create', name, type, runtime]);
  usage('ios', name);
}

// --- main ---------------------------------------------------------------------------------------

const platform = arg('platform') ?? (await ask('Platform (android/ios): ')).toLowerCase();
if (platform === 'android') {
  await createAndroid();
} else if (platform === 'ios') {
  await createIos();
} else {
  log.err("platform must be 'android' or 'ios'");
  process.exit(1);
}
