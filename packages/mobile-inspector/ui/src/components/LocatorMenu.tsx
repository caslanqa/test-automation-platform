import { useEffect, useState } from 'react';

import type { ClientMessage, LocatorCandidate, MobileLocator } from '../protocol';

interface LocatorMenuProps {
  anchor: { x: number; y: number } | null;
  candidates: LocatorCandidate[];
  loading: boolean;
  onClose: () => void;
  send: (message: ClientMessage) => void;
}

/**
 * Right-click context menu anchored to a device element. Lists ranked locator candidates (best-first,
 * with confidence + fragility warnings) and offers Tap / Fill / Assert visible / Assert not visible /
 * Wait / Copy against the chosen candidate — mirroring Maestro Studio's element-to-command flow but
 * generating PWTAP's own `MobileAction`s.
 */
export function LocatorMenu({ anchor, candidates, loading, onClose, send }: LocatorMenuProps) {
  const [selected, setSelected] = useState(0);
  const [fillOpen, setFillOpen] = useState(false);
  const [fillValue, setFillValue] = useState('');

  useEffect(() => {
    setSelected(0);
    setFillOpen(false);
    setFillValue('');
  }, [candidates]);

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
      <div className="locator-menu" style={style} role="menu">
        <div className="locator-menu-title">Locator alternatives</div>
        {loading && <div className="muted locator-loading">inspecting element…</div>}
        {!loading && candidates.length === 0 && (
          <div className="muted locator-loading">no element found here</div>
        )}
        {candidates.map((c, i) => (
          <button
            key={i}
            className={`locator-candidate${i === selected ? ' active' : ''}`}
            onClick={() => setSelected(i)}
            role="menuitemradio"
            aria-checked={i === selected}
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

        {candidate && (
          <div className="locator-actions">
            <button className="btn btn-small" onClick={() => perform(l => tap(l))}>
              Tap
            </button>
            <button className="btn btn-small" onClick={() => setFillOpen(true)}>
              Fill…
            </button>
            <button
              className="btn btn-small"
              onClick={() =>
                perform(l => ({ type: 'perform', action: { kind: 'assertVisible', locator: l } }))
              }
            >
              Assert visible
            </button>
            <button
              className="btn btn-small"
              onClick={() =>
                perform(l => ({
                  type: 'record',
                  action: { kind: 'assertNotVisible', locator: l },
                }))
              }
            >
              Assert not visible
            </button>
            <button
              className="btn btn-small"
              onClick={() =>
                perform(l => ({ type: 'perform', action: { kind: 'waitFor', locator: l } }))
              }
            >
              Wait
            </button>
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

function tap(locator: MobileLocator): ClientMessage {
  return { type: 'perform', action: { kind: 'tap', locator } };
}
