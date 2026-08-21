/**
 * Where a run's record lives, and how it is written safely.
 *
 * Concurrency here is easier than it looks: the reporter runs in the **main process**, not in
 * workers, so there is exactly one writer per process and a single `writeFileSync` at `onEnd`. The
 * real concurrency is `--shard` (N processes) and two developers' terminals, which the filename
 * handles by carrying the run id and the shard index — those never collide.
 *
 * The write itself reuses the precedent already in this repo (`plugin-ai-judge`'s verdict cache):
 * write to a uniquely-suffixed temp file, then rename. Readers ignore anything that is not `.json`,
 * so a half-written file is invisible rather than a parse error.
 *
 * The ISO timestamp is the filename **prefix** on purpose: it sorts lexicographically, which is what
 * makes pruning and "most recent N" a sort rather than N stat calls.
 *
 * @example
 * writeRun('/repo/.heal/runs', record);
 * readRuns('/repo/.heal/runs', { limit: 20 });
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { RUN_SCHEMA, type RunRecord } from '../types.js';

/** Default run directory, relative to the project root. */
export const RUNS_DIR = path.join('.heal', 'runs');

/** How many run records to keep. Small enough to read them all, long enough for a flake window. */
export const DEFAULT_KEEP = 50;

/** `2026-08-20T09:14:02.123Z` → `2026-08-20T09-14-02Z`, filename-safe and still sortable. */
export function stampFor(iso: string): string {
  return iso.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

/**
 * The run id inside a record's filename: `<stamp>-<runId>[-sN].json`.
 *
 * Matched rather than split, because the stamp contains dashes of its own (`2026-08-20T04-23-00Z`)
 * and so does nothing else here — a uuid split on the wrong dash silently prunes live evidence.
 */
export function runIdOf(fileName: string): string {
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-(.+?)(?:-s\d+)?\.json$/.exec(fileName);
  return match?.[1] ?? '';
}

export function runFileName(record: RunRecord): string {
  const shard = record.shard === undefined ? '' : `-s${record.shard.current}`;
  return `${stampFor(record.startedAt)}-${record.runId}${shard}.json`;
}

/** Write one run record. Never throws: losing history must not fail a test run. */
export function writeRun(dir: string, record: RunRecord): string | null {
  const target = path.join(dir, runFileName(record));
  const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`);
    fs.renameSync(temp, target);
    return target;
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing further to do; the caller already treats history as best-effort.
    }
    return null;
  }
}

export interface ReadRunsOptions {
  /** Keep only the most recent N records. */
  limit?: number;
}

/**
 * Read run records, newest first. A record with an unknown schema or unparseable content is skipped
 * rather than throwing — one bad file must not blind the whole triage.
 */
export function readRuns(dir: string, options: ReadRunsOptions = {}): RunRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const candidates = names
    .filter(name => name.endsWith('.json'))
    .sort()
    .reverse();
  const limited = options.limit === undefined ? candidates : candidates.slice(0, options.limit);

  const records: RunRecord[] = [];
  for (const name of limited) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as RunRecord;
      if (parsed.schema === RUN_SCHEMA && Array.isArray(parsed.tests)) {
        records.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return records;
}

/** Drop all but the newest `keep` records. Returns the names removed. */
export function pruneRuns(dir: string, keep: number = DEFAULT_KEEP): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  const stale = names
    .filter(name => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(keep);
  for (const name of stale) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch {
      continue;
    }
  }

  // Each run may also have kept a directory of error contexts beside it. Pruning the record without
  // the directory would leave the only unbounded thing this store writes growing forever.
  const live = new Set(
    names.filter(name => name.endsWith('.json') && !removed.includes(name)).map(runIdOf),
  );
  for (const name of names) {
    if (!name.endsWith('-context') || live.has(name.slice(0, -'-context'.length))) {
      continue;
    }
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      continue;
    }
  }
  return removed;
}
