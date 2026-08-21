---
'@pwtap/plugin-db': patch
'@pwtap/plugin-perf': patch
---

Correct the CLI invocation in the README — `npx create-pwtap` is not a package

There is no `create-pwtap` package on the npm registry, and a scaffolded project does not get that bin
either, so `npx create-pwtap add db` fails with a 404 for anyone who has not globally installed
`@pwtap/create`. The documented invocation is `npx @pwtap/create add db`.

These two packages have no other change in this release, and the patch exists so the corrected README
actually reaches npmjs.com — a fix that only lands in the repository leaves the page every user reads
still telling them to run a command that does not resolve.
