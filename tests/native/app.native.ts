import { expect, test } from '@fixtures/nativeFixtures';

// The bundled examples target a built-in OS app per platform (native/apps.ts), so the layer runs
// out-of-box: macOS TextEdit and Windows Notepad. Point these at your own app once ready — add it to
// native/apps.ts, then `native: { app: '<name>' }`. Each example runs only on its own OS.

test.describe('Native desktop (Appium) — macOS TextEdit', () => {
  test.use({ native: { app: 'textEdit' } });

  test.beforeEach(() => {
    test.skip(process.platform !== 'darwin', 'macOS-only example (TextEdit / mac2 driver)');
  });

  test('the app launches and exposes its accessibility tree', async ({ app }) => {
    // mac2 is XCTest-based, so the page source is an XCUIElement* accessibility tree.
    const source = await app.source();
    expect(source).toContain('XCUIElementType');

    // Demonstrate element querying without being brittle about TextEdit's first-run window
    // (a new document vs an open panel) — `isVisible` branches instead of failing.
    const hasWindow = await app.isVisible({ xpath: '//XCUIElementTypeWindow' }, { timeout: 10000 });
    expect(typeof hasWindow).toBe('boolean');

    await app.takeScreenshot('textedit');
  });
});

test.describe('Native desktop (Appium) — Windows Notepad', () => {
  test.use({ native: { app: 'notepad' } });

  test.beforeEach(() => {
    test.skip(process.platform !== 'win32', 'Windows-only example (Notepad / windows driver)');
  });

  test('the app launches and exposes its UI tree', async ({ app }) => {
    const source = await app.source();
    expect(source.length).toBeGreaterThan(0);

    const hasWindow = await app.isVisible({ xpath: '//Window' }, { timeout: 10000 });
    expect(typeof hasWindow).toBe('boolean');

    await app.takeScreenshot('notepad');
  });
});
