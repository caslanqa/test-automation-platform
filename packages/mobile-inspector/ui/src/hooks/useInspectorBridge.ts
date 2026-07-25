import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ActionResult,
  ClientMessage,
  DriverCapabilities,
  DriverSummary,
  InspectorDevice,
  InstalledApp,
  LocatorCandidate,
  MobileAction,
  MobileNode,
  ScreenFrame,
  ServerMessage,
  TestFileEntry,
} from '../protocol';

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

export interface RunLine {
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface InspectedResult {
  node: MobileNode | null;
  candidates: LocatorCandidate[];
}

export interface InspectorState {
  /** Whether the privileged Electron bridge (`window.pwtapInspector`) is present. */
  bridgeReady: boolean;
  drivers: DriverSummary[];
  devices: InspectorDevice[];
  apps: InstalledApp[];
  connected: { driver: string; device: InspectorDevice; capabilities: DriverCapabilities } | null;
  connecting: boolean;
  frame: ScreenFrame | null;
  hierarchy: MobileNode[];
  timeline: MobileAction[];
  /** Authoritative editor source and its server-side revision. */
  code: string;
  codeRevision: number;
  /** Latest right-click hit-test result (node + ranked locator candidates), or null. */
  inspected: InspectedResult | null;
  logs: LogEntry[];
  runOutput: RunLine[];
  runState: 'idle' | 'running';
  runExitCode: number | null | undefined;
  lastResult: { action: MobileAction; result: ActionResult } | null;
  /** Existing recorded test files under the project, for the save dialog's "append" picker. */
  testFiles: TestFileEntry[];
}

const INITIAL_STATE: InspectorState = {
  bridgeReady: false,
  drivers: [],
  devices: [],
  apps: [],
  connected: null,
  connecting: false,
  frame: null,
  hierarchy: [],
  timeline: [],
  code: '',
  codeRevision: 0,
  inspected: null,
  logs: [],
  runOutput: [],
  runState: 'idle',
  runExitCode: undefined,
  lastResult: null,
  testFiles: [],
};

/**
 * Owns the Electron IPC bridge connection to the privileged main process. Replaces the old WebSocket
 * transport: the sandboxed preload exposes `window.pwtapInspector` (send/onEvent), and this hook maps
 * inbound {@link ServerMessage}s to renderer state and exposes a typed `send` for commands.
 */
export function useInspectorBridge(): {
  state: InspectorState;
  send: (msg: ClientMessage) => void;
} {
  const [state, setState] = useState<InspectorState>(INITIAL_STATE);
  const bridgeRef = useRef<Window['pwtapInspector'] | null>(null);

  useEffect(() => {
    const bridge = window.pwtapInspector ?? null;
    bridgeRef.current = bridge;
    if (!bridge) {
      setState(s => ({ ...s, bridgeReady: false }));
      return;
    }
    setState(s => ({ ...s, bridgeReady: true }));
    const unsubscribe = bridge.onEvent(message => applyServerMessage(setState, message));
    bridge.send({ type: 'listDrivers' });
    return unsubscribe;
  }, []);

  const send = useCallback((message: ClientMessage) => {
    if (message.type === 'inspectAt') {
      // Never expose the previous element's locator candidates while a new hit-test is in flight.
      setState(s => ({ ...s, inspected: null }));
    }
    bridgeRef.current?.send(message);
  }, []);

  return { state, send };
}

function applyServerMessage(
  setState: React.Dispatch<React.SetStateAction<InspectorState>>,
  message: ServerMessage,
): void {
  setState(s => {
    switch (message.type) {
      case 'drivers':
        return { ...s, drivers: message.drivers };
      case 'devices':
        return { ...s, devices: message.devices };
      case 'apps':
        return { ...s, apps: message.apps };
      case 'connecting':
        return { ...s, connecting: true };
      case 'connected':
        return {
          ...s,
          connecting: false,
          connected: {
            driver: message.driver,
            device: message.device,
            capabilities: message.capabilities,
          },
        };
      case 'disconnected':
        return {
          ...s,
          connecting: false,
          connected: null,
          frame: null,
          hierarchy: [],
          timeline: [],
          inspected: null,
          code: '',
          codeRevision: 0,
        };
      case 'frame':
        return { ...s, frame: message.frame };
      case 'hierarchy':
        return { ...s, hierarchy: message.nodes };
      case 'inspected':
        return { ...s, inspected: { node: message.node, candidates: message.candidates } };
      case 'actionResult':
        return { ...s, lastResult: { action: message.action, result: message.result } };
      case 'timeline':
        return { ...s, timeline: message.actions };
      case 'code':
        // Only accept server code if it is newer than what we hold (guards against stale echoes).
        return message.revision >= s.codeRevision
          ? { ...s, code: message.source, codeRevision: message.revision }
          : s;
      case 'testFiles':
        return { ...s, testFiles: message.files };
      case 'saved':
        return {
          ...s,
          logs: [...s.logs, { level: 'info', message: `saved to ${message.path}`, at: Date.now() }],
        };
      case 'runOutput':
        return {
          ...s,
          runOutput: [...s.runOutput, { stream: message.stream, chunk: message.chunk }],
        };
      case 'runStatus':
        return message.state === 'started'
          ? { ...s, runState: 'running', runExitCode: undefined, runOutput: [] }
          : { ...s, runState: 'idle', runExitCode: message.exitCode ?? null };
      case 'log':
        return {
          ...s,
          logs: [...s.logs, { level: message.level, message: message.message, at: Date.now() }],
        };
      case 'error':
        return {
          ...s,
          logs: [...s.logs, { level: 'error', message: message.message, at: Date.now() }],
        };
      default:
        return s;
    }
  });
}
