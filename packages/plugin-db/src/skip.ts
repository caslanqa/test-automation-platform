/**
 * Reporting a skip so it is not a silent gap in the run.
 *
 * @example skipWithReason(testInfo, '[db] could not reach the pg database: …');
 */
/**
 * Skip a test and say why where the reader will actually see it.
 *
 * `testInfo.skip(condition, description)` records the reason as an annotation, which reaches the HTML and JSON
 * reports and **no terminal reporter at all** — `list` and `line` print only a dash and the test name. So a
 * skipped test looked like an unexplained gap in the run, which is what a user reported. The console line puts
 * the reason next to the test; the annotation still carries it into the report.
 */
export function skipWithReason(
  testInfo: { skip(condition: boolean, description: string): void },
  reason: string,
): void {
  console.info(`  \u21B7 skipped \u2014 ${reason}`);
  testInfo.skip(true, reason);
}
