/**
 * Whether a quarantined failure stops the run from going red.
 *
 * The distinction that matters: a quarantined test **still runs**. Every attempt executes, and the
 * HTML, JSON and Allure reports all carry the real failure with its trace and video. Only the run's
 * exit status is suppressed. That is the whole reason this exists instead of `test.fixme()`, which
 * never executes the test and therefore produces *no* evidence at all — coverage deleted quietly,
 * with nothing left to tell anyone it happened.
 *
 * @example
 * isShielded(entry, Date.now()); // false the moment expiresAt passes
 */
import type { QuarantineEntry } from './file.js';

export const isExpired = (entry: QuarantineEntry, now: number): boolean =>
  Date.parse(entry.expiresAt) <= now;

/** Shielded means: listed, and not yet expired. Expiry at exactly `expiresAt` is expired. */
export const isShielded = (entry: QuarantineEntry, now: number): boolean => !isExpired(entry, now);

export interface ShieldDecision {
  /** True when every unexpected failure in the run is covered by a live entry. */
  shield: boolean;
  /** Entries that covered a failure this run. */
  used: QuarantineEntry[];
  /** Failing test keys with no live entry — these are what keep the run red. */
  unshielded: string[];
  /** Entries that matched a failure but had already expired. */
  expired: QuarantineEntry[];
}

/**
 * Decide the run. `failedKeys` are the tests whose final outcome was `unexpected` — a `flaky`
 * outcome is already not a failure to Playwright, so it never reaches here.
 */
export function decideShield(
  failedKeys: readonly string[],
  entries: readonly QuarantineEntry[],
  now: number,
): ShieldDecision {
  const byKey = new Map(entries.map(entry => [entry.testKey, entry]));
  const used: QuarantineEntry[] = [];
  const expired: QuarantineEntry[] = [];
  const unshielded: string[] = [];

  for (const key of failedKeys) {
    const entry = byKey.get(key);
    if (entry === undefined) {
      unshielded.push(key);
    } else if (isShielded(entry, now)) {
      used.push(entry);
    } else {
      expired.push(entry);
      unshielded.push(key);
    }
  }

  // An empty failure list must not produce a shield: there is nothing to shield, and claiming one
  // would let a green run report a suppression it never made.
  return { shield: failedKeys.length > 0 && unshielded.length === 0, used, unshielded, expired };
}

/** Days remaining, rounded down; negative once expired. */
export const daysLeft = (entry: QuarantineEntry, now: number): number =>
  Math.floor((Date.parse(entry.expiresAt) - now) / 86_400_000);
