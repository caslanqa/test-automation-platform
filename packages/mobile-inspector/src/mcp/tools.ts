/**
 * The nine tools, and the boundary each argument crosses.
 *
 * Every handler is `(args, session) => Promise<ToolResult>` and imports nothing from `rpc.ts`. That is
 * the escape hatch, stated once: if sampling, elicitation or an HTTP transport is ever needed, `rpc.ts`
 * is the only file that changes.
 *
 * **Three refusals live here rather than anywhere else**, because each is about what a model may ask for
 * rather than about what the platform can do:
 *
 * 1. **`locator.native` is rejected.** `service/protocol.ts`'s `isLocator` deliberately passes it through
 *    as an adapter escape hatch — correct for a human writing a test, wrong for a model-supplied locator,
 *    which would reach the driver as an arbitrary XPath or Maestro selector object. Tightened here rather
 *    than in the narrower, because the SSE client legitimately needs it.
 * 2. **Acting is off unless `ALLOW_ACTIONS` says otherwise.** `mobile_perform` stays *listed* when it is
 *    off, deliberately: a missing tool pushes a model to invent a workaround (usually
 *    `adb shell input tap` through Bash), where a refusal naming the switch pushes it to ask a human.
 * 3. **The hierarchy is bounded.** An unbounded tree is both a token bomb and a larger injection surface.
 *
 * And one thing that is deliberately *not* here: no shell passthrough, no `uninstall`, no `simctl erase`,
 * no `adb` proxy. MCP tools are approved by **name**, not by argument, so a `mobile_shell(cmd)` allowed
 * once is a permanent unaudited escape from the user's own Bash permission gate. An agent can already run
 * `adb` through Bash, where the permission system sees the real command string.
 *
 * @example
 * await callTool('mobile_locators', { key: '0/1' }, session);
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  countMatches,
  findNodeByKey,
  locatorCandidates,
  type MobileAction,
  type MobileLocator,
  type MobileNode,
} from '@pwtap/mobile-core';

import { generateTestSource, statementForAction } from '../service/codegen.js';
import { isMobileAction, parseConnectOptions } from '../service/protocol.js';
import { TOOLS } from './schemas.js';
import type { McpMobileSession } from './session.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_ITEMS = 300;

const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

const ok = (structured: Record<string, unknown>, text?: string): ToolResult => ({
  // `structuredContent` is the primary channel on purpose: JSON is structurally harder to read as prose
  // instructions than prose is, and the text block exists for clients that show only text.
  content: [{ type: 'text', text: text ?? JSON.stringify(structured, null, 2) }],
  structuredContent: structured,
});

/**
 * Wrap application-controlled strings so the guard in `SERVER_INSTRUCTIONS` applies to them.
 *
 * A per-call nonce, exactly as `plugin-ai-judge`'s `createNonce` does, so a screen that embeds a guessed
 * closing tag cannot end the wrapper and speak as the server.
 */
