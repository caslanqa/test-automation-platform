/**
 * `@pwtap/create` injection manifest for the healing plugin.
 *
 * **No fixture and no Playwright project.** A reporter plus a CLI covers triage, run history and
 * quarantine entirely, and every millisecond a fixture would cost lands on the hot path of a green
 * run. The one new thing this plugin needs from the injector is the `reporter` field — a line
 * spliced into `playwright.config.ts`'s `reporter` array, which is the only way the runner can hand
 * us `TestCase.outcome()` (where `flaky` lives) and the run's exit status.
 *
 * **No env keys.** What to triage is a run that already happened, and the policy lives in a
 * committed file. Nothing here is deployment configuration.
 *
 * Untyped, like every other plugin's manifest in this repo: `@pwtap/create` is a devDependency-only
 * scaffolder with no published type surface, so the authority is `packages/create/src/manifest.ts`
 * and a drift shows up as an injection that silently does nothing — which is what
 * `scripts/smoke-heal.mjs` asserts against.
 *
 * @example
 * // in the client's playwright.config.ts, between the managed markers
 * ['@pwtap/plugin-heal/reporter', { runsDir: '.heal/runs' }],
 */
export const manifest = {
  id: 'heal',
  name: '@pwtap/plugin-heal',
  devDependencies: {},
  scripts: {
    'heal:triage': 'heal triage',
    'heal:propose': 'heal propose',
    'heal:gate': 'heal gate',
    'heal:quarantine': 'heal quarantine list',
    'heal:calibrate': 'heal calibrate',
    'heal:metrics': 'heal metrics',
    'heal:baseline': 'heal baseline',
  },
  envKeys: {},
  reporter: {
    // The removal match key, same contract as `playwrightProject.gateVar`.
    uniq: '@pwtap/plugin-heal/reporter',
    line: "    ['@pwtap/plugin-heal/reporter', { runsDir: '.heal/runs' }],",
  },
  examples: [
    // The starter case set. Copied once and never overwritten, because the moment a team labels its own
    // failures this file stops being ours — and grading a classifier against somebody else's examples is
    // the one thing calibration must not do.
    { src: 'templates/heal/triage-cases.json', dest: 'heal/triage-cases.json' },
    // Workflows rather than doc snippets, for the reason the judge's calibration workflow is one: the
    // nightly check is the part teams skip when it has to be written from scratch. Both skip with a
    // notice rather than failing red until there is something for them to read.
    {
      src: 'templates/workflows/heal-calibration.yml',
      dest: '.github/workflows/heal-calibration.yml',
    },
    { src: 'templates/workflows/heal-history.yml', dest: '.github/workflows/heal-history.yml' },
  ],
  docs: [{ src: 'docs/HEALING.md', dest: 'docs/HEALING.md' }],
  readmeSection: [
    '## Failure triage and flake detection',
    '',
    'Every run writes a typed record to `.heal/runs/` (gitignored). Nothing else happens on its own —',
    'the reporter records, and you ask:',
    '',
    '```bash',
    'npm run heal:triage      # classify this run: flaky / locator-drift / true-fail / env-infra',
    'npm run heal:propose     # rank locator replacements, prove one, verify it — nothing applied',
    'npm run heal:gate        # CI gate: quarantine budget + unshielded failures',
    'npm run heal:quarantine  # what is quarantined, and for how much longer',
    '```',
    '',
    'A **value mismatch is never healed**. If `Expected: "Welcome, Ada"` meets',
    '`Received: "Welcome, Grace"`, the test is doing its job and triage says `true-fail` — changing the',
    'expected value would make the suite green and the bug invisible.',
    '',
    "Quarantine (`heal/quarantine.json`, committed) suppresses a run's exit status without skipping",
    'the test: it still runs, and its trace and video are still in the report. Entries expire, and',
    '`heal gate` fails when one does. See `docs/HEALING.md`.',
  ].join('\n'),
};

export default manifest;
