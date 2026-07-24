/**
 * The single, typed IPC contract between the Electron main process (`main.ts`) and the sandboxed
 * renderer (via `preload.ts`'s `contextBridge`). This is the Electron transport equivalent of the
 * old WebSocket protocol: the renderer sends already-shaped {@link ClientMessage}s (still re-validated
 * in main with `parseClientMessage`, since the renderer is untrusted) and receives {@link ServerMessage}s.
 *
 * Kept as string channel constants + a small typed surface so both sides import exactly one source of
 * truth and a typo can't silently create a dead channel.
 */
import type { ClientMessage, ServerMessage } from '../service/protocol.js';

/** Channel names. Namespaced under `pwtap-inspector:` to avoid clashing with any Electron internals. */
export const IpcChannels = {
  /** renderer -> main: one validated recorder command. */
  command: 'pwtap-inspector:command',
  /** main -> renderer: one recorder event (pushed on the webContents send channel). */
  event: 'pwtap-inspector:event',
  /** renderer -> main (invoke): open a native file dialog to pick an app artifact; returns a path. */
  pickAppFile: 'pwtap-inspector:pickAppFile',
  /** renderer -> main (invoke): open a native folder dialog for the "new file" save location. */
  pickSaveLocation: 'pwtap-inspector:pickSaveLocation',
  /** renderer -> main (invoke): open a native file dialog to pick an existing test file to append to. */
  pickExistingTestFile: 'pwtap-inspector:pickExistingTestFile',
} as const;

/** Result of the native "pick an app artifact" dialog. `null` when the user cancels. */
export interface PickAppFileResult {
  path: string;
  /** Best-effort app id inferred from the artifact (e.g. an `.apk`/`.app` basename), when available. */
  inferredAppId?: string;
}

/** Result of a project-confined location/file picker. `null` when the user cancels or picks outside the project. */
export interface PickPathResult {
  /** POSIX-style path relative to the project root. */
  relativePath: string;
}

/**
 * The frozen API surface `preload.ts` exposes on `window.pwtapInspector`. The renderer programs
 * against this shape only — it has no direct Node/Electron access.
 */
export interface InspectorBridge {
  /** Send one recorder command to main. */
  send(message: ClientMessage): void;
  /** Subscribe to recorder events from main. Returns an unsubscribe function. */
  onEvent(listener: (message: ServerMessage) => void): () => void;
  /** Open the native app-artifact picker. Resolves `null` on cancel. */
  pickAppFile(): Promise<PickAppFileResult | null>;
  /**
   * Open a native folder picker (defaulting to the project's `tests/` dir) for the "new file" save
   * flow's location. Resolves `null` on cancel or when the chosen folder is outside the project.
   */
  pickSaveLocation(): Promise<PickPathResult | null>;
  /**
   * Open a native file picker (filtered to `*.mobile.ts`, defaulting to the project's `tests/` dir)
   * for the "append to existing file" save flow. Resolves `null` on cancel or if outside the project.
   */
  pickExistingTestFile(): Promise<PickPathResult | null>;
}

export type { ClientMessage, ServerMessage };
