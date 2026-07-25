import type { LogEntry } from '../hooks/useInspectorBridge';
import type { ActionResult, MobileAction } from '../protocol';

interface ConsolePanelProps {
  logs: LogEntry[];
  lastResult: { action: MobileAction; result: ActionResult } | null;
}

/** Driver/service log stream plus the outcome of the most recent action, for debugging failures. */
export function ConsolePanel({ logs, lastResult }: ConsolePanelProps) {
  return (
    <div className="console-panel">
      {lastResult && !lastResult.result.ok && (
        <div className="log-line log-error">last action failed: {lastResult.result.error}</div>
      )}
      <div className="console-lines">
        {logs
          .slice(-200)
          .reverse()
          .map((log, i) => (
            <div key={i} className={`log-line log-${log.level}`}>
              {new Date(log.at).toLocaleTimeString()} · {log.message}
            </div>
          ))}
        {logs.length === 0 && <div className="muted">no log messages yet</div>}
      </div>
    </div>
  );
}
