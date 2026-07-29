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
  ScreenFrameMeta,
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

/** Bounded so a long session — or a failing device logging every poll — cannot grow without limit. */
const MAX_LOGS = 2000;
const MAX_RUN_LINES = 5000;

export interface InspectorState {
  /** Whether the event stream is currently attached to the service. */
  connectedToService: boolean;
  /** Set when the service refuses or drops us, so the UI can say why instead of just going quiet. */
  serviceError: string | null;
  drivers: DriverSummary[];
  devices: InspectorDevice[];
  apps: InstalledApp[];
  connected: { driver: string; device: InspectorDevice; capabilities: DriverCapabilities } | null;
  connecting: boolean;
  /** Frame metadata only; the image itself is fetched from `/frame/<frameId>`. */
  frame: ScreenFrameMeta | null;
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
  /** The directory the save dialog is browsing, and its subdirectories. */
  dirs: { path: string; entries: string[] };
}

const INITIAL_STATE: InspectorState = {
  connectedToService: false,
  serviceError: null,
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
  dirs: { path: '', entries: [] },
};

/** Append to a bounded list, dropping the oldest entries. */
function bounded<T>(list: T[], item: T, max: number): T[] {
  const next = [...list, item];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Owns the connection to the local inspector service.
 *
 * Events arrive over one SSE stream (`EventSource`, which reconnects on its own and resumes from
 * `Last-Event-ID`); commands go out as `POST /command` with a monotonic sequence number, because independent
 * POSTs can race in a way WebSocket framing used to hide (architecture.md ADR-013). Both are same-origin, so
 * the launch token travels in the service's cookie and never needs handling here.
 *
 * Commands are sent one at a time, in order: a queued send waits for the previous POST to be accepted, so
 * the server's sequence check can never fire for a client that is behaving.
 */
export function useInspectorBridge(): {
  state: InspectorState;
  send: (msg: ClientMessage) => void;
} {
  const [state, setState] = useState<InspectorState>(INITIAL_STATE);
  const seqRef = useRef(0);
  /** Tail of the send chain — each command awaits the previous one, preserving order. */
  const pendingRef = useRef<Promise<unknown>>(Promise.resolve());

  const send = useCallback((message: ClientMessage) => {
    if (message.type === 'inspectAt') {
      // Never show the previous element's candidates while a new hit-test is in flight.
      setState(s => ({ ...s, inspected: null }));
    }
    const seq = ++seqRef.current;
    pendingRef.current = pendingRef.current
      .then(() =>
        fetch('/command', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seq, message }),
        }),
      )
      .then(async response => {
        if (!response.ok) {
          const detail = await response.text().catch(() => response.statusText);
          setState(s => ({
            ...s,
            logs: bounded(
              s.logs,
              { level: 'error', message: `command rejected: ${detail}`, at: Date.now() },
              MAX_LOGS,
            ),
          }));
        }
      })
      .catch((error: unknown) => {
        setState(s => ({
          ...s,
          serviceError: `could not reach the inspector service: ${String(error)}`,
        }));
      });
  }, []);

  useEffect(() => {
    const source = new EventSource('/events');
    source.onopen = () => {
      setState(s => ({ ...s, connectedToService: true, serviceError: null }));
      // The re-sync snapshot covers device/timeline/draft, but the installed driver list is discovered on
      // demand, so ask for it every time the stream opens — including after an automatic reconnect.
      // Without this the driver picker stays empty and nothing can be connected at all.
      send({ type: 'listDrivers' });
    };
    source.onmessage = event =>
      applyServerMessage(setState, JSON.parse(event.data as string) as ServerMessage);
    source.onerror = () =>
      // EventSource retries by itself; report the gap rather than looking frozen.
      setState(s => ({
        ...s,
        connectedToService: false,
        serviceError: 'lost the connection to the inspector service — retrying…',
      }));
    return () => source.close();
  }, [send]);

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
        // The device is gone; the RECORDING is not. The draft and timeline survive on the server (they
        // describe work the user did), and `run` disconnects before it spawns Playwright — clearing them
        // here is what used to make pressing Run empty the editor.
        return { ...s, connecting: false, connected: null, frame: null, hierarchy: [] };
      case 'frame':
        return { ...s, frame: message.frame };
      case 'frameUnchanged':
        // The device produced a byte-identical screen: the image on display is still current, and its id is
        // unchanged, so there is deliberately nothing to do.
        return s;
      case 'hierarchy':
        return { ...s, hierarchy: message.nodes };
      case 'inspected':
        return { ...s, inspected: { node: message.node, candidates: message.candidates } };
      case 'actionResult':
        return { ...s, lastResult: { action: message.action, result: message.result } };
      case 'timeline':
        return { ...s, timeline: message.actions };
      case 'code':
        // Only accept source newer than what we hold (guards against a stale echo).
        return message.revision >= s.codeRevision
          ? { ...s, code: message.source, codeRevision: message.revision }
          : s;
      case 'testFiles':
        return { ...s, testFiles: message.files };
      case 'dirs':
        return { ...s, dirs: { path: message.path, entries: message.entries } };
      case 'saved':
        return {
          ...s,
          logs: bounded(
            s.logs,
            { level: 'info', message: `saved to ${message.path}`, at: Date.now() },
            MAX_LOGS,
          ),
        };
      case 'runOutput': {
        const next = [...s.runOutput, { stream: message.stream, chunk: message.chunk }];
        return {
          ...s,
          runOutput: next.length > MAX_RUN_LINES ? next.slice(next.length - MAX_RUN_LINES) : next,
        };
      }
      case 'runStatus':
        return message.state === 'started'
          ? { ...s, runState: 'running', runExitCode: undefined, runOutput: [] }
          : { ...s, runState: 'idle', runExitCode: message.exitCode ?? null };
      case 'log':
        return {
          ...s,
          logs: bounded(
            s.logs,
            { level: message.level, message: message.message, at: Date.now() },
            MAX_LOGS,
          ),
        };
      case 'error':
        return {
          ...s,
          logs: bounded(
            s.logs,
            { level: 'error', message: message.message, at: Date.now() },
            MAX_LOGS,
          ),
        };
      default:
        return s;
    }
  });
}
