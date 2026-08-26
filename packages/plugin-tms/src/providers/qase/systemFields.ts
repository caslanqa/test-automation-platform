/**
 * System field options, looked up by slug rather than hard-coded.
 *
 * Qase's `status`, `severity`, `priority` and `layer` are integers on the wire, and the public API
 * documentation never says which integer is which. Guessing one and writing it into somebody's test
 * repository is the kind of confident-wrong change that is only discovered by the person who later
 * cannot find their cases — so nothing here is a magic number. `GET /system-fields` returns each field
 * with its options, each option carrying an `id` and a `slug`, and the lookup uses those.
 *
 * One call per sync, cached. When a slug does not resolve, the caller is told exactly that rather than
 * being handed a plausible number.
 *
 * @example
 * const id = await optionId(client, 'status', 'deprecated'); // 2, or whatever this workspace uses
 */
import type { QaseClient } from './client.js';

interface SystemFieldOption {
  id: number;
  title?: string;
  slug?: string;
}

interface SystemField {
  title?: string;
  slug?: string;
  options?: SystemFieldOption[] | null;
}

const cache = new WeakMap<QaseClient, Promise<SystemField[]>>();

function load(client: QaseClient): Promise<SystemField[]> {
  const cached = cache.get(client);
  if (cached !== undefined) {
    return cached;
  }
  // Not `list`: this endpoint returns every field in one response and takes no pagination parameters.
  const pending = client
    .get<{ entities?: SystemField[] }>('/system-fields')
    .then(result => result.entities ?? []);
  cache.set(client, pending);
  return pending;
}

/**
 * The id of one option of one system field, matched on slug and falling back to a case-insensitive
 * title match — a workspace that renamed "Deprecated" keeps the slug, but the reverse has been seen.
 * Returns `undefined` when neither matches, which is a reportable fact, not a default.
 */
export async function optionId(
  client: QaseClient,
  fieldSlug: string,
  optionSlug: string,
): Promise<number | undefined> {
  const fields = await load(client);
  const field = fields.find(
    candidate =>
      (candidate.slug ?? candidate.title ?? '').toLowerCase() === fieldSlug.toLowerCase(),
  );
  const options = field?.options ?? [];
  const wanted = optionSlug.toLowerCase();
  return options.find(
    option =>
      (option.slug ?? '').toLowerCase() === wanted || (option.title ?? '').toLowerCase() === wanted,
  )?.id;
}
