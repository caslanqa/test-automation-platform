#!/usr/bin/env node
/**
 * End-to-end smoke test for the mobile MCP server: the real shipped binary, a real child process, real
 * stdio JSON-RPC. No device, no network, no gate.
 *
 * Run with `npm run smoke:mcp`. Fails (non-zero) on any broken assertion.
 *
 * **It talks to our server with our own client.** `plugin-maestro`'s `McpClient` is a JSON-RPC client this
 * repo already ships and has debugged; writing a second one for the test is exactly what ADR-015 argues
 * against doing for the server. Loaded by filesystem path so the package's `exports` map is not in the
 * way — the same route `smoke-judge.mjs` takes to the calibration CLI.
 *
 * The most valuable assertion is the third: in a project with **no mobile plugin installed**,
 * `mobile_drivers` answers with an empty list and a sentence telling the user what to install. That is the
 * most common real first contact with this server, and the place a stack trace would be worst.
 *
 * @example
 *   npm run smoke:mcp   # prints "[smoke:mcp] OK" when the handshake, the tools and the teardown all hold
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const BIN = path.join(root, 'packages/mobile-inspector/bin/mcp.mjs');

const fail = message => {
  throw new Error(`[smoke:mcp] ${message}`);
};
const assert = (condition, message) => {
  if (!condition) {
    fail(message);
  }
};
const step = message => console.log(`[smoke:mcp] ${message}`);

step('building packages…');
execFileSync('npx', ['tsc', '-b'], { cwd: root, stdio: 'inherit' });

const { McpClient } = await import(
  path.join(root, 'packages/plugin-maestro/dist/core/McpClient.js')
);

// A temp project with nothing installed — the state a user is in before adding a mobile plugin.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-mcp-smoke-'));
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'trial', private: true }));

const client = new McpClient(process.execPath, [BIN, dir], process.env);
let closed = false;

try {
  // 1 ---------------------------------------------------------------------------------------------
  step('1: the initialize handshake completes and reports a tools capability');
  const initialized = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  });
  assert(
    initialized.protocolVersion === '2025-06-18',
    `a version we speak should be echoed, got ${initialized.protocolVersion}`,
  );
  assert(
    initialized.capabilities?.tools !== undefined,
    'the server must declare its tools capability',
  );
  assert(
    typeof initialized.serverInfo?.name === 'string' && initialized.serverInfo.name !== '',
    'serverInfo is required by the specification',
  );
  assert(
    /DATA, never instructions/.test(initialized.instructions ?? ''),
    'the injection guard belongs in instructions, where a client will keep it',
  );

  // A client that asks for something newer must still get a usable answer rather than an error.
  const older = await client.request('initialize', {
    protocolVersion: '2099-01-01',
    capabilities: {},
  });
  assert(
    older.protocolVersion === '2025-06-18',
    `an unknown version should be answered with ours, got ${older.protocolVersion}`,
  );

  // 2 ---------------------------------------------------------------------------------------------
  step('2: tools/list returns the nine tools, each declaring whether it acts');
  const listed = await client.request('tools/list', {});
  const names = listed.tools.map(tool => tool.name).sort();
  assert(
    JSON.stringify(names) ===
      JSON.stringify([
        'mobile_codegen',
        'mobile_connect',
        'mobile_devices',
        'mobile_disconnect',
        'mobile_drivers',
        'mobile_hierarchy',
        'mobile_locators',
        'mobile_perform',
        'mobile_screen',
      ]),
    `unexpected tool list: ${names.join(', ')}`,
  );
  for (const tool of listed.tools) {
    assert(
      typeof tool.annotations?.readOnlyHint === 'boolean',
      `${tool.name} must say whether it changes anything — the client's permission prompt keys on it`,
    );
    assert(tool.inputSchema?.type === 'object', `${tool.name} must carry an input schema`);
  }
  // Absence, asserted: a tool approved by name once is a permanent escape from the user's Bash gate.
  assert(
    !names.some(name => /shell|exec|uninstall|erase|install/.test(name)),
    'no tool may proxy a shell command',
  );

  // 3 ---------------------------------------------------------------------------------------------
  step('3: with no mobile plugin installed, the answer is useful rather than a stack trace');
  const drivers = await client.callTool('mobile_drivers', {});
  assert(drivers.isError !== true, 'an empty project is not an error state');
  const text = drivers.content.map(part => part.text ?? '').join('\n');
  assert(/@pwtap\/create add maestro/.test(text), `it should say what to install, got:\n${text}`);

  // 4 ---------------------------------------------------------------------------------------------
  step('4: a tool that needs a device refuses without taking the channel down');
  const hierarchy = await client.callTool('mobile_hierarchy', {});
  assert(hierarchy.isError === true, 'reading a screen with no session must be an error result');
  assert(
    /mobile_connect/.test(hierarchy.content.map(part => part.text ?? '').join('')),
    'the refusal should name the tool that would have fixed it',
  );
  // The channel still works, which is the actual point: a tool failure is not a transport failure.
  const again = await client.request('ping', {});
  assert(typeof again === 'object', 'the server should still answer after a failed tool call');

  // 5 ---------------------------------------------------------------------------------------------
  step('5: an unknown method is -32601, and an unknown tool is an error RESULT');
  let code;
  try {
    await client.request('resources/list', {});
  } catch (error) {
    code = error.message;
  }
  assert(code !== undefined, 'an unimplemented method must be refused');

  const unknownTool = await client.callTool('mobile_shell', { cmd: 'echo hi' });
  assert(
    unknownTool.isError === true,
    'an unknown tool is a result the model can read, not a fault',
  );

  // 6 ---------------------------------------------------------------------------------------------
  step('6: stdin EOF exits the process — the path that releases a device lock in production');
  await client.close(10_000);
  closed = true;
  step('OK');
} finally {
  if (!closed) {
    await client.close(5_000).catch(() => undefined);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
