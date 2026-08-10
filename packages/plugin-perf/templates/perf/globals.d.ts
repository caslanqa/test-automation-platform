/**
 * One gap in `@types/k6`, declared rather than papered over.
 *
 * k6 provides `console` at run time — it is how a scenario reports which target it is about to load — but
 * `@types/k6` does not declare it, and this project has no DOM lib (these scripts run in k6's own runtime, not a
 * browser and not Node). Adding `"DOM"` to `lib` would fix the error by pulling in hundreds of browser globals
 * that do not exist here, which trades one wrong type for many.
 *
 * Found by `npm run typecheck:perf` on the first run, which is the point of having it.
 */
declare const console: {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
};