function material(text: string): string {
  const nonce = randomBytes(4).toString('hex');
  return `<device-material-${nonce}>\n${text}\n</device-material-${nonce}>`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const allowActions = (): boolean =>
  /^(1|true|yes|on)$/i.test((process.env.PWTAP_MCP_ALLOW_ACTIONS ?? '').trim());

/** Reject a locator carrying the adapter escape hatch, wherever it appears in an action. */
function rejectsNative(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if ('native' in value) {
    return true;
  }
  return Object.values(value).some(entry => isRecord(entry) && 'native' in entry);
}

/** Depth- and count-bounded projection of the tree. */
function trimTree(
  nodes: readonly MobileNode[],
  maxDepth: number,
  budget: { left: number },
  depth = 0,
): unknown[] {
  const out: unknown[] = [];
  for (const node of nodes) {
    if (budget.left <= 0) {
      break;
    }
    budget.left -= 1;
    out.push({
      key: node.key,
      className: node.className,
      text: node.text,
      accessibilityId: node.accessibilityId,
      resourceId: node.resourceId,
      bounds: node.bounds,
      children:
        depth + 1 >= maxDepth || (node.children ?? []).length === 0
          ? undefined
          : trimTree(node.children ?? [], maxDepth, budget, depth + 1),
    });
  }
  return out;
}

/** Which element the caller means: a key from the tree, or a locator to resolve against it. */
function resolveNode(
  session: McpMobileSession,
  args: Record<string, unknown>,
): MobileNode | undefined {
  if (typeof args.key === 'string') {
    return findNodeByKey(session.hierarchy, args.key);
  }
  if (isRecord(args.locator)) {
    const locator = args.locator as MobileLocator;
    const flat: MobileNode[] = [];
    const walk = (list: readonly MobileNode[]): void => {
      for (const node of list) {
        flat.push(node);
        walk(node.children ?? []);
      }
    };
    walk(session.hierarchy);
    return flat.find(
      node =>
        (locator.accessibilityId !== undefined &&
          node.accessibilityId === locator.accessibilityId) ||
        (locator.resourceId !== undefined && node.resourceId === locator.resourceId) ||
        (locator.text !== undefined && node.text === locator.text),
    );
  }
  return undefined;
}

export const TOOL_NAMES = new Set(TOOLS.map(tool => tool.name));

/**
 * Run one tool.
 *
 * **Never throws.** Anything that goes wrong comes back as `isError: true`, which is the distinction the
 * protocol draws and the one that matters in practice: a tool result is something a model can read and
 * act on, where a JSON-RPC error is a transport failure it can only report. A driver that lost its
 * device, an argument that failed a narrower, a session that was never connected — all of them are
 * answers, not channel faults.
 */
export async function callTool(
  name: string,
  rawArgs: unknown,
  session: McpMobileSession,
): Promise<ToolResult> {
  try {
    return await dispatch(name, rawArgs, session);
  } catch (error) {
    return fail(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function dispatch(
  name: string,
  rawArgs: unknown,
  session: McpMobileSession,
): Promise<ToolResult> {
  if (!TOOL_NAMES.has(name)) {
    return fail(`unknown tool '${name}'`);
  }
  const args = isRecord(rawArgs) ? rawArgs : {};
  session.touch();

  switch (name) {
    case 'mobile_drivers': {
      const drivers = await session.drivers();
      const list = [...drivers.values()].map(driver => ({
        id: driver.id,
        capabilities: driver.capabilities,
        testBinding: driver.testBinding,
      }));
      return ok(
        { drivers: list, problems: session.driverProblems },
        list.length === 0
          ? [
              'No mobile driver is installed in this project.',
              'Add one with: npx create-pwtap add maestro   (or: add appium)',
              ...session.driverProblems.map(problem => `- ${problem}`),
            ].join('\n')
          : undefined,
      );
    }

    case 'mobile_devices': {
      if (typeof args.driver !== 'string') {
        return fail("mobile_devices: 'driver' must be a string");
      }
      const driver = (await session.drivers()).get(args.driver);
      if (driver === undefined) {
        return fail(`unknown driver '${args.driver}'`);
      }
      return ok({ driver: driver.id, devices: await driver.discoverDevices() });
    }

    case 'mobile_connect': {
      if (typeof args.driver !== 'string') {
        return fail("mobile_connect: 'driver' must be a string");
      }
      // The same narrower the SSE boundary uses: rebuilt field by field, so nothing the caller invented
      // — an `onProgress` callback, say — reaches an adapter (ADR-010).
      const options = parseConnectOptions(args);
      if (options === null) {
        return fail("mobile_connect: invalid options — 'platform' must be 'android' or 'ios'");
      }
      try {
        const result = await session.connect({ ...options, driver: args.driver });
        return ok({ connected: true, driver: args.driver, ...result });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    }

    case 'mobile_disconnect':
      return ok({ disconnected: await session.disconnect() });

    case 'mobile_hierarchy': {
      const device = session.require();
      await device.refreshHierarchy();
      const maxDepth = Math.min(Number(args.maxDepth) || DEFAULT_MAX_DEPTH, 40);
      const budget = { left: Math.min(Number(args.maxItems) || DEFAULT_MAX_ITEMS, 2000) };
      const tree = trimTree(session.hierarchy, maxDepth, budget);
      return {
        content: [
          {
            type: 'text',
            text: material(JSON.stringify(tree, null, 2)),
          },
        ],
        structuredContent: { nodes: tree, truncated: budget.left <= 0 },
      };
    }

    case 'mobile_locators': {
      session.require();
      const node = resolveNode(session, args);
      if (node === undefined) {
        return fail(
          'mobile_locators: no element matched — pass a `key` from mobile_hierarchy, or a locator that resolves',
        );
      }
      // `appId` matters: without it the out-of-app penalty never fires, and a status-bar element would
      // be offered as though it were part of the app under test.
      const candidates = locatorCandidates(node, session.hierarchy, { appId: session.appId });
      return ok({
        candidates: candidates.map(candidate => ({
          strategy: candidate.strategy,
          locator: candidate.locator,
          score: candidate.score,
          confidence: candidate.confidence,
          unique: candidate.unique,
          warnings: candidate.warnings,
          code: candidate.display,
        })),
      });
    }

    case 'mobile_screen': {
      const device = session.require();
      await device.refreshFrame();
      const frame = session.frame;
      if (frame === undefined) {
        return fail('mobile_screen: the device did not return a frame');
      }
      if (args.format === 'image') {
        return {
          content: [
            { type: 'text', text: `Screen ${frame.width}x${frame.height}` },
            { type: 'image', data: frame.imageBase64, mimeType: 'image/png' } as never,
          ],
          structuredContent: { width: frame.width, height: frame.height, inline: true },
        };
      }
      // Default. A screenshot of a logged-in app is a credential, and the picture is rarely what was
      // wanted — `frameStore.ts` made the same call for the UI, and it saves an enormous number of tokens.
      const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-mcp-frame-')),
        'screen.png',
      );
      fs.writeFileSync(file, Buffer.from(frame.imageBase64, 'base64'));
      return ok(
        { path: file, width: frame.width, height: frame.height },
        `Screen ${frame.width}x${frame.height} written to ${file}`,
      );
    }

    case 'mobile_perform': {
      const device = session.require();
      if (!allowActions()) {
        return fail(
          'actions are disabled — set PWTAP_MCP_ALLOW_ACTIONS=1 (or enable it in the plugin settings) to let this session touch the device',
        );
      }
      if (rejectsNative(args.action)) {
        return fail(
          'mobile_perform: `native` locators are not accepted here — it is an adapter-specific escape hatch, and nothing in the ranked candidates ever produces one',
        );
      }
      if (!isMobileAction(args.action)) {
        return fail('mobile_perform: `action` is not a valid MobileAction');
      }
      const result = await device.perform(args.action as MobileAction);
      return ok({ ok: result.ok, error: result.error, value: result.value });
    }

    case 'mobile_codegen': {
      if (typeof args.testName !== 'string' || !Array.isArray(args.actions)) {
        return fail('mobile_codegen: `testName` (string) and `actions` (array) are required');
      }
      const invalid = args.actions.findIndex(action => !isMobileAction(action));
      if (invalid !== -1) {
        return fail(`mobile_codegen: actions[${invalid}] is not a valid MobileAction`);
      }
      const actions = args.actions as MobileAction[];
      const device = session.deviceInfo;
      const source = generateTestSource({
        // The target header is why codegen lives inside this server rather than beside it: only the
        // connected session knows the driver, platform, stable device name and app id it needs.
        target: {
          driver: session.driver ?? 'maestro',
          platform: device?.platform,
          device: device?.name,
          appId: session.appId,
        },
        testName: args.testName,
        actions,
      });
      return ok({ source, statements: actions.map(action => statementForAction(action)) }, source);
    }

    default:
      return fail(`unknown tool '${name}'`);
  }
}

/** Exported for the locators tool's uniqueness reporting, and for tests. */
export { countMatches };
