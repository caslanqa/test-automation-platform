import { mergeExpects, mergeTests } from '@playwright/test';

import { test as apiTest } from './api';
import { expect as uiExpect, test as uiTest, withSessionAuth } from './ui';

/**
 * The single, editable test object for this project — core UI + API fixtures, plus any installed
 * plugin fixtures merged in below. Import `test` and `expect` from `@fixtures` everywhere. Auth works
 * at suite level (`test.use({ session })`) or per test (`test.as('session')('title', fn)`).
 *
 * The regions between the `pwtap:` markers are maintained by `create-pwtap add|remove`. Edit outside
 * the markers freely; the tool only rewrites between them.
 *
 * @example
 * import { test, expect } from '@fixtures';
 * test.as('adminUser')('reaches the app', async ({ page }) => {
 *   await page.goto('/');
 *   await expect(page).toHaveURL(/\//);
 * });
 */

// pwtap:plugins:imports
// pwtap:plugins:imports:end

export const test = withSessionAuth(
  mergeTests(
    uiTest,
    apiTest,
    // pwtap:plugins:tests
    // pwtap:plugins:tests:end
  ),
);

export const expect = mergeExpects(
  uiExpect,
  // pwtap:plugins:expects
  // pwtap:plugins:expects:end
);
