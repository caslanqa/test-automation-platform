import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Cache location for a downloaded artifact, keyed by URL hash (stable across a run). */
function cachePath(url: string): string {
  const ext = path.extname(new URL(url).pathname) || '.bin';
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `pwtap-appium-app-${hash}${ext}`);
}

/** Download an http(s) artifact to the cache (skipped if already downloaded this run). */
async function download(url: string): Promise<string> {
  const dest = cachePath(url);
  if (fs.existsSync(dest)) {
    return dest;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[appium] app download failed (HTTP ${res.status}): ${url}`);
  }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/**
 * Resolve an app source (local path or http(s) URL) to a local artifact path for the `appium:app`
 * capability — the Appium driver installs it during session creation, so there's no separate
 * adb/simctl install step here (unlike Maestro, which drives the flow itself). An iOS `.zip` (a
 * zipped `.app`, e.g. a CI artifact) is unzipped and the `.app` bundle inside it is returned.
 */
export async function resolveAppArtifact(source: string): Promise<string> {
  let artifact = /^https?:\/\//.test(source) ? await download(source) : source;
  if (!fs.existsSync(artifact)) {
    throw new Error(`[appium] app artifact not found: ${source}`);
  }
  if (artifact.endsWith('.zip')) {
    const out = `${artifact}.extracted`;
    if (!fs.existsSync(out)) {
      fs.mkdirSync(out, { recursive: true });
      await execFileAsync('unzip', ['-o', '-q', artifact, '-d', out]);
    }
    const { stdout } = await execFileAsync('find', [out, '-maxdepth', '3', '-name', '*.app']);
    const app = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)[0];
    if (!app) {
      throw new Error(`[appium] no .app bundle found inside ${source}`);
    }
    artifact = app;
  }
  return artifact;
}
