/**
 * The renderer: gating, the Claude plugin layout, and byte-stability. The gating assertions are the
 * point — a definition whose predicate fails must not reach the plugin directory at all, because
 * Claude Code cannot gate a component itself.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { ProjectCapabilities } from '../src/agents/capabilities.js';
import { loadDefs } from '../src/agents/defs.js';
import { parseFrontmatter } from '../src/agents/frontmatter.js';
import { renderClaudePlugin } from '../src/agents/renderClaude.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

/** A definitions root from `<kind-dir>/<file>.md` → contents. */
function defsRoot(files: Record<string, string>): string {
  const root = tmp('pwtap-render-defs-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const def = (front: string, body = 'Body.\n'): string => `---\n${front}\n---\n${body}`;

function caps(overrides: Partial<ProjectCapabilities> = {}): ProjectCapabilities {
  return {
    projectDir: '/tmp/a-project',
    testsDir: 'tests',
    plugins: {},
    scripts: ['test', 'test:api'],
    tokens: new Set(['core']),
    warnings: [],
    ...overrides,
  };
}

const FIXTURE_DEFS = {
  'agents/vv-lead.md': def(
    'name: vv-lead\ndescription: Routes a change. Use when reviewing.\ntools: [read, search, shell]',
  ),
  'agents/mobile-vv.md': def(
    [
      'name: mobile-vv',
      'description: Mobile V&V. Use when reviewing mobile tests.',
      'requires: cap:mobile',
      'tools: [read]',
      'model: sonnet',
      'effort: high',
      'owns: [mobile-locators]',
      'subagentOf: vv-lead',
    ].join('\n'),
  ),
  'agents/test-strategist.md': def(
    [
      'name: test-strategist',
      'description: Picks the layer. Use when planning coverage.',
      'owns: [risk-to-layer, perf-budgets]',
      'subagentOf: vv-lead',
    ].join('\n'),
  ),
  'skills/risk-to-layer.md': def(
    'name: risk-to-layer\ndescription: Layer rules. Use when planning.',
  ),
  'skills/mobile-locators.md': def(
    'name: mobile-locators\ndescription: Mobile locators. Use when writing mobile tests.\nrequires: cap:mobile',
  ),
  'skills/perf-budgets.md': def(
    'name: perf-budgets\ndescription: Perf budgets. Use when checking perf.\nrequires: plugin:perf',
  ),
  'commands/vv.md': def('name: vv\ndescription: Run a V&V pass.'),
};

/** The fixture definition set, in a fresh root each call. */
const FIXTURE_DEFS_ROOT = (): string => defsRoot(FIXTURE_DEFS);

function render(tokens: string[], extra: Partial<ProjectCapabilities> = {}) {
  const defs = loadDefs(FIXTURE_DEFS_ROOT());
  const outDir = path.join(tmp('pwtap-render-out-'), 'plugin');
  return renderClaudePlugin({
    defs,
    capabilities: caps({ tokens: new Set(['core', ...tokens]), ...extra }),
    outDir,
    version: '9.9.9',
  });
}

const read = (outDir: string, rel: string): string =>
  fs.readFileSync(path.join(outDir, rel), 'utf8');

test('only satisfied definitions are emitted — the gating guarantee', () => {
  const result = render([]);
  assert.deepEqual(result.included.map(d => d.name).sort(), [
    'risk-to-layer',
    'test-strategist',
    'vv',
    'vv-lead',
  ]);
  assert.deepEqual(result.excluded.map(e => e.def.name).sort(), [
    'mobile-locators',
    'mobile-vv',
    'perf-budgets',
  ]);
  assert.equal(fs.existsSync(path.join(result.outDir, 'agents', 'mobile-vv.md')), false);
  assert.equal(fs.existsSync(path.join(result.outDir, 'skills', 'mobile-locators')), false);
  assert.equal(fs.existsSync(path.join(result.outDir, 'skills', 'perf-budgets')), false);
});

test('the same definitions appear once the capability is present', () => {
  const result = render(['cap:mobile']);
  assert.ok(result.included.some(d => d.name === 'mobile-vv'));
  assert.ok(fs.existsSync(path.join(result.outDir, 'agents', 'mobile-vv.md')));
  assert.ok(fs.existsSync(path.join(result.outDir, 'skills', 'mobile-locators', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(result.outDir, 'skills', 'perf-budgets')), false);
});

test('plugin.json names the namespace and sets no component path fields', () => {
  const result = render([]);
  const manifest = JSON.parse(read(result.outDir, '.claude-plugin/plugin.json')) as Record<
    string,
    unknown
  >;
  assert.equal(manifest.name, 'pwtap');
  assert.equal(manifest.version, '9.9.9');
  // These REPLACE the default scan, and the default scan is exactly what we emit.
  for (const field of ['agents', 'commands', 'skills', 'workflows', 'outputStyles']) {
    assert.equal(manifest[field], undefined, `plugin.json must not set '${field}'`);
  }
});

test('the layout is agents/<name>.md, skills/<name>/SKILL.md, commands/<name>.md', () => {
  const result = render([]);
  assert.deepEqual(result.emitted, [
    '.claude-plugin/plugin.json',
    'README.md',
    'agents/test-strategist.md',
    'agents/vv-lead.md',
    'commands/vv.md',
    'skills/risk-to-layer/SKILL.md',
  ]);
});

test('an agent never carries hooks, mcpServers or permissionMode', () => {
  const result = render(['cap:mobile']);
  for (const file of result.emitted.filter(f => f.startsWith('agents/'))) {
    const { data } = parseFrontmatter(read(result.outDir, file), file);
    for (const forbidden of ['hooks', 'mcpServers', 'permissionMode']) {
      assert.equal(data[forbidden], undefined, `${file} must not set '${forbidden}'`);
    }
  }
});

test('neutral tools map to Claude tool names, and model/effort pass through', () => {
  const result = render(['cap:mobile']);
  const lead = parseFrontmatter(read(result.outDir, 'agents/vv-lead.md'), 'vv-lead').data;
  assert.deepEqual(lead.tools, ['Read', 'Grep', 'Glob', 'Bash']);
  assert.equal(lead.model, undefined);

  const mobile = parseFrontmatter(read(result.outDir, 'agents/mobile-vv.md'), 'mobile-vv').data;
  assert.deepEqual(mobile.tools, ['Read']);
  assert.equal(mobile.model, 'sonnet');
  assert.equal(mobile.effort, 'high');
});

test('a skill carries no tools block — only agents get one', () => {
  const result = render([]);
  const { data } = parseFrontmatter(read(result.outDir, 'skills/risk-to-layer/SKILL.md'), 's');
  assert.deepEqual(Object.keys(data), ['name', 'description']);
});

test('an owns entry whose predicate failed is pruned from the emitted skills list', () => {
  const withoutPerf = render([]);
  const strategist = parseFrontmatter(
    read(withoutPerf.outDir, 'agents/test-strategist.md'),
    'test-strategist',
  ).data;
  assert.deepEqual(strategist.skills, ['pwtap:risk-to-layer'], 'perf-budgets must not be named');
  // Pruning is not warned about: `owns` is a superset by design, so it would print the same lines on
  // every session start of every core-only project. The README's roster table carries it instead.
  assert.equal(
    withoutPerf.warnings.some(w => w.includes('owns')),
    false,
  );
  assert.ok(
    withoutPerf.excluded.some(entry => entry.def.name === 'perf-budgets'),
    'the exclusion belongs in the roster report',
  );

  const withPerf = render(['plugin:perf']);
  const both = parseFrontmatter(
    read(withPerf.outDir, 'agents/test-strategist.md'),
    'test-strategist',
  ).data;
  assert.deepEqual(both.skills, ['pwtap:risk-to-layer', 'pwtap:perf-budgets']);
});

test('subagent composition becomes prose, since a plugin agent has no parent field', () => {
  const result = render(['cap:mobile']);
  const lead = read(result.outDir, 'agents/vv-lead.md');
  assert.match(lead, /## Delegate to/);
  assert.match(lead, /@pwtap:mobile-vv/);
  assert.match(lead, /@pwtap:test-strategist/);

  const child = read(result.outDir, 'agents/mobile-vv.md');
  assert.match(child, /Report your verdict back to `@pwtap:vv-lead`/);
});

test('a gated-out child is not named in its parent delegation list', () => {
  const result = render([]);
  const lead = read(result.outDir, 'agents/vv-lead.md');
  assert.equal(lead.includes('mobile-vv'), false);
});

test('interpolation fills testsDir, projectDir and script names', () => {
  const defs = loadDefs(
    defsRoot({
      'skills/s.md': def(
        'name: s\ndescription: Interpolation probe. Use when testing.',
        'Run {{script:test}} in {{projectDir}} over {{testsDir}}/api.\n',
      ),
    }),
  );
  const outDir = path.join(tmp('pwtap-render-out-'), 'plugin');
  const result = renderClaudePlugin({
    defs,
    capabilities: caps({ testsDir: 'e2e', projectDir: '/srv/suite' }),
    outDir,
    version: '1.0.0',
  });
  assert.match(
    read(result.outDir, 'skills/s/SKILL.md'),
    /Run npm run test in \/srv\/suite over e2e\/api\./,
  );
});

test('a script the project does not have is reported, and degrades rather than breaking', () => {
  const defs = loadDefs(
    defsRoot({
      'skills/s.md': def(
        'name: s\ndescription: Interpolation probe. Use when testing.',
        'Run {{script:test:mobile}}.\n',
      ),
    }),
  );
  const outDir = path.join(tmp('pwtap-render-out-'), 'plugin');
  const result = renderClaudePlugin({ defs, capabilities: caps(), outDir, version: '1.0.0' });
  assert.ok(result.warnings.some(w => w.includes("script 'test:mobile'")));
  assert.match(read(result.outDir, 'skills/s/SKILL.md'), /Run npm run test:mobile\./);
});

test('a baseline render — no project at all — still produces a loadable plugin', () => {
  const defs = loadDefs(defsRoot(FIXTURE_DEFS));
  const outDir = path.join(tmp('pwtap-render-out-'), 'plugin');
  const result = renderClaudePlugin({ defs, capabilities: null, outDir, version: '1.0.0' });
  assert.ok(fs.existsSync(path.join(result.outDir, '.claude-plugin', 'plugin.json')));
  assert.ok(fs.existsSync(path.join(result.outDir, 'agents', 'vv-lead.md')));
  assert.equal(
    result.included.some(d => d.name === 'mobile-vv'),
    false,
  );
  assert.match(read(result.outDir, 'README.md'), /No pwtap project was resolved/);
  // Nothing to report: with no project there is nothing to check a script against, and a prune is
  // normal operation. A warning on every session start of a fresh install would be pure noise.
  assert.deepEqual(result.warnings, []);
});

test('the README explains the roster, both what is in and what is out', () => {
  const readmeText = read(render([]).outDir, 'README.md');
  assert.match(readmeText, /\| ✓ \| agent \| `vv-lead` \| `core` \|/);
  assert.match(readmeText, /\| · \| agent \| `mobile-vv` \| `cap:mobile` \|/);
  assert.match(readmeText, /Capability tokens: `core`/);
});

test('rendering the same input twice is byte-identical', () => {
  const defs = loadDefs(defsRoot(FIXTURE_DEFS));
  const capabilities = caps({ tokens: new Set(['core', 'cap:mobile']) });
  const digest = (): string => {
    const outDir = path.join(tmp('pwtap-render-out-'), 'plugin');
    const result = renderClaudePlugin({ defs, capabilities, outDir, version: '1.0.0' });
    return result.emitted.map(rel => `${rel}\n${read(outDir, rel)}`).join('\0');
  };
  assert.equal(digest(), digest());
});

test('a re-render into the same directory replaces it rather than merging', () => {
  const defs = loadDefs(defsRoot(FIXTURE_DEFS));
  const outDir = path.join(tmp('pwtap-render-out-'), 'plugin');
  renderClaudePlugin({
    defs,
    capabilities: caps({ tokens: new Set(['core', 'cap:mobile']) }),
    outDir,
    version: '1.0.0',
  });
  assert.ok(fs.existsSync(path.join(outDir, 'agents', 'mobile-vv.md')));

  renderClaudePlugin({ defs, capabilities: caps(), outDir, version: '1.0.0' });
  assert.equal(
    fs.existsSync(path.join(outDir, 'agents', 'mobile-vv.md')),
    false,
    'a removed plugin must leave no stale component behind',
  );
});

test('extras are copied in verbatim, and a missing extra is skipped', () => {
  const source = path.join(tmp('pwtap-extra-'), 'hooks.json');
  fs.writeFileSync(source, '{"hooks":{}}\n');
  const defs = loadDefs(defsRoot({ 'skills/s.md': def('name: s\ndescription: aaaaaaaaaaaaaaa') }));
  const outDir = path.join(tmp('pwtap-render-out-'), 'plugin');
  const result = renderClaudePlugin({
    defs,
    capabilities: caps(),
    outDir,
    version: '1.0.0',
    extras: [
      [source, 'hooks/hooks.json'],
      [path.join(source, 'absent'), 'hooks/absent.mjs'],
    ],
  });
  assert.equal(read(result.outDir, 'hooks/hooks.json'), '{"hooks":{}}\n');
  assert.equal(result.emitted.includes('hooks/absent.mjs'), false);
});

test('a prose reference to a definition that was gated out is reported, not left dangling', () => {
  const defs = loadDefs(
    defsRoot({
      'agents/a.md': def(
        'name: a\ndescription: Refers onward. Use when testing.',
        'See {{ref:gated}} for the rule.\n',
      ),
      'skills/gated.md': def(
        'name: gated\ndescription: Only with perf. Use when checking perf.\nrequires: plugin:perf',
      ),
    }),
  );
  const outDir = path.join(tmp('pwtap-render-out-'), 'plugin');
  const result = renderClaudePlugin({ defs, capabilities: caps(), outDir, version: '1.0.0' });
  assert.ok(result.warnings.some(w => w.includes("refers to 'gated'")));
  // Still rendered as a reference: the sentence was written on the assumption, and a half-substituted
  // token would reach the model as literal `{{ref:…}}`, which is worse than a name it cannot find.
  assert.match(read(result.outDir, 'agents/a.md'), /See `?@pwtap:gated/);
});

test('standalone mode drops the manifest and stops namespacing', () => {
  const defs = loadDefs(FIXTURE_DEFS_ROOT());
  const outDir = path.join(tmp('pwtap-standalone-'), '.claude');
  const result = renderClaudePlugin({
    defs,
    capabilities: caps({ tokens: new Set(['core', 'cap:mobile']) }),
    outDir,
    version: '1.0.0',
    standalone: true,
  });

  assert.equal(result.emitted.includes('.claude-plugin/plugin.json'), false);
  assert.ok(result.emitted.includes('pwtap-vv-roster.md'));
  assert.equal(result.emitted.includes('README.md'), false);

  const lead = parseFrontmatter(read(result.outDir, 'agents/vv-lead.md'), 'vv-lead');
  assert.match(lead.body, /- `@mobile-vv`/, 'a project-level agent is mentioned bare');
  assert.equal(lead.body.includes('@pwtap:'), false);

  const strategist = parseFrontmatter(read(result.outDir, 'agents/test-strategist.md'), 's').data;
  assert.deepEqual(strategist.skills, ['risk-to-layer'], 'skills are bare names, not pwtap:names');
});

test('standalone mode never deletes what it did not write', () => {
  const outDir = path.join(tmp('pwtap-standalone-'), '.claude');
  fs.mkdirSync(path.join(outDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'settings.local.json'), '{"permissions":{}}');
  fs.writeFileSync(path.join(outDir, 'agents', 'mine.md'), 'keep me');

  const render1 = (tokens: string[]): void => {
    renderClaudePlugin({
      defs: loadDefs(FIXTURE_DEFS_ROOT()),
      capabilities: caps({ tokens: new Set(['core', ...tokens]) }),
      outDir,
      version: '1.0.0',
      standalone: true,
    });
  };
  render1(['cap:mobile']);
  render1([]);

  assert.equal(fs.readFileSync(path.join(outDir, 'agents', 'mine.md'), 'utf8'), 'keep me');
  assert.ok(fs.existsSync(path.join(outDir, 'settings.local.json')));
  // The trade this buys: a component whose capability disappeared stays behind as a stale file, which
  // is why the plugin path stages-and-swaps and this one is documented as a static snapshot.
  assert.ok(
    fs.existsSync(path.join(outDir, 'agents', 'mobile-vv.md')),
    'standalone is a snapshot: re-running with fewer plugins does not remove what it wrote before',
  );
});
