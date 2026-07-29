/**
 * Writes a recording to disk and enumerates what is already there. Owns file concerns only — it never
 * spawns a process or touches the device (§6).
 *
 * @example await new TestWriter(projectRoot, emit).save({ mode: 'new', targetPath: 'tests/login', … });
 */
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DriverTestBinding, TestFileEntry } from '@pwtap/mobile-core';

import { loadProjectTypeScript, mergeIntoExistingTest } from './ast.js';
import { resolveInsideProject } from './paths.js';
import type { RecorderEvent } from './protocol.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'ui-dist',
  'coverage',
  'test-results',
  'playwright-report',
]);

/** Cap so a huge or misconfigured project cannot make the picker hang. */
const MAX_FILES = 500;

export interface SaveRequest {
  mode: 'new' | 'append';
  targetPath: string;
  testName: string;
  source: string;
  /** Every installed driver's extension, for recognising an already-suffixed name. */
  extensions: string[];
  /** The connected driver's binding, which decides the extension for a new file. */
  binding: DriverTestBinding | undefined;
}

export class TestWriter {
  private readonly projectRoot: string;
  private readonly emit: (event: RecorderEvent) => void;

  constructor(projectRoot: string, emit: (event: RecorderEvent) => void) {
    this.projectRoot = projectRoot;
    this.emit = emit;
  }

  /**
   * Neither mode clobbers the wrong thing: `new` refuses an existing path, and `append` requires the file to
   * exist and merges into it. The write is atomic (temp file, then rename).
   */
  async save(request: SaveRequest): Promise<void> {
    const relative = request.targetPath.trim().replace(/^[/\\]+/, '');
    if (!relative) {
      this.emit({ type: 'error', message: 'no target file specified' });
      return;
    }
    const resolved = resolveSaveExtension({
      relative,
      mode: request.mode,
      extensions: request.extensions,
      binding: request.binding,
    });
    if ('error' in resolved) {
      this.emit({ type: 'error', message: resolved.error });
      return;
    }
    const target = await resolveInsideProject(this.projectRoot, resolved.relativePath);
    if (!target) {
      this.emit({ type: 'error', message: 'save location must be inside the project' });
      return;
    }

    const exists = await fs
      .access(target)
      .then(() => true)
      .catch(() => false);
    if (request.mode === 'new' && exists) {
      this.emit({
        type: 'error',
        message: `${resolved.relativePath} already exists — choose "append to existing file" or a different name`,
      });
      return;
    }
    if (request.mode === 'append' && !exists) {
      this.emit({
        type: 'error',
        message: `${resolved.relativePath} does not exist — choose "new file" to create it`,
      });
      return;
    }

    const body =
      request.mode === 'append'
        ? await this.merge(await fs.readFile(target, 'utf8'), request.source, request.testName)
        : request.source;

    const formatted = await this.format(body, target);
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
    await fs.writeFile(tmp, formatted, 'utf8');
    await fs.rename(tmp, target);
    this.emit({ type: 'saved', path: target });
  }

