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
  /** renderer -> main (invoke): choose a project-confined save directory. */
  pickSaveLocation: 'pwtap-inspector:pickSaveLocation',
  /** renderer -> main (invoke): choose an existing test file to append to. */
  pickExistingTestFile: 'pwtap-inspector:pickExistingTestFile',
  /** renderer -> main (invoke): copy trusted renderer text through Electron's native clipboard. */
  copyText: 'pwtap-inspector:copyText',
} as const;

/** Result of the native "pick an app artifact" dialog. `null` when the user cancels. */
export interface PickAppFileResult {
  path: string;
  /** Best-effort app id inferred from the artifact (e.g. an `.apk`/`.app` basename), when available. */
  inferredAppId?: string;
}

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
  pickSaveLocation(): Promise<PickPathResult | null>;
  pickExistingTestFile(): Promise<PickPathResult | null>;
  /** Copy text using Electron's native clipboard (works under file:// and denied web permissions). */
  copyText(text: string): Promise<void>;
}

export type { ClientMessage, ServerMessage };
