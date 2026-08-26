/**
 * The injection manifest, against `@pwtap/create`'s expectations.
 *
 * The manifest is untyped — `@pwtap/create` publishes no type surface — so nothing in the build catches
 * a drift between what this package declares and what the injector reads. The failure is silent by
 * construction: a misspelled field is an injection that quietly does nothing, and the user finds out
 * when a run they thought was published isn't there.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { manifest } from '../src/manifest.js';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('the reporter removal key is a substring of the line it removes', () => {
  // `create-pwtap remove tms` finds the line by `uniq`. If the two ever diverge, add works and remove
  // silently leaves a reporter pointing at an uninstalled package — which fails every subsequent run.
  assert.ok(manifest.reporter.line.includes(manifest.reporter.uniq));
  assert.match(
    manifest.reporter.line,
    /^ {4}\[.*\],$/,
    'the line is spliced verbatim, indent included',
  );
});

test('the reporter line names this package’s published export', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')) as {
    name: string;
    exports: Record<string, unknown>;
  };
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.reporter.uniq, `${pkg.name}/reporter`);
  assert.ok(pkg.exports['./reporter'] !== undefined);
});

test('every script the manifest promises is a command the CLI answers', () => {
  const usage = fs.readFileSync(path.join(PKG_ROOT, 'src', 'cli', 'index.ts'), 'utf8');
  for (const command of Object.values(manifest.scripts)) {
    // The subcommand, not the flags: `tms trace --gate` and `tms trace` are one entry in the usage
    // block, and asserting the full string would force the usage text to repeat every script verbatim.
    const subcommand = command.split(' ').slice(0, 2).join(' ');
    assert.ok(usage.includes(subcommand), `${subcommand} is not documented in the CLI usage block`);
  }
});

test('installing the plugin does not switch anything on', () => {
  assert.equal(manifest.envKeys.TMS_MODE, 'off');
  assert.equal(
    manifest.envKeys.QASE_TESTOPS_API_TOKEN,
    '',
    'a placeholder, never a committed secret',
  );
  assert.equal(manifest.envKeys.QASE_TESTOPS_PROJECT, '');
});

test('no fixture and no Playwright project — this plugin is not on a green run’s hot path', () => {
  assert.equal('fixture' in manifest, false);
  assert.equal('playwrightProject' in manifest, false);
});

test('every declared doc file exists, or the copy step fails at install time', () => {
  for (const doc of manifest.docs) {
    assert.ok(fs.existsSync(path.join(PKG_ROOT, doc.src)), `${doc.src} is declared but missing`);
  }
});
