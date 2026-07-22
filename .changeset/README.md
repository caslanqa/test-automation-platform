# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets).

Add a changeset with `npm run changeset`, then version packages with `npm run version-packages`.
Publishing happens from CI (`.github/workflows/release.yml`) once packages land; until then
publish is dry-run only. The private `@pwtap/core-template` workspace is ignored (never published).
