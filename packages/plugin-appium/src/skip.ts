/**
 * Reporting a skip so it is not a silent gap in the run.
 *
 * @example skipWithReason(testInfo, '[appium] no android device available — …');
 */
/**
 * Skip a test and say why where the reader will actually see it.
 *
 * `testInfo.skip(condition, description)` records the reason as an annotation, which reaches the HTML and JSON
 * reports and **no terminal reporter** — `list` and `line` print a dash and the test name, nothing more. A
 * skipped test therefore looked like an unexplained gap in the run. The console line puts the reason beside
 * the test; the annotation still carries it into the report.
 */
export function skipWithReason(
  testInfo: { skip(condition: boolean, description: string): void },
  reason: string,
): void {
  console.info(`  \u21B7 skipped \u2014 ${oneLine(reason)}`);
  testInfo.skip(true, reason);
}

/**
 * Keep the console to a single line; the annotation still carries the whole reason.
 *
 * A driver decides what its own errors look like, and some are paragraphs — Knex answers a missing `pg` with a
 * six-line require stack. Printed verbatim that buries the skip it was meant to explain, so the terminal gets
 * the first line and the report keeps the rest.
 */
function oneLine(reason: string): string {
  const first = reason.split('\n')[0]?.trim() ?? reason;
  const truncated = first.length > 200 ? `${first.slice(0, 199)}\u2026` : first;
  return truncated === reason.trim() ? truncated : `${truncated} (full reason in the report)`;
}
