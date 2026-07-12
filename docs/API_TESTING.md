# API Testing

A layered API-testing structure built on Playwright's `APIRequestContext`. Three layers keep tests
readable and the HTTP details in one place. The examples target the public
[Petstore v3](https://petstore3.swagger.io) API.

## The three layers

```
tests/api/*.api.ts          Layer 3 — tests: speak business language via services
        │
api/services/PetService.ts  Layer 2 — business operations (fetch by status, CRUD, derived queries)
        │
api/core/ApiClient.ts       Layer 1 — typed get/post/put/patch/delete over APIRequestContext
```

- **Layer 1 — `ApiClient`** (`api/core/`): a thin, typed wrapper over Playwright's
  `APIRequestContext`. Exposes `get/post/put/patch/delete`, builds absolute URLs from a base path,
  sends a default `Accept: application/json`, and normalizes every response into
  `ApiResponse<T>` (`{ status, ok, data, headers }`). Tests never touch the raw request context.
- **Layer 2 — services** (`api/services/`): turn raw HTTP into business operations and derive
  results the API doesn't offer directly (e.g. "available pets in a category" = fetch a list, then
  filter). This is where domain logic lives — not in the test.
- **Layer 3 — tests** (`tests/api/*.api.ts`): use the service (and, where useful, the client) and
  assert. Nothing HTTP-specific here.

## How it's wired

- **Base URL** comes from `API_BASE_URL` in `env/environments.json` (separate from the UI
  `BASE_URL`). `ApiClient` concatenates it as an absolute base, because the Petstore root has a path
  (`/api/v3`) that Playwright's `baseURL` join would otherwise drop for leading-slash paths.
- **Fixtures** (`fixtures/apiFixtures.ts`) provide `apiClient` (layer 1) and `petService` (layer 2),
  built on Playwright's `request` fixture. The `api` project in `playwright.config.ts` runs
  `tests/api/*.api.ts` **without a browser**.

```bash
npm run test:api          # playwright test --project=api
```

## Writing a test

```typescript
import { test, expect } from '@fixtures/apiFixtures';

test('available pets are all "available"', async ({ petService }) => {
  const pets = await petService.findAvailable();
  expect(pets.length).toBeGreaterThan(0);
  expect(pets.every(p => p.status === 'available')).toBeTruthy();
});
```

Drop to the base client when you want to assert on the raw HTTP shape:

```typescript
test('raw response shape', async ({ apiClient }) => {
  const res = await apiClient.get('/pet/findByStatus', { params: { status: 'pending' } });
  expect(res.ok).toBeTruthy();
  expect(res.status).toBe(200);
});
```

## Adding your own resource

1. **Model** — add domain types under `api/models/` (e.g. `order.ts`).
2. **Service** — add `api/services/OrderService.ts` that takes an `ApiClient` and exposes business
   methods:

   ```typescript
   export class OrderService {
     constructor(private readonly client: ApiClient) {}

     async place(order: Order): Promise<Order> {
       const res = await this.client.post<Order>('/store/order', { data: order });
       if (!res.ok) throw new Error(`placeOrder failed: HTTP ${res.status}`);
       return res.data;
     }
   }
   ```

3. **Fixture** — expose it in `fixtures/apiFixtures.ts`:

   ```typescript
   export const test = base.extend<ApiFixtures>({
     apiClient: async ({ request }, use) => use(new ApiClient(request, process.env.API_BASE_URL)),
     petService: async ({ apiClient }, use) => use(new PetService(apiClient)),
     orderService: async ({ apiClient }, use) => use(new OrderService(apiClient)),
   });
   ```

4. **Test** — write `tests/api/order.api.ts` using `orderService`.

## Pointing at your own API

Change `API_BASE_URL` in `env/environments.json` to your API root, then replace the Petstore-specific
services/models with your own. The `ApiClient` (layer 1) and fixtures stay the same.
