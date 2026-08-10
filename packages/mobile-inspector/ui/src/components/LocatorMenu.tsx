import { useEffect, useRef, useState } from 'react';

import type { GateFn } from '../capabilities';
import type {
  ClientMessage,
  LocatorCandidate,
  MobileAction,
  MobileDirection,
  MobileLocator,
  MobileNode,
} from '../protocol';

interface LocatorMenuProps {
  anchor: { x: number; y: number } | null;
  candidates: LocatorCandidate[];
  /** The hit-tested element itself, so the menu can show what the driver actually sees. */
  node: MobileNode | null;
  loading: boolean;
  /** Whether the connected driver accepts an action kind, and why not when it doesn't. */
  gate: GateFn;
  onClose: () => void;
  /** Select this element in the accessibility tree — the other half of the existing tree→viewport sync. */
  onReveal: (key: string) => void;
  send: (message: ClientMessage) => void;
}

const SCROLL_DIRECTIONS: { direction: MobileDirection; glyph: string }[] = [
  { direction: 'up', glyph: '↑' },
  { direction: 'down', glyph: '↓' },
  { direction: 'left', glyph: '←' },
  { direction: 'right', glyph: '→' },
];

/**
 * Right-click context menu anchored to a device element. Lists ranked locator candidates (best-first,
 * with confidence + fragility warnings), shows the element's own attributes, and offers every action the
 * IR can express against the chosen candidate — mirroring Maestro Studio's element-to-command flow but
 * generating PWTAP's own `MobileAction`s. Actions the connected driver refuses are disabled with the
 * reason as their tooltip, and the candidate list is a radiogroup with arrow-key navigation.
 *
 * Two things every action here shares. It **records**, because choosing a locator from a menu is an explicit
 * "write this down" in a way a click on the screen is not (see `recordsThisGesture`). And it can be recorded
 * *without* running, via the checkbox — the only honest way to record an assertion about a state the screen
 * is not in yet, which is why `assertNotVisible` always took that path.
 */
