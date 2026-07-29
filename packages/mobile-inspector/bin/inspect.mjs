#!/usr/bin/env node
/**
 * `mobile-inspect [projectDir]` — open the recorder for a project.
 *
 * Starts the loopback service (per-launch token, one instance per project) and opens it in an app-mode
 * Chromium window using the browser Playwright already installed — no Electron (architecture.md ADR-001).
 * With no browser available it prints the URL instead, which is an equally usable inspector.
 *
 * Closing the window, or Ctrl-C, tears the launch down: device lock released, any test run killed, temp
 * files removed.
 */
import path from 'node:path';

import { openInspectorWindow } from '../dist/cli/window.js';
import { startInspectorService } from '../dist/service/server.js';

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());

// Installed before anything that can leave state behind. Starting the service and launching the browser
// each take a moment, and a Ctrl-C in either gap must tear the launch down rather than kill the process
// where it stands — which is how a run used to leave its device lock and temp files on disk.
let service;
let window;
let stopping = false;
const stop = async () => {
  if (stopping) {
    return;
  }
  stopping = true;
  await window?.close().catch(() => undefined);
  await service?.close().catch(() => undefined);
  process.exit(0);
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void stop());
}

try {
  service = await startInspectorService({ projectRoot });
} catch (error) {
  // A second launch for the same project is refused, with the URL of the first (ADR-011).
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`\n  Mobile Inspector for ${projectRoot}\n\n  ${service.url}\n`);

// `onLaunched` hands over a closable window the moment the browser exists, before it is navigated: a
// signal inside that window used to leave an orphaned Chromium because there was nothing to close yet.
window = await openInspectorWindow(
  service.url,
  reason => console.warn(`  Could not open a browser window: ${reason}\n`),
  opened => {
    window = opened;
  },
);

if (window) {
  // The window is the session: closing it ends the launch.
  await window.closed;
  await stop();
} else {
  console.log('  Open the URL above to use the inspector. Press Ctrl-C to stop.\n');
}
