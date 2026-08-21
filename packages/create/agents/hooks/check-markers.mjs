#!/usr/bin/env node
/**
 * Warn when an edit unbalanced a pwtap managed region.
 *
 * `fixtures/index.ts` and `playwright.config.ts` carry regions owned by `create-pwtap add|remove`.
 * Losing a marker is worse than editing inside one: the injector then refuses to splice and prints a
 * paste block, so the next plugin install silently does nothing. That failure is invisible until
 * someone wonders why `add` did not work — hence a hook that says it at the moment of the edit.
 *
 * Advisory only. It always exits 0: a hook that can block an edit over a heuristic is a hook that
 * will eventually block the wrong one.
 *
 * The whole-line predicate is inlined rather than imported: a rendered plugin directory cannot reach
 * @pwtap/create's dist. It must match markers.ts exactly — a substring test would false-positive,
 * because the end marker `// pwtap:foo:end` contains the start marker `// pwtap:foo`.
 */
import fs from 'node:fs';
import path from 'node:path';

const MANAGED = {
  'fixtures/index.ts': ['plugins:imports', 'plugins:tests', 'plugins:expects'],
  'playwright.config.ts': ['plugins:gates', 'plugins:projects'],
};

const hasLine = (source, marker) => source.split('\n').some(line => line.trim() === marker);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** The file this hook fired for, or null when the payload is not usable. */
function editedFile(raw) {
  try {
    const value = JSON.parse(raw)?.tool_input?.file_path;
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const edited = editedFile(readStdin());

// Check only the managed file that was touched; with no usable payload, check both — they are two
// small files, and a missed warning is worse than reading them.
const targets = Object.keys(MANAGED).filter(
  relative => edited === null || path.resolve(edited) === path.resolve(projectDir, relative),
);

const problems = [];
for (const relative of targets) {
  const absolute = path.join(projectDir, relative);
  let source;
  try {
    source = fs.readFileSync(absolute, 'utf8');
  } catch {
    continue; // Not every project has every managed file, and a missing one is not this hook's business.
  }
  for (const key of MANAGED[relative]) {
    const start = hasLine(source, `// pwtap:${key}`);
    const end = hasLine(source, `// pwtap:${key}:end`);
    if (!start || !end) {
      problems.push(
        `${relative}: managed region '${key}' is missing its ${start ? 'end' : 'start'} marker`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(
    [
      '[pwtap] A managed marker region is broken. `create-pwtap add|remove` will refuse to splice',
      'and print a paste block instead, so the next plugin install will appear to do nothing.',
      ...problems.map(problem => `  - ${problem}`),
      'Restore the marker pair, or run `git diff` on the file to see what was removed.',
    ].join('\n'),
  );
}

process.exit(0);
