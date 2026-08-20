---
name: db-state-verification
description: "When to verify state in the database rather than through the UI or the API, and how to do it without making tests order-dependent. Use when a criterion's observable is stored state, or when reviewing a test that touches the database."
requires: plugin:db
---

The database is a layer, and it is the right one for exactly one kind of criterion: **the observable
is stored state that no interface exposes.**

## When a DB assertion is correct

- A side effect with no API representation — an audit row, a soft-delete flag, a queued job.
- A migration or a constraint: the schema itself is the thing under test.
- Verifying that an action wrote _nothing_ — the negative case an API cannot show you.

## When it is wrong

- **Asserting what the API already returns.** If `GET /orders/1` shows the total, assert the response.
  A DB assertion there tests your knowledge of the schema, and it breaks on every refactor that does
  not change behaviour.
- **Reading a row to build a UI assertion.** That is two layers doing one job; pick one.
- **Seeding state the test then verifies.** A test that writes a row and asserts the row is present is
  testing the driver.

## Setup, not leakage

The plugin's fixtures give query assertions plus seed and reset, and the driver packages are peer
dependencies — the project brings its own Postgres, MySQL, MariaDB, SQLite or Mongo client.

`fullyParallel: true` is on, so shared mutable state is the hazard:

- Prefer data a test creates for itself, with a unique key, over a fixture row every test shares.
- If a reset is needed, scope it as narrowly as the test — a whole-schema reset makes every parallel
  test order-dependent, and turns one real failure into a cascade.
- Never assume test order. Two tests that seed the same key will race, and the loser reports a bug
  that does not exist.

## Reading a DB failure

Distinguish three things before changing anything:

1. **The value is wrong** — a product bug. The test is right.
2. **The row is missing** — either the action did not happen, or the transaction has not committed
   yet. The second one is a race, and a longer sleep is not the fix; wait for the observable the
   application actually publishes.
3. **The query failed** — schema drift or connection failure. Environment, not behaviour.
