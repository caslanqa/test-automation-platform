import type { RunLine } from '../hooks/useInspectorBridge';

interface RunOutputProps {
  lines: RunLine[];
  runState: 'idle' | 'running';
  exitCode: number | null | undefined;
}

/** Streamed stdout/stderr from the current Playwright run, plus its final exit status. */
export function RunOutput({ lines, runState, exitCode }: RunOutputProps) {
  return (
    <div className="run-output">
      {runState === 'idle' && lines.length === 0 && (
        <div className="muted">no run yet — press Run to execute the test source</div>
      )}
      {runState === 'idle' && exitCode !== undefined && (
        <div className={exitCode === 0 ? 'run-pass' : 'run-fail'}>
          {exitCode === 0 ? '✓ passed' : `✗ finished (exit ${exitCode})`}
        </div>
      )}
      <pre className="run-stream">
        {lines.map((l, i) => (
          <span key={i} className={l.stream === 'stderr' ? 'run-stderr' : undefined}>
            {l.chunk}
          </span>
        ))}
      </pre>
    </div>
  );
}
