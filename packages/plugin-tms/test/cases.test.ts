/**
 * The Qase side of case sync: the suite tree, and the two read/write asymmetries in Qase's own API.
 *
 * `tags` come back as `{ title }` objects and go out as plain strings; `suite_id` comes back as a number
 * you have to resolve and goes out as one you have to create. Getting either backwards is a sync that
 * looks like it worked and puts every case at the root with no tags.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCases, listCases, updateCase } from '../src/providers/qase/cases.js';
import { QaseClient } from '../src/providers/qase/client.js';
import { QASE_DEFAULT_BASE_URL, type QaseConfig } from '../src/providers/qase/config.js';
import { ensurePath, loadSuites, pathKey } from '../src/providers/qase/suites.js';

const config: QaseConfig = {
  token: 'tok',
  project: 'DEMO',
  baseUrl: QASE_DEFAULT_BASE_URL,
  runId: '',
};

/** A `fetch` that answers by path, and records every request it was given. */
function routed(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const doFetch = (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    seen.push({ url, method, body });
    const key = Object.keys(routes).find(candidate => url.includes(candidate));
    const value = key === undefined ? {} : routes[key];
    const result = typeof value === 'function' ? (value as (b: unknown) => unknown)(body) : value;
    return Promise.resolve(new Response(JSON.stringify({ status: true, result })));
  };
  return {
    doFetch,
    seen,
    client: new QaseClient(config, { fetch: doFetch, sleep: () => Promise.resolve() }),
  };
}

test('a flat suite list becomes a path index in both directions', async () => {
  const { client } = routed({
    '/suite/DEMO': {
      total: 3,
      entities: [
        { id: 1, title: 'checkout', parent_id: null },
        { id: 2, title: 'cart', parent_id: 1 },
        { id: 3, title: 'orphaned-parent', parent_id: 99 },
      ],
    },
  });

  const index = await loadSuites(client);

  assert.equal(index.byPath.get(pathKey(['checkout', 'cart'])), 2);
  assert.deepEqual(index.pathById.get(2), ['checkout', 'cart']);
  assert.equal(
    index.byPath.has(pathKey(['orphaned-parent'])),
    false,
    'a missing parent yields no path',
  );
});

test('a cycle in the suite tree is survived rather than recursed into', async () => {
  const { client } = routed({
    '/suite/DEMO': {
      entities: [
        { id: 1, title: 'a', parent_id: 2 },
        { id: 2, title: 'b', parent_id: 1 },
      ],
    },
  });

  const index = await loadSuites(client);
  assert.ok(index.byPath.size <= 2);
});

test('ensurePath reuses what exists and creates only what is missing', async () => {
  let nextId = 10;
  const { client, seen } = routed({
    '/suite/DEMO': (body: unknown) =>
      body === undefined
        ? { entities: [{ id: 1, title: 'checkout', parent_id: null }] }
        : { id: nextId++ },
  });

  const index = await loadSuites(client);
  const id = await ensurePath(client, index, ['checkout', 'cart', 'totals']);

  assert.equal(id, 11);
  const creates = seen.filter(request => request.method === 'POST');
  assert.deepEqual(
    creates.map(request => request.body),
    [
      { title: 'cart', parent_id: 1 },
      { title: 'totals', parent_id: 10 },
    ],
    'checkout already existed and is not recreated',
  );
});

test('ensurePath is idempotent within a run — the second call creates nothing', async () => {
  let nextId = 10;
  const { client, seen } = routed({
    '/suite/DEMO': (body: unknown) => (body === undefined ? { entities: [] } : { id: nextId++ }),
  });

  const index = await loadSuites(client);
  const first = await ensurePath(client, index, ['a', 'b']);
  const before = seen.filter(request => request.method === 'POST').length;
  const second = await ensurePath(client, index, ['a', 'b']);

  assert.equal(first, second);
  assert.equal(seen.filter(request => request.method === 'POST').length, before);
});

