#!/usr/bin/env node
/**
 * Runtime smoke test for the AI judge's calibration workflow. Run with `npm run smoke:judge`.
 *
 * The pieces it covers are shipped CODE that no unit test reaches end to end: the CLI's argument handling, the
 * dataset `@pwtap/plugin-ai-judge` ships, the agreement metrics, the exit codes CI gates on, and the harvest that
 * turns a run's cache into a dataset. It needs no model and no credentials — a local HTTP server answers as an
 * OpenAI-compatible gateway, returning for each case whatever verdict this script decides, which is what makes
 * "the gate fails on a false pass" assertable at all.
 *
 * Four assertions, each one a claim the shipped tooling makes:
 *   1. Every case in the shipped dataset reaches the judge and the metrics add up (100 %, exit 0).
 *   2. The gates GATE: one flipped verdict makes `--max-false-pass 0` exit 1 and name the case.
 *   3. `--harvest` drafts a loadable dataset out of what a run judged, and grading it exits 0.
 *   4. A dataset named after the npm script's own path wins — the defect where the default was graded instead.
 *
 * @example
 *   npm run smoke:judge   # prints "[smoke:judge] OK" when the calibration workflow holds end to end
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const CLI = path.join(root, 'packages/plugin-ai-judge/dist/calibrate/cli.js');
const DATASET = path.join(root, 'packages/plugin-ai-judge/templates/tests/calibration.json');
/** The case whose verdict gets flipped in assertion 2 — a human failed it, the fake judge will pass it. */
const FLIPPED = 'grounded: invents a policy';

function fail(message, detail = '') {
  console.error(`[smoke:judge] FAILED — ${message}${detail ? `\n${detail}` : ''}`);
  process.exit(1);
}

if (!fs.existsSync(CLI)) {
  fail(`${CLI} is missing — run \`npm run build\` first.`);
}

const cases = JSON.parse(fs.readFileSync(DATASET, 'utf8')).cases;

/** The text that identifies one case in a judging request: its response, or the last thing the bot said. */
function needleFor(entry) {
  const turns = entry.input.conversation ?? [];
  return (
    entry.input.botResponse ??
    [...turns].reverse().find(turn => turn.role === 'assistant')?.content ??
    ''
  );
}

const needles = cases.map(entry => ({ needle: needleFor(entry), entry }));
for (const { needle, entry } of needles) {
  if (needle.length === 0) {
    fail(`case '${entry.name}' carries no response, so the fake gateway cannot identify it.`);
  }
  if (needles.filter(other => other.needle === needle).length > 1) {
    fail(
      `two cases share the response '${needle.slice(0, 40)}…' — the fake gateway would confuse them.`,
    );
  }
}

/** A verdict in the shape the parser expects, with one criterion so the score follows the label. */
function verdictFor(pass) {
  return JSON.stringify({
    criteria: [{ criterion: 'smoke', why: 'answered by the fake gateway', met: pass }],
    reasoning: 'fake gateway',
    score: pass ? 100 : 0,
    pass,
  });
}

/**
 * A gateway that answers every case with the HUMAN label, so agreement is perfect unless `flip` names a case —
 * the only way to test that a gate fires is to make the judge wrong on purpose.
 */
function startGateway(flip) {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      if (request.url.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ data: [{ id: 'fake-judge', owned_by: 'smoke' }] }));
      }

      const text = JSON.stringify(JSON.parse(body).messages);
      const match = needles.find(entry => text.includes(entry.needle));
      if (match === undefined) {
        response.writeHead(500);
        return response.end('the fake gateway could not identify the case');
      }
      seen.push(match.entry.name);
      const human = match.entry.expected === 'pass' || match.entry.expected === true;
      const pass = match.entry.name === flip ? !human : human;

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: verdictFor(pass) } }] }));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, seen, close: () => server.close() }),
    );
  });
}

