/**
 * Where a requirement id lands on the Qase side.
 *
 * **Qase has no requirements API**, and its own traceability report is built from *external issues* —
 * a case linked to a Jira/GitHub/GitLab ticket. With no tracker configured there is nothing to link to,
 * so the requirement key goes into a **custom field on the test case**, which makes it visible,
 * filterable and QQL-searchable in Qase without inventing anything. When a tracker is later connected,
 * the same key moves to `POST /case/{code}/{id}/external-issues` and Qase's own matrix fills in; that is
 * the documented upgrade path, not a rewrite.
 *
 * **The field is never created here.** `POST /custom-fields` writes workspace-level schema, and a CLI
 * that reshapes someone's Qase project as a side effect of syncing tests is doing more than it was
 * asked. When the field is absent the sync says so once and carries on — the local matrix is the
 * deliverable, and this is the mirror.
 *
 * Naming note: the API documentation calls the map key an `internal_id`, but no schema declares a field
 * by that name — `GET /custom_field` returns `id`, and `TestCase.custom_fields[]` returns `{id, value}`.
 * `id` is what this uses.
 *
 * @example
 * const field = await requirementField(client);
 * // → { id: 12, title: 'Requirement' }, or undefined when the workspace has no such field
 */
import type { QaseClient } from './client.js';

/** The field title this looks for, overridable because "Requirement" may already mean something else. */
export const DEFAULT_REQUIREMENT_FIELD = 'Requirement';

export interface QaseCustomField {
  id: number;
  title: string;
}

interface CustomFieldRow {
  id?: number;
  title?: string;
  entity?: string;
  type?: string;
}

const cache = new WeakMap<QaseClient, Promise<CustomFieldRow[]>>();

function load(client: QaseClient): Promise<CustomFieldRow[]> {
  const cached = cache.get(client);
  if (cached !== undefined) {
    return cached;
  }
  const pending = client.list<CustomFieldRow>('/custom_field', { entity: 'case' });
  cache.set(client, pending);
  return pending;
}

/**
 * The case-entity custom field with this title, or `undefined`.
 *
 * Only `string`/`text` fields qualify. A `selectbox` would need the requirement key to exist as a
 * pre-defined option — the value written there is an option id, not the text — so writing a key into
 * one is rejected by the API, and picking it here would turn a clear "no field" into a confusing 422.
 */
export async function requirementField(
  client: QaseClient,
  title: string = DEFAULT_REQUIREMENT_FIELD,
): Promise<QaseCustomField | undefined> {
  const wanted = title.trim().toLowerCase();
  const match = (await load(client)).find(
    row =>
      (row.title ?? '').trim().toLowerCase() === wanted &&
      (row.type === undefined || row.type === 'string' || row.type === 'text'),
  );
  return match?.id === undefined ? undefined : { id: match.id, title: match.title ?? title };
}

/** The stored value for one case: a comma-separated key list, since the field holds a scalar string. */
export function encodeRequirements(requirements: readonly string[]): string {
  return [...new Set(requirements.map(key => key.trim()).filter(key => key !== ''))].join(',');
}

export function decodeRequirements(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(key => key.trim())
    .filter(key => key !== '');
}