test('reading a case turns tag objects into strings and suite_id into a path', async () => {
  const { client } = routed({
    '/suite/DEMO': { entities: [{ id: 5, title: 'cart', parent_id: null }] },
    '/case/DEMO': {
      entities: [
        { id: 1, title: 'a', suite_id: 5, tags: [{ title: 'smoke' }, {}], isManual: false },
        { id: 2, title: 'b', suite_id: null, tags: [], automation: 2 },
        { id: 3, title: 'c', suite_id: 5, tags: [], automation: 0 },
      ],
    },
  });

  const index = await loadSuites(client);
  const cases = await listCases(client, index);

  assert.deepEqual(cases[0], {
    id: '1',
    title: 'a',
    suitePath: ['cart'],
    tags: ['smoke'],
    requirements: [],
    automated: true,
  });
  assert.equal(cases[1].automated, true, 'an old case has only the deprecated automation integer');
  assert.equal(cases[2].automated, false);
});

test('creating cases sends plain tag strings, isManual false, and one suite call per distinct path', async () => {
  let nextSuite = 10;
  const { client, seen } = routed({
    '/case/DEMO/bulk': { ids: [101, 102] },
    '/suite/DEMO': (body: unknown) => (body === undefined ? { entities: [] } : { id: nextSuite++ }),
  });

  const index = await loadSuites(client);
  const created = await createCases(client, index, [
    { ref: 'one', title: 'a', suitePath: ['cart'], tags: ['smoke'], requirements: [] },
    { ref: 'two', title: 'b', suitePath: ['cart'], tags: [], requirements: [] },
  ]);

  assert.deepEqual(created, [
    { ref: 'one', id: '101' },
    { ref: 'two', id: '102' },
  ]);

  const bulk = seen.find(request => request.url.includes('/bulk'))?.body as {
    cases: Array<Record<string, unknown>>;
  };
  assert.deepEqual(bulk.cases[0], { title: 'a', suite_id: 10, tags: ['smoke'], isManual: false });
  assert.equal(bulk.cases[1].tags, undefined, 'an empty tag list is omitted, not sent as []');
  assert.equal(
    seen.filter(request => request.method === 'POST' && request.url.endsWith('/suite/DEMO')).length,
    1,
    'both cases share a suite path, so it is created once',
  );
});

test('a bulk response with the wrong number of ids refuses to guess', async () => {
  const { client } = routed({
    '/case/DEMO/bulk': { ids: [101] },
    '/suite/DEMO': { entities: [] },
  });

  const index = await loadSuites(client);
  await assert.rejects(
    () =>
      createCases(client, index, [
        { ref: 'one', title: 'a', suitePath: [], tags: [], requirements: [] },
        { ref: 'two', title: 'b', suitePath: [], tags: [], requirements: [] },
      ]),
    /refusing to guess which id belongs to which test/,
  );
});

test('deprecating looks the status option up by slug instead of hard-coding an integer', async () => {
  const { client, seen } = routed({
    '/suite/DEMO': { entities: [] },
    '/system-fields': {
      entities: [{ slug: 'status', options: [{ id: 7, slug: 'deprecated', title: 'Deprecated' }] }],
    },
    '/case/DEMO/9': {},
  });

  const index = await loadSuites(client);
  await updateCase(client, index, '9', { deprecated: true });

  const patch = seen.find(request => request.method === 'PATCH')?.body;
  assert.deepEqual(patch, { status: 7 });
});

test('a workspace with no deprecated option is told so, and nothing is changed', async () => {
  const { client, seen } = routed({
    '/suite/DEMO': { entities: [] },
    '/system-fields': { entities: [{ slug: 'status', options: [{ id: 1, slug: 'actual' }] }] },
  });

  const index = await loadSuites(client);
  await assert.rejects(
    () => updateCase(client, index, '9', { deprecated: true }),
    /no "deprecated" option on the Status field/,
  );
  assert.equal(seen.filter(request => request.method === 'PATCH').length, 0);
});

test('an empty patch makes no request at all', async () => {
  const { client, seen } = routed({ '/suite/DEMO': { entities: [] } });

  const index = await loadSuites(client);
  await updateCase(client, index, '9', {});

  assert.equal(seen.filter(request => request.method === 'PATCH').length, 0);
});
