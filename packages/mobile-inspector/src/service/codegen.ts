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

/** One `await app.xxx(...)` statement per recorded action, in the same order as the timeline. */
function statementFor(action: MobileAction): string {
  switch (action.kind) {
    case 'tap':
      return `await app.tap(${locatorLiteral(action.locator)});`;
    case 'fill':
      return `await app.fill(${locatorLiteral(action.locator)}, ${quote(action.value)});`;
    case 'longPress':
      return `await app.longPress(${locatorLiteral(action.locator)}${optionsArg(action.options)});`;
    case 'swipe':
      return `await app.swipe(${directionLiteral(action.direction)}${optionsArg(action.options)});`;
    case 'scroll':
      return `await app.scroll(${directionLiteral(action.direction)}${optionsArg(scrollOptionsLiteral(action.options))});`;
    case 'drag':
      return `await app.drag(${targetLiteral(action.from)}, ${targetLiteral(action.to)});`;
    case 'pinch':
      return `await app.pinch(${action.scale}${optionsArg(action.options)});`;
    case 'pressKey':
      return `await app.pressKey(${quote(action.key)});`;
    case 'back':
      return `await app.back();`;
    case 'waitFor':
      return `await app.waitFor(${locatorLiteral(action.locator)}${optionsArg(action.options)});`;
    case 'assertVisible':
      return `expect(await app.isVisible(${locatorLiteral(action.locator)})).toBe(true);`;
    case 'assertNotVisible':
      return `expect(await app.isVisible(${locatorLiteral(action.locator)})).toBe(false);`;
    case 'screenshot':
      return `await app.screenshot(${action.name ? quote(action.name) : ''});`;
    case 'aiAssert':
      return (
        `const shot = await app.screenshot(${action.name ? quote(action.name) : ''});\n` +
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

/**
 * Render a full `*.mobile.ts` test file body for the recorded `actions`, targeting `driver`/`device`.
 * `testName` becomes the `test(...)` title; the caller (save handler) chooses the file path.
 */
export function generateTestSource(options: {
  driver: string;
  device?: string;
  testName: string;
  actions: MobileAction[];
}): string {
  const { driver, device, testName, actions } = options;
  const useLine = device
    ? `test.use({ mobile: { driver: ${quote(driver)}, device: ${quote(device)} } });`
    : `test.use({ mobile: { driver: ${quote(driver)} } });`;
  const body =
    actions.length > 0
      ? actions.map(a => `  ${statementFor(a)}`).join('\n')
      : '  // Recorded actions will appear here.';
  return [
    `import { test, expect } from '@fixtures';`,
    '',
    useLine,
    '',
    `test(${quote(testName)}, async ({ app }) => {`,
    body,
    '});',
    '',
  ].join('\n');
}
