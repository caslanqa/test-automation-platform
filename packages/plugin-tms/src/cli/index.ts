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
import path from 'node:path';

import { gitContext, loadEnvFile, readConfig, runTitle, type TmsConfig } from '../config.js';
import { resolveProvider } from '../providers/index.js';
import { flagList, flagNumber, flagValue, positionals } from './args.js';
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
