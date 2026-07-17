import { expect, test } from '@fixtures/mobileFixtures';
import { devices } from '@mobile/devices';

test.describe('Settings app — iOS (About: relational checks)', () => {
  test.use({ mobile: { ...devices.iphone16, headless: false } });

  // A richer example than a straight-line flow: on the About table, verify that the value in the
  // "Name" row is "iPhone" — two independent ways, both needing more than a flat tapOn.
  test('the About "Name" row resolves to "iPhone"', async ({ maestro }) => {
    await maestro.launchApp('com.apple.Preferences');
    await maestro.scrollUntilVisible('General');
    await maestro.tapOn('General');
    await maestro.tapOn('About');
    await maestro.assertVisible('Name'); // we're on the About page

    // (1) Maestro-native RELATIONAL selector: assert "iPhone" sits to the right of the "Name" label —
    //     i.e. in the same table row. No node types, no tree walking; one line.
    await maestro.assertVisible({ text: 'iPhone', rightOf: { text: 'Name' } });

    // (2) Read the value and assert/branch in TypeScript. `rowValue` walks the live hierarchy for you
    //     (the walker lives in the framework, not here) — nothing to define per screen or per table.
    expect(await maestro.rowValue('Name'), 'About → Name').toBe('iPhone');
    expect(await maestro.rowValue('iOS Version'), 'About → iOS Version').toBeTruthy();
  });
});
