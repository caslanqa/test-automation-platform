/**
 * Deterministic `MobileAction[]` -> TypeScript source generator for the code preview panel and the
 * save workflow. Uses plain string templates over a small, fully-covered switch (every `MobileAction`
 * kind is handled, so `default` is unreachable and TypeScript's exhaustiveness check catches any new
 * action kind that forgets a codegen branch) — this MVP does not yet run the output through a real
 * TypeScript AST (Phase 4 scope: locator ranking, formatting, atomic writes); the save step below
 * pipes the result through the project's own Prettier config so output style still matches the repo.
 */
import type { MobileAction, MobileDirection, MobileLocator, MobileTarget } from '../types.js';

function quote(value: string): string {
  return JSON.stringify(value);
}

/** Render a `MobileLocator` as the object literal `app.tap(...)` etc. expect. */
function locatorLiteral(locator: MobileLocator): string {
  const parts: string[] = [];
  if (locator.accessibilityId !== undefined) {
    parts.push(`accessibilityId: ${quote(locator.accessibilityId)}`);
  }
  if (locator.resourceId !== undefined) {
    parts.push(`resourceId: ${quote(locator.resourceId)}`);
  }
  if (locator.text !== undefined) {
    parts.push(`text: ${quote(locator.text)}`);
  }
  if (locator.point !== undefined) {
    parts.push(`point: { x: ${locator.point.x}, y: ${locator.point.y} }`);
  }
  return `{ ${parts.join(', ')} }`;
}

function targetLiteral(target: MobileTarget): string {
  return 'x' in target && 'y' in target
    ? `{ x: ${target.x}, y: ${target.y} }`
    : locatorLiteral(target);
}

function directionLiteral(direction: MobileDirection): string {
  return quote(direction);
}

/** One `await mobileApp.xxx(...)` statement per recorded action, in the same order as the timeline. */
function statementFor(action: MobileAction): string {
  switch (action.kind) {
    case 'tap':
      return `await mobileApp.tap(${locatorLiteral(action.locator)});`;
    case 'fill':
      return `await mobileApp.fill(${locatorLiteral(action.locator)}, ${quote(action.value)});`;
    case 'longPress':
      return `await mobileApp.longPress(${locatorLiteral(action.locator)}${optionsArg(action.options)});`;
    case 'swipe':
      return `await mobileApp.swipe(${directionLiteral(action.direction)}${optionsArg(action.options)});`;
    case 'scroll':
      return `await mobileApp.scroll(${directionLiteral(action.direction)}${optionsArg(scrollOptionsLiteral(action.options))});`;
    case 'drag':
      return `await mobileApp.drag(${targetLiteral(action.from)}, ${targetLiteral(action.to)});`;
    case 'pinch':
      return `await mobileApp.pinch(${action.scale}${optionsArg(action.options)});`;
    case 'pressKey':
      return `await mobileApp.pressKey(${quote(action.key)});`;
    case 'back':
      return `await mobileApp.back();`;
    case 'waitFor':
      return `await mobileApp.waitFor(${locatorLiteral(action.locator)}${optionsArg(action.options)});`;
    // Visibility is generated as `expect.poll`, not `expect(await …)`: the generated test then carries
    // its own waiting semantics instead of depending on whatever timeout the driver happens to apply,
    // and — crucially — `isVisible` is the boolean query action, so asserting `false` is a real
    // outcome rather than a thrown adapter error (architecture.md ADR-004).
    case 'isVisible':
    case 'assertVisible':
      return `await expect.poll(() => mobileApp.isVisible(${locatorLiteral(action.locator)})).toBe(true);`;
    case 'assertNotVisible':
      return `await expect.poll(() => mobileApp.isVisible(${locatorLiteral(action.locator)})).toBe(false);`;
    case 'screenshot':
      return `await mobileApp.screenshot(${action.name ? quote(action.name) : ''});`;
    case 'aiAssert':
      return (
        `const shot = await mobileApp.screenshot(${action.name ? quote(action.name) : ''});\n` +
        `  await expect({ image: shot, rubric: ${quote(action.rubric)} }).toPassRubric();`
      );
  }
}

// Raw string form (already-rendered), reused so `optionsArg` doesn't need a second overload.
function scrollOptionsLiteral(options: { within?: MobileLocator } | undefined): string | undefined {
  if (!options?.within) {
    return undefined;
  }
  return `{ within: ${locatorLiteral(options.within)} }`;
}

function optionsArg(options: unknown): string {
  if (options === undefined) {
    return '';
  }
  if (typeof options === 'string') {
    return `, ${options}`;
  }
  const entries = Object.entries(options as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  return entries.length > 0
    ? `, { ${entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? quote(v) : v}`).join(', ')} }`
    : '';
}

/**
 * Render the single statement (one recorded action) as it appears in the generated test body. Exposed
 * so the recorder can splice a newly recorded action into a hand-edited draft without regenerating the
 * whole file (see `RecorderSession`'s incremental-insertion path).
 */
export function statementForAction(action: MobileAction): string {
  return statementFor(action);
}

/** What the generated `test.use({ mobileTarget: … })` header selects. */
export interface GeneratedTarget {
  driver: string;
  /**
   * MUST be supplied whenever the recorder knows it (it always does — `session.device.platform`).
   * Omitting it forces the fixture to fall back to env vars and throw "platform not set" on any machine
   * that has none, which is what made every generated test unrunnable.
   */
  platform?: string;
  /** Stable device name (AVD name / simulator name), never an `adb` serial — see ADR-003. */
  device?: string;
  /** App to launch on connect. Effectively required for Maestro; without it a replay drives nothing. */
  appId?: string;
  /** Artifact to install before launching `appId`. */
  appSource?: string;
}

/**
 * Render a full `*.mobile.ts` test file for the recorded `actions`. `testName` becomes the `test(...)`
 * title; the caller (save handler) chooses the file path.
 *
 * The emitted fixture names — the `mobileTarget` option and the `mobileApp` fixture — are fixed by
 * ADR-003 and must stay in step with `src/fixture.ts`; a drift here produces a test that fails with an
 * unknown-fixture error, which is why Phase 0's exit criterion is running generated output on a device.
 */
export function generateTestSource(options: {
  target: GeneratedTarget;
  testName: string;
  actions: MobileAction[];
}): string {
  const { target, testName, actions } = options;
  const fields: string[] = [`driver: ${quote(target.driver)}`];
  for (const key of ['platform', 'device', 'appId', 'appSource'] as const) {
    const value = target[key];
    if (value !== undefined && value !== '') {
      fields.push(`${key}: ${quote(value)}`);
    }
  }
  const body =
    actions.length > 0
      ? actions.map(a => `  ${statementFor(a)}`).join('\n')
      : '  // Recorded actions will appear here.';
  return [
    `import { test, expect } from '@fixtures';`,
    '',
    `test.use({ mobileTarget: { ${fields.join(', ')} } });`,
    '',
    `test(${quote(testName)}, async ({ mobileApp }) => {`,
    body,
    '});',
    '',
  ].join('\n');
}
