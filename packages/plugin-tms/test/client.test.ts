/**
 * The Qase client. Every assertion runs against a stub `fetch` — the three things worth testing here
 * are exactly the three that a live call would make untestable: what happens on 429, what happens on
 * page two, and what the user reads when Qase says no.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { backoffMs, PAGE_SIZE, QaseApiError, QaseClient } from '../src/providers/qase/client.js';
import { QASE_DEFAULT_BASE_URL, type QaseConfig } from '../src/providers/qase/config.js';

const config: QaseConfig = {
  token: 'tok',
  project: 'DEMO',
  baseUrl: QASE_DEFAULT_BASE_URL,
  runId: '',
};

/** A `fetch` that replays a scripted list of responses and records the URLs it was asked for. */
function stubFetch(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const doFetch = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(
      new Response(JSON.stringify(next.body ?? { status: true, result: {} }), {
        status: next.status ?? 200,
        headers: next.headers,
      }),
    );
  };
  return { doFetch, calls };
}

const noSleep = (): Promise<void> => Promise.resolve();

test('sends the Token header and the JSON body', async () => {
  const { doFetch, calls } = stubFetch([{ body: { status: true, result: { id: 7 } } }]);
  const client = new QaseClient(config, { fetch: doFetch, sleep: noSleep });

  const result = await client.post<{ id: number }>('/run/DEMO', { title: 'x' });

  assert.deepEqual(result, { id: 7 });
  assert.equal(calls[0].url, 'https://api.qase.io/v1/run/DEMO');
  assert.equal((calls[0].init?.headers as Record<string, string>).Token, 'tok');
  assert.equal(calls[0].init?.body, JSON.stringify({ title: 'x' }));
});

test('retries a 429 and succeeds on the next attempt', async () => {
  const { doFetch, calls } = stubFetch([
    { status: 429, headers: { 'Retry-After': '0' } },
    { body: { status: true, result: { ok: 1 } } },
  ]);
  const client = new QaseClient(config, { fetch: doFetch, sleep: noSleep });

  assert.deepEqual(await client.get<{ ok: number }>('/project/DEMO'), { ok: 1 });
  assert.equal(calls.length, 2);
});

test('gives up after MAX_ATTEMPTS and reports the status', async () => {
  const { doFetch, calls } = stubFetch([{ status: 503 }]);
  const client = new QaseClient(config, { fetch: doFetch, sleep: noSleep });

  await assert.rejects(
    () => client.get('/project/DEMO'),
    (error: unknown) => error instanceof QaseApiError && error.status === 503,
  );
  assert.equal(calls.length, 4);
});

test('a 4xx is not retried and carries Qase’s own words', async () => {
  const { doFetch, calls } = stubFetch([
    {
      status: 422,
      body: {
        status: false,
        errorMessage: 'Data is invalid.',
        errorFields: [{ field: 'title', error: 'required' }],
      },
    },
  ]);
  const client = new QaseClient(config, { fetch: doFetch, sleep: noSleep });

  await assert.rejects(
    () => client.post('/case/DEMO', {}),
    (error: unknown) =>
      error instanceof QaseApiError &&
      error.message.includes('Data is invalid.') &&
      error.message.includes('title: required'),
  );
  assert.equal(calls.length, 1, 'a 422 is the caller’s fault — retrying it just repeats it');
});

test('an auth failure says which variable to look at', async () => {
  const { doFetch } = stubFetch([
    { status: 401, body: { status: false, errorMessage: 'Unauthorized' } },
  ]);
  const client = new QaseClient(config, { fetch: doFetch, sleep: noSleep });

  await assert.rejects(
    () => client.get('/project/DEMO'),
    (error: unknown) => error instanceof Error && error.message.includes('QASE_TESTOPS_API_TOKEN'),
  );
});

test('list walks every page rather than reading the first', async () => {
  const full = Array.from({ length: PAGE_SIZE }, (_unused, i) => ({ id: i }));
  const { doFetch, calls } = stubFetch([
    { body: { status: true, result: { total: PAGE_SIZE + 2, entities: full } } },
    {
      body: {
        status: true,
        result: { total: PAGE_SIZE + 2, entities: [{ id: 100 }, { id: 101 }] },
      },
    },
  ]);
  const client = new QaseClient(config, { fetch: doFetch, sleep: noSleep });

  const all = await client.list<{ id: number }>('/case/DEMO');

  assert.equal(all.length, PAGE_SIZE + 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /limit=100&offset=0/);
  assert.match(calls[1].url, /limit=100&offset=100/);
});

test('list stops on a short page without asking for another', async () => {
  const { doFetch, calls } = stubFetch([
    { body: { status: true, result: { entities: [{ id: 1 }] } } },
  ]);
  const client = new QaseClient(config, { fetch: doFetch, sleep: noSleep });

  assert.equal((await client.list('/case/DEMO')).length, 1);
  assert.equal(calls.length, 1);
});

test('backoff honours Retry-After, and grows without it', () => {
  assert.equal(backoffMs(1, '5'), 5000);
  assert.equal(backoffMs(3, '0'), 0);
  // A non-numeric Retry-After (the HTTP-date form) falls back to the exponential schedule rather than
  // to NaN, which would become an instant retry.
  assert.ok(backoffMs(1, 'Wed, 21 Oct 2026 07:28:00 GMT') >= 1000);
  assert.ok(backoffMs(1, null) >= 1000 && backoffMs(1, null) < 1250);
  assert.ok(backoffMs(3, null) >= 4000 && backoffMs(3, null) < 4250);
  assert.equal(backoffMs(1, '9999'), 60_000, 'a hostile Retry-After is capped');
});
