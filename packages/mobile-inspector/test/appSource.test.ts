/**
 * `appSource` validation (ADR-010). The value comes from a browser field and ends at `adb install` /
 * `simctl install` / Appium's `app` capability, so anything that is not an artifact must be refused before
 * an adapter sees it. `.app` is a directory bundle while the rest are files, which is the one asymmetry here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { resolveAppSource } from '../src/service/appSource.js';

let project = '';

before(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'pwtap-appsource-'));
  await fs.mkdir(path.join(project, 'build'), { recursive: true });
  await fs.writeFile(path.join(project, 'build/app.apk'), 'not really an apk');
  await fs.mkdir(path.join(project, 'build/App.app'), { recursive: true });
  await fs.mkdir(path.join(project, 'build/wrong.apk-dir.apk'), { recursive: true });
});

after(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

test('a relative artifact resolves against the project root, and is returned absolute', async () => {
  assert.deepEqual(await resolveAppSource('./build/app.apk', project), {
    appSource: path.join(project, 'build/app.apk'),
  });
});

test('an https URL is accepted as given', async () => {
  assert.deepEqual(await resolveAppSource('https://ci.example.com/app.apk', project), {
    appSource: 'https://ci.example.com/app.apk',
  });
});

test('any other scheme is refused — this artifact gets installed on a device', async () => {
  for (const value of [
    'http://ci.example.com/app.apk',
    'file:///etc/passwd',
    'data:application/zip;base64,AAA',
    'javascript:alert(1)',
  ]) {
    const result = await resolveAppSource(value, project);
    assert.ok('error' in result, value);
  }
});

test('an unknown extension is refused before the filesystem is touched', async () => {
  const result = await resolveAppSource('./build/app.tar.gz', project);

  assert.ok('error' in result);
  assert.match(result.error, /\.apk, \.app, \.ipa, \.zip/);
});

test('a path that does not exist says so, with the path it looked at', async () => {
  const result = await resolveAppSource('./build/missing.apk', project);

  assert.ok('error' in result);
  assert.match(result.error, /not found/);
  assert.match(result.error, /build\/missing\.apk/);
});

test('a .app bundle must be a directory, and everything else a file', async () => {
  assert.deepEqual(await resolveAppSource('./build/App.app', project), {
    appSource: path.join(project, 'build/App.app'),
  });
  // A directory named `*.apk` is not an apk, whatever it is called.
  const result = await resolveAppSource('./build/wrong.apk-dir.apk', project);
  assert.ok('error' in result);
  assert.match(result.error, /not a file/);
});

test('an empty value is refused rather than silently treated as absent', async () => {
  assert.ok('error' in (await resolveAppSource('   ', project)));
});
