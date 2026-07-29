import { useEffect, useRef, useState } from 'react';

import type { GateFn } from '../capabilities';
import type { ClientMessage, LocatorCandidate, MobileAction, MobileLocator } from '../protocol';

interface LocatorMenuProps {
  anchor: { x: number; y: number } | null;
  candidates: LocatorCandidate[];
  loading: boolean;
  /** Whether the connected driver accepts an action kind, and why not when it doesn't. */
  gate: GateFn;
  onClose: () => void;
  send: (message: ClientMessage) => void;
}

/**
 * Right-click context menu anchored to a device element. Lists ranked locator candidates (best-first,
 * with confidence + fragility warnings) and offers Tap / Fill / Assert visible / Assert not visible /
 * Wait / Copy against the chosen candidate — mirroring Maestro Studio's element-to-command flow but
 * generating PWTAP's own `MobileAction`s. Actions the connected driver refuses are disabled with the
 * reason as their tooltip, and the candidate list is a radiogroup with arrow-key navigation.
 */
export function LocatorMenu({
  anchor,
  candidates,
  loading,
  gate,
  onClose,
  send,
}: LocatorMenuProps) {
  const [selected, setSelected] = useState(0);
  const [fillOpen, setFillOpen] = useState(false);
  const [fillValue, setFillValue] = useState('');
  const candidateRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const returnFocusRef = useRef<Element | null>(null);

  // A fresh hit-test starts over: first candidate selected, and focus moves into the menu so the
  // list is reachable by keyboard rather than only by pointer.
  useEffect(() => {
    setSelected(0);
    setFillOpen(false);
    setFillValue('');
    candidateRefs.current[0]?.focus();
  }, [candidates]);

  // Remember where focus came from and put it back on close, so dismissing the menu does not drop
  // the user at the top of the document.
  useEffect(() => {
    if (!anchor) {
      return;
    }
    returnFocusRef.current = document.activeElement;
    return () => {
      const target = returnFocusRef.current;
      if (target instanceof HTMLElement && target.isConnected) {
        target.focus();
      }
    };
  }, [anchor]);

  useEffect(() => {
    if (!anchor) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anchor, onClose]);

  if (!anchor) {
    return null;
  }

  const candidate = candidates[selected];

  function moveSelection(to: number): void {
    const index = (to + candidates.length) % candidates.length;
    setSelected(index);
    candidateRefs.current[index]?.focus();
  }

  function onCandidateKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step: Record<string, number> = {
      ArrowDown: selected + 1,
      ArrowUp: selected - 1,
      Home: 0,
      End: candidates.length - 1,
    };
    if (candidates.length > 0 && event.key in step) {
      event.preventDefault();
      moveSelection(step[event.key]);
    }
  }

  function perform(build: (locator: MobileLocator) => ClientMessage): void {
    if (candidate) {
      send(build(candidate.locator));
    }
    onClose();
  }

  async function copyLocator(): Promise<void> {
    if (candidate) {
      await navigator.clipboard.writeText(candidate.display);
    }
    onClose();
  }

  function submitFill(): void {
    if (!candidate) {
      return;
    }
    send({
      type: 'perform',
      action: { kind: 'fill', locator: candidate.locator, value: fillValue },
    });
    onClose();
  }

  // Clamp the menu inside the viewport.
  const style: React.CSSProperties = {
    left: Math.min(anchor.x, window.innerWidth - 300),
    top: Math.min(anchor.y, window.innerHeight - 320),
  };

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} onContextMenu={e => e.preventDefault()} />
      <div className="locator-menu" style={style} role="dialog" aria-label="Locator alternatives">
        <div className="locator-menu-title">Locator alternatives</div>
        {loading && <div className="muted locator-loading">inspecting element…</div>}
        {!loading && candidates.length === 0 && (
          <div className="muted locator-loading">no element found here</div>
        )}
        <div role="radiogroup" aria-label="Locator candidates" onKeyDown={onCandidateKeyDown}>
          {candidates.map((c, i) => (
            <button
              key={i}
              ref={element => {
                candidateRefs.current[i] = element;
              }}
              className={`locator-candidate${i === selected ? ' active' : ''}`}
              onClick={() => setSelected(i)}
              role="radio"
              aria-checked={i === selected}
              // Roving tab stop: Tab reaches the list once, then leaves it for the action buttons.
              tabIndex={i === selected ? 0 : -1}
            >
              <span className={`badge badge-${c.confidence}`}>{c.confidence}</span>
              <span className="locator-display">{c.display}</span>
              <span className="locator-score muted">{c.score}</span>
              {!c.unique && <span className="warn locator-warn">⚠ non-unique</span>}
              {c.warnings.length > 0 && c.unique && (
                <span className="warn locator-warn" title={c.warnings.join('; ')}>
                  ⚠
                </span>
              )}
            </button>
          ))}
        </div>

        {candidate && (
          <div className="locator-actions">
            <GatedAction gate={gate} kind="tap" onClick={() => perform(l => tap(l))}>
              Tap
            </GatedAction>
            <GatedAction gate={gate} kind="fill" onClick={() => setFillOpen(true)}>
              Fill…
            </GatedAction>
            <GatedAction
              gate={gate}
              kind="assertVisible"
              onClick={() =>
                perform(l => ({ type: 'perform', action: { kind: 'assertVisible', locator: l } }))
              }
            >
              Assert visible
            </GatedAction>
            <GatedAction
              gate={gate}
              kind="assertNotVisible"
              onClick={() =>
                perform(l => ({
                  type: 'record',
                  action: { kind: 'assertNotVisible', locator: l },
                }))
              }
            >
              Assert not visible
            </GatedAction>
            <GatedAction
              gate={gate}
              kind="waitFor"
              onClick={() =>
                perform(l => ({ type: 'perform', action: { kind: 'waitFor', locator: l } }))
              }
            >
              Wait
            </GatedAction>
            {/* Not a driver action — copying to the clipboard works with no device at all. */}
            <button className="btn btn-small" onClick={copyLocator}>
              Copy locator
            </button>
          </div>
        )}
        {candidate && fillOpen && (
          <form
            className="locator-fill"
            onSubmit={event => {
              event.preventDefault();
              submitFill();
            }}
          >
            <input
              autoFocus
              value={fillValue}
              onChange={event => setFillValue(event.target.value)}
              placeholder="Value to fill"
              aria-label="Value to fill"
            />
            <button className="btn btn-small btn-primary" type="submit">
              Apply
            </button>
            <button className="btn btn-small" type="button" onClick={() => setFillOpen(false)}>
              Cancel
            </button>
          </form>
        )}
      </div>
    </>
  );
}

/** An action button that disables itself when the connected driver refuses the kind, stating why. */
function GatedAction({
  gate,
  kind,
  onClick,
  children,
}: {
  gate: GateFn;
  kind: MobileAction['kind'];
  onClick: () => void;
  children: React.ReactNode;
}) {
  const { supported, reason } = gate(kind);
  return (
    <button className="btn btn-small" onClick={onClick} disabled={!supported} title={reason}>
      {children}
    </button>
  );
}

function tap(locator: MobileLocator): ClientMessage {
  return { type: 'perform', action: { kind: 'tap', locator } };
}
