import { useCallback, useEffect, useRef, useState } from 'react';

import { CodeEditor } from './components/CodeEditor';
import { ConnectionDrawer } from './components/ConnectionDrawer';
import { ConsolePanel } from './components/ConsolePanel';
import { DeviceViewport } from './components/DeviceViewport';
import { HierarchyTree } from './components/HierarchyTree';
import { LocatorMenu } from './components/LocatorMenu';
import { RunOutput } from './components/RunOutput';
import { SaveDialog, type SaveResult } from './components/SaveDialog';
import { Timeline } from './components/Timeline';
import { useInspectorBridge } from './hooks/useInspectorBridge';
import type { MobileNode } from './protocol';

type BottomTab = 'timeline' | 'output' | 'logs';
type PaneDivider = 'device-code' | 'code-tree';

const DEFAULT_PANE_RATIOS: [number, number, number] = [1, 1.1, 0.8];
const PANE_RATIOS_KEY = 'pwtap-inspector-pane-ratios';
const DIVIDER_WIDTH = 6;
const MIN_PANE_WIDTHS = [220, 280, 220] as const;

export function App() {
  const { state, send } = useInspectorBridge();
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [saveOpen, setSaveOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>('timeline');
  const [selectedNode, setSelectedNode] = useState<MobileNode | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [paneRatios, setPaneRatios] = useState<[number, number, number]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PANE_RATIOS_KEY) ?? '') as unknown;
      return Array.isArray(saved) &&
        saved.length === 3 &&
        saved.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
        ? (saved as [number, number, number])
        : DEFAULT_PANE_RATIOS;
    } catch {
      return DEFAULT_PANE_RATIOS;
    }
  });
  const [resizing, setResizing] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    divider: PaneDivider;
    startX: number;
    widths: [number, number, number];
  } | null>(null);

  // Auto-close the connection drawer once a device is connected; reopen on disconnect.
  useEffect(() => {
    setDrawerOpen(!state.connected);
  }, [state.connected]);

  // Refresh the "existing test files" list after a save so a freshly created file is immediately
  // available for the next "append to existing file" pick.
  useEffect(() => {
    const last = state.logs.at(-1);
    if (last?.message.startsWith('saved to ')) {
      send({ type: 'listTestFiles' });
    }
  }, [state.logs, send]);

  // Surface run output automatically while a test is running.
  useEffect(() => {
    if (state.runState === 'running') {
      setBottomTab('output');
    }
  }, [state.runState]);

  useEffect(() => {
    try {
      localStorage.setItem(PANE_RATIOS_KEY, JSON.stringify(paneRatios));
    } catch {
      // Persistence is best-effort when browser storage is disabled.
    }
  }, [paneRatios]);

  const onContextMenu = useCallback((anchor: { x: number; y: number }) => {
    setMenuAnchor(anchor);
  }, []);

  const running = state.runState === 'running';

  function beginPaneResize(divider: PaneDivider, event: React.PointerEvent<HTMLDivElement>): void {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }
    dragRef.current = { divider, startX: event.clientX, widths: readPaneWidths(workspace) };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  }

  function resizePanes(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    const workspace = workspaceRef.current;
    if (!drag || !workspace) {
      return;
    }
    const availableWidth = workspace.clientWidth - DIVIDER_WIDTH * 2;
    if (availableWidth <= 0) {
      return;
    }
    const widths = [...drag.widths];
    const delta = event.clientX - drag.startX;

    if (drag.divider === 'device-code') {
      const pairWidth = widths[0] + widths[1];
      widths[0] = clamp(widths[0] + delta, MIN_PANE_WIDTHS[0], pairWidth - MIN_PANE_WIDTHS[1]);
      widths[1] = pairWidth - widths[0];
    } else {
      const pairWidth = widths[1] + widths[2];
      widths[1] = clamp(widths[1] + delta, MIN_PANE_WIDTHS[1], pairWidth - MIN_PANE_WIDTHS[2]);
      widths[2] = pairWidth - widths[1];
    }
    setPaneRatios(widths.map(width => width / availableWidth) as [number, number, number]);
  }

  function endPaneResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setResizing(false);
  }

  function nudgePaneDivider(divider: PaneDivider, direction: -1 | 1): void {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }
    const availableWidth = workspace.clientWidth - DIVIDER_WIDTH * 2;
    if (availableWidth <= 0) {
      return;
    }
    setPaneRatios(() => {
      const widths = readPaneWidths(workspace);
      const leftIndex = divider === 'device-code' ? 0 : 1;
      const rightIndex = leftIndex + 1;
      const pairWidth = widths[leftIndex] + widths[rightIndex];
      widths[leftIndex] = clamp(
        widths[leftIndex] + direction * 20,
        MIN_PANE_WIDTHS[leftIndex],
        pairWidth - MIN_PANE_WIDTHS[rightIndex],
      );
      widths[rightIndex] = pairWidth - widths[leftIndex];
      return widths.map(width => width / availableWidth) as [number, number, number];
    });
  }

  return (
    <div className="app">
      {/* The event stream reconnects on its own, so this reports the gap rather than replacing the UI:
          the recording lives on the service and is still there when the stream comes back (ADR-011). */}
      {state.serviceError && (
        <div className="service-banner" role="status">
          {state.serviceError}
        </div>
      )}
      <header className="topbar">
        <div className="topbar-title">PWTAP Mobile Inspector</div>
        <button className="btn" onClick={() => setDrawerOpen(o => !o)}>
          {state.connected ? '● Connected' : 'Connection'}
        </button>
        <div className="topbar-status muted">
          {state.connected
            ? `${state.connected.driver} · ${state.connected.device.name}`
            : state.connecting
              ? 'connecting…'
              : 'not connected'}
        </div>
        <div className="topbar-spacer" />
        <button
          className="btn btn-primary"
          onClick={() => send({ type: 'run', source: state.code })}
          disabled={running || !state.code.trim()}
        >
          {running ? 'Running…' : 'Run'}
        </button>
        <button
          className="btn btn-danger"
          onClick={() => send({ type: 'stopRun' })}
          disabled={!running}
        >
          Stop
        </button>
        <button
          className="btn"
          onClick={() => {
            send({ type: 'listTestFiles' });
            setSaveOpen(true);
          }}
          disabled={!state.code.trim()}
        >
          Save…
        </button>
      </header>

      <div
        ref={workspaceRef}
        className={`workspace${resizing ? ' resizing' : ''}`}
        style={{
          gridTemplateColumns:
            `minmax(${MIN_PANE_WIDTHS[0]}px, ${paneRatios[0]}fr) ${DIVIDER_WIDTH}px ` +
            `minmax(${MIN_PANE_WIDTHS[1]}px, ${paneRatios[1]}fr) ${DIVIDER_WIDTH}px ` +
            `minmax(${MIN_PANE_WIDTHS[2]}px, ${paneRatios[2]}fr)`,
        }}
      >
        <section className="pane pane-left">
          <div className="panel-title">Device</div>
          <DeviceViewport
            frame={state.frame}
            hierarchy={state.hierarchy}
            connecting={state.connecting}
            send={send}
            onContextMenu={onContextMenu}
            selectedNode={selectedNode}
          />
          <ConnectionDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            drivers={state.drivers}
            devices={state.devices}
            apps={state.apps}
            connected={state.connected}
            connecting={state.connecting}
            send={send}
          />
        </section>

        <div
          className="pane-resizer"
          role="separator"
          aria-label="Resize device and code panels"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={event => beginPaneResize('device-code', event)}
          onPointerMove={resizePanes}
          onPointerUp={endPaneResize}
          onPointerCancel={endPaneResize}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              nudgePaneDivider('device-code', event.key === 'ArrowLeft' ? -1 : 1);
            }
          }}
        />

        <section className="pane pane-center">
          <CodeEditor source={state.code} revision={state.codeRevision} send={send} />
        </section>

        <div
          className="pane-resizer"
          role="separator"
          aria-label="Resize code and accessibility tree panels"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={event => beginPaneResize('code-tree', event)}
          onPointerMove={resizePanes}
          onPointerUp={endPaneResize}
          onPointerCancel={endPaneResize}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              nudgePaneDivider('code-tree', event.key === 'ArrowLeft' ? -1 : 1);
            }
          }}
        />

        <section className="pane pane-right">
          <HierarchyTree
            nodes={state.hierarchy}
            selectedNode={selectedNode}
            onSelect={setSelectedNode}
          />
        </section>
      </div>

      <footer className="bottom-drawer">
        <nav className="bottom-tabs">
          <button
            className={`tab${bottomTab === 'timeline' ? ' active' : ''}`}
            onClick={() => setBottomTab('timeline')}
          >
            Timeline ({state.timeline.length})
          </button>
          <button
            className={`tab${bottomTab === 'output' ? ' active' : ''}`}
            onClick={() => setBottomTab('output')}
          >
            Run output{running ? ' ●' : ''}
          </button>
          <button
            className={`tab${bottomTab === 'logs' ? ' active' : ''}`}
            onClick={() => setBottomTab('logs')}
          >
            Logs ({state.logs.length})
          </button>
        </nav>
        <div className="bottom-body">
          {bottomTab === 'timeline' && <Timeline actions={state.timeline} send={send} />}
          {bottomTab === 'output' && (
            <RunOutput
              lines={state.runOutput}
              runState={state.runState}
              exitCode={state.runExitCode}
            />
          )}
          {bottomTab === 'logs' && <ConsolePanel logs={state.logs} lastResult={state.lastResult} />}
        </div>
      </footer>

      <LocatorMenu
        anchor={menuAnchor}
        candidates={state.inspected?.candidates ?? []}
        loading={!state.inspected}
        onClose={() => setMenuAnchor(null)}
        send={send}
      />

      {saveOpen && (
        <SaveDialog
          testFiles={state.testFiles}
          extension={
            state.drivers.find(d => d.id === state.connected?.driver)?.testBinding.extension ?? ''
          }
          onCancel={() => setSaveOpen(false)}
          onConfirm={(result: SaveResult) => {
            send({ type: 'save', ...result, source: state.code });
            setSaveOpen(false);
          }}
        />
      )}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function readPaneWidths(workspace: HTMLDivElement): [number, number, number] {
  const panes = workspace.querySelectorAll<HTMLElement>(':scope > .pane');
  return [panes[0]?.offsetWidth ?? 0, panes[1]?.offsetWidth ?? 0, panes[2]?.offsetWidth ?? 0];
}
