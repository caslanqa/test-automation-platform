import fs from 'fs';
import path from 'path';

/** One Maestro flow command, as recorded in the debug `commands-*.json`. */
export interface MaestroStep {
  /** Human-readable label, e.g. `tapOn "Sign in"`. */
  label: string;
  /** Maestro status: `COMPLETED`, `FAILED`, `WARNED`, `SKIPPED`, … */
  status: string;
  /** Command duration in ms (from Maestro). */
  durationMs: number;
}

/**
 * Parse Maestro's per-command debug log (`<outputDir>/debug/commands-*.json`) into an ordered list of
 * steps. The fixture replays these as native Playwright `test.step()`s so the HTML report shows the
 * flow step-by-step and marks the failing step. Returns `[]` if the log is missing/unreadable (the
 * caller then falls back to the raw exit-code error).
 */
export function parseMaestroSteps(outputDir: string): MaestroStep[] {
  const debugDir = path.join(outputDir, 'debug');
  let entries: unknown;
  try {
    const file = fs
      .readdirSync(debugDir)
      .find(f => f.startsWith('commands') && f.endsWith('.json'));
    if (!file) {
      return [];
    }
    entries = JSON.parse(fs.readFileSync(path.join(debugDir, file), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) {
    return [];
  }
  // Maestro's array isn't in execution order — sort by the command timestamp (monotonic per run).
  const ordered = [...(entries as Array<Record<string, unknown>>)].sort((a, b) => {
    const ta = ((a.metadata ?? {}) as { timestamp?: number }).timestamp ?? 0;
    const tb = ((b.metadata ?? {}) as { timestamp?: number }).timestamp ?? 0;
    return ta - tb;
  });
  const steps: MaestroStep[] = [];
  for (const entry of ordered) {
    const label = commandLabel(entry.command as Record<string, unknown> | undefined);
    if (!label) {
      continue; // internal setup command (config/variables) — not a user-facing step
    }
    const meta = (entry.metadata ?? {}) as { status?: string; duration?: number };
    steps.push({ label, status: meta.status ?? 'UNKNOWN', durationMs: meta.duration ?? 0 });
  }
  return steps;
}

/**
 * Extract the real failure reason(s) from Maestro's `debug/maestro.log` — Maestro writes the cause
 * (e.g. `CommandFailed: Element not found: …`) there, not to stderr. Used to enrich the failing step's
 * error so the report shows WHY it failed, not just that it did. Returns `''` if unavailable.
 */
export function maestroFailureDetail(outputDir: string): string {
  let log: string;
  try {
    log = fs.readFileSync(path.join(outputDir, 'debug', 'maestro.log'), 'utf8');
  } catch {
    return '';
  }
  const reasons: string[] = [];
  for (const line of log.split('\n')) {
    const failed = /CommandFailed:\s*(.+)$/.exec(line);
    if (failed) {
      reasons.push(failed[1].trim());
    } else if (line.includes('[ERROR]')) {
      reasons.push(line.replace(/^.*\[ERROR\]\s*/, '').trim());
    }
  }
  return [...new Set(reasons)].slice(-4).join('\n');
}

const truncate = (value: unknown, max = 48): string => {
  const s = value == null ? '' : String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Best-effort selector summary (`"text"`) from a command's args — Maestro's shapes vary by command. */
function selector(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== 'object') {
    return '';
  }
  const sel = (args.selector ?? args.visible ?? args.condition ?? args) as Record<string, unknown>;
  const target = (sel?.visible ?? sel) as Record<string, unknown>;
  const value =
    target?.text ?? target?.textRegex ?? target?.id ?? target?.idRegex ?? target?.accessibilityText;
  return value ? `"${truncate(value)}"` : '';
}

/** Map a Maestro command object to a readable label, or `null` for internal setup commands to skip. */
function commandLabel(command: Record<string, unknown> | undefined): string | null {
  if (!command || typeof command !== 'object') {
    return null;
  }
  const [type, rawArgs] = Object.entries(command)[0] ?? [];
  if (!type) {
    return null;
  }
  // Maestro's command keys are inconsistent (some end in `Command`, some like `tapOnElement` don't).
  const name = type.replace(/Command$/, '');
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const sel = selector(args);
  switch (name) {
    case 'applyConfiguration':
    case 'defineVariables':
      return null;
    case 'launchApp':
      return `launchApp${args.appId ? ` "${String(args.appId)}"` : ''}`;
    case 'stopApp':
      return `stopApp${args.appId ? ` "${String(args.appId)}"` : ''}`;
    case 'tapOn':
    case 'tapOnElement':
      return `tapOn ${sel}`.trim();
    case 'doubleTapOn':
    case 'doubleTapOnElement':
      return `doubleTapOn ${sel}`.trim();
    case 'longPressOn':
    case 'longPressOnElement':
      return `longPressOn ${sel}`.trim();
    case 'assertCondition':
    case 'assertVisual':
      return `assert ${sel}`.trim();
    case 'inputText':
    case 'inputRandomText':
      return `inputText ${truncate(args.text)}`.trim();
    case 'eraseText':
      return 'eraseText';
    case 'takeScreenshot':
      return `takeScreenshot${args.path ? ` ${String(args.path)}` : ''}`;
    case 'scrollUntilVisible':
      return `scrollUntilVisible ${sel}`.trim();
    case 'scroll':
      return 'scroll';
    case 'swipe':
      return 'swipe';
    case 'back':
      return 'back';
    case 'waitForAnimationToEnd':
      return 'waitForAnimationToEnd';
    case 'runFlow':
      return `runFlow${args.sourceDescription ? ` ${String(args.sourceDescription)}` : ''}`;
    case 'runScript':
      return 'runScript';
    case 'openLink':
      return `openLink ${truncate(args.link)}`.trim();
    default:
      // Unknown command: show its name, plus a selector if it targets an element.
      return sel ? `${name} ${sel}`.trim() : name;
  }
}
