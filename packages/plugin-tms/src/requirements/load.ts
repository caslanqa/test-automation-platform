/**
 * Requirements, read from the repository.
 *
 * **Qase has no requirements API.** Its own traceability is fed by *external issues* — a case linked to
 * a Jira/GitHub/GitLab ticket through `POST /case/{code}/{id}/external-issues`. With no tracker wired
 * up there is nothing on that side to sync to, so the requirements live here, next to the tests, in
 * `requirements/*.md`. That is also the shape `story-reviewer` already produces: this format gives its
 * output a home rather than inventing a new one.
 *
 * ```markdown
 * ---
 * id: PAY-17
 * title: An expired card is rejected at checkout
 * status: valid          # valid | draft | review | implemented | obsolete
 * type: user-story       # epic | feature | user-story
 * parent: PAY-1
 * ---
 *
 * ## Acceptance criteria
 *
 * 1. **AC-1** — Paying with an expired card returns HTTP 422 and the code `card_expired`.
 * 2. **AC-2** — The user is shown "Your card has expired".
 * ```
 *
 * The frontmatter reader is a **flat-YAML subset**, hand-written, the same choice
 * `@pwtap/create`'s `src/agents/frontmatter.ts` made for the same reason: a `yaml` dependency to read
 * six scalar keys is not a trade worth making, and an unknown key is refused rather than ignored so a
 * typo surfaces at read time instead of becoming a silently-missing link.
 *
 * @example
 * const requirements = loadRequirements('/repo');
 * requirements[0]; // { id: 'PAY-17', title: '…', criteria: [{ id: 'AC-1', text: '…' }] }
 */
import fs from 'node:fs';
import path from 'node:path';

/** Where requirement files live, relative to the project root. */
export const REQUIREMENTS_DIR = 'requirements';

export const REQUIREMENT_STATUSES = [
  'valid',
  'draft',
  'review',
  'implemented',
  'obsolete',
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const REQUIREMENT_TYPES = ['epic', 'feature', 'user-story'] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];

export interface AcceptanceCriterion {
  /** `AC-1`, as written in the file. */
  id: string;
  text: string;
}

export interface Requirement {
  id: string;
  title: string;
  status: RequirementStatus;
  type: RequirementType;
  /** Another requirement's id, or `undefined` for a root. */
  parent?: string;
  criteria: AcceptanceCriterion[];
  /** Posix path relative to the project root, for error messages and the report. */
  file: string;
}

/** A file that could not be read as a requirement, and why. Reported, never thrown past the loader. */
export interface RequirementProblem {
  file: string;
  reason: string;
}

export interface RequirementSet {
  requirements: Requirement[];
  problems: RequirementProblem[];
}

const KNOWN_KEYS = new Set(['id', 'title', 'status', 'type', 'parent']);

/**
 * Split `---`-delimited frontmatter from the body.
 *
 * The closing fence must be its own line: a `---` inside a fenced code block in the body is not a
 * terminator, and a document that only opens a fence is malformed rather than empty.
 */
function splitFrontmatter(source: string): { front: string; body: string } | undefined {
  const normalised = source.replace(/^﻿/, '');
  if (!normalised.startsWith('---')) {
    return undefined;
  }
  const lines = normalised.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      return { front: lines.slice(1, index).join('\n'), body: lines.slice(index + 1).join('\n') };
    }
  }
  return undefined;
}

/**
 * The flat-YAML subset: `key: value` per line, `#` comments, optional single or double quotes.
 * Nesting, lists and multi-line scalars are refused rather than half-supported.
 */
