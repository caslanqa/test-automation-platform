/**
 * The MCP server against a real emulator or simulator, opt-in.
 *
 * Every other MCP test uses the fake driver, which proves the tools and the wiring and says nothing about
 * whether a real driver answers them. This drives the genuine adapter through the genuine discovery path.
 *
 *   PWTAP_DEVICE=1 npm run test:device
 *   PWTAP_DEVICE=1 PWTAP_DEVICE_DRIVER=appium npm run test:device
 *
 * **The assertion that justifies the whole file is the last one: connect, disconnect, then connect
 * again.** Nothing else proves the device lock was actually released — and the way that failure is
 * normally discovered is a colleague's test suite hanging for half an hour with no explanation.
 *
 * It asserts and never mutates: the Settings app exists on every device, so nothing is installed and no
 * device is shut down.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMcpServer } from '../src/mcp/index.js';
import { callTool } from '../src/mcp/tools.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const ENABLED = process.env.PWTAP_DEVICE === '1';
const DRIVER = process.env.PWTAP_DEVICE_DRIVER ?? 'maestro';
const PLATFORM = process.env.PWTAP_DEVICE_PLATFORM === 'ios' ? 'ios' : 'android';
const APP_ID =
  process.env.PWTAP_DEVICE_APP ??
  (PLATFORM === 'android' ? 'com.android.settings' : 'com.apple.Preferences');

const options = { skip: ENABLED ? false : 'set PWTAP_DEVICE=1 to run against a real device' };

const textOf = (result: { content: Array<{ text?: string }> }): string =>
  result.content.map(part => part.text ?? '').join('\n');

test(
  'a full MCP cycle against a real device, and the lock is released afterwards',
  options,
  async () => {
    const server = createMcpServer(REPO_ROOT);
    const session = server.session;

    try {
      const drivers = await callTool('mobile_drivers', {}, session);
      assert.equal(drivers.isError, undefined, textOf(drivers));

      const connected = await callTool(
        'mobile_connect',
        { driver: DRIVER, platform: PLATFORM, appId: APP_ID },
        session,
      );
      assert.equal(connected.isError, undefined, textOf(connected));

      const hierarchy = await callTool('mobile_hierarchy', {}, session);
      assert.equal(hierarchy.isError, undefined, textOf(hierarchy));
      const nodes = (hierarchy.structuredContent as { nodes: unknown[] }).nodes;
      assert.ok(nodes.length > 0, 'a real driver should return a real tree');

      // The capability that justifies this server existing: a ranked, uniqueness-checked candidate list,
      // which no shell command produces. Any node will do — what matters is that it comes back scored.
      const first = (nodes[0] as { key?: string }).key;
      assert.ok(typeof first === 'string', 'nodes must carry re-resolvable keys');
      const locators = await callTool('mobile_locators', { key: first }, session);
      assert.equal(locators.isError, undefined, textOf(locators));
      const candidates = (locators.structuredContent as { candidates: Array<{ score: number }> })
        .candidates;
      assert.ok(candidates.length > 0);
      for (let i = 1; i < candidates.length; i += 1) {
        assert.ok(candidates[i - 1].score >= candidates[i].score, 'best first');
      }

      const screen = await callTool('mobile_screen', {}, session);
      assert.equal(screen.isError, undefined, textOf(screen));
      const file = (screen.structuredContent as { path: string }).path;
      assert.ok(fs.existsSync(file));
      fs.rmSync(file, { force: true });

      const generated = await callTool(
        'mobile_codegen',
        { testName: 'device smoke', actions: [{ kind: 'back' }] },
        session,
      );
      assert.match(
        (generated.structuredContent as { source: string }).source,
        new RegExp(`driver: "${DRIVER}"`),
      );

      assert.equal((await callTool('mobile_disconnect', {}, session)).isError, undefined);

      // The one that matters. A lock the adapter failed to release would make this hang until the
      // platform's stale-lock steal, which is ten minutes — far longer than this test's patience.
      const again = await callTool(
        'mobile_connect',
        { driver: DRIVER, platform: PLATFORM, appId: APP_ID, timeoutMs: 20_000 },
        session,
      );
      assert.equal(
        again.isError,
        undefined,
        `the device lock was not released by disconnect: ${textOf(again)}`,
      );
    } finally {
      await server.shutdown();
    }
  },
);
