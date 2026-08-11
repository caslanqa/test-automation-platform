/**
 * Getting the measurements into the report, instead of into stdout where they die.
 *
 * A performance number that is only printed is lost: `list` and `line` scroll past it, CI keeps it in a log nobody
 * opens, and the HTML report — the artefact people actually read after a run — shows nothing at all. Worse, the run
 * that most needs its numbers is the one that failed, and that is exactly when the console is buried under a stack
 * trace.
 *
 * So every fixture does two things with what it measured: pushes a **one-line annotation** (visible next to the
 * test in the HTML report, and in the JSON reporter) and attaches the **full JSON** (openable in the report, and
 * machine-readable for anyone tracking a trend). This file holds the formatting, kept pure so the wording is unit
 * tested rather than eyeballed once.
 *
 * @example
 * vitalsSummary({ supported: [], lcp: 508.4, cls: 0.0021, ttfb: 129 });
 * // → 'lcp 508ms · cls 0.002 · ttfb 129ms'
 */
import type { BenchResult } from './bench.js';
import type { ResourceTotals } from './resources.js';
import type { VitalsSample } from './vitals.js';

/** kB/MB in the decimal units browsers and bundlers report, so the number matches what the reader compares to. */
export function bytes(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)} MB`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)} kB`;
  }
  return `${value} B`;
}

/** Whole milliseconds above 10 ms, one decimal below — precision the measurement does not have is noise. */
export function ms(value: number): string {
  return value >= 10 ? `${Math.round(value)}ms` : `${value.toFixed(1)}ms`;
}

/** The separator between summary fields. A middot survives a terminal, a Markdown table and the HTML report. */
const SEP = ' · ';

/**
 * The metrics worth a summary line, in the order a reader wants them: what the user waited for, then what the page
 * did to them. Deliberately not every field — `collect()`'s full sample goes in the attachment.
 */
const HEADLINE: Array<[keyof VitalsSample, (value: number) => string]> = [
  ['lcp', ms],
  ['cls', value => value.toFixed(3)],
  ['inp', ms],
  ['tbt', ms],
  ['ttfb', ms],
  ['fcp', ms],
  ['load', ms],
];

export function vitalsSummary(sample: VitalsSample): string {
  const parts = HEADLINE.filter(([key]) => typeof sample[key] === 'number').map(
    ([key, format]) => `${key} ${format(sample[key] as number)}`,
  );
  // A sample with nothing in it is possible — an unnavigated page on a browser with few entry types — and saying so
  // beats an empty annotation that reads like the fixture did not run.
  return parts.length > 0 ? parts.join(SEP) : 'nothing measured';
}

export function resourcesSummary(totals: ResourceTotals): string {
  const byType = Object.entries(totals.byType)
    .sort(([, a], [, b]) => b.bytes - a.bytes)
    .slice(0, 3)
    .map(([type, sums]) => `${type} ${bytes(sums.bytes)}`)
    .join(', ');
  const head = `${totals.requests} requests${SEP}${bytes(totals.totalBytes)}`;
  return byType ? `${head} (${byType})` : head;
}

export function benchSummary(result: BenchResult): string {
  return [
    `p50 ${ms(result.p50)}`,
    `p97.5 ${ms(result.p97_5)}`,
    `p99 ${ms(result.p99)}`,
    `${Math.round(result.rps)} req/s`,
    // Always present, never optional: a fast run that rejects half its requests is not a fast run.
    `${(result.errorRate * 100).toFixed(2)}% errors`,
  ].join(SEP);
}

/** Several bench runs in one test summarise as one line each, prefixed by what was hit. */
export function benchesSummary(results: BenchResult[]): string {
  if (results.length === 1) {
    return benchSummary(results[0]!);
  }
  return results.map(result => `${pathOf(result.url)} → ${benchSummary(result)}`).join(' | ');
}

/** The path, or the whole URL when it will not parse — a summary line should never be the thing that throws. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
