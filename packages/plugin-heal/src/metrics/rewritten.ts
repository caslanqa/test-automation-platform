/**
 * Is the heal still in the code?
 *
 * The weakest of the three mask detectors, and labelled a heuristic wherever it is reported. It asks
 * the question directly: does the spec still contain the locator the heal wrote? If it does not,
 * somebody took it out — a `git revert`, a hand edit, a rewrite — and a heal that was removed is a heal
 * that did not hold.
 *
 * **Two earlier designs were wrong, and both looked right.** Asking git for the line history
 * (`log -L<line>,<line>`) fails twice over: the commit that *lands* the heal is itself a commit after
 * the heal, so every committed repair flags itself; and comparing git's `%aI` (offset-bearing) against
 * an ISO `Z` timestamp as strings makes every commit in a non-UTC timezone look later than it was.
 * Reading the file needs no clock and no repository, so neither mistake is available.
 *
 * Matching the whole file rather than the recorded line number is deliberate: lines move, and a heal
 * that is still present three lines down was not undone.
 *
 * @example
 * healsRemoved('/repo', heals).get(someHealId); // true when the locator is gone from the spec
 */
import fs from 'node:fs';
import path from 'node:path';

import type { HealLogEntry } from './healLog.js';

export function healsRemoved(
  projectDir: string,
  heals: readonly HealLogEntry[],
): Map<string, boolean> {
  const contents = new Map<string, string | undefined>();
  const read = (file: string): string | undefined => {
    if (!contents.has(file)) {
      try {
        contents.set(file, fs.readFileSync(path.join(projectDir, file), 'utf8'));
      } catch {
        contents.set(file, undefined);
      }
    }
    return contents.get(file);
  };

  const result = new Map<string, boolean>();
  for (const heal of heals) {
    const source = read(heal.file);
    // A file we cannot read says nothing. A deleted spec is a removed test, not a hidden bug, and a
    // detector gated at zero must not fire on an absence of evidence.
    result.set(
      heal.healId,
      source === undefined || heal.to === '' ? false : !source.includes(heal.to),
    );
  }
  return result;
}
