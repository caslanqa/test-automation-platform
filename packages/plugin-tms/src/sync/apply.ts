/**
 * Executing a plan: create, link, update, and write the ids back into the specs.
 *
 * Order matters and is not arbitrary.
 *
 * 1. **Create first.** Nothing else can be written back until the ids exist.
 * 2. **Write back before updating.** If the update pass fails halfway, the ids are already committed to
 *    the source, so a re-run picks up where it stopped instead of creating a second set of cases.
 * 3. **Deprecate last**, and only when asked. It is the only step that takes something away.
 *
 * Edits are applied **bottom-up within each file**. Inserting text never adds a line, so an edit at
 * line 30 cannot move line 10 — but doing it in the other order would invalidate every offset after the
 * first insertion, and this file computes offsets from line numbers.
 *
 * A refusal from {@link insertQaseId} is not a failure: the case exists, only the link is unwritten. The
 * caller gets the file, the line and the exact snippet to paste, and the next sync will adopt the case
 * by title rather than create a second one.
 *
 * @example
 * const result = await applySync(provider, plan, { rootDir });
 * result.refusals; // [] when every id landed
 */
import fs from 'node:fs';
import path from 'node:path';

import type { TmsProvider } from '../provider.js';
import { insertQaseId } from './annotate.js';
import type { SyncPlan } from './diff.js';
import type { DiscoveredTest } from './discover.js';

export interface Refusal {
  file: string;
  line: number;
  title: string;
  reason: string;
  snippet: string;
}

export interface ApplyResult {
  created: number;
  adopted: number;
  updated: number;
  deprecated: number;
  /** How many ids reached a spec file. */
  written: number;
  refusals: Refusal[];
}

export interface ApplyOptions {
  /** Absolute path the plan's `file` fields are relative to — Playwright's `rootDir`. */
  rootDir: string;
  /** Mark orphaned cases deprecated in the tool. Off unless explicitly asked for. */
  deprecateOrphans?: boolean;
  /** Injected in tests. */
  readFile?: (file: string) => string;
  writeFile?: (file: string, source: string) => void;
}

interface PendingEdit {
  test: DiscoveredTest;
  id: string;
}

/**
 * Apply every pending edit, one file at a time.
 *
 * The whole file is read once, edited in memory and written once, so a partially-applied file is not a
 * state this can leave behind.
 */
function writeBack(
  edits: readonly PendingEdit[],
  options: ApplyOptions,
): { written: number; refusals: Refusal[] } {
  const read = options.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'));
  const write =
    options.writeFile ?? ((file: string, source: string) => fs.writeFileSync(file, source, 'utf8'));

  const byFile = new Map<string, PendingEdit[]>();
  for (const edit of edits) {
    const list = byFile.get(edit.test.file);
    if (list === undefined) {
      byFile.set(edit.test.file, [edit]);
    } else {
      list.push(edit);
    }
  }

  let written = 0;
  const refusals: Refusal[] = [];

  for (const [relative, fileEdits] of byFile) {
    const absolute = path.resolve(options.rootDir, relative);
    let source: string;
    try {
      source = read(absolute);
    } catch (error) {
      for (const edit of fileEdits) {
        refusals.push({
          file: relative,
          line: edit.test.line,
          title: edit.test.title,
          reason: `could not read the file: ${error instanceof Error ? error.message : String(error)}`,
          snippet: `annotation: { type: 'QaseID', description: '${edit.id}' }`,
        });
      }
      continue;
    }

    const original = source;
    const seen = new Set<string>();
    const ordered = [...fileEdits].sort(
      (left, right) => right.test.line - left.test.line || right.test.column - left.test.column,
    );

    for (const edit of ordered) {
      const site = `${edit.test.line}:${edit.test.column}`;
      if (seen.has(site)) {
        continue;
      }
      seen.add(site);

      const result = insertQaseId(source, edit.test.line, edit.test.column, Number(edit.id));
      if (result.ok && result.source !== undefined) {
        source = result.source;
        written += 1;
      } else {
        refusals.push({
          file: relative,
          line: edit.test.line,
          title: edit.test.title,
          reason: result.reason ?? 'could not place the annotation',
          snippet: result.snippet,
        });
      }
    }

    if (source !== original) {
      write(absolute, source);
    }
  }

  return { written, refusals };
}

export async function applySync(
  provider: TmsProvider,
  plan: SyncPlan,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const created = await provider.createCases(plan.create.map(entry => entry.case));
  const idByRef = new Map(created.map(item => [item.ref, item.id]));

  const edits: PendingEdit[] = [];
  for (const entry of plan.create) {
    const id = idByRef.get(entry.case.ref);
    // No call site of its own to hold an id — see DiscoveredTest.unwritableReason.
    if (id !== undefined && entry.test.unwritableReason === undefined) {
      edits.push({ test: entry.test, id });
    }
  }
  for (const entry of plan.adopt) {
    if (entry.test.unwritableReason === undefined) {
      edits.push({ test: entry.test, id: entry.caseId });
    }
  }

  const { written, refusals } = writeBack(edits, options);

  for (const entry of plan.update) {
    await provider.updateCase(entry.caseId, entry.patch);
  }

  let deprecated = 0;
  if (options.deprecateOrphans === true) {
    for (const orphan of plan.orphans) {
      await provider.updateCase(orphan.id, { deprecated: true });
      deprecated += 1;
    }
  }

  return {
    created: created.length,
    adopted: plan.adopt.length,
    updated: plan.update.length,
    deprecated,
    written,
    refusals,
  };
}