function parseFrontmatter(front: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const raw of front.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    if (raw.startsWith(' ') || raw.startsWith('\t') || line.startsWith('- ')) {
      return `nested or list frontmatter is not supported: "${line}"`;
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      return `frontmatter line is not "key: value": "${line}"`;
    }
    const key = line.slice(0, colon).trim();
    // Strip a trailing `# comment`, then the quotes a value may carry.
    const value = line
      .slice(colon + 1)
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    if (!KNOWN_KEYS.has(key)) {
      return `unknown frontmatter key "${key}" — known keys: ${[...KNOWN_KEYS].join(', ')}`;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Acceptance criteria from the body: any line carrying a bold `**AC-n**` marker, with the rest of the
 * line as its text.
 *
 * Deliberately loose about the surrounding markdown — numbered list, bullet, or a bare line all work —
 * because the marker is the contract and the prose around it is the author's business. A file with no
 * markers simply has no criteria, which is a valid state: the requirement is then covered as a whole.
 */
const CRITERION = /\*\*(AC-\d+)\*\*\s*[—–:-]?\s*(.*)$/;

function parseCriteria(body: string): AcceptanceCriterion[] {
  const seen = new Set<string>();
  const out: AcceptanceCriterion[] = [];
  for (const line of body.split('\n')) {
    const match = CRITERION.exec(line);
    if (match === null) {
      continue;
    }
    const [, id, text] = match;
    // First one wins: a repeated id is an authoring mistake, and silently keeping the last would make
    // the matrix depend on file order.
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ id, text: text.trim() });
    }
  }
  return out;
}

function parseOne(source: string, file: string): Requirement | RequirementProblem {
  const split = splitFrontmatter(source);
  if (split === undefined) {
    return { file, reason: 'no --- frontmatter block' };
  }

  const front = parseFrontmatter(split.front);
  if (typeof front === 'string') {
    return { file, reason: front };
  }

  const id = (front.id ?? '').trim();
  if (id === '') {
    return { file, reason: 'frontmatter has no id' };
  }
  const title = (front.title ?? '').trim();
  if (title === '') {
    return { file, reason: `${id} has no title` };
  }

  const status = (front.status ?? 'valid').trim() as RequirementStatus;
  if (!REQUIREMENT_STATUSES.includes(status)) {
    return {
      file,
      reason: `${id} has status "${status}" — one of ${REQUIREMENT_STATUSES.join(', ')}`,
    };
  }
  const type = (front.type ?? 'user-story').trim() as RequirementType;
  if (!REQUIREMENT_TYPES.includes(type)) {
    return { file, reason: `${id} has type "${type}" — one of ${REQUIREMENT_TYPES.join(', ')}` };
  }

  const parent = (front.parent ?? '').trim();
  return {
    id,
    title,
    status,
    type,
    ...(parent === '' ? {} : { parent }),
    criteria: parseCriteria(split.body),
    file,
  };
}

function markdownFiles(dir: string, prefix: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        return markdownFiles(path.join(dir, entry.name), relative);
      }
      return entry.name.toLowerCase().endsWith('.md') ? [relative] : [];
    })
    .sort();
}

/**
 * Every requirement under `<cwd>/requirements/`, recursively.
 *
 * A missing directory yields an empty set rather than an error — a project that has not adopted
 * requirements yet should get a clear "none found", not a stack trace. A duplicate id becomes a problem
 * on the second file, because two requirements answering to one key make every downstream link
 * ambiguous.
 */
export function loadRequirements(cwd: string, dir: string = REQUIREMENTS_DIR): RequirementSet {
  const root = path.resolve(cwd, dir);
  if (!fs.existsSync(root)) {
    return { requirements: [], problems: [] };
  }

  const requirements: Requirement[] = [];
  const problems: RequirementProblem[] = [];
  const byId = new Map<string, string>();

  for (const relative of markdownFiles(root, '')) {
    const file = `${dir}/${relative}`;
    let source: string;
    try {
      source = fs.readFileSync(path.join(root, relative), 'utf8');
    } catch (error) {
      problems.push({ file, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const parsed = parseOne(source, file);
    if (!('id' in parsed)) {
      problems.push(parsed);
      continue;
    }
    const clash = byId.get(parsed.id);
    if (clash !== undefined) {
      problems.push({ file, reason: `duplicate id ${parsed.id} — already defined in ${clash}` });
      continue;
    }
    byId.set(parsed.id, file);
    requirements.push(parsed);
  }

  for (const requirement of requirements) {
    if (requirement.parent !== undefined && !byId.has(requirement.parent)) {
      problems.push({
        file: requirement.file,
        reason: `${requirement.id} names parent ${requirement.parent}, which no file defines`,
      });
    }
  }

  return { requirements, problems };
}
