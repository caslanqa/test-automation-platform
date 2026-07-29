---
'@pwtap/plugin-db': patch
'@pwtap/plugin-maestro': patch
'@pwtap/plugin-appium': patch
---

Say why a test was skipped in the terminal, not only in the report

A skipped test showed a dash and its name — no reason — so an unreachable database or an absent device looked
like an unexplained gap in the run. The reason was never missing: `testInfo.skip(condition, description)` records
it as a `skip` annotation, which the HTML and JSON reports read and **no terminal reporter prints**. The reason is
now printed beside the skip as well, and still recorded for the report.

Two things the live run through the packed tarballs then exposed, both about the reason itself rather than where
it goes: an uninstalled driver was reported as Knex's `Cannot find module 'pg'` plus a six-line require stack,
naming no fix, and is now `the pg driver is not installed — run \`npm i -D pg\``; and the console line is held to
one line whatever a driver decides to say, with the whole text still in the report.

Running the installed example against a real project then found three more, all in the same family — an option
that is EMPTY rather than absent, which is exactly what `create` writes into `env/environments.json` for a user to
fill in:

- The scaffolded example used `process.env.DB_CLIENT ?? 'pg'`. `??` falls back only on null/undefined, so the
  default never fired in the one case it existed for: an empty key reached Knex as a missing one and the reason
  read `could not create a  connection` — a sentence with a hole in it. Every template now uses `||`.
- `createSqlConnection` validates its own options instead of relaying Knex's `Required configuration option
'client' is missing`: an empty client, an unknown one (`postgresql` is the likely spelling) and an empty
  connection each name the thing to set.
- **An unconfigured MongoDB failed the test instead of skipping it.** `new MongoClient('')` throws a
  MongoParseError and was constructed outside the try, bypassing the return-a-reason contract entirely. Measured
  as `1 failed` on a scaffolded project. Both keys are now checked, and the constructor moved inside the try so a
  malformed URI is a reason like any other.
