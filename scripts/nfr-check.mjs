/**
 * Enforces the §11 non-functional budget rows that are deterministic (architecture.md §12, Phase 3).
 *
 * The rest of §11 — tap→frame latency, idle CPU, frame payload — needs a real device and belongs to the
 * device-gated job. What is checked here is the dependency footprint, because that is the row a single
 * careless `npm install` silently breaks: Electron alone put 296 MB into every client project, and nothing
 * in the build would have complained.
 *
 * Run: `npm run nfr`
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Discovered, not listed. The list used to be hardcoded, so `plugin-db` — a package with two new runtime
 * dependencies — would have escaped the footprint check without anyone noticing, and so would the plugin after
 * it. A package counts as runtime unless it is a dev tool a test never loads.
 */
const DEV_ONLY_PACKAGES = new Set(['create', 'mobile-inspector']);
const ALL_PACKAGES = fs
  .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
  .filter(
    entry =>
      entry.isDirectory() && fs.existsSync(path.join(ROOT, 'packages', entry.name, 'package.json')),
  )
  .map(entry => entry.name)
  .sort();
const RUNTIME_PACKAGES = ALL_PACKAGES.filter(pkg => !DEV_ONLY_PACKAGES.has(pkg));
/**
 * `electron` is banned transitively: it was 296 MB in every client install and nothing in the build
 * complained. The rest are banned only as OUR OWN direct dependencies (ADR-013/ADR-014) — a third-party
 * client that brings its own WebSocket implementation is its business, ours is not adding a second
 * formatter or compiler when the project already has one.
 */
const BANNED_ANYWHERE = ['electron'];
const BANNED_AS_OURS = ['ws', 'prettier', 'typescript', 'electron'];
/** §11: install size added by the inspector devDependency. */
const INSPECTOR_MAX_UNPACKED_MB = 5;

const failures = [];
const note = message => console.log(`  ${message}`);

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifestOf = pkg => readJson(path.join(ROOT, 'packages', pkg, 'package.json'));

/**
 * Every package reachable through `dependencies` from a workspace package. Walks the workspace's own
 * manifests for `@pwtap/*` and `node_modules` for the rest, so it sees the real transitive graph rather
 * than only what a manifest lists.
 */
function dependencyClosure(pkg) {
  const seen = new Set();
  const queue = Object.keys(manifestOf(pkg).dependencies ?? {});
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const local = name.startsWith('@pwtap/')
      ? path.join(ROOT, 'packages', name.slice('@pwtap/'.length), 'package.json')
      : path.join(ROOT, 'node_modules', name, 'package.json');
    if (fs.existsSync(local)) {
      queue.push(...Object.keys(readJson(local).dependencies ?? {}));
    }
  }
  return seen;
}

console.log('\nNFR — dependency footprint (§11)\n');

for (const pkg of RUNTIME_PACKAGES) {
  const closure = dependencyClosure(pkg);
  const found = BANNED_ANYWHERE.filter(name => closure.has(name));
  if (found.length > 0) {
    failures.push(`@pwtap/${pkg} pulls in ${found.join(', ')} — a test must not load these`);
  }
  note(
    `@pwtap/${pkg}: ${closure.size} transitive runtime deps${found.length ? ` ✗ ${found.join(', ')}` : ' ✓'}`,
  );
}

for (const pkg of ALL_PACKAGES) {
  const declared = Object.keys(manifestOf(pkg).dependencies ?? {});
  const found = declared.filter(name => BANNED_AS_OURS.includes(name));
  if (found.length > 0) {
    failures.push(`@pwtap/${pkg} declares ${found.join(', ')} as its own dependency`);
  }
  note(
    `@pwtap/${pkg}: declares [${declared.join(', ') || 'nothing'}]${found.length ? ' ✗' : ' ✓'}`,
  );
}

console.log('\nNFR — no stale build output\n');

/** Every emitted `.js` under a package's `dist`, relative and without the extension. */
function emittedModules(dir) {
  const found = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(next, `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.js')) {
        found.push(`${prefix}${entry.name.slice(0, -'.js'.length)}`);
      }
    }
  };
  if (fs.existsSync(dir)) {
    walk(dir, '');
  }
  return found;
}

// `tsc -b` emits but never prunes, so a moved or deleted source leaves its output in `dist` and it ships.
// That is how `dist/electron/*` stayed in the inspector's tarball after ADR-001 removed Electron: dead
// modules importing a package that is not even a dependency. `npm run clean` (wired into every prepack)
// prevents it; this fails the build if it comes back.
for (const pkg of ALL_PACKAGES) {
  const packageDir = path.join(ROOT, 'packages', pkg);
  const orphans = emittedModules(path.join(packageDir, 'dist')).filter(
    module =>
      !fs.existsSync(path.join(packageDir, 'src', `${module}.ts`)) &&
      !fs.existsSync(path.join(packageDir, 'src', `${module}.tsx`)),
  );
  if (orphans.length > 0) {
    failures.push(
      `@pwtap/${pkg} has ${orphans.length} stale dist file(s) with no source: ${orphans.join(', ')} — run npm run clean`,
    );
  }
  note(`@pwtap/${pkg}: ${orphans.length === 0 ? 'no orphans ✓' : `${orphans.length} orphans ✗`}`);
}

console.log('\nNFR — published size (§11)\n');

// `--ignore-scripts` so `prepack` does not rebuild (and print into) the JSON we are parsing; the built
// artifacts must therefore already exist, which is worth asserting anyway — a missing `ui-dist` would
// otherwise publish an inspector that serves nothing, and report a flattering size while doing it.
const inspectorDir = path.join(ROOT, 'packages', 'mobile-inspector');
for (const artifact of manifestOf('mobile-inspector').files) {
  if (!fs.existsSync(path.join(inspectorDir, artifact))) {
    failures.push(
      `@pwtap/mobile-inspector is missing ${artifact}/ — run npm run build && npm run build:ui`,
    );
  }
}
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: inspectorDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);
const unpackedMb = (packed[0]?.unpackedSize ?? 0) / 1024 / 1024;
if (unpackedMb > INSPECTOR_MAX_UNPACKED_MB) {
  failures.push(
    `@pwtap/mobile-inspector unpacks to ${unpackedMb.toFixed(1)} MB, over the ${INSPECTOR_MAX_UNPACKED_MB} MB budget`,
  );
}
note(
  `@pwtap/mobile-inspector: ${unpackedMb.toFixed(1)} MB unpacked (budget ${INSPECTOR_MAX_UNPACKED_MB} MB)` +
    (unpackedMb > INSPECTOR_MAX_UNPACKED_MB ? ' ✗' : ' ✓'),
);

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} NFR budget violation(s):\n`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log('\n✓ all checked NFR budgets are met\n');
