/**
 * Reporting a skip so it is not a silent gap in the run.
 *
 * A copy of the same helper in `mobile-core`, `plugin-maestro`, `plugin-appium` and `plugin-db`. Copied rather
 * than shared: the only package that already exports it is `@pwtap/mobile-core`, and depending on the mobile
 * runtime to print one console line would drag a device layer into a performance plugin.
 *
 * @example skipWithReason(testInfo, '[perf] could not reach http://localhost:3000/health: fetch failed');
 */
export function skipWithReason(
  testInfo: { skip(condition: boolean, description: string): void },
  reason: string,
): void {
  console.info(`  ↷ skipped — ${oneLine(reason)}`);
  testInfo.skip(true, reason);
}

/**
 * Keep the console to a single line; the annotation still carries the whole reason.
 *
 * `testInfo.skip(condition, description)` records the reason as an annotation, which reaches the HTML and JSON
 * reports and **no terminal reporter at all** — `list` and `line` print only a dash and the test name. So a
 * skipped test looks like an unexplained gap in the run unless the reason is printed too.
 */
function oneLine(reason: string): string {
  const first = reason.split('\n')[0]?.trim() ?? reason;
  const truncated = first.length > 200 ? `${first.slice(0, 199)}…` : first;
  return truncated === reason.trim() ? truncated : `${truncated} (full reason in the report)`;
}
