/**
 * Edits test files through the project's own TypeScript compiler instead of by regex (ADR-005/ADR-014).
 *
 * Nothing here re-emits code from an AST; it slices the original text at positions the parser reports, so
 * formatting and comments survive untouched. The string version this replaces dropped every non-`@fixtures`
 * import when merging and found the insertion point by searching for the last `});` in the file.
 *
 * @example const ts = await loadProjectTypeScript(root); insertStatementIntoTest(ts, source, stmt);
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import type TypeScript from 'typescript';

export type TypeScriptApi = typeof TypeScript;

/** The project's TypeScript, or `undefined` when it has none so the caller can degrade audibly. */
export async function loadProjectTypeScript(
  projectRoot: string,
): Promise<TypeScriptApi | undefined> {
  try {
    const require = createRequire(`${projectRoot}/`);
    const resolved = require.resolve('typescript', { paths: [projectRoot] });
    const mod = (await import(pathToFileURL(resolved).href)) as {
      default?: TypeScriptApi;
    } & TypeScriptApi;
    const api = mod.default ?? mod;
    return typeof api.createSourceFile === 'function' ? api : undefined;
  } catch {
    return undefined;
  }
}

function parse(ts: TypeScriptApi, source: string): TypeScript.SourceFile {
  return ts.createSourceFile('draft.ts', source, ts.ScriptTarget.Latest, true);
}

/**
 * Insert a statement at the end of the last `test(...)` body. Falls back to appending at the end of the file
 * when there is no test block to insert into, which is what a draft the user has emptied looks like.
 */
export function insertStatementIntoTest(
  ts: TypeScriptApi,
  source: string,
  statement: string,
): string {
  const file = parse(ts, source);
  let body: TypeScript.Block | undefined;

  const visit = (node: TypeScript.Node): void => {
    if (ts.isCallExpression(node) && callsTest(ts, node.expression)) {
      const callback = node.arguments.at(-1);
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        callback.body &&
        ts.isBlock(callback.body)
      ) {
        body = callback.body; // keep walking: the LAST test in the file is the one being recorded into
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  if (!body) {
    return `${source.trimEnd()}\n${statement}\n`;
  }
  // Insert before the block's closing brace, preserving the indentation the file already uses.
  const closingBrace = body.getEnd() - 1;
  const indent = `${indentationOf(source, closingBrace)}  `;
  return `${source.slice(0, closingBrace)}${indent}${statement}\n${source.slice(closingBrace)}`;
}

/**
 * Merge a generated test into an existing file. The generated body is wrapped in its own `test.describe` so
 * its `test.use()` stays scoped to it, and imports are merged by module specifier — the old version dropped
 * any import the target did not already have unless it lacked `@fixtures` entirely.
 */
export function mergeIntoExistingTest(
  ts: TypeScriptApi,
  existing: string,
  generated: string,
  testName: string,
): string {
  const generatedFile = parse(ts, generated);
  const existingFile = parse(ts, existing);

  const existingModules = new Set(
    existingFile.statements
      .filter(ts.isImportDeclaration)
      .map(statement => statement.moduleSpecifier.getText(existingFile)),
  );
  const missingImports = generatedFile.statements
    .filter(ts.isImportDeclaration)
    .filter(statement => !existingModules.has(statement.moduleSpecifier.getText(generatedFile)))
    .map(statement => statement.getText(generatedFile));

  const bodyStatements = generatedFile.statements.filter(
    statement => !ts.isImportDeclaration(statement),
  );
  const body = bodyStatements.map(statement => statement.getText(generatedFile)).join('\n\n');
  const indented = body
    .split('\n')
    .map(line => (line.trim() ? `  ${line}` : line))
    .join('\n');
  const block = `test.describe(${JSON.stringify(testName)}, () => {\n${indented}\n});\n`;

  const header = missingImports.length > 0 ? `${missingImports.join('\n')}\n` : '';
  return `${header}${existing.trimEnd()}\n\n${block}`;
}

function callsTest(ts: TypeScriptApi, expression: TypeScript.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === 'test';
  }
  // `test.only`, `test.skip`, `test.as(...)(…)` — anything rooted at `test` counts.
  if (ts.isPropertyAccessExpression(expression)) {
    return callsTest(ts, expression.expression);
  }
  if (ts.isCallExpression(expression)) {
    return callsTest(ts, expression.expression);
  }
  return false;
}

/** Leading whitespace of the line containing `position`. */
function indentationOf(source: string, position: number): string {
  const lineStart = source.lastIndexOf('\n', position - 1) + 1;
  const line = source.slice(lineStart, position);
  return /^\s*/.exec(line)?.[0] ?? '';
}
