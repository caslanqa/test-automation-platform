/**
 * `@pwtap/create` injection manifest for the test management plugin.
 *
 * Shaped like `heal`, not like the fixture plugins: **a reporter plus a CLI, no fixture and no
 * Playwright project.** Nothing a spec imports, so there is nothing to merge into `@fixtures`; and the
 * work — publishing results, syncing cases, building the traceability matrix — is either a reporter hook
 * or a command someone runs, never something that happens inside a test.
 *
 * The `reporter` field is the only injection point this needs. It splices one line into
 * `playwright.config.ts`'s reporter array, which is the only way the runner hands anyone `TestResult`
 * and its attachments.
 *
 * **`TMS_MODE` defaults to `off`.** Installing this plugin must not make a bare `npx playwright test`
 * reach the network, so the env key ships empty-ish and the reporter is inert until someone opts in.
 * `QASE_TESTOPS_API_TOKEN` ships as an empty string, exactly like `plugin-ai-judge`'s
 * `ANTHROPIC_API_KEY` — `env/environments.json` is gitignored and `environments.example.json` is the
 * tracked one, so the placeholder documents the key without committing a secret.
 *
 * Untyped, like every other plugin's manifest here: `@pwtap/create` is a devDependency-only scaffolder
 * with no published type surface, so the authority is `packages/create/src/manifest.ts` and a drift
 * shows up as an injection that silently does nothing — which is what `scripts/smoke-tms.mjs` asserts
 * against.
 *
 * @example
 * // in the client's playwright.config.ts, between the managed markers
 * ['@pwtap/plugin-tms/reporter', {}],
 */
export const manifest = {
  id: 'tms',
  name: '@pwtap/plugin-tms',
  devDependencies: {},
  scripts: {
    'tms:doctor': 'tms doctor',
    'tms:run:create': 'tms run create',
    'tms:run:complete': 'tms run complete',
  },
  envKeys: {
    TMS_PROVIDER: 'qase',
    TMS_MODE: 'off',
    QASE_TESTOPS_PROJECT: '',
    QASE_TESTOPS_API_TOKEN: '',
    QASE_TESTOPS_RUN_ID: '',
  },
  reporter: {
    // The removal match key, same contract as `playwrightProject.gateVar`.
    uniq: '@pwtap/plugin-tms/reporter',
    line: "    ['@pwtap/plugin-tms/reporter', {}],",
  },
  docs: [{ src: 'docs/TEST_MANAGEMENT.md', dest: 'docs/TEST_MANAGEMENT.md' }],
  readmeSection: [
    '## Test management',
    '',
    'Results, with every artifact, go to your test management tool — Qase today, via `TMS_PROVIDER`.',
    'Nothing happens until you ask: `TMS_MODE` is `off` by default, and a bare `npx playwright test`',
    'makes no network call.',
    '',
    '**1. Configure in `env/environments.json`**: `QASE_TESTOPS_PROJECT` and `TMS_MODE=testops`. Export',
    '`QASE_TESTOPS_API_TOKEN` from your secret store rather than committing it — the file is gitignored,',
    'but an exported variable always wins over it, which is what makes CI work.',
    '',
    '**2. Check the wiring before you need it**: `npm run tms:doctor` prints the provider, the mode, the',
    'run title it would use, and whether the project is actually reachable with that token.',
    '',
    '**3. Run.** `TMS_MODE=testops npx playwright test` opens a run titled `<branch> · <sha> · <env>`',
    'and publishes results in batches while it goes. The trace, video, screenshots and Playwright’s',
    '`error-context.md` are uploaded with the failure that produced them.',
    '',
    '**4. Sharding needs two extra commands**, because four shards are four processes and the first to',
    'finish would close the run on the other three:',
    '',
    '```bash',
    'npm run tms:run:create            # writes QASE_TESTOPS_RUN_ID to qase.env',
    'set -a && . ./qase.env && set +a  # every shard exports the same id',
    'npx playwright test --shard=1/4   # …and 2/4, 3/4, 4/4',
    'npm run tms:run:complete',
    '```',
    '',
    'Full guide, including the CI snippet and what each configuration key does: `docs/TEST_MANAGEMENT.md`.',
  ].join('\n'),
};

export default manifest;
