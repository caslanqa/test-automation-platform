import { useCallback, useEffect, useState } from 'react';

import { CodeEditor } from './components/CodeEditor';
import { ConnectionDrawer } from './components/ConnectionDrawer';
import { ConsolePanel } from './components/ConsolePanel';
import { DeviceViewport } from './components/DeviceViewport';
import { HierarchyTree } from './components/HierarchyTree';
import { LocatorMenu } from './components/LocatorMenu';
import { RunOutput } from './components/RunOutput';
import { SaveDialog, type SaveResult } from './components/SaveDialog';
import { Timeline } from './components/Timeline';
import type { PickAppFileResult, PickPathResult } from './global';
import { useInspectorBridge } from './hooks/useInspectorBridge';
import type { MobileNode } from './protocol';

type BottomTab = 'timeline' | 'output' | 'logs';

async function pickAppFile(): Promise<PickAppFileResult | null> {
  return (await window.pwtapInspector?.pickAppFile()) ?? null;
}

async function pickSaveLocation(): Promise<PickPathResult | null> {
  return (await window.pwtapInspector?.pickSaveLocation()) ?? null;
}

async function pickExistingTestFile(): Promise<PickPathResult | null> {
  return (await window.pwtapInspector?.pickExistingTestFile()) ?? null;
}

export function App() {
  const { state, send } = useInspectorBridge();
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [saveOpen, setSaveOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>('timeline');
  const [selectedNode, setSelectedNode] = useState<MobileNode | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);

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

  const onContextMenu = useCallback((anchor: { x: number; y: number }) => {
    setMenuAnchor(anchor);
  }, []);

  const running = state.runState === 'running';

  if (!state.bridgeReady) {
    return (
      <div className="boot-screen">
        <div>
          <h2>PWTAP Mobile Inspector</h2>
          <p className="muted">
            This window must run inside the Electron host. Launch it with
            <code> npm run start</code> (or <code>mobile-inspect &lt;projectRoot&gt;</code>).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
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

      <div className="workspace">
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
            pickAppFile={pickAppFile}
          />
        </section>

        <section className="pane pane-center">
          <CodeEditor source={state.code} revision={state.codeRevision} send={send} />
        </section>

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
          pickSaveLocation={pickSaveLocation}
          pickExistingTestFile={pickExistingTestFile}
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
