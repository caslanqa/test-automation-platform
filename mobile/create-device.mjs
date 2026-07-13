#!/usr/bin/env node

/**
 * Create a local mobile device (Android AVD or iOS simulator) from your ALREADY-INSTALLED toolchain
 * (Android SDK / Xcode). It does NOT install Android Studio or Xcode — those are prerequisites.
 *
 * Run it with no args in a terminal for an interactive picker (lists the device profiles + system
 * images / runtimes you can choose). Or pass flags to skip the prompts:
 *   node mobile/create-device.mjs --platform android --name Pixel_7_API_34 --api 34 --device pixel_7
 *   node mobile/create-device.mjs --platform ios --name "My iPhone" --type "iPhone 16 Pro" [--download 26.0|latest]
 *
 * Both platforms can download on demand: Android fetches a system image if the chosen one isn't
 * installed (~1 GB); iOS can download a runtime via `xcodebuild` (~7 GB) when you pick a download
 * option (or pass --download). The pickers mark what's already local. Apple exposes no CLI to LIST
 * downloadable iOS versions, so that step asks you to type one. Add the printed name to mobile/devices.ts.
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

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

const rl = () => readline.createInterface({ input: process.stdin, output: process.stdout });

async function prompt(question) {
  const r = rl();
  try {
    return (await new Promise(res => r.question(question, res))).trim();
  } finally {
    r.close();
  }
}

/** Print a numbered list and return the chosen option's `value`. */
async function select(label, options) {
  console.log(`\n${label}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  const ans = await prompt(`Select [1-${options.length}]: `);
  const idx = Number.parseInt(ans, 10) - 1;
  if (!(idx >= 0 && idx < options.length)) {
    log.err('Invalid selection.');
    process.exit(1);
  }
  return options[idx].value;
}

// --- Device catalog (mobile/devices.ts) ----------------------------------------------------------

const CATALOG = fileURLToPath(new URL('./devices.ts', import.meta.url));

/** Turn a device name into a valid JS identifier usable as a `devices.<key>` accessor. */
function toKey(name) {
  const k = name.replace(/[^A-Za-z0-9_$]/g, '');
  return /^[0-9]/.test(k) ? `d${k}` : k || 'device';
}

/**
 * Append the created device to mobile/devices.ts so a test can reference it right away — no manual
 * copy-paste. Returns `{ key }` on success, `{ existed: true }` if the same device is already listed,
 * or `null` when the file can't be edited (caller then prints a manual hint). The new entry goes in
 * as the first member of the `devices` object; prettier/eslint format it on commit.
 */
function addToCatalog(name, platform) {
  let src;
  try {
    src = fs.readFileSync(CATALOG, 'utf8');
  } catch {
    return null;
  }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`device:\\s*['"]${esc(name)}['"]`).test(src)) {
    return { existed: true };
  }
  const anchor = 'export const devices = {';
  const at = src.indexOf(anchor);
  if (at === -1) {
    return null;
  }
  let key = toKey(name);
  if (new RegExp(`\\b${esc(key)}\\s*:`).test(src)) {
    let n = 2;
    while (new RegExp(`\\b${esc(key)}${n}\\s*:`).test(src)) n++;
    key = `${key}${n}`;
  }
  const safe = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const entry = `\n  ${key}: { platform: '${platform}', device: '${safe}' },`;
  const pos = at + anchor.length;
  fs.writeFileSync(CATALOG, src.slice(0, pos) + entry + src.slice(pos));
  return { key };
}

/** Register the device in the catalog and tell the user how to use it. */
function registerDevice(name, platform) {
  const res = addToCatalog(name, platform);
  if (res?.existed) {
    log.info(`Already listed in mobile/devices.ts (device: '${name}').`);
  } else if (res?.key) {
    log.ok(`Added to mobile/devices.ts → use it: test.use({ mobile: devices.${res.key} })`);
  } else {
    log.warn(
      `Add it to mobile/devices.ts manually:  ${toKey(name)}: { platform: '${platform}', device: '${name}' }`
    );
  }
}

// --- Android -------------------------------------------------------------------------------------

const ANDROID_ARCH = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
const ANDROID_PROFILES = [
  { value: 'pixel_9', label: 'Pixel 9' },
  { value: 'pixel_8', label: 'Pixel 8' },
  { value: 'pixel_7', label: 'Pixel 7' },
  { value: 'pixel_6', label: 'Pixel 6' },
  { value: 'medium_phone', label: 'Medium Phone' },
];
const ANDROID_APIS = ['36', '35', '34', '33']; // fallback levels if the SDK catalog can't be queried
const ANDROID_TAGS = ['google_apis_playstore', 'google_apis']; // phone-relevant image tags to offer

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
    // Prefer `latest`, then any versioned install (e.g. cmdline-tools/11.0/bin).
    const versions = fs.readdirSync(cmdline).filter(d => d !== 'latest');
    for (const d of ['latest', ...versions]) dirs.push(path.join(cmdline, d, 'bin'));
  }
  dirs.push(path.join(sdk, 'tools', 'bin')); // legacy location
  return dirs.map(d => path.join(d, exe)).find(fs.existsSync) ?? null;
}

