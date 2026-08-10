/**
 * Defaults the CONTRACT owns, not each adapter.
 *
 * An action's options are optional, and every adapter used to invent its own default for the ones a test left
 * out — `isVisible` waited 2 s on Maestro and 5 s on Appium, `longPress` held for 1 s on Appium and for
 * whatever Maestro chose. So the same test body, which is the whole promise of the driver-neutral IR, behaved
 * differently depending on which driver ran it, silently and only under timing.
 *
 * An adapter MUST resolve an omitted option from here rather than from a literal of its own. Where a driver
 * cannot express the value at all it MUST refuse the action, not quietly substitute its own behaviour.
 *
 * @example const timeout = action.options?.timeoutMs ?? ACTION_DEFAULTS.isVisibleMs;
 */
export const ACTION_DEFAULTS: {
  readonly isVisibleMs: number;
  readonly waitForMs: number;
  readonly longPressMs: number;
  readonly swipeDistance: number;
  readonly scrollUntilVisibleMs: number;
} = {
  /** How long `scrollUntilVisible` keeps looking before it fails, rather than scrolling forever. */
  scrollUntilVisibleMs: 10_000,
  /** `isVisible` asks "is this here now?" to branch on, so it must not stall a test that expects `false`. */
  isVisibleMs: 2_000,
  /** `waitFor` is a wait, so it gets Playwright's own default expect timeout. */
  waitForMs: 5_000,
  /** How long `longPress` holds when a test does not say. */
  longPressMs: 1_000,
  /** How far a `swipe` travels, as a fraction of the swept axis. */
  swipeDistance: 0.75,
};
