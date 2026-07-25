/**
 * Electron main process for the PWTAP Mobile Inspector desktop app.
 *
 * This is the ONLY privileged layer: it owns the single {@link RecorderSession} (device/driver
 * lifecycle, recording, code draft, run child process), the application window, and all native
 * dialogs. The renderer is fully sandboxed (`contextIsolation`, `sandbox`, no Node integration) and
 * talks to main exclusively through the narrow, re-validated IPC surface in `ipc.ts` — every inbound
 * command is passed through the same `parseClientMessage` guard the WebSocket transport used, because
 * the renderer is treated as untrusted.
 *
 * Security posture (see `plan.md`'s "Electron security and lifecycle"):
 * - no arbitrary navigation, popups, or remote content — only the packaged renderer is loaded;
 * - a strict CSP is injected for every response;
 * - file access happens only through native dialogs and project-confined main-process operations;
 * - window close / app quit / signals deterministically tear down the recorder session, device
 *   locks, and any run child process.
 */
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  session as electronSession,
  ipcMain,
} from 'electron';

import { parseClientMessage } from '../service/protocol.js';
import { RecorderSession } from '../service/recorderSession.js';
import { IpcChannels, type PickAppFileResult, type PickPathResult } from './ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The Vite renderer build output (see `vite.config.ts` — `ui-dist/` sits beside `dist/`). */
const RENDERER_DIR = path.resolve(__dirname, '../../ui-dist');
const RENDERER_INDEX = path.join(RENDERER_DIR, 'index.html');
/** Sandboxed preload must be CommonJS (`.cjs`); built separately by esbuild (see `build:electron`). */
const PRELOAD = path.join(__dirname, 'preload.cjs');

/** The scaffolded client project whose installed plugins/adapters the inspector drives. */
const PROJECT_ROOT = path.resolve(process.env.PWTAP_INSPECTOR_PROJECT_ROOT ?? process.cwd());
/** Smoke mode: create the window offscreen and quit right after load — for CI/headless validation. */
const SMOKE = process.env.PWTAP_INSPECTOR_SMOKE === '1';

const CSP =
  "default-src 'none'; " +
  "script-src 'self'; " +
  // Monaco injects styles at runtime; workers run from blob URLs. Kept as tight as Monaco allows.
  "style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' data:; " +
  "img-src 'self' data:; " +
  "connect-src 'self'; " +
  "worker-src 'self' blob:; " +
  "child-src 'self' blob:";

let mainWindow: BrowserWindow | undefined;
let recorder: RecorderSession | undefined;

function createRecorder(window: BrowserWindow): RecorderSession {
  return new RecorderSession(PROJECT_ROOT, message => {
    if (!window.isDestroyed()) {
      window.webContents.send(IpcChannels.event, message);
    }
  });
}

