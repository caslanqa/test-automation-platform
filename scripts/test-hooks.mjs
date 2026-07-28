/**
 * Module-resolution hook for `npm test`.
 *
 * Tests run straight from TypeScript through Node's built-in type stripping (`node --test`), with no
 * build step and no transpiler dependency (see docs/mobile-inspector/architecture.md ADR-012). That
 * works for the test files themselves, but not for the modules they import: every source file in this
 * monorepo addresses its siblings with a `.js` specifier, because `moduleResolution: "NodeNext"`
 * requires the *emitted* extension. Node does not map `./locator.js` back to `locator.ts`, so loading
 * a source module directly would fail with ERR_MODULE_NOT_FOUND.
 *
 * This hook closes exactly that gap: when a `.ts` file imports a relative `.js` path and a sibling
 * `.ts` exists, resolve to the `.ts`. The `parentURL.endsWith('.ts')` guard is what keeps it safe —
 * compiled output in `dist/` is never touched, so this changes how tests load source and nothing else.
 *
 * The alternative was rewriting every relative import in every package to a `.ts` specifier (TypeScript's
 * `rewriteRelativeImportExtensions`). That is the blessed long-term path, but it is a monorepo-wide diff
 * to source that ships to users, in exchange for deleting twenty lines that only ever run under `--test`.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (parent?.endsWith('.ts') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const tsUrl = new URL(`${specifier.slice(0, -3)}.ts`, parent);
      if (existsSync(tsUrl)) {
        return { url: tsUrl.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
