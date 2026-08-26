/**
 * `tms` — the CLI.
 *
 * ```
 * tms doctor
 * tms run create   [--title <t>] [--description <d>] [--environment <slug>]
 *                  [--milestone <id>] [--plan <id>] [--tags a,b] [--output <file>]
 * tms run complete [--id <runId>] [--output <file>]
 * ```
 *
 * A pure function of `argv` and the working directory, so every command is testable without spawning
 * anything. Exit codes: **0** ok · **1** the command failed · **2** usage.
 *
 * `run create` and `run complete` exist because the reporter cannot own the run under sharding: four
 * shards are four processes, and the first one to finish would complete a run the other three are still
 * writing into. CI creates the run once, exports the id, and closes it after the last shard.
 *
 * @example
 * // .github/workflows/e2e.yml
 * // npx tms run create --title "$GITHUB_REF_NAME" && set -a && . ./qase.env && set +a
 * // npx playwright test --shard=1/4 & npx playwright test --shard=2/4 & wait
 * // npx tms run complete
 */
import fs from 'node:fs';
import path from 'node:path';

import { gitContext, loadEnvFile, readConfig, runTitle, type TmsConfig } from '../config.js';
import { planDefects } from '../defects/plan.js';
import {
  DEFAULT_QUARANTINE_FILE,
  DEFAULT_TRIAGE_FILE,
  readQuarantine,
  readTriage,
} from '../heal/read.js';
import { resolveProvider } from '../providers/index.js';
import { gateMatrix } from '../requirements/gate.js';
import { loadRequirements, REQUIREMENTS_DIR } from '../requirements/load.js';
import {
  buildMatrix,
  countByVerdict,
  renderCsv,
  renderJson,
  renderMarkdown,
} from '../requirements/rtm.js';
import { applySync } from '../sync/apply.js';
import { planIsEmpty, planSync } from '../sync/diff.js';
import {
  discoverTests,
  healTitle,
  readResultsReport,
  sameFile,
  testKey,
} from '../sync/discover.js';
import { renderPlan } from '../sync/report.js';
import { flagList, flagNumber, flagPresent, flagValue, positionals } from './args.js';
import { DEFAULT_RUN_ID_FILE, readRunId, RUN_ID_KEY, writeRunId } from './runId.js';

const USAGE = `tms — test management sync

  tms doctor
      Configuration, credentials and reachability. Prints every check, not just the first failure.

  tms run create [--title <t>] [--description <d>] [--environment <slug>] [--milestone <id>]
                 [--plan <id>] [--tags a,b] [--output <file>]
      Open one run and write ${RUN_ID_KEY} to <file> (default ${DEFAULT_RUN_ID_FILE}). Export that
      variable in every shard so they all report into the same run.

  tms run complete [--id <runId>] [--output <file>]
      Close the run. Takes --id, else ${RUN_ID_KEY}, else the id in <file>.

  tms sync [--apply] [--deprecate-orphans] [--project <name>] [--limit <n>]
      Reconcile the cases in the tool with the specs in this repo. Prints the plan and changes
      NOTHING without --apply. Reads the suite through "playwright test --list" — no test is run.

      --apply              create, link and update; write each new id back into its spec file
      --deprecate-orphans  also mark cases the code no longer contains as deprecated (never deletes)
      --project <name>     limit discovery to one Playwright project
      --limit <n>          detail lines per section (default 10)

  tms trace [--gate] [--strict] [--format md|json|csv] [--out <dir>] [--results <file>]
      Build the requirements traceability matrix from ${REQUIREMENTS_DIR}/*.md and the Requirement
      annotations in the specs. Reads run outcomes from <file> (default test-results/results.json)
      when it exists. Entirely local — no network, no test run.

      --gate            exit 1 on an uncovered, failing or not-run requirement (CI check)
      --strict          with --gate, also require every acceptance criterion to be covered
      --format          one or more of md,json,csv (default md,json)
      --out <dir>       where the report files go (default tms/)
      --results <file>  the Playwright JSON report to read outcomes from

  tms defects [--apply] [--from <file>] [--quarantine <file>] [--no-flaky]
      Open a defect for every failure heal classified as true-fail, and mark quarantined tests as
      flaky in the tool. Prints the plan and changes NOTHING without --apply.

      --from <file>        heal triage report (default ${DEFAULT_TRIAGE_FILE})
      --quarantine <file>  heal quarantine list (default ${DEFAULT_QUARANTINE_FILE})
      --no-flaky           skip the quarantine mirror; open defects only

      Produce the triage report first:  npx heal triage --json ${DEFAULT_TRIAGE_FILE}

Configuration lives in env/environments.json (TMS_PROVIDER, TMS_MODE, QASE_TESTOPS_*), and an
exported variable always wins over the file.`;

