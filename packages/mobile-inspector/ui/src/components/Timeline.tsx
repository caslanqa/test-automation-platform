import type { ClientMessage, MobileAction } from '../protocol';

interface TimelineProps {
  actions: MobileAction[];
  send: (message: ClientMessage) => void;
}

/** Recorded-action list with per-item removal and undo/redo/clear controls. */
export function Timeline({ actions, send }: TimelineProps) {
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
      </div>
      <ol>
        {actions.map((action, i) => (
          <li key={i} className="timeline-item">
            <span>{describeAction(action)}</span>
            <button
              className="btn btn-small btn-danger"
              onClick={() => send({ type: 'removeAction', index: i })}
            >
              ✕
            </button>
          </li>
        ))}
        {actions.length === 0 && <li className="muted">no actions recorded yet</li>}
      </ol>
    </div>
  );
}

function describeAction(action: MobileAction): string {
  switch (action.kind) {
    case 'tap':
      return `tap(${describeLocator(action.locator)})`;
    case 'fill':
      return `fill(${describeLocator(action.locator)}, "${action.value}")`;
    case 'longPress':
      return `longPress(${describeLocator(action.locator)})`;
    case 'swipe':
      return `swipe(${action.direction})`;
    case 'scroll':
      return `scroll(${action.direction})`;
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
  point?: { x: number; y: number };
  label?: string;
}): string {
  if (locator.accessibilityId) return `a11y=${locator.accessibilityId}`;
  if (locator.resourceId) return `id=${locator.resourceId}`;
  if (locator.text) return `text="${locator.text}"`;
  if (locator.point) return `(${locator.point.x}, ${locator.point.y})`;
  return locator.label ?? '?';
}