/** Installed system images for our arch: [{ api, tag, image, installed:true }] (exact image string). */
function installedImages(sdk) {
  const root = path.join(sdk, 'system-images');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const dir of fs.readdirSync(root)) {
    const m = /^android-(\d+)$/.exec(dir);
    if (!m) continue;
    for (const tag of fs.readdirSync(path.join(root, dir))) {
      if (fs.existsSync(path.join(root, dir, tag, ANDROID_ARCH))) {
        out.push({
          api: m[1],
          tag,
          image: `system-images;${dir};${tag};${ANDROID_ARCH}`,
          installed: true,
        });
      }
    }
  }
  return out;
}

/** Downloadable system images from the live SDK catalog (`sdkmanager --list`), filtered to our arch + phone tags. */
function availableImages(sdkmanager) {
  let out;
  try {
    out = execSync(`"${sdkmanager}" --list`, {
      encoding: 'utf8',
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return []; // offline / older tool / no network → caller falls back to the curated list
  }
  const seen = new Set();
  const images = [];
  for (const line of out.split('\n')) {
    const pkg = line.split('|')[0].trim();
    const m = /^system-images;android-(\d+);([^;]+);(.+)$/.exec(pkg);
    if (!m) continue;
    const [, api, tag, arch] = m;
    if (arch !== ANDROID_ARCH || !ANDROID_TAGS.includes(tag) || seen.has(pkg)) continue;
    seen.add(pkg);
    images.push({ api, tag, image: pkg, installed: false });
  }
  return images;
}

const MAX_DOWNLOAD_LEVELS = 8; // keep the picker readable; older levels stay reachable via --api / sdkmanager

/**
 * System-image options for the picker: everything installed (exact image, no download) first, then the
 * newest downloadable levels from the live `sdkmanager --list` catalog — one entry per API level
 * (preferring the lighter `google_apis` tag), skipping levels already installed, capped at
 * `MAX_DOWNLOAD_LEVELS`. Falls back to a curated recent set if the catalog can't be read (offline / no
 * cmdline-tools yet).
 */
function androidImageOptions(sdk, sdkmanager) {
  const installed = installedImages(sdk);
  const installedApis = new Set(installed.map(i => i.api));

  // Collapse the catalog to one preferred image per NEW API level (google_apis over playstore).
  const byApi = new Map();
  for (const img of availableImages(sdkmanager)) {
    if (installedApis.has(img.api)) continue;
    const cur = byApi.get(img.api);
    if (!cur || (cur.tag !== 'google_apis' && img.tag === 'google_apis')) byApi.set(img.api, img);
  }
  let downloadable = [...byApi.values()].sort((a, b) => Number(b.api) - Number(a.api));
  const dropped = Math.max(0, downloadable.length - MAX_DOWNLOAD_LEVELS);
  downloadable = downloadable.slice(0, MAX_DOWNLOAD_LEVELS);

  if (installed.length === 0 && downloadable.length === 0) {
    downloadable = ANDROID_APIS.map(api => ({
      api,
      tag: 'google_apis',
      image: `system-images;android-${api};google_apis;${ANDROID_ARCH}`,
      installed: false,
    }));
  }
  if (dropped > 0) {
    log.info(
      `(+${dropped} older API level(s) available — install with --api <n> or \`sdkmanager\`)`
    );
  }

  const all = [...installed.sort((a, b) => Number(b.api) - Number(a.api)), ...downloadable];
  return all.map(i => ({
    value: i,
    label: `Android API ${i.api} · ${i.tag} · ${ANDROID_ARCH}  ${i.installed ? '(installed — no download)' : '(download)'}`,
  }));
}

async function createAndroid(opts) {
  const sdk = androidSdkRoot();
  if (!sdk) {
    log.err('Android SDK not found — install Android Studio, or set ANDROID_HOME.');
    process.exit(1);
  }
  const sdkmanager = sdkTool(sdk, 'sdkmanager');
  const avdmanager = sdkTool(sdk, 'avdmanager');
  if (!sdkmanager || !avdmanager) {
    log.err(
      'sdkmanager/avdmanager not found — install "Android SDK Command-line Tools" (Android Studio → SDK Manager).'
    );
    process.exit(1);
  }

  const interactive = process.stdin.isTTY;
  // `spec` = { api, image, installed } — the EXACT image string is reused for the create command so a
  // device backed by (e.g.) google_apis_playstore isn't re-created against a non-installed google_apis tag.
  const spec = opts.api
    ? {
        api: opts.api,
        image: `system-images;android-${opts.api};google_apis;${ANDROID_ARCH}`,
        installed: installedImages(sdk).some(i => i.api === opts.api && i.tag === 'google_apis'),
      }
    : interactive
      ? await select('Android system image:', androidImageOptions(sdk, sdkmanager))
      : {
          api: '34',
          image: `system-images;android-34;google_apis;${ANDROID_ARCH}`,
          installed: false,
        };
  const profile =
    opts.device ?? (interactive ? await select('Device profile:', ANDROID_PROFILES) : 'pixel_7');
  const defaultName = `${profile}_API_${spec.api}`;
  const name =
    opts.name ??
    (interactive ? (await prompt(`Device name [${defaultName}]: `)) || defaultName : defaultName);

  if (!spec.installed) {
    log.warn(`System image ${spec.image} not installed — downloading (~1 GB)...`);
    execSync(`yes | "${sdkmanager}" "${spec.image}"`, { stdio: 'inherit' });
  }

  log.info(`Creating AVD "${name}" (${profile}, ${spec.image})...`);
  execSync(
    `echo no | "${avdmanager}" create avd -n "${name}" -k "${spec.image}" --device "${profile}" --force`,
    {
      stdio: 'inherit',
    }
  );
  log.ok(`Created AVD "${name}".`);
  registerDevice(name, 'android');
}

// --- iOS -----------------------------------------------------------------------------------------

function xcrunJson(args) {
  return JSON.parse(execFileSync('xcrun', args, { encoding: 'utf8' }));
}

/** Installed, available iOS runtimes, newest first. */
function installedIosRuntimes() {
  return xcrunJson(['simctl', 'list', 'runtimes', '-j'])
    .runtimes.filter(r => r.isAvailable && /iOS/.test(r.name))
    .sort((a, b) => (a.version < b.version ? 1 : -1));
}

/** The installed runtime matching `version` (e.g. '26.0'), else the newest installed. */
function newestInstalledRuntime(version) {
  const all = installedIosRuntimes();
  return (
    (version && all.find(r => r.version === version || r.version.startsWith(version))) || all[0]
  );
}

/**
 * Download an iOS simulator runtime via Xcode. `version` (e.g. '26.0') fetches that specific one; omit
 * it for the latest. Streams progress; downloads are large (~7 GB) and slow. Apple exposes no CLI to
 * LIST downloadable versions, so the picker can't enumerate them — the user types one instead.
 */
function downloadIosRuntime(version) {
  const args = ['-downloadPlatform', 'iOS', ...(version ? ['-buildVersion', version] : [])];
  log.info(
    `Downloading ${version ? `iOS ${version}` : 'the latest iOS runtime'} (~7 GB — this can take a while)...`
  );
  try {
    execFileSync('xcodebuild', args, { stdio: 'inherit' });
  } catch {
    log.err(
      `Download failed. Needs full Xcode (not just Command Line Tools); on a permissions error retry with: sudo xcodebuild ${args.join(' ')}`
    );
    process.exit(1);
  }
}

/** Resolve the iOS runtime to use — an installed one, or download (latest / a typed version) first. */
async function resolveIosRuntime(opts, interactive) {
  if (opts.download) {
    const version = opts.download === 'latest' ? undefined : opts.download;
    downloadIosRuntime(version);
    return newestInstalledRuntime(version);
  }
  const installed = installedIosRuntimes();
  if (!interactive || opts.runtime) {
    const r =
      installed.find(x => x.name === opts.runtime || x.identifier === opts.runtime) ?? installed[0];
    if (!r) {
      log.err(
        'No iOS runtime installed — pass --download latest, or add one in Xcode → Settings → Components.'
      );
      process.exit(1);
    }
    return r;
  }
  const choice = await select('iOS runtime:', [
    ...installed.map(r => ({ value: r, label: `${r.name}  (installed)` })),
    { value: '__latest__', label: '⬇ Download latest iOS runtime (~7 GB)' },
    { value: '__specific__', label: '⬇ Download a specific version…' },
  ]);
  if (choice === '__latest__') {
    downloadIosRuntime(undefined);
    return newestInstalledRuntime();
  }
  if (choice === '__specific__') {
    const v = await prompt('iOS version to download (e.g. 26.0): ');
    if (!v) {
      log.err('No version entered.');
      process.exit(1);
    }
    downloadIosRuntime(v);
    return newestInstalledRuntime(v);
  }
  return choice;
}

async function createIos(opts) {
  try {
    execFileSync('xcrun', ['--version'], { stdio: 'ignore' });
  } catch {
    log.err('xcrun not found — install Xcode (App Store) to get iOS simulators.');
    process.exit(1);
  }
  const interactive = process.stdin.isTTY;
  const runtime = await resolveIosRuntime(opts, interactive);

  const iphones = xcrunJson(['simctl', 'list', 'devicetypes', '-j']).devicetypes.filter(d =>
    /iPhone/.test(d.name)
  );
  const deviceType =
    opts.type ??
    (interactive
      ? await select(
          'Device type:',
          iphones.slice(0, 12).map(d => ({ value: d.name, label: d.name }))
        )
      : 'iPhone 16 Pro');

  const defaultName = `${deviceType} (${runtime.name})`;
  const name =
    opts.name ??
    (interactive ? (await prompt(`Device name [${defaultName}]: `)) || defaultName : defaultName);

  log.info(`Creating simulator "${name}" (${deviceType}, ${runtime.name})...`);
  const udid = execFileSync('xcrun', ['simctl', 'create', name, deviceType, runtime.identifier], {
    encoding: 'utf8',
  }).trim();
  log.ok(`Created simulator "${name}" (${udid}).`);
  registerDevice(name, 'ios');
}

// --- main ----------------------------------------------------------------------------------------

async function main() {
  let platform = arg('platform');
  if (!platform && process.stdin.isTTY) {
    platform = await select('Platform:', [
      { value: 'android', label: 'Android (emulator / AVD)' },
      { value: 'ios', label: 'iOS (simulator)' },
    ]);
  }
  if (platform !== 'android' && platform !== 'ios') {
    log.err('Pass --platform android|ios (or run in a terminal for the interactive picker).');
    process.exit(1);
  }

  const opts = {
    name: arg('name'),
    api: arg('api'),
    device: arg('device'),
    type: arg('type'),
    runtime: arg('runtime'),
    download: arg('download'), // iOS only: 'latest' or a version like '26.0' → download that runtime first
  };
  if (!opts.name && !process.stdin.isTTY) {
    log.err('Pass --name <device name> (required in non-interactive mode).');
    process.exit(1);
  }

  if (platform === 'android') {
    await createAndroid(opts);
  } else {
    await createIos(opts);
  }
}

main().catch(e => {
  log.err(e.message);
  process.exit(1);
});