/**
 * Run the calibration CLI in an isolated cwd, so its `.judge` cache never lands in the repo. Async on
 * purpose: the fake gateway lives in THIS process, and `spawnSync` would block the event loop that has to
 * answer it — the first version did, and every request timed out.
 */
function runCli(args, { port, cwd, cache = 'off' }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        JUDGE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/v1`,
        JUDGE_API_KEY: 'smoke',
        JUDGE_MODEL: 'fake-judge',
        JUDGE_CACHE: cache,
      },
    });

    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    child.on('close', status => resolve({ status, output }));
  });
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-judge-'));
// Stays up for the whole script: steps 3 and 4 replay from the cache, but a miss must reach a gateway
// rather than a closed port.
const truthful = await startGateway(null);

try {
  // 1. Every shipped case reaches the judge, and perfect agreement reports as perfect.
  const clean = await runCli([DATASET, '--min-accuracy', '100', '--max-false-pass', '0'], {
    port: truthful.port,
    cwd: work,
    cache: 'on', // populates the cache assertion 3 harvests from
  });

  if (clean.status !== 0) {
    fail('a judge that agrees with every human label should pass the gates', clean.output);
  }
  if (!clean.output.includes(`100% accuracy (${cases.length}/${cases.length})`)) {
    fail(`expected ${cases.length}/${cases.length} agreement`, clean.output);
  }
  if (truthful.seen.length < cases.length) {
    fail(
      `only ${truthful.seen.length} of ${cases.length} cases reached the judge — a case in the shipped dataset is unreachable`,
      clean.output,
    );
  }

  // 2. The gates gate. Without this, a green CI job proves nothing about the thresholds it claims to enforce.
  const flipped = await startGateway(FLIPPED);
  const gated = await runCli([DATASET, '--max-false-pass', '0'], { port: flipped.port, cwd: work });
  flipped.close();

  if (gated.status !== 1) {
    fail(`a false pass must exit 1, got ${gated.status}`, gated.output);
  }
  if (!gated.output.includes('FALSE PASS') || !gated.output.includes(FLIPPED)) {
    fail('a breached gate must name the case it failed on', gated.output);
  }

  // 3. Harvest drafts a dataset from the cache the first run wrote, and that dataset grades.
  const harvested = path.join(work, 'harvested.json');
  const draft = await runCli(['--harvest', harvested], {
    port: truthful.port,
    cwd: work,
    cache: 'on',
  });
  if (draft.status !== 0 || !fs.existsSync(harvested)) {
    fail('--harvest should draft a dataset from the cache a run filled', draft.output);
  }
  const drafted = JSON.parse(fs.readFileSync(harvested, 'utf8'));
  if (drafted.cases.length !== cases.length) {
    fail(`harvest drafted ${drafted.cases.length} cases from ${cases.length} judged`, draft.output);
  }

  const replay = await runCli([harvested], { port: truthful.port, cwd: work, cache: 'on' });
  if (replay.status !== 0 || !replay.output.includes(`${cases.length} labelled cases`)) {
    fail('a harvested dataset should grade off the cache that produced it', replay.output);
  }

  // 4. `npm run judge:calibrate -- mine.json` appends after the script's own path: the last one must win. And
  // `--json`'s own argument is a .json too, so grading the report file instead of the dataset is the trap here.
  const report = path.join(work, 'report.json');
  const override = await runCli([DATASET, harvested, '--json', report], {
    port: truthful.port,
    cwd: work,
    cache: 'on',
  });
  if (!override.output.includes(`labelled cases from ${harvested}`)) {
    fail('a dataset given after the default path must be the one graded', override.output);
  }
  const written = JSON.parse(fs.readFileSync(report, 'utf8'));
  if (written.dataset !== harvested || written.reports[0].results.length !== cases.length) {
    fail(
      '--json must record which dataset ran and every case in it',
      JSON.stringify(written).slice(0, 300),
    );
  }
} finally {
  truthful.close();
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(
  `[smoke:judge] OK — ${cases.length} shipped cases judged, gates fire on a false pass, harvest round-trips.`,
);
