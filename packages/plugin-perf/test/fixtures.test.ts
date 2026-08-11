/**
 * The `budget` fixture's bounded wait, against a page that never goes quiet.
 *
 * The settle budget is what keeps a page with polling or a websocket from stalling the suite, and it is only as
 * bounded as the read that follows it: a record promise resolves on `requestfinished` / `requestfailed`, so awaiting
 * one that is still open would hang past the deadline no matter how short the deadline was. A fake page is enough to
 * pin that down — the browser adds nothing to the question.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Page, Request, TestInfo } from '@playwright/test';

import { provideBudget, type PageResources } from '../src/fixtures.js';

type Handler = (request: Request) => void;

/** A page that records handlers and lets the test fire the request events itself. */
function fakePage(): { page: Page; emit: (event: string, request: Request) => void } {
  const handlers = new Map<string, Set<Handler>>();
  const page = {
    on(event: string, handler: Handler): void {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
    },
    off(event: string, handler: Handler): void {
      handlers.get(event)?.delete(handler);
    },
    async waitForTimeout(ms: number): Promise<void> {
      await new Promise(resolve => setTimeout(resolve, ms));
    },
  } as unknown as Page;
  return {
    page,
    emit: (event, request) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(request);
      }
    },
  };
}

function fakeRequest(url: string, resourceType: string, bytes: number): Request {
  return {
    url: () => url,
    resourceType: () => resourceType,
    sizes: async () => ({
      requestBodySize: 0,
      requestHeadersSize: 0,
      responseBodySize: bytes,
      responseHeadersSize: 0,
    }),
  } as unknown as Request;
}

function fakeTestInfo(): TestInfo {
  return {
    annotations: [],
    attach: async (): Promise<void> => {},
  } as unknown as TestInfo;
}

test('collect() measures what arrived instead of hanging on a request that never finishes', async () => {
  const { page, emit } = fakePage();
  const document = fakeRequest('https://app/index.html', 'document', 12_000);
  const stream = fakeRequest('https://app/events', 'fetch', 0);

  let quiet: PageResources | undefined;
  let afterStream: PageResources | undefined;

  await provideBudget(
    { page, perfBudget: {} },
    async budget => {
      emit('request', document);
      emit('request', stream);
      emit('requestfinished', document);

      // The stream is still open, so the settle wait runs to its deadline — and the read has to return anyway.
      quiet = await budget.collect({ settleMs: 200 });

      // Once it does settle, the next collect() counts it: it was left pending, not dropped.
      emit('requestfinished', stream);
      afterStream = await budget.collect({ settleMs: 0 });
    },
    fakeTestInfo(),
  );

  assert.equal(quiet?.requests, 1);
  assert.equal(quiet?.totalBytes, 12_000);
  assert.equal(afterStream?.requests, 2);
});
