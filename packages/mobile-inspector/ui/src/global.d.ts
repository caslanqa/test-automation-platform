import type { ClientMessage, ServerMessage } from './protocol';

/** Result of the native "pick an app artifact" dialog. `null` when the user cancels. */
export interface PickAppFileResult {
  path: string;
  inferredAppId?: string;
}

export interface PickPathResult {
  relativePath: string;
}

/**
 * The frozen API surface `preload.ts` exposes on `window.pwtapInspector`. Mirror of the Electron
 * `InspectorBridge` (src/electron/ipc.ts); the renderer programs against this shape only and has no
 * direct Node/Electron access.
 */
export interface InspectorBridge {
  send(message: ClientMessage): void;
  onEvent(listener: (message: ServerMessage) => void): () => void;
  pickAppFile(): Promise<PickAppFileResult | null>;
  pickSaveLocation(): Promise<PickPathResult | null>;
  pickExistingTestFile(): Promise<PickPathResult | null>;
  copyText(text: string): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron renderer (injected by the sandboxed preload). */
    pwtapInspector?: InspectorBridge;
  }
}

export {};
