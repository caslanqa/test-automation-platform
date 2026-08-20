/**
 * The framing, which is the part that bites.
 *
 * A stdio JSON-RPC server has exactly one hard problem and it is not the protocol: a stream delivers
 * bytes, not messages. One message can arrive in three chunks, three can arrive in one, and a single
 * wrong assumption there produces a server that works on a fast machine and hangs on a slow one. These
 * are the same cases `plugin-maestro`'s `McpClient.onStdout` was written to survive, asserted from the
 * other side.
 *
 * The last test is a different kind: **nothing but JSON-RPC may reach stdout**. A stray `console.log`
 * anywhere in the server corrupts the channel for every client, and it is the failure that would be
 * hardest to diagnose from a user's report.
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  DEFAULT_PROTOCOL_VERSION,
  JSON_RPC_ERRORS,
  RpcError,
  RpcServer,
  negotiateVersion,
} from '../src/mcp/rpc.js';

/** A server whose handler echoes, plus the lines it wrote. */
function harness(handler?: Partial<{ handle: RpcServerHandle; notify: RpcServerNotify }>) {
  type Sent = Record<string, unknown>;
  const sent: Sent[] = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const raw: string[] = [];

  const server = new RpcServer({
    handle: handler?.handle ?? (async (method, params) => ({ method, params })),
    notify: handler?.notify ?? ((method, params) => void notifications.push({ method, params })),
  });
  server.listen(new PassThrough(), {
    write: (chunk: string) => {
      raw.push(chunk);
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') {
          sent.push(JSON.parse(line) as Sent);
        }
      }
      return true;
    },
  });
  return { server, sent, notifications, raw };
}

type RpcServerHandle = (method: string, params: unknown) => Promise<unknown>;
type RpcServerNotify = (method: string, params: unknown) => void;

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('a message split across three chunks is still one message', async () => {
  const { server, sent } = harness();
  server.feed('{"jsonrpc":"2.0","id":1,');
  server.feed('"method":"ping"');
  server.feed('}\n');
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 1);
});

test('three messages in one chunk are three messages', async () => {
  const { server, sent } = harness();
  server.feed(
    [
      '{"jsonrpc":"2.0","id":1,"method":"a"}',
      '{"jsonrpc":"2.0","id":2,"method":"b"}',
      '{"jsonrpc":"2.0","id":3,"method":"c"}',
      '',
    ].join('\n'),
  );
  await settle();
  assert.deepEqual(
    sent.map(message => message.id),
    [1, 2, 3],
  );
});

test('a blank line is skipped rather than treated as a message', async () => {
  const { server, sent } = harness();
  server.feed('\n\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n');
  await settle();
  assert.equal(sent.length, 1);
});

test('a non-JSON line is ignored without breaking the stream', async () => {
  const { server, sent } = harness();
  server.feed('this is not json\n{"jsonrpc":"2.0","id":7,"method":"ping"}\n');
  await settle();
  assert.equal(sent.length, 1, 'the junk line must not consume the real one after it');
  assert.equal(sent[0].id, 7);
});

test('a message with no trailing newline waits rather than being half-parsed', async () => {
  const { server, sent } = harness();
  server.feed('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  await settle();
  assert.equal(sent.length, 0);
  server.feed('\n');
  await settle();
  assert.equal(sent.length, 1);
});

test('a notification draws no reply — answering one is itself a protocol error', async () => {
  const { server, sent, notifications } = harness();
  server.feed('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(notifications[0].method, 'notifications/initialized');
});

test('a failing notification still draws no reply', async () => {
  const { server, sent } = harness({
    handle: async () => {
      throw new RpcError(JSON_RPC_ERRORS.methodNotFound, 'nope');
    },
  });
  server.feed('{"jsonrpc":"2.0","method":"whatever"}\n');
  await settle();
  assert.equal(sent.length, 0);
});

test('an unknown method answers -32601, not a crash', async () => {
  const { server, sent } = harness({
    handle: async method => {
      throw new RpcError(JSON_RPC_ERRORS.methodNotFound, `unknown method '${method}'`);
    },
  });
  server.feed('{"jsonrpc":"2.0","id":1,"method":"nope"}\n');
  await settle();
  assert.equal((sent[0].error as { code: number }).code, -32601);
});

test('a handler that throws a plain error becomes an internal error, not a dropped request', async () => {
  const { server, sent } = harness({
    handle: async () => {
      throw new Error('something broke');
    },
  });
  server.feed('{"jsonrpc":"2.0","id":1,"method":"boom"}\n');
  await settle();
  assert.equal((sent[0].error as { code: number }).code, JSON_RPC_ERRORS.internal);
  assert.match((sent[0].error as { message: string }).message, /something broke/);
});

test('version negotiation echoes a version we speak, and states ours when we do not', () => {
  assert.equal(negotiateVersion('2025-06-18'), '2025-06-18');
  assert.equal(negotiateVersion('2024-11-05'), '2024-11-05');
  // Newer than us: answering with ours is what the specification permits, and advertising a revision
  // whose MUSTs we do not satisfy would be worse than being behind.
  assert.equal(negotiateVersion('2099-01-01'), DEFAULT_PROTOCOL_VERSION);
  assert.equal(negotiateVersion(undefined), DEFAULT_PROTOCOL_VERSION);
});

test('every byte written to the output is a JSON-RPC line', async () => {
  const { server, raw } = harness();
  server.feed('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await settle();
  const everything = raw.join('');
  assert.ok(everything.endsWith('\n'), 'each message is newline-terminated');
  for (const line of everything.split('\n').filter(entry => entry !== '')) {
    const parsed = JSON.parse(line) as { jsonrpc?: string };
    assert.equal(parsed.jsonrpc, '2.0');
  }
});
