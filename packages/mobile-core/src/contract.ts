/**
 * The core↔adapter compatibility contract (architecture.md ADR-009).
 *
 * A driver adapter is a separately versioned package that implements `MobileInspectorDriver` and is loaded
 * by `registry.ts` from the client project's own `node_modules`, so core and adapter can end up at versions
 * that disagree. Each adapter declares, as a literal in its own source, the contract it was built against;
 * this core states which range it accepts and the registry refuses the rest with the package to upgrade.
 * The number is not the package version — it is bumped only when `MobileInspectorDriver`, `DriverSession`
 * or the action IR changes in a way an older adapter cannot satisfy.
 */

/** Bumped on every breaking change to the driver interfaces or the action IR. */
export const MOBILE_CORE_CONTRACT = 1;

/** The oldest adapter contract this core still accepts. */
export const MIN_ADAPTER_CONTRACT = 1;

/**
 * The value an adapter built against THIS core declares. Typed as the exact current contract so bumping
 * `MOBILE_CORE_CONTRACT` breaks each adapter's build — the point being that a human then reviews whether
 * that adapter actually satisfies the new contract.
 */
export type AdapterContract = typeof MOBILE_CORE_CONTRACT;

/**
 * Why an adapter cannot be loaded, or `undefined` when it can. Named separately from the registry so the
 * decision is testable without a filesystem, and so the message says which package to change.
 */
export function adapterContractProblem(pkg: string, declared: unknown): string | undefined {
  if (typeof declared !== 'number' || !Number.isInteger(declared)) {
    return (
      `[mobile-core] ${pkg} declares no inspector contract version, so it was built against a ` +
      `@pwtap/mobile-core older than contract ${MIN_ADAPTER_CONTRACT}. Upgrade ${pkg}.`
    );
  }
  if (declared < MIN_ADAPTER_CONTRACT) {
    return (
      `[mobile-core] ${pkg} implements inspector contract ${declared}, but this @pwtap/mobile-core ` +
      `requires at least ${MIN_ADAPTER_CONTRACT}. Upgrade ${pkg}.`
    );
  }
  if (declared > MOBILE_CORE_CONTRACT) {
    return (
      `[mobile-core] ${pkg} implements inspector contract ${declared}, which is newer than this ` +
      `@pwtap/mobile-core (${MOBILE_CORE_CONTRACT}). Upgrade @pwtap/mobile-core.`
    );
  }
  return undefined;
}
