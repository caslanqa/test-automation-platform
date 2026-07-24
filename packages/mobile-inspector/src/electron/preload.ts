/**
 * Sandboxed preload script. Runs with `contextIsolation` + `sandbox`, so it has no Node access beyond
 * Electron's `contextBridge`/`ipcRenderer`. It exposes exactly one frozen object, `window.pwtapInspector`
 * ({@link InspectorBridge}), and nothing else — the renderer can only do what this surface permits.
 *
 * Built to CommonJS (`preload.cjs`) by esbuild because sandboxed preload scripts cannot use ESM
 * imports (an Electron constraint); see `build:electron` in package.json.
 */
import { contextBridge, ipcRenderer } from 'electron';

import type { ClientMessage, ServerMessage } from '../service/protocol.js';
import { IpcChannels, type InspectorBridge } from './ipc.js';

const bridge: InspectorBridge = {
  send(message: ClientMessage): void {
    ipcRenderer.send(IpcChannels.command, message);
  },
  onEvent(listener: (message: ServerMessage) => void): () => void {
    const handler = (_event: unknown, message: ServerMessage): void => listener(message);
    ipcRenderer.on(IpcChannels.event, handler);
    return () => ipcRenderer.removeListener(IpcChannels.event, handler);
  },
  pickAppFile() {
    return ipcRenderer.invoke(IpcChannels.pickAppFile);
  },
  pickSaveLocation() {
    return ipcRenderer.invoke(IpcChannels.pickSaveLocation);
  },
  pickExistingTestFile() {
    return ipcRenderer.invoke(IpcChannels.pickExistingTestFile);
  },
};

contextBridge.exposeInMainWorld('pwtapInspector', Object.freeze(bridge));
