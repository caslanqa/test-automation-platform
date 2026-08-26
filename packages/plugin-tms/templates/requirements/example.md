---
id: EX-1
title: An expired card is rejected at checkout
status: draft
type: user-story
---

Delete this file once you have requirements of your own — it exists to show the shape, and its `draft`
status keeps it out of the coverage gate until you make it `valid`.

## Acceptance criteria

1. **AC-1** — Paying with a card whose expiry date has passed returns HTTP 422 with the code `card_expired`.
2. **AC-2** — The checkout page shows "Your card has expired" and the order is not created.
3. **AC-3** — A card expiring this month is still accepted, up to the last day.

## How a test claims one

Put the key in a `Requirement` annotation. `EX-1` covers the requirement as a whole; `EX-1#AC-1`
covers it **and** that one criterion.

```ts
test(
  'rejects an expired card',
  {
    annotation: { type: 'Requirement', description: 'EX-1#AC-1' },
  },
  async ({ request }) => {
    const response = await request.post('/payments', { data: { card: EXPIRED } });
    expect(response.status()).toBe(422);
  },
);
```

Then `npm run tms:trace` writes the matrix, and `npm run tms:gate` fails the build when a `valid`
requirement has no test — or has one that did not pass.