export function LocatorMenu({
  anchor,
  candidates,
  node,
  loading,
  gate,
  onClose,
  onReveal,
  send,
}: LocatorMenuProps) {
  const [selected, setSelected] = useState(0);
  const [prompt, setPrompt] = useState<'fill' | 'aiAssert' | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [recordOnly, setRecordOnly] = useState(false);
  const candidateRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const returnFocusRef = useRef<Element | null>(null);

  // A fresh hit-test starts over: first candidate selected, and focus moves into the menu so the
  // list is reachable by keyboard rather than only by pointer.
  useEffect(() => {
    setSelected(0);
    setPrompt(null);
    setPromptValue('');
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

  /**
   * Send one action built from the selected candidate and close.
   *
   * `alwaysRecordOnly` is for the actions that cannot be executed against the current screen: asserting an
   * element is absent while looking straight at it would fail every time, so it is written down and not run.
   */
  function submit(build: (locator: MobileLocator) => MobileAction, alwaysRecordOnly = false): void {
    if (candidate) {
      const action = build(candidate.locator);
      send(
        recordOnly || alwaysRecordOnly ? { type: 'record', action } : { type: 'perform', action },
      );
    }
    onClose();
  }

  async function copy(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    onClose();
  }

  function submitPrompt(): void {
    if (!candidate || !prompt) {
      return;
    }
    submit(locator =>
      prompt === 'fill'
        ? { kind: 'fill', locator, value: promptValue }
        : { kind: 'aiAssert', rubric: promptValue },
    );
  }

  // Clamp the menu inside the viewport.
  const style: React.CSSProperties = {
    left: Math.min(anchor.x, window.innerWidth - 320),
    top: Math.min(anchor.y, window.innerHeight - 460),
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

        {/* What the driver actually reports about this element. The ranking above answers "how do I address
            it"; this answers "is it even the thing I meant", which a score cannot. It arrived with every
            hit-test all along and was thrown away by the UI. */}
        {node && (
          <dl className="element-attributes">
            {attributeRows(node).map(([name, value]) => (
              <div className="element-attribute" key={name}>
                <dt className="muted">{name}</dt>
                <dd title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        )}

        {candidate && (
          <>
            <div className="locator-actions">
              <GatedAction
                gate={gate}
                kind="tap"
                onClick={() => submit(l => ({ kind: 'tap', locator: l }))}
              >
                Tap
              </GatedAction>
              <GatedAction
                gate={gate}
                kind="doubleTap"
                onClick={() => submit(l => ({ kind: 'doubleTap', locator: l }))}
              >
                Double tap
              </GatedAction>
              <GatedAction gate={gate} kind="fill" onClick={() => setPrompt('fill')}>
                Fill…
              </GatedAction>
              <GatedAction
                gate={gate}
                kind="eraseText"
                onClick={() => submit(l => ({ kind: 'eraseText', locator: l }))}
              >
                Erase text
              </GatedAction>
              <GatedAction
                gate={gate}
                kind="scrollUntilVisible"
                onClick={() => submit(l => ({ kind: 'scrollUntilVisible', locator: l }))}
              >
                Scroll into view
              </GatedAction>
              <GatedAction
                gate={gate}
                kind="longPress"
                onClick={() => submit(l => ({ kind: 'longPress', locator: l }))}
              >
                Long press
              </GatedAction>
              <GatedAction
                gate={gate}
                kind="waitFor"
                onClick={() => submit(l => ({ kind: 'waitFor', locator: l }))}
              >
                Wait
              </GatedAction>
              <GatedAction
                gate={gate}
                kind="assertVisible"
                onClick={() => submit(l => ({ kind: 'assertVisible', locator: l }))}
              >
                Assert visible
              </GatedAction>
              <GatedAction
                gate={gate}
                kind="assertNotVisible"
                // Never executed: the element is on screen right now, so running it would always fail.
                onClick={() => submit(l => ({ kind: 'assertNotVisible', locator: l }), true)}
              >
                Assert not visible
              </GatedAction>
              <GatedAction
                gate={gate}
                kind="isVisible"
                onClick={() => submit(l => ({ kind: 'isVisible', locator: l }))}
              >
                Is visible
              </GatedAction>
              <GatedAction
                gate={gate}
                kind="screenshot"
                onClick={() => submit(() => ({ kind: 'screenshot' }))}
              >
                Screenshot
              </GatedAction>
              <GatedAction gate={gate} kind="aiAssert" onClick={() => setPrompt('aiAssert')}>
                AI assert…
              </GatedAction>
            </div>

            {/* Scrolling a specific container, which the IR expresses as `scroll({ within })`. Maestro
                refuses it outright rather than scrolling the whole screen and pretending — that refusal
                arrives as the usual failure banner. */}
            <div className="locator-scroll">
              <span className="muted">Scroll inside</span>
              {SCROLL_DIRECTIONS.map(({ direction, glyph }) => (
                <GatedAction
                  key={direction}
                  gate={gate}
                  kind="scroll"
                  label={`Scroll ${direction} inside this element`}
                  onClick={() =>
                    submit(l => ({ kind: 'scroll', direction, options: { within: l } }))
                  }
                >
                  {glyph}
                </GatedAction>
              ))}
            </div>

            <div className="locator-actions">
              {/* Not driver actions — these work with no device at all. */}
              <button className="btn btn-small" onClick={() => void copy(candidate.display)}>
                Copy locator
              </button>
              <button
                className="btn btn-small"
                onClick={() => void copy(`await mobileApp.tap(${candidate.display});`)}
              >
                Copy as code
              </button>
              <button
                className="btn btn-small"
                disabled={!node?.key}
                title={node?.key ? undefined : 'this element has no identity to select'}
                onClick={() => {
                  if (node?.key) {
                    onReveal(node.key);
                  }
                  onClose();
                }}
              >
                Reveal in tree
              </button>
            </div>

            <label className="field field-checkbox locator-record-only">
              <input
                type="checkbox"
                checked={recordOnly}
                onChange={event => setRecordOnly(event.target.checked)}
              />
              write the step without running it
            </label>
          </>
        )}

        {candidate && prompt && (
          <form
            className="locator-fill"
            onSubmit={event => {
              event.preventDefault();
              submitPrompt();
            }}
          >
            <input
              autoFocus
              value={promptValue}
              onChange={event => setPromptValue(event.target.value)}
              placeholder={prompt === 'fill' ? 'Value to fill' : 'What must be true on this screen'}
              aria-label={prompt === 'fill' ? 'Value to fill' : 'Rubric to assert'}
            />
            <button className="btn btn-small btn-primary" type="submit">
              Apply
            </button>
            <button className="btn btn-small" type="button" onClick={() => setPrompt(null)}>
              Cancel
            </button>
          </form>
        )}
      </div>
    </>
  );
}

/** The element's own attributes, skipping the ones this node does not carry. */
function attributeRows(node: MobileNode): [string, string][] {
  const rows: [string, string | undefined][] = [
    ['class', node.className],
    ['text', node.text],
    ['a11y', node.accessibilityId],
    ['id', node.resourceId],
    ['package', node.appPackage],
    [
      'bounds',
      node.bounds
        ? `${node.bounds.x},${node.bounds.y} ${node.bounds.width}×${node.bounds.height}`
        : undefined,
    ],
    // Only when explicitly false: a driver that reports nothing means "default", not "disabled".
    ['enabled', node.enabled === false ? 'false' : undefined],
    ['checked', node.checked === undefined ? undefined : String(node.checked)],
  ];
  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}

/** An action button that disables itself when the connected driver refuses the kind, stating why. */
function GatedAction({
  gate,
  kind,
  onClick,
  label,
  children,
}: {
  gate: GateFn;
  kind: MobileAction['kind'];
  onClick: () => void;
  /** Accessible name, for the icon-only buttons whose glyph says nothing to a screen reader. */
  label?: string;
  children: React.ReactNode;
}) {
  const { supported, reason } = gate(kind);
  return (
    <button
      className="btn btn-small"
      onClick={onClick}
      disabled={!supported}
      title={reason ?? label}
      aria-label={label}
    >
      {children}
    </button>
  );
}
