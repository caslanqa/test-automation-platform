import type { ClientMessage, MobileAction, TimelineEntry } from '../protocol';

interface TimelineProps {
  entries: TimelineEntry[];
  /** The step whose frame the viewport is showing, if any. */
  pinnedStepId: number | null;
  /** Show this step's screen in the viewport, or `null` to go back to the live device. */
  onPin: (stepId: number | null) => void;
  send: (message: ClientMessage) => void;
}

/**
 * Recorded-step list with per-item removal and undo/redo/clear controls.
 *
 * Each step that moved the screen also remembers the frame it produced, so clicking one shows what the device
 * looked like at that point — the "jump to any point and inspect" that made Maestro Studio's run view useful,
 * applied to the recording rather than to a replay. A pinned step puts the viewport in read-only mode: the
 * coordinates on a past screen do not address the live one, so acting on it would tap the wrong element.
 */
export function Timeline({ entries, pinnedStepId, onPin, send }: TimelineProps) {
  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <button className="btn btn-small" onClick={() => send({ type: 'undo' })}>
          Undo
        </button>
        <button className="btn btn-small" onClick={() => send({ type: 'redo' })}>
          Redo
        </button>
        <button className="btn btn-small" onClick={() => send({ type: 'clearTimeline' })}>
          Clear
        </button>
        {pinnedStepId !== null && (
          <button className="btn btn-small btn-primary" onClick={() => onPin(null)}>
            Back to live
          </button>
        )}
      </div>
      <ol>
        {entries.map((entry, i) => (
          <li
            key={entry.id}
            className={`timeline-item${entry.id === pinnedStepId ? ' active' : ''}`}
          >
            <button
              className="timeline-step"
              // A step with no frame has nothing to show: it was recorded without being run, or its frame
              // has aged out of retention. Saying so beats a button that appears to do nothing.
              disabled={entry.frameId === undefined}
              title={
                entry.frameId === undefined
                  ? 'no screen was captured for this step'
                  : 'show the screen after this step'
              }
              aria-pressed={entry.id === pinnedStepId}
              onClick={() => onPin(entry.id === pinnedStepId ? null : entry.id)}
            >
              <span className="muted timeline-index">{i + 1}</span>
              {describeAction(entry.action)}
            </button>
            <button
              className="btn btn-small btn-danger"
              aria-label={`Remove step ${i + 1}`}
              onClick={() => send({ type: 'removeAction', index: i })}
            >
              ✕
            </button>
          </li>
        ))}
        {entries.length === 0 && <li className="muted">no actions recorded yet</li>}
      </ol>
    </div>
  );
}

function describeAction(action: MobileAction): string {
  switch (action.kind) {
    case 'tap':
      return `tap(${describeLocator(action.locator)})`;
    case 'doubleTap':
      return `doubleTap(${describeLocator(action.locator)})`;
    case 'fill':
      return `fill(${describeLocator(action.locator)}, "${action.value}")`;
    case 'eraseText':
      return `eraseText(${describeLocator(action.locator)})`;
    case 'hideKeyboard':
      return 'hideKeyboard()';
    case 'longPress':
      return `longPress(${describeLocator(action.locator)})`;
    case 'swipe':
      return `swipe(${action.direction})`;
    case 'scroll':
      return `scroll(${action.direction})`;
    case 'scrollUntilVisible':
      return `scrollUntilVisible(${describeLocator(action.locator)})`;
    case 'drag':
      return 'drag(...)';
    case 'pinch':
      return `pinch(${action.scale})`;
    case 'pressKey':
      return `pressKey(${action.key})`;
    case 'back':
      return 'back()';
    case 'waitFor':
      return `waitFor(${describeLocator(action.locator)})`;
    // The boolean query, which was missing here and fell through to raw JSON in the step list.
    case 'isVisible':
      return `isVisible(${describeLocator(action.locator)})`;
    case 'assertVisible':
      return `assertVisible(${describeLocator(action.locator)})`;
    case 'assertNotVisible':
      return `assertNotVisible(${describeLocator(action.locator)})`;
    case 'screenshot':
      return `screenshot(${action.name ?? ''})`;
    case 'aiAssert':
      return `aiAssert("${action.rubric}")`;
    default:
      return JSON.stringify(action);
  }
}

function describeLocator(locator: {
  accessibilityId?: string;
  resourceId?: string;
  text?: string;
  index?: number;
  point?: { x: number; y: number };
  label?: string;
}): string {
  // Shown because it changes which element the step acts on, and a step that reads identically to the one
  // above it while resolving elsewhere is the hardest kind of recording to review.
  const nth = locator.index === undefined ? '' : ` #${locator.index}`;
  if (locator.accessibilityId) return `a11y=${locator.accessibilityId}${nth}`;
  if (locator.resourceId) return `id=${locator.resourceId}${nth}`;
  if (locator.text) return `text="${locator.text}"${nth}`;
  if (locator.point) return `(${locator.point.x}, ${locator.point.y})`;
  return locator.label ?? '?';
}
