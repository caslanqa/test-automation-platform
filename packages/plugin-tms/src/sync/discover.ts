/**
 * The test inventory, read **without running anything**.
 *
 * `playwright test --list --reporter=json` is the only honest source. A regex over the spec files would
 * get `describe` nesting, `test.skip`, project membership and parameterised loops wrong, and each of
 * those is a case created in the wrong place or not at all. The runner already knows; asking it costs
 * one process and no browser.
 *
 * Three facts from that output shape everything downstream:
 *
 * | Fact | Consequence |
 * |---|---|
 * | Declared `annotation:`s appear in the list output, with a `location` | the QaseID link is readable statically, so no map file is needed |
 * | `spec.file` is relative to `config.rootDir` | the suite path falls out of the path, with no extra configuration |
 * | A parameterised loop yields several specs sharing one `line`/`column` | those cannot each own an id in the source — see {@link DiscoveredTest.unwritableReason} |
 *
 * @example
 * const tests = discoverTests('/path/to/project');
 * tests[0]; // { file: 'checkout/cart.spec.ts', suitePath: ['checkout', 'cart'], title: '…', caseIds: [42] }
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/** The annotation type the Qase reporter reads for case ids — theirs, not ours. */
export const QASE_ID_ANNOTATION = 'QaseID';
/** The annotation type this plugin reads for requirement links. */
export const REQUIREMENT_ANNOTATION = 'Requirement';

export interface DiscoveredTest {
  /** Posix path relative to Playwright's `rootDir`, e.g. `checkout/cart.spec.ts`. */
  file: string;
  /** Directory segments, file stem and `describe` titles — where the case belongs in the tool. */
  suitePath: string[];
  /** The leaf test title, which is the case title. */
  title: string;
  /** 1-based position of the `(` in the `test(` call, straight from the runner. */
  line: number;
  column: number;
  /** Playwright tags, without the leading `@`. */
  tags: string[];
  /** Ids from the `QaseID` annotation. Empty means "not linked yet". */
  caseIds: number[];
  /** Requirement keys from the `Requirement` annotation. Read in phase 2. */
  requirements: string[];
  /** Playwright projects this test belongs to. */
  projects: string[];
  /**
   * Why an id must not be written at this call site, or `undefined` when it may be. Two reasons, both
   * the same underlying hazard — an annotation there would name something other than this one test:
   *
   * - **a shared call site**, from a parameterised loop;
   * - **a call site outside the tests directory**, which is what a test declared by a helper looks like.
   *   Playwright reports the file where `test(` literally appears, so a `test.as('admin')(…)` wrapper in
   *   `fixtures/ui.ts` makes every test it produces point at the wrapper. Writing there would tag the
   *   helper, and through it every test that has ever used it.
   *
   * These tests are still synced. They stay matched by suite path and title, which is the link that
   * breaks on a rename — so the sync says so rather than letting it look solved.
   */
  unwritableReason?: string;
}

/** The identity used for matching, in both directions. Suite path plus title, nothing else. */
export function testKey(test: Pick<DiscoveredTest, 'suitePath' | 'title'>): string {
  return [...test.suitePath, test.title].join('\u0000');
}

/** `cart.spec.ts` → `cart`; `users.api.ts` → `users`. The suffix is a project selector, not a name. */
export function fileStem(file: string): string {
  return path.posix
    .basename(file)
    .replace(/\.(spec|test|api)\.[cm]?[jt]sx?$/i, '')
    .replace(/\.[cm]?[jt]sx?$/i, '');
}

// --- the runner's JSON ---------------------------------------------------------------------------

interface JsonAnnotation {
  type: string;
  description?: string;
}

interface JsonTest {
  annotations?: JsonAnnotation[];
  projectName?: string;
}

interface JsonSpec {
  title: string;
  file: string;
  line: number;
  column: number;
  tags?: string[];
  tests?: JsonTest[];
}

interface JsonSuite {
  title: string;
  file: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

interface JsonReport {
  config?: { rootDir?: string };
  suites?: JsonSuite[];
  errors?: Array<{ message?: string }>;
}

export interface DiscoverOptions {
  /** Injected in tests. Defaults to actually shelling out to Playwright. */
  listJson?: (cwd: string) => string;
  /** Extra arguments, e.g. `['--project=chromium']` to sync one project only. */
  args?: string[];
}

/**
 * Run the runner's own lister.
 *
 * Two decisions here, both learned the hard way:
 *
 * - **Resolved from the CLIENT's `node_modules`, run with this process's Node** rather than through
 *   `npx`, which may reach the network for a package that is already installed. A sync command has no
 *   business doing that.
 * - **The report goes to a file, not to stdout.** The scaffolded `playwright.config.ts` calls the
 *   project's own `loadEnv()`, which prints `[loadEnv] Loaded environment: …` — to stdout, before the
 *   JSON reporter writes a byte. Parsing stdout means parsing that line too. `PLAYWRIGHT_JSON_OUTPUT_NAME`
 *   is the reporter's own answer, and it makes the config's chattiness irrelevant.
 */
function listJson(cwd: string, args: string[] = []): string {
  let cli: string;
  try {
    cli = createRequire(`${cwd}/`).resolve('@playwright/test/cli');
  } catch {
    throw new Error(
      `@playwright/test is not installed in ${cwd} — tms sync reads the suite through Playwright's own lister`,
    );
  }

  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tms-list-')), 'list.json');
  try {
    execFileSync(process.execPath, [cli, 'test', '--list', '--reporter=json', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: report },
    });
    return fs.readFileSync(report, 'utf8');
  } catch (error) {
    // A non-zero exit still writes the report when the failure was a load error, and that report holds
    // the `errors` array the caller turns into a readable message. Only re-throw when there is nothing.
    if (fs.existsSync(report)) {
      return fs.readFileSync(report, 'utf8');
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`playwright test --list failed:\n${detail}`);
  } finally {
    fs.rmSync(path.dirname(report), { recursive: true, force: true });
  }
}