/** Same shape as `@pwtap/plugin-heal`'s CLI: a CLI owns its stdout, and `console` is for libraries. */
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export async function run(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const [command, subcommand] = positionals(argv);
  if (command === undefined || command === 'help' || argv.includes('--help')) {
    out(USAGE);
    return command === undefined ? 2 : 0;
  }

  // The CLI runs outside Playwright, so nothing has flattened env/environments.json yet.
  loadEnvFile(cwd);
  const config = readConfig();

  try {
    switch (command) {
      case 'doctor':
        return await commandDoctor(config);
      case 'sync':
        return await commandSync(argv, cwd, config);
      case 'trace':
        return commandTrace(argv, cwd);
      case 'defects':
        return await commandDefects(argv, cwd, config);
      case 'run':
        switch (subcommand) {
          case 'create':
            return await commandRunCreate(argv, cwd, config);
          case 'complete':
            return await commandRunComplete(argv, cwd, config);
          default:
            err(`tms run: expected "create" or "complete"\n\n${USAGE}`);
            return 2;
        }
      default:
        err(`tms: unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    err(`tms ${command}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function commandDoctor(config: TmsConfig): Promise<number> {
  const git = gitContext();
  out(`provider     ${config.provider}`);
  out(
    `mode         ${config.mode}${config.mode === 'off' ? '  (set TMS_MODE=testops to publish)' : ''}`,
  );
  out(`environment  ${config.environment === '' ? '(none)' : config.environment}`);
  out(`run title    ${runTitle(config, git)}`);

  const probe = await resolveProvider(config).probe();
  for (const check of probe.checks) {
    out(`${check.ok ? '✓' : '✗'} ${check.name.padEnd(12)} ${check.detail}`);
  }
  return probe.ok ? 0 : 1;
}

/**
 * Reconcile the tool with the repo.
 *
 * Discovery runs first and independently of the network: a suite that will not list is a problem to fix
 * before anything is created, and finding that out after half a project has been written is worse.
 *
 * Exit code 1 with no `--apply` when there is something to do, so `tms sync` doubles as a CI check —
 * "the specs and the tool have drifted" is a reportable state.
 */
async function commandSync(argv: string[], cwd: string, config: TmsConfig): Promise<number> {
  const apply = flagPresent(argv, '--apply');
  const project = flagValue(argv, '--project');
  const limit = flagNumber(argv, '--limit', 10);

  const discovery = discoverTests(cwd, {
    args: project === undefined ? [] : [`--project=${project}`],
  });
  if (discovery.tests.length === 0) {
    err('tms sync: Playwright listed no tests — nothing to sync');
    return 1;
  }

  const provider = resolveProvider(config);
  const existing = await provider.listCases();
  const plan = planSync(discovery.tests, existing);

  for (const line of renderPlan(plan, { existingCount: existing.length, limit, applied: apply })) {
    out(line);
  }

  if (!apply) {
    out('');
    out(
      planIsEmpty(plan)
        ? 'nothing to do.'
        : 'dry run — nothing was changed. Re-run with --apply to create, link and write ids back.',
    );
    return planIsEmpty(plan) ? 0 : 1;
  }

  // Asked once, before anything is written: the answer is workspace configuration, so discovering it
  // per case would print the same sentence a hundred times or — worse — swallow it.
  if (discovery.tests.some(test => test.requirements.length > 0)) {
    const support = await provider.requirementSupport();
    if (!support.ok) {
      out('');
      out(`note: ${support.detail}`);
    }
  }

  const result = await applySync(provider, plan, {
    rootDir: discovery.rootDir,
    deprecateOrphans: flagPresent(argv, '--deprecate-orphans'),
  });

  out('');
  out(
    `applied: ${result.created} created, ${result.adopted} linked, ${result.updated} updated, ` +
      `${result.written} ids written${result.deprecated === 0 ? '' : `, ${result.deprecated} deprecated`}`,
  );

  if (result.refusals.length > 0) {
    // Not a failure of the sync: the cases exist. Only the link is unwritten, and the next run adopts
    // them by title rather than creating duplicates.
    out('');
    out(`${result.refusals.length} id(s) could not be placed automatically — paste these by hand:`);
    for (const refusal of result.refusals) {
      out(`  ${refusal.file}:${refusal.line}  ${refusal.title}`);
      out(`      ${refusal.reason}`);
      out(`      ${refusal.snippet}`);
    }
    return 1;
  }

  return 0;
}

async function commandRunCreate(argv: string[], cwd: string, config: TmsConfig): Promise<number> {
  const provider = resolveProvider(config);
  const output = path.resolve(cwd, flagValue(argv, '--output') ?? DEFAULT_RUN_ID_FILE);
  const tags = flagList(argv, '--tags');

  const ref = await provider.createRun({
    title: flagValue(argv, '--title') ?? runTitle(config),
    description: flagValue(argv, '--description'),
    environment: flagValue(argv, '--environment') ?? config.environment,
    milestoneId: flagNumber(argv, '--milestone', undefined),
    planId: flagNumber(argv, '--plan', undefined),
    ...(tags.length === 0 ? {} : { tags }),
  });

  writeRunId(output, ref.id);
  out(`run ${ref.id} created${ref.url === undefined ? '' : ` — ${ref.url}`}`);
  out(`${RUN_ID_KEY}=${ref.id} written to ${path.relative(cwd, output)}`);
  return 0;
}

async function commandRunComplete(argv: string[], cwd: string, config: TmsConfig): Promise<number> {
  const output = path.resolve(cwd, flagValue(argv, '--output') ?? DEFAULT_RUN_ID_FILE);
  const id =
    flagValue(argv, '--id') ??
    (process.env[RUN_ID_KEY]?.trim() === '' ? undefined : process.env[RUN_ID_KEY]?.trim()) ??
    readRunId(output);

  if (id === undefined) {
    err(
      `tms run complete: no run id — pass --id, export ${RUN_ID_KEY}, or run "tms run create" first`,
    );
    return 2;
  }

  await resolveProvider(config).completeRun(id);
  out(`run ${id} completed`);
  return 0;
}

/**
 * The requirements traceability matrix.
 *
 * **Entirely local.** Requirements come from the repository, links come from the `Requirement`
 * annotations the runner already reports, and outcomes come from the JSON report the scaffold's own
 * config already writes. No token, no network, no test run — which is what lets this be the artifact an
 * auditor is handed and the check a pull request runs.
 *
 * Exit codes: `0` when nothing is asked of it or the gate passes, `1` when `--gate` finds something.
 * Without `--gate` it always exits `0` — writing a report is not a verdict.
 */
function commandTrace(argv: string[], cwd: string): number {
  const { requirements, problems } = loadRequirements(cwd);
  const resultsPath = path.resolve(
    cwd,
    flagValue(argv, '--results') ?? 'test-results/results.json',
  );
  const results = readResultsReport(resultsPath);
  const resultsRead = results.tests.length > 0;

  // Discovery gives the LINKS (every declared test, whether or not it ran); the results report gives the
  // OUTCOMES. Joining them by testKey is what keeps "covered" and "verified" separate — a requirement
  // whose only test was filtered out of the last run must not read as green.
  const discovery = discoverTests(cwd);
  const outcomes = new Map(results.tests.map(test => [testKey(test), test.outcome]));
  const tests = discovery.tests.map(test => {
    const outcome = outcomes.get(testKey(test));
    return outcome === undefined ? test : { ...test, outcome };
  });

  const matrix = buildMatrix(requirements, tests);
  const git = gitContext(cwd);
  const context = {
    sha: git.sha,
    branch: git.branch,
    generatedAt: new Date().toISOString(),
    ...(resultsRead ? { resultsFile: path.relative(cwd, resultsPath) } : {}),
  };

  if (requirements.length === 0) {
    out(`no requirements found in ${REQUIREMENTS_DIR}/ — nothing to trace.`);
    out(
      `Add a ${REQUIREMENTS_DIR}/<id>.md with id/title frontmatter; see docs/TEST_MANAGEMENT.md.`,
    );
  }

  const formats = flagList(argv, '--format');
  const wanted = formats.length === 0 ? ['md', 'json'] : formats;
  const outDir = path.resolve(cwd, flagValue(argv, '--out') ?? 'tms');
  const renderers: Record<string, () => string> = {
    md: () => renderMarkdown(matrix, context),
    json: () => renderJson(matrix, context),
    csv: () => renderCsv(matrix, context),
  };

  const unknown = wanted.filter(format => renderers[format] === undefined);
  if (unknown.length > 0) {
    err(`tms trace: unknown --format ${unknown.join(', ')} — known formats: md, json, csv`);
    return 2;
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const format of wanted) {
    const file = path.join(outDir, `rtm.${format}`);
    fs.writeFileSync(file, renderers[format](), 'utf8');
    out(`wrote ${path.relative(cwd, file)}`);
  }

  const counts = countByVerdict(matrix);
  out('');
  out(
    `verified ${counts.verified}  failing ${counts.failing}  not run ${counts['not-run']}  ` +
      `uncovered ${counts.uncovered}  excluded ${counts.excluded}`,
  );
  if (!resultsRead) {
    out(
      `no run results at ${path.relative(cwd, resultsPath)} — coverage only, nothing is "verified".`,
    );
  }

  for (const problem of problems) {
    err(`${problem.file}: ${problem.reason}`);
  }

  if (!flagPresent(argv, '--gate')) {
    return 0;
  }

  const verdict = gateMatrix(matrix, {
    resultsRead,
    problems,
    strict: flagPresent(argv, '--strict'),
  });
  out('');
  out(verdict.summary);
  for (const finding of verdict.findings) {
    err(`  ${finding.kind.padEnd(9)} ${finding.subject}  ${finding.detail}`);
  }
  return verdict.ok ? 0 : 1;
}

/**
 * Open defects for real failures, and mirror the quarantine list.
 *
 * heal does the classifying; this does the filing. The one rule that matters is the whitelist: **only
 * `true-fail`**. A flaky test opening a defect fills the tracker with noise, and a tracker full of
 * noise is one nobody reads — at which point the real defect is invisible too.
 *
 * Reads heal's two artifacts by path rather than importing the package: no build coupling, no version
 * skew, and a project without heal simply has no such file.
 */
async function commandDefects(argv: string[], cwd: string, config: TmsConfig): Promise<number> {
  const triageFile = path.resolve(cwd, flagValue(argv, '--from') ?? DEFAULT_TRIAGE_FILE);
  const triage = readTriage(triageFile);
  if (triage === undefined) {
    err(
      `tms defects: no triage report at ${path.relative(cwd, triageFile)} — ` +
        `produce one with "npx heal triage --json ${DEFAULT_TRIAGE_FILE}"`,
    );
    return 1;
  }

  const apply = flagPresent(argv, '--apply');
  const provider = resolveProvider(config);
  const openDefects = await provider.listOpenDefects();
  const plan = planDefects(triage.findings, openDefects, triage);

  out(`triage run ${triage.runId}${triage.commit === undefined ? '' : ` at ${triage.commit}`}`);
  out(`${triage.findings.length} finding(s), ${openDefects.length} open defect(s) in the tool`);
  out('');
  out(`  open       ${String(plan.open.length).padStart(4)}`);
  out(`  existing   ${String(plan.existing.length).padStart(4)}`);
  out(`  skipped    ${String(plan.skipped.length).padStart(4)}`);

  for (const entry of plan.open) {
    out(`  + ${entry.title}`);
  }
  for (const entry of plan.existing) {
    out(`  = ${entry.title}  (defect ${entry.defectId})`);
  }
  for (const entry of plan.skipped) {
    out(`  · ${entry.finding.title}  ${entry.reason}`);
  }

  // The quarantine mirror is one-way: the committed list is policy, and the tool reflects it.
  const quarantineFile = path.resolve(
    cwd,
    flagValue(argv, '--quarantine') ?? DEFAULT_QUARANTINE_FILE,
  );
  const quarantined = flagPresent(argv, '--no-flaky') ? [] : readQuarantine(quarantineFile);
  const flaky: Array<{ caseId: string; title: string }> = [];
  if (quarantined.length > 0) {
    const tests = discoverTests(cwd).tests;
    for (const entry of quarantined) {
      const match = tests.find(
        test => healTitle(test) === entry.title && sameFile(entry.file, test.file),
      );
      const caseId = match?.caseIds[0];
      if (caseId === undefined) {
        out(
          `  ? ${entry.title}  quarantined, but no case is linked to it yet — run tms sync first`,
        );
        continue;
      }
      flaky.push({ caseId: String(caseId), title: entry.title });
    }
    out('');
    out(`  flaky      ${String(flaky.length).padStart(4)}  quarantined tests to mark in the tool`);
  }

  if (!apply) {
    out('');
    out(
      plan.open.length === 0 && flaky.length === 0
        ? 'nothing to do.'
        : 'dry run — nothing was changed. Re-run with --apply to open the defects.',
    );
    return 0;
  }

  let opened = 0;
  for (const entry of plan.open) {
    const id = await provider.createDefect({
      title: entry.title,
      actualResult: entry.actualResult,
    });
    out(`opened defect ${id} — ${entry.title}`);
    opened += 1;
  }
  for (const entry of flaky) {
    await provider.setCaseFlaky(entry.caseId, true);
  }

  out('');
  out(`applied: ${opened} defect(s) opened, ${flaky.length} case(s) marked flaky`);
  return 0;
}