  /** Existing recordings under the project, for the "append to existing file" picker. */
  async listTestFiles(extensions: string[]): Promise<void> {
    const files: TestFileEntry[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (files.length >= MAX_FILES) {
        return;
      }
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) {
          return;
        }
        if (entry.name.startsWith('.')) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            await walk(full);
          }
        } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
          files.push({
            relativePath: path.relative(this.projectRoot, full).split(path.sep).join('/'),
            name: entry.name,
          });
        }
      }
    };
    await walk(this.projectRoot);
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    this.emit({ type: 'testFiles', files });
  }

  /**
   * Append through the project's TypeScript so imports merge and the body is placed by structure, not by a
   * search for the last `});`. Without TypeScript the test is appended verbatim and the user is told, which
   * is honest about the imports they may need to reconcile.
   */
  /**
   * Subdirectories of a project-relative path, so the save dialog can offer a location instead of asking the
   * user to type one blind. Confined to the project and filtered the same way the file scan is.
   */
  async listDirs(relative = ''): Promise<void> {
    const requested = await resolveInsideProject(this.projectRoot, relative);
    if (!requested) {
      this.emit({ type: 'error', message: 'location must be inside the project' });
      return;
    }
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(requested, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .filter(name => !SKIP_DIRS.has(name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      this.emit({ type: 'error', message: `cannot read ${relative || '.'}` });
      return;
    }
    // Relative to the REAL root: on macOS `/tmp` is a link to `/private/tmp`, so measuring the
    // confined (real) path against an unresolved root would produce a `../…` path the UI cannot use.
    const root = await fs.realpath(this.projectRoot).catch(() => this.projectRoot);
    const listed = path.relative(root, requested).split(path.sep).join('/');
    this.emit({ type: 'dirs', path: listed, entries });
  }

  private async merge(existing: string, generated: string, testName: string): Promise<string> {
    const ts = await loadProjectTypeScript(this.projectRoot);
    if (!ts) {
      this.emit({
        type: 'log',
        level: 'warn',
        message:
          'typescript is not installed in this project, so the test was appended without merging ' +
          'imports — check the top of the file',
      });
      return `${existing.trimEnd()}\n\n${generated.trimEnd()}\n`;
    }
    return mergeIntoExistingTest(ts, existing, generated, testName);
  }

  private async format(body: string, target: string): Promise<string> {
    const prettier = await loadProjectPrettier(this.projectRoot);
    if (!prettier) {
      this.emit({
        type: 'log',
        level: 'info',
        message: 'prettier is not installed in this project — writing the file unformatted',
      });
      return body;
    }
    try {
      const config = (await prettier.resolveConfig(target)) ?? undefined;
      return await prettier.format(body, { ...config, filepath: target });
    } catch (error) {
      this.emit({
        type: 'log',
        level: 'warn',
        message: `prettier formatting skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
      return body;
    }
  }
}

/**
 * Decide the final project-relative path. The extension names the driver (§8), so it comes from the driver
 * the recording was made against — a Maestro recording saved as `*.appium.ts` would land in a project with a
 * different gate variable and never run under `npm run test:maestro`. An already-suffixed name is left alone,
 * and `append` never rewrites the path: the file exists and its name is the user's.
 */
export function resolveSaveExtension(input: {
  relative: string;
  mode: 'new' | 'append';
  extensions: string[];
  binding: DriverTestBinding | undefined;
}): { relativePath: string } | { error: string } {
  const { relative, mode, extensions, binding } = input;
  if (mode === 'append' || extensions.some(ext => relative.endsWith(ext))) {
    return { relativePath: relative };
  }
  if (!binding) {
    return {
      error:
        'cannot tell which driver this test targets — connect a device before saving, or give the file ' +
        `name one of these extensions: ${extensions.join(', ') || '(no driver plugin installed)'}`,
    };
  }
  return { relativePath: `${relative}${binding.extension}` };
}

/** The slice of Prettier's API the save step uses. */
interface ProjectPrettier {
  resolveConfig(filePath: string): Promise<Record<string, unknown> | null>;
  format(source: string, options: Record<string, unknown>): Promise<string>;
}

/**
 * Resolve **the project's own** Prettier rather than bundling a copy (ADR-014): the user's version and
 * `.prettierrc` are the ones that should shape a file written into their repo. Returns `undefined` when the
 * project has none, so the caller degrades audibly instead of crashing a save.
 */
async function loadProjectPrettier(projectRoot: string): Promise<ProjectPrettier | undefined> {
  try {
    const require = createRequire(`${projectRoot}/`);
    const resolved = require.resolve('prettier', { paths: [projectRoot] });
    const mod = (await import(pathToFileURL(resolved).href)) as {
      default?: ProjectPrettier;
    } & ProjectPrettier;
    const api = mod.default ?? mod;
    return typeof api.format === 'function' ? api : undefined;
  } catch {
    return undefined;
  }
}
