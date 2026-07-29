/**
 * The core↔adapter contract check (ADR-009). It replaces `platformCompat.ts`, which probed each imported
 * function at runtime to tell an outdated install apart from a broken one. What matters here is that every
 * refusal names the package to change: "no driver adapter found" while the adapter is installed and simply
 * too old is the failure mode this exists to prevent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MIN_ADAPTER_CONTRACT,
  MOBILE_CORE_CONTRACT,
  adapterContractProblem,
} from '../src/contract.js';
import { DriverNotFoundError } from '../src/types.js';

test('an adapter built against this core is accepted', () => {
  assert.equal(adapterContractProblem('@pwtap/plugin-maestro', MOBILE_CORE_CONTRACT), undefined);
});

test('an adapter that declares nothing is refused, and told to upgrade itself', () => {
  const problem = adapterContractProblem('@pwtap/plugin-maestro', undefined);

  assert.match(problem ?? '', /Upgrade @pwtap\/plugin-maestro/);
});

test('a non-integer declaration is refused rather than coerced', () => {
  for (const declared of ['1', 1.5, null, {}, NaN]) {
    assert.ok(adapterContractProblem('@pwtap/plugin-appium', declared), String(declared));
  }
});

test('too old points at the adapter; too new points at the core', () => {
  assert.match(
    adapterContractProblem('@pwtap/plugin-appium', MIN_ADAPTER_CONTRACT - 1) ?? '',
    /Upgrade @pwtap\/plugin-appium/,
  );
  assert.match(
    adapterContractProblem('@pwtap/plugin-appium', MOBILE_CORE_CONTRACT + 1) ?? '',
    /Upgrade @pwtap\/mobile-core/,
  );
});

test('the shipped adapters declare a contract this core accepts', async () => {
  // The real declarations, not a fixture: this is what catches an adapter published without one.
  for (const pkg of ['@pwtap/plugin-maestro', '@pwtap/plugin-appium']) {
    const mod = (await import(`${pkg}/inspector`)) as { contract?: number };
    assert.equal(adapterContractProblem(pkg, mod.contract), undefined, pkg);
  }
});

test('a refused adapter surfaces its reason through DriverNotFoundError', () => {
  const problem = adapterContractProblem('@pwtap/plugin-maestro', 0) ?? '';

  assert.match(
    new DriverNotFoundError('maestro', [problem]).message,
    /Upgrade @pwtap\/plugin-maestro/,
    'the test author must see why the installed adapter was skipped, not just that nothing was found',
  );
});
