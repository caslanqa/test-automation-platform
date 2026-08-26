/**
 * Defects.
 *
 * Three things about Qase's defect API that shape this file:
 *
 * | Fact | Consequence |
 * |---|---|
 * | `POST /defect/{code}` **requires** `severity` as an integer | it is resolved through `GET /system-fields` by slug, never hardcoded — see `systemFields.ts` |
 * | `severity` comes back as a **string** on read | one more read/write asymmetry, hidden here |
 * | `GET /defect/{code}` has no search parameter — only `status` and pagination | deduplication lists the open defects and matches on title, which is why the title is derived deterministically |
 *
 * `Defect.runs` is read-only, so a defect cannot be attached to a run after the fact. The run id goes
 * into the body instead, which is what a human needs to reproduce it anyway.
 *
 * @example
 * const open = await listOpenDefects(client);
 * await createDefect(client, { title: '…', actualResult: '…' });
 */
import type { QaseClient } from './client.js';
import { optionId } from './systemFields.js';

/** The severity a defect opened from a failing automated test gets, by slug. */
export const DEFAULT_DEFECT_SEVERITY = 'major';

interface DefectRow {
  id?: number;
  title?: string;
}

export interface NewDefect {
  title: string;
  actualResult: string;
  /** Slug of the severity option, resolved against the workspace. */
  severity?: string;
}

/** Open defects only: a resolved one naming the same test is a regression, and deserves a new defect. */
export async function listOpenDefects(
  client: QaseClient,
): Promise<Array<{ id: string; title: string }>> {
  const rows = await client.list<DefectRow>(`/defect/${client.project}`, { status: 'open' });
  return rows
    .filter(row => row.id !== undefined && row.title !== undefined)
    .map(row => ({ id: String(row.id), title: row.title as string }));
}

export async function createDefect(client: QaseClient, defect: NewDefect): Promise<string> {
  const slug = defect.severity ?? DEFAULT_DEFECT_SEVERITY;
  const severity = await optionId(client, 'severity', slug);
  if (severity === undefined) {
    throw new Error(
      `this workspace has no "${slug}" option on the Severity field, and Qase requires one to create a ` +
        'defect. Nothing was created.',
    );
  }

  const result = await client.post<{ id: number }>(`/defect/${client.project}`, {
    title: defect.title,
    actual_result: defect.actualResult,
    severity,
  });
  return String(result.id);
}

/**
 * Mark a case as known-flaky.
 *
 * `is_flaky` is an integer field with no documented encoding — but unlike `status`, whose five named
 * options genuinely cannot be guessed, this is a boolean spelled as a number, and `1`/`0` is the only
 * encoding that has. A wrong value here fails loudly with a 422 rather than silently doing the wrong
 * thing, which is why it is written rather than deferred.
 */
export async function setCaseFlaky(
  client: QaseClient,
  caseId: string,
  flaky: boolean,
): Promise<void> {
  await client.patch<unknown>(`/case/${client.project}/${caseId}`, { is_flaky: flaky ? 1 : 0 });
}
