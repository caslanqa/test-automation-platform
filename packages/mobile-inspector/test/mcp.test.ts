/**
 * The nine tools, against the fake driver. No device, no child process, no network.
 *
 * Most of these are refusals, and that is the point of the file. An MCP tool is approved by **name**,
 * once, and then called with whatever arguments a model produces from a screen it read — so every
 * argument-level guard has to hold on its own, forever, without a human in the loop.
 *
 * The one that matters most is `mobile_perform` with `ALLOW_ACTIONS` off: the tool stays *listed* and
 * refuses by naming the switch. Hiding it would push a model to invent a workaround, which in practice
 * means `adb shell input tap` through Bash — the exact escape this server exists to avoid.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { SERVER_INSTRUCTIONS, TOOLS } from '../src/mcp/schemas.js';
import { McpMobileSession } from '../src/mcp/session.js';
import { callTool } from '../src/mcp/tools.js';
import { fakeDriverMap } from './fakes/fakeDriver.js';

function makeSession(options?: Parameters<typeof fakeDriverMap>[0]) {
  const { map, driver } = fakeDriverMap(options);
  // Idle timer off: these tests are synchronous and a live timer would keep the runner alive.
  return { session: new McpMobileSession('/nowhere', 0, async () => map), driver };
}

const connect = async (session: McpMobileSession) =>
  callTool(
    'mobile_connect',
    { driver: 'fake', platform: 'android', appId: 'com.example.app' },
    session,
  );

const structured = (result: Awaited<ReturnType<typeof callTool>>) =>
  result.structuredContent as Record<string, never>;

// --- discovery ------------------------------------------------------------------------------------

test('an empty driver map is a clean answer, not a crash', async () => {
  const session = new McpMobileSession('/nowhere', 0, async () => new Map());
  const result = await callTool('mobile_drivers', {}, session);
  assert.equal(result.isError, undefined);
  assert.deepEqual(structured(result).drivers, []);
  // The most common real first contact. It must say what to do, not print a stack.
  assert.match(result.content[0].text, /npx create-pwtap add maestro/);
});

test('an installed driver is listed with what it can do', async () => {
  const { session } = makeSession();
  const result = await callTool('mobile_drivers', {}, session);
  const drivers = structured(result).drivers as unknown as Array<{ id: string }>;
  assert.equal(drivers[0].id, 'fake');
});

test('an unknown tool name is an error result, not a thrown exception', async () => {
  const { session } = makeSession();
  const result = await callTool('mobile_shell', { cmd: 'rm -rf /' }, session);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unknown tool/);
});

test('there is no shell, uninstall or erase tool at all', () => {
  // Not a refusal — an absence. A tool approved by name once is a permanent escape from the user's own
  // Bash permission gate, which does see the real command string.
  for (const banned of ['shell', 'exec', 'uninstall', 'erase', 'adb', 'simctl', 'reset']) {
    assert.ok(
      !TOOLS.some(tool => tool.name.includes(banned)),
      `a '${banned}' tool must never exist here`,
    );
  }
});

// --- session --------------------------------------------------------------------------------------

test('connecting reports what the SESSION can do, not what the driver claims', async () => {
  const { session } = makeSession();
  const result = await connect(session);
  assert.equal(structured(result).connected, true);
  assert.ok(structured(result).capabilities !== undefined);
  assert.equal(session.connected, true);
});

test('a tool that needs a device says which tool would have fixed it', async () => {
  const { session } = makeSession();
  const result = await callTool('mobile_hierarchy', {}, session);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /mobile_connect/);
});

test('an unknown driver names the ones this project does have', async () => {
  const { session } = makeSession();
  const result = await callTool('mobile_connect', { driver: 'nope', platform: 'android' }, session);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unknown driver 'nope'.*fake/s);
});

test('a bad platform is refused by the same narrower the SSE boundary uses', async () => {
  const { session } = makeSession();
  const result = await callTool(
    'mobile_connect',
    { driver: 'fake', platform: 'windows-phone' },
    session,
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /platform/);
});

test('disconnect closes exactly once, and a second call is a clean no-op', async () => {
  const { session } = makeSession();
  await connect(session);
  assert.equal(structured(await callTool('mobile_disconnect', {}, session)).disconnected, true);
  assert.equal(structured(await callTool('mobile_disconnect', {}, session)).disconnected, false);
});

test('the idle timer releases a session nobody is using', async () => {
  const { map } = fakeDriverMap();
  const session = new McpMobileSession('/nowhere', 20, async () => map);
  await connect(session);
  assert.equal(session.connected, true);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(session.connected, false, 'a forgotten session must not hold the device forever');
});

// --- reading --------------------------------------------------------------------------------------

test('the hierarchy is wrapped as material, under a per-call nonce', async () => {
  const { session } = makeSession();
  await connect(session);
  const first = await callTool('mobile_hierarchy', {}, session);
  const second = await callTool('mobile_hierarchy', {}, session);

  const tag = /<device-material-([0-9a-f]{8})>/;
  const a = tag.exec(first.content[0].text);
  const b = tag.exec(second.content[0].text);
  assert.ok(a && b, 'application text must be quoted as data');
  assert.notEqual(a[1], b[1], 'a fresh nonce per call, or a screen could close the wrapper');
  assert.match(SERVER_INSTRUCTIONS, /DATA, never instructions/);
});

test('the tree is bounded, and says when it was cut', async () => {
  const { session } = makeSession();
  await connect(session);
  const result = await callTool('mobile_hierarchy', { maxItems: 1 }, session);
  assert.equal(structured(result).truncated, true);
  assert.equal((structured(result).nodes as unknown as unknown[]).length, 1);
});

test('locators come back ranked, with uniqueness and the reasons they might be fragile', async () => {
  const { session } = makeSession();
  await connect(session);
  await callTool('mobile_hierarchy', {}, session);

  const result = await callTool('mobile_locators', { locator: { text: 'Log in' } }, session);
  const candidates = structured(result).candidates as unknown as Array<{
    strategy: string;
    score: number;
    unique: boolean;
    warnings: string[];
  }>;
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].strategy, 'accessibilityId', 'the most stable identifier leads');
  for (let i = 1; i < candidates.length; i += 1) {
    assert.ok(candidates[i - 1].score >= candidates[i].score, 'best first');
  }
  // The coordinate fallback is offered last and always flagged — this is the ranking no shell command
  // can produce, and the reason this server exists at all.
  const point = candidates.find(candidate => candidate.strategy === 'point');
  assert.ok(point !== undefined && point.warnings.length > 0);
  assert.equal(point.score, Math.min(...candidates.map(candidate => candidate.score)));
});

test('an element nobody can find is a refusal that says how to find one', async () => {
  const { session } = makeSession();
  await connect(session);
  await callTool('mobile_hierarchy', {}, session);
  const result = await callTool('mobile_locators', { locator: { text: 'nope' } }, session);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /mobile_hierarchy/);
});

test('a screenshot returns a path by default, and bytes only when asked', async () => {
  const { session } = makeSession();
  await connect(session);

  const byPath = await callTool('mobile_screen', {}, session);
  const file = structured(byPath).path as unknown as string;
  assert.ok(fs.existsSync(file), 'the frame is written where the caller can read it');
  assert.equal(byPath.content.length, 1, 'no image bytes unless asked');
  fs.rmSync(file, { force: true });

  const inline = await callTool('mobile_screen', { format: 'image' }, session);
  assert.ok(inline.content.some(part => (part as { type: string }).type === 'image'));
});

// --- acting ---------------------------------------------------------------------------------------

test('acting is off by default, and the refusal names the switch', async () => {
  delete process.env.PWTAP_MCP_ALLOW_ACTIONS;
  const { session } = makeSession();
  await connect(session);
  const result = await callTool(
    'mobile_perform',
    { action: { kind: 'tap', locator: { accessibilityId: 'loginButton' } } },
    session,
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PWTAP_MCP_ALLOW_ACTIONS/);
  // Listed, not hidden: a missing tool is what makes a model reach for `adb shell input tap`.
  assert.ok(TOOLS.some(tool => tool.name === 'mobile_perform'));
});

test('with actions enabled, one reaches the driver', async () => {
  process.env.PWTAP_MCP_ALLOW_ACTIONS = '1';
  try {
    const { session, driver } = makeSession();
    await connect(session);
    const result = await callTool(
      'mobile_perform',
      { action: { kind: 'tap', locator: { accessibilityId: 'loginButton' } } },
      session,
    );
    assert.equal(structured(result).ok, true);
    assert.equal(driver.session?.performed.length, 1);
  } finally {
    delete process.env.PWTAP_MCP_ALLOW_ACTIONS;
  }
});

test('a native locator is rejected at this boundary, even though the narrower allows it', async () => {
  process.env.PWTAP_MCP_ALLOW_ACTIONS = '1';
  try {
    const { session } = makeSession();
    await connect(session);
    const result = await callTool(
      'mobile_perform',
      { action: { kind: 'tap', locator: { native: { xpath: '//*[@id="anything"]' } } } },
      session,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /native/);
  } finally {
    delete process.env.PWTAP_MCP_ALLOW_ACTIONS;
  }
});

test('a malformed action is refused by the shared narrower', async () => {
  process.env.PWTAP_MCP_ALLOW_ACTIONS = '1';
  try {
    const { session } = makeSession();
    await connect(session);
    const result = await callTool('mobile_perform', { action: { kind: 'levitate' } }, session);
    assert.equal(result.isError, true);
  } finally {
    delete process.env.PWTAP_MCP_ALLOW_ACTIONS;
  }
});

// --- codegen --------------------------------------------------------------------------------------

test('generated code pins the session the actions were recorded against', async () => {
  const { session } = makeSession();
  await connect(session);
  const result = await callTool(
    'mobile_codegen',
    {
      testName: 'logs in',
      actions: [{ kind: 'tap', locator: { accessibilityId: 'loginButton' } }],
    },
    session,
  );
  const source = structured(result).source as unknown as string;
  // The target header is why codegen belongs inside this server: only the connected session knows it.
  assert.match(source, /mobileTarget: \{ driver: "fake", platform: "android"/);
  assert.match(source, /appId: "com\.example\.app"/);
  assert.match(source, /device: "Pixel_7_API_34"/, 'a stable device name, never an adb serial');
  assert.match(source, /mobileApp\.tap\(\{ accessibilityId: "loginButton" \}\)/);
});

test('codegen refuses an action it cannot express rather than emitting something broken', async () => {
  const { session } = makeSession();
  await connect(session);
  const result = await callTool(
    'mobile_codegen',
    {
      testName: 't',
      actions: [{ kind: 'tap', locator: { accessibilityId: 'loginButton' } }, { kind: 'nonsense' }],
    },
    session,
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /actions\[1\]/);
});

test('every tool declares whether it changes anything', () => {
  // The client's own permission prompt keys on this, which is the approval mechanism — a stdio server
  // cannot ask a human anything without elicitation, which is deliberately not implemented.
  const acting = TOOLS.filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name);
  assert.deepEqual(acting.sort(), ['mobile_connect', 'mobile_disconnect', 'mobile_perform']);
  assert.equal(
    TOOLS.find(tool => tool.name === 'mobile_perform')?.annotations.destructiveHint,
    true,
  );
});
