/**
 * Two fingerprints, not one, because the two questions a triage asks are different:
 *
 * - **`siteFingerprint`** — "is this the same failure, in the same place?" Clusters flakes and repeat
 *   offenders. Excludes the observed values, so a value that changes does not start a new cluster.
 * - **`errorFingerprint`** — "did the data change?" Adds the expected and received values on top.
 *
 * A single fingerprint answers neither well, and the split is load-bearing beyond tidiness: the
 * strongest heuristic for a *masked* heal is "the same site later failed with a value mismatch",
 * which cannot even be expressed if the site and the values share one hash.
 *
 * `TAXONOMY_VERSION` participates in both, so changing a pattern in `errorTaxonomy.ts` starts new
 * clusters instead of silently merging pre- and post-change failures.
 *
 * @example
 * const site = siteFingerprint({ kind: 'presence-timeout', matcher: 'toBeVisible',
 *   locatorCode: "getByRole('button')", topFrame: { file: 'tests/a.spec.ts', line: 12 } });
 */
import { createHash } from 'node:crypto';

import { TAXONOMY_VERSION, type ErrorKind } from '../types.js';
import { normalizeMessage } from './ansi.js';

const hash = (parts: Array<string | number | undefined>): string =>
  createHash('sha1')
    .update(parts.map(part => (part === undefined ? '' : String(part))).join('\0'))
    .digest('hex')
    .slice(0, 12);

export interface SiteInput {
  kind: ErrorKind;
  matcher?: string;
  locatorCode?: string;
  topFrame?: { file: string; line: number };
}

export function siteFingerprint(input: SiteInput): string {
  return hash([
    TAXONOMY_VERSION,
    input.kind,
    input.matcher,
    input.locatorCode,
    input.topFrame === undefined ? undefined : `${input.topFrame.file}:${input.topFrame.line}`,
  ]);
}

export interface ErrorInput extends SiteInput {
  expected?: string;
  received?: string;
  /** Falls back to the normalised message when the matcher reported no values. */
  message?: string;
  rootDir?: string;
}

export function errorFingerprint(input: ErrorInput): string {
  // With no values to compare, the normalised message is the only thing that distinguishes two
  // failures at the same site — and normalising it is what keeps a line number or a port out.
  const values =
    input.expected === undefined && input.received === undefined
      ? normalizeMessage(input.message ?? '', { rootDir: input.rootDir })
      : `${input.expected ?? ''}${input.received ?? ''}`;
  return hash([siteFingerprint(input), values]);
}
