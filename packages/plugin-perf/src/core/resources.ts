/**
 * Resource budgets: how many bytes and how many requests a page actually cost.
 *
 * Pure. The fixture collects records from Playwright's `requestfinished` event and hands them here, so the
 * arithmetic and the failure messages are unit tested without a browser.
 *
 * Bytes come from `request.sizes()` — real transfer size, headers included — not from `content-length`, which is
 * absent on every chunked or compressed-unknown response, and not from CDP, which would tie this to Chromium.
 *
 * @example
 * compareResources([{ url: 'https://x/app.js', resourceType: 'script', bytes: 900_000 }], { totalBytes: 500_000 });
 * // → ['total transfer 900 kB exceeds the 500 kB budget — largest: script https://x/app.js (900 kB)']
 */

/** One finished request. */
export interface ResourceRecord {
  url: string;
  /** Playwright's own classification: 'document', 'script', 'stylesheet', 'image', 'fetch', … */
  resourceType: string;
  /** Response body plus response headers, in bytes. */
  bytes: number;
}

/** Totals for a page, overall and per resource type. */
export interface ResourceTotals {
  totalBytes: number;
  requests: number;
  byType: Record<string, { bytes: number; requests: number }>;
}

/** Ceilings. `byType` keys are Playwright resource types; an unlisted type is unbudgeted. */
export interface ResourceBudget {
  totalBytes?: number;
  requests?: number;
  byType?: Record<string, number>;
}

/** How many offenders a failure message names before it stops being a report and becomes a log dump. */
const CULPRITS_SHOWN = 5;

export function totalsOf(records: ResourceRecord[]): ResourceTotals {
  const totals: ResourceTotals = { totalBytes: 0, requests: records.length, byType: {} };
  for (const record of records) {
    totals.totalBytes += record.bytes;
    const forType = (totals.byType[record.resourceType] ??= { bytes: 0, requests: 0 });
    forType.bytes += record.bytes;
    forType.requests += 1;
  }
  return totals;
}

/**
 * Every breached budget, each message naming what caused it.
 *
 * The naming is the point. A bare "1.7 MB exceeds 1.5 MB" sends the reader to the network tab to find out which
 * dependency someone added; listing the largest resources answers that in the failure itself.
 */
export function compareResources(records: ResourceRecord[], budget: ResourceBudget): string[] {
  const totals = totalsOf(records);
  const failures: string[] = [];

  if (budget.totalBytes !== undefined && totals.totalBytes > budget.totalBytes) {
    failures.push(
      `total transfer ${bytes(totals.totalBytes)} exceeds the ${bytes(budget.totalBytes)} budget — ` +
        `largest: ${largest(records)}`,
    );
  }

  if (budget.requests !== undefined && totals.requests > budget.requests) {
    const perType = Object.entries(totals.byType)
      .sort(([, a], [, b]) => b.requests - a.requests)
      .slice(0, CULPRITS_SHOWN)
      .map(([type, sums]) => `${type} ${sums.requests}`)
      .join(', ');
    failures.push(
      `${totals.requests} requests exceed the ${budget.requests} budget — by type: ${perType}`,
    );
  }

  for (const [type, limit] of Object.entries(budget.byType ?? {})) {
    const measured = totals.byType[type]?.bytes ?? 0;
    if (measured > limit) {
      failures.push(
        `${type} transfer ${bytes(measured)} exceeds the ${bytes(limit)} budget — ` +
          `largest: ${largest(records.filter(record => record.resourceType === type))}`,
      );
    }
  }

  return failures;
}

/** The biggest offenders, largest first. */
function largest(records: ResourceRecord[]): string {
  return [...records]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, CULPRITS_SHOWN)
    .map(record => `${record.resourceType} ${record.url} (${bytes(record.bytes)})`)
    .join(', ');
}

/** kB/MB in the decimal units browsers and bundlers report, so the number matches what the reader compares to. */
function bytes(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)} MB`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)} kB`;
  }
  return `${value} B`;
}
