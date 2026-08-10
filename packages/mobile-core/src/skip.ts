/**
 * Reporting a skip so it is not a silent gap in the run.
 *
 * @example skipWithReason(testInfo, '[maestro] android device "pixel9" was not found on this machine…');
 */
/**
 * Skip a test and say why where the reader will actually see it.
 *
 * `testInfo.skip(condition, description)` records the reason as an annotation, which reaches the HTML and JSON
 * reports and **no terminal reporter** — `list` and `line` print a dash and the test name, nothing more. A
 * skipped test therefore looked like an unexplained gap in the run. The console line puts the reason beside
 * the test; the annotation still carries it into the report.
 *
 * A per-package copy on purpose: `@pwtap/plugin-maestro`, `@pwtap/plugin-appium` and `@pwtap/plugin-db` each
 * own one, and `@pwtap/plugin-db` depends on neither this package nor `@pwtap/platform`, so there is no shared
 * home that would not mean adding a dependency to move four lines.
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
 * A device-unavailable message names every device on the machine and how to create a missing one, which is
 * exactly right in a report and buries the skip it was meant to explain when printed verbatim in a terminal.
 */
function oneLine(reason: string): string {
  const first = reason.split('\n')[0]?.trim() ?? reason;
  const truncated = first.length > 200 ? `${first.slice(0, 199)}…` : first;
  return truncated === reason.trim() ? truncated : `${truncated} (full reason in the report)`;
}
