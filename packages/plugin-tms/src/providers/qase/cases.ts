/**
 * Reading and writing cases.
 *
 * Two asymmetries in Qase's API that a caller has to know about, and which this module hides:
 *
 * | Reading | Writing |
 * |---|---|
 * | `tags: [{ title, internal_id }]` | `tags: ['smoke']` — plain strings |
 * | `suite_id` — a number you must resolve against the suite tree | `suite_id` — one you must create first |
 * | `isManual` may be absent on older cases, with the deprecated `automation` integer instead | `isManual: false` |
 *
 * Creation goes through `POST /case/{code}/bulk`, which answers with `{ ids: [...] }` **in request
 * order**. That ordering is the only link between an input and its new id, so it is preserved here and
 * paired back with the caller's own `ref` rather than left to the caller to re-derive.
 *
 * @example
 * const created = await createCases(client, index, [{ ref: 'a', title: 'x', suitePath: ['cart'], tags: [] }]);
 */
import type { NewTmsCase, TmsCase, TmsCasePatch } from '../../provider.js';
import type { QaseClient } from './client.js';
import { ensurePath, pathKey, type SuiteIndex } from './suites.js';
import { optionId } from './systemFields.js';

interface QaseCase {
  id: number;
  title: string;
  suite_id?: number | null;
  tags?: Array<{ title?: string }>;
  isManual?: boolean;
  /** Deprecated in the API, still the only signal on cases created before `isManual` existed. */
  automation?: number;
}

/** `automation: 2` is Qase's own documented encoding for "automated" — the field's docstring says so. */
const AUTOMATION_AUTOMATED = 2;

function isAutomated(row: QaseCase): boolean {
  return row.isManual === undefined ? row.automation === AUTOMATION_AUTOMATED : !row.isManual;
}

export async function listCases(client: QaseClient, index: SuiteIndex): Promise<TmsCase[]> {
  const rows = await client.list<QaseCase>(`/case/${client.project}`);
  return rows.map(row => ({
    id: String(row.id),
    title: row.title,
    suitePath: row.suite_id == null ? [] : (index.pathById.get(row.suite_id) ?? []),
    tags: (row.tags ?? []).map(tag => tag.title ?? '').filter(title => title !== ''),
    automated: isAutomated(row),
  }));
}

/** Qase caps a bulk create; 100 keeps each request well inside the body-size limit too. */
export const BULK_SIZE = 100;

export async function createCases(
  client: QaseClient,
  index: SuiteIndex,
  cases: readonly NewTmsCase[],
): Promise<Array<{ ref: string; id: string }>> {
  if (cases.length === 0) {
    return [];
  }

  // Suites first, and only once per distinct path — several hundred cases usually share a handful.
  const suiteIds = new Map<string, number | undefined>();
  for (const item of cases) {
    const key = pathKey(item.suitePath);
    if (!suiteIds.has(key)) {
      suiteIds.set(key, await ensurePath(client, index, item.suitePath));
    }
  }

  const out: Array<{ ref: string; id: string }> = [];
  for (let offset = 0; offset < cases.length; offset += BULK_SIZE) {
    const batch = cases.slice(offset, offset + BULK_SIZE);
    const result = await client.post<{ ids?: number[] }>(`/case/${client.project}/bulk`, {
      cases: batch.map(item => ({
        title: item.title,
        ...(suiteIds.get(pathKey(item.suitePath)) === undefined
          ? {}
          : { suite_id: suiteIds.get(pathKey(item.suitePath)) }),
        ...(item.tags.length === 0 ? {} : { tags: item.tags }),
        isManual: false,
      })),
    });

    const ids = result.ids ?? [];
    if (ids.length !== batch.length) {
      throw new Error(
        `bulk create returned ${ids.length} ids for ${batch.length} cases — refusing to guess which id belongs to which test`,
      );
    }
    batch.forEach((item, position) => out.push({ ref: item.ref, id: String(ids[position]) }));
  }

  return out;
}

export async function updateCase(
  client: QaseClient,
  index: SuiteIndex,
  id: string,
  patch: TmsCasePatch,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    body.title = patch.title;
  }
  if (patch.tags !== undefined) {
    body.tags = patch.tags;
  }
  if (patch.suitePath !== undefined) {
    const suiteId = await ensurePath(client, index, patch.suitePath);
    if (suiteId !== undefined) {
      body.suite_id = suiteId;
    }
  }
  if (patch.deprecated === true) {
    const status = await optionId(client, 'status', 'deprecated');
    if (status === undefined) {
      throw new Error(
        'this workspace has no "deprecated" option on the Status field — nothing was changed. ' +
          'Run without --deprecate-orphans and retire the cases in Qase instead.',
      );
    }
    body.status = status;
  }

  if (Object.keys(body).length > 0) {
    await client.patch<unknown>(`/case/${client.project}/${id}`, body);
  }
}