function numericIds(annotations: JsonAnnotation[]): number[] {
  return (
    annotations
      .filter(annotation => annotation.type === QASE_ID_ANNOTATION)
      // `description: '1,2,3'` is the vendor's multi-id form, so one annotation can carry several.
      .flatMap(annotation => (annotation.description ?? '').split(','))
      .map(part => Number(part.trim()))
      .filter(value => Number.isInteger(value) && value > 0)
  );
}

function requirementKeys(annotations: JsonAnnotation[]): string[] {
  return annotations
    .filter(annotation => annotation.type === REQUIREMENT_ANNOTATION)
    .flatMap(annotation => (annotation.description ?? '').split(','))
    .map(part => part.trim())
    .filter(part => part !== '');
}

/**
 * Walk the suite tree.
 *
 * Depth 0 is the file suite — its title is the file path, not a `describe` — so it contributes the
 * directory and stem rather than its title. Everything deeper is a real `describe` and becomes a suite.
 */
function collect(
  suites: JsonSuite[],
  depth: number,
  prefix: string[],
  out: DiscoveredTest[],
): void {
  for (const suite of suites) {
    const file = suite.file.split(path.sep).join('/');
    const here =
      depth === 0
        ? [
            ...path.posix
              .dirname(file)
              .split('/')
              .filter(part => part !== '' && part !== '.'),
            fileStem(file),
          ]
        : [...prefix, suite.title];

    for (const spec of suite.specs ?? []) {
      const annotations = (spec.tests ?? []).flatMap(test => test.annotations ?? []);
      out.push({
        file: spec.file.split(path.sep).join('/'),
        suitePath: here,
        title: spec.title,
        line: spec.line,
        column: spec.column,
        tags: (spec.tags ?? []).map(tag => tag.replace(/^@/, '')),
        caseIds: numericIds(annotations),
        requirements: requirementKeys(annotations),
        projects: [
          ...new Set(
            (spec.tests ?? []).map(test => test.projectName ?? '').filter(name => name !== ''),
          ),
        ],
      });
    }
    collect(suite.suites ?? [], depth + 1, here, out);
  }
}

/** Decide, per test, whether its call site can hold an id — see {@link DiscoveredTest.unwritableReason}. */
function markUnwritable(tests: DiscoveredTest[]): void {
  const bySite = new Map<string, DiscoveredTest[]>();
  for (const test of tests) {
    const site = `${test.file}:${test.line}:${test.column}`;
    const group = bySite.get(site);
    if (group === undefined) {
      bySite.set(site, [test]);
    } else {
      group.push(test);
    }
  }

  for (const group of bySite.values()) {
    for (const test of group) {
      if (group.length > 1) {
        test.unwritableReason = 'several tests share this test() call';
      } else if (test.file.startsWith('../')) {
        // Outside the tests directory: a helper that calls `test()` on the caller's behalf. See the
        // field's own doc comment for why writing there is worse than not writing at all.
        test.unwritableReason =
          'the test() call is outside the tests directory — a helper declares it';
      }
    }
  }
}

export interface Discovery {
  /** Absolute path the `file` fields are relative to. */
  rootDir: string;
  tests: DiscoveredTest[];
}

export function discoverTests(cwd: string, options: DiscoverOptions = {}): Discovery {
  const raw = (options.listJson ?? (dir => listJson(dir, options.args)))(cwd);

  let report: JsonReport;
  try {
    report = JSON.parse(raw) as JsonReport;
  } catch {
    throw new Error(
      `could not parse Playwright's list output — run "npx playwright test --list" to see why`,
    );
  }

  const errors = (report.errors ?? [])
    .map(error => error.message ?? '')
    .filter(message => message !== '');
  if (errors.length > 0) {
    // A file that fails to load lists no tests, and syncing then reads as "those tests were deleted".
    throw new Error(`Playwright could not load the suite:\n${errors.join('\n')}`);
  }

  const tests: DiscoveredTest[] = [];
  collect(report.suites ?? [], 0, [], tests);
  markUnwritable(tests);

  return { rootDir: report.config?.rootDir ?? cwd, tests };
}
