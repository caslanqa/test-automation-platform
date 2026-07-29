/**
 * Puts each installed plugin's usage notes into the project's own README.
 *
 * Every plugin manifest already declares a `readmeSection` — `ai-judge` wrote a substantial one — and until now
 * nothing read the field. A scaffolded project had no README at all, so the one place a new teammate looks to
 * learn what the suite can do was empty while four plugins carried the answer.
 *
 * Markers are HTML comments rather than the `// pwtap:` ones the code injectors use, because these live in
 * Markdown, where a `//` line is body text. One region per plugin, so `add` twice replaces rather than
 * duplicates, and `remove` takes out exactly its own.
 *
 * @example applyReadme(clientDir, manifest) // → README.md gains a "## Database" section
 */
import path from 'node:path';

import type { PluginManifest } from '../manifest.js';
import { exists, readText, writeText } from '../util/fs.js';

const start = (id: string): string => `<!-- pwtap:readme:${id} -->`;
const end = (id: string): string => `<!-- pwtap:readme:${id}:end -->`;

/** What a project with no README gets, once a plugin has something to say in it. */
const SKELETON = [
  '# Test suite',
  '',
  'Playwright tests scaffolded with [`create-pwtap`](https://www.npmjs.com/package/@pwtap/create).',
  '',
  '```bash',
  'npm test              # the default projects',
  'npx playwright show-report',
  '```',
  '',
  'Sections below are maintained by `create-pwtap add|remove`; anything outside them is yours.',
  '',
].join('\n');

function readmePath(clientDir: string): string {
  return path.join(clientDir, 'README.md');
}

/** Drop an existing region for `id`, so adding twice replaces instead of duplicating. */
function withoutRegion(source: string, id: string): string {
  const from = source.indexOf(start(id));
  if (from === -1) {
    return source;
  }
  const to = source.indexOf(end(id));
  if (to === -1) {
    return source; // half a region: leave it rather than guess where it ended
  }
  return `${source.slice(0, from)}${source.slice(to + end(id).length)}`.replace(/\n{3,}/g, '\n\n');
}

/** Add (or refresh) this plugin's README section. A plugin with nothing to say changes nothing. */
export function applyReadme(clientDir: string, m: PluginManifest): void {
  if (!m.readmeSection?.trim()) {
    return;
  }
  const file = readmePath(clientDir);
  const current = exists(file) ? readText(file) : SKELETON;
  const body = `${start(m.id)}\n\n${m.readmeSection.trim()}\n\n${end(m.id)}`;
  const cleaned = withoutRegion(current, m.id).trimEnd();
  writeText(file, `${cleaned}\n\n${body}\n`);
}

/** Reverse {@link applyReadme}. Absent region, absent file: both are simply nothing to clean. */
export function removeReadme(clientDir: string, m: PluginManifest): void {
  const file = readmePath(clientDir);
  if (!exists(file)) {
    return;
  }
  const stripped = withoutRegion(readText(file), m.id).trimEnd();
  writeText(file, `${stripped}\n`);
}