function registerIpc(window: BrowserWindow): void {
  recorder = createRecorder(window);

  ipcMain.on(IpcChannels.command, (_event, raw: unknown) => {
    // Re-validate on the trusted side: the renderer is untrusted even though it's local.
    const message = parseClientMessage(raw);
    if (!message) {
      window.webContents.send(IpcChannels.event, {
        type: 'error',
        message: 'malformed or unknown command',
      });
      return;
    }
    void recorder?.dispatch(message);
  });

  ipcMain.handle(IpcChannels.pickAppFile, async (): Promise<PickAppFileResult | null> => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Select an app artifact',
      properties: ['openFile'],
      filters: [
        { name: 'Mobile apps', extensions: ['apk', 'app', 'ipa', 'zip'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const picked = result.filePaths[0];
    if (result.canceled || !picked) {
      return null;
    }
    // Best-effort app-id inference from the artifact basename (e.g. `com.example.app.apk`).
    const base = path.basename(picked).replace(/\.(apk|app|ipa|zip)$/i, '');
    const inferredAppId = /^[\w.]+\.[\w.]+$/.test(base) ? base : undefined;
    return { path: picked, inferredAppId };
  });

  ipcMain.handle(IpcChannels.copyText, (_event, value: unknown): void => {
    if (typeof value !== 'string' || value.length > 100_000) {
      throw new Error('clipboard value must be a string no longer than 100,000 characters');
    }
    clipboard.writeText(value);
  });

  ipcMain.handle(IpcChannels.pickSaveLocation, async (): Promise<PickPathResult | null> => {
    const testsDir = path.resolve(PROJECT_ROOT, 'tests');
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a folder to save the test in',
      defaultPath: fsSync.existsSync(testsDir) ? testsDir : PROJECT_ROOT,
      properties: ['openDirectory', 'createDirectory'],
    });
    const picked = result.filePaths[0];
    return result.canceled || !picked ? null : confineToProject(picked, window);
  });

  ipcMain.handle(IpcChannels.pickExistingTestFile, async (): Promise<PickPathResult | null> => {
    const testsDir = path.resolve(PROJECT_ROOT, 'tests');
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose an existing test file to append to',
      defaultPath: fsSync.existsSync(testsDir) ? testsDir : PROJECT_ROOT,
      properties: ['openFile'],
      filters: [
        { name: 'Mobile test', extensions: ['ts'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const picked = result.filePaths[0];
    return result.canceled || !picked ? null : confineToProject(picked, window);
  });
}

function confineToProject(absolutePath: string, window: BrowserWindow): PickPathResult | null {
  const rel = path.relative(PROJECT_ROOT, absolutePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    window.webContents.send(IpcChannels.event, {
      type: 'error',
      message: 'location must be inside the project',
    });
    return null;
  }
  return { relativePath: rel.split(path.sep).join('/') };
}

function hardenWebContents(window: BrowserWindow): void {
  // Deny all new windows/popups.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Block any navigation away from the packaged renderer.
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
  // Deny every permission request (camera/mic/etc.) — the inspector needs none.
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
}

async function createWindow(): Promise<void> {
  // Inject a strict CSP on every response served to the renderer.
  electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: !SMOKE,
    title: 'PWTAP Mobile Inspector',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  hardenWebContents(mainWindow);
  registerIpc(mainWindow);

  await mainWindow.loadFile(RENDERER_INDEX);

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  if (SMOKE) {
    // Headless self-check: verify React actually mounted (catches CSP-blocked scripts on file://),
    // then tear down and exit cleanly. Exit non-zero if the renderer failed to render.
    const probe = mainWindow.webContents;
    setTimeout(() => {
      void probe
        .executeJavaScript(
          "(document.querySelector('.app') ? 'app' : document.querySelector('.boot-screen') ? 'boot' : 'empty') + (document.querySelector('.cm-editor') ? '+cm' : '')",
        )
        .then(result => {
          // eslint-disable-next-line no-console
          console.log(`[mobile-inspector] smoke: renderer mounted -> ${String(result)}`);
          const ok = result === 'app+cm' || result === 'boot';
          return teardown().then(() => {
            app.exit(ok ? 0 : 1);
          });
        })
        .catch(err => {
          console.error('[mobile-inspector] smoke: probe failed', err);
          return teardown().then(() => app.exit(1));
        });
    }, 1500);
  }
}

async function teardown(): Promise<void> {
  const current = recorder;
  recorder = undefined;
  if (current) {
    await current.close();
  }
}

app.on('window-all-closed', () => {
  void teardown().then(() => app.quit());
});

app.on('before-quit', event => {
  if (recorder) {
    event.preventDefault();
    void teardown().then(() => app.quit());
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void teardown().then(() => app.quit());
  });
}

// Single instance — a second launch focuses the existing window instead of stacking sessions.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
  app.whenReady().then(createWindow, (error: unknown) => {
    console.error('[mobile-inspector] failed to start:', error);
    app.quit();
  });
}
