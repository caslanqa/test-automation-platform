/**
 * JSON-RPC 2.0 over stdio — the mirror of `plugin-maestro`'s `McpClient`.
 *
 * **Hand-rolled, no SDK.** ADR-015 has the argument in full; the short version is that both SDK
 * generations make `zod` a hard requirement (`@modelcontextprotocol/server@2` depends on it,
 * `@modelcontextprotocol/sdk@1` has it as a non-optional peer), which is ~11.6 MB of closure added to a
 * package that ships 1.15 MB today — to avoid writing the 120 lines below, whose inverse this repo
 * already ships and has debugged. It is the same shape as ADR-013's decision about `ws`.
 *
 * The framing details are taken from `McpClient.onStdout` rather than reinvented, because that is the
 * part that bites: accumulate and split on newlines (**never** assume one message per chunk), skip blank
 * lines, and ignore anything that is not JSON instead of failing the stream.
 *
 * One rule this side has that the client does not: **nothing but JSON-RPC may reach stdout.** A stray
 * `console.log` corrupts the channel, so `src/mcp/**` is lint-banned from using it.
 *
 * @example
 * const server = new RpcServer({ handle: async (method, params) => ({ ok: true }) });
 * server.listen(process.stdin, process.stdout);
 */

/** Protocol revisions this server can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/**
 * What we advertise when the client asks for something we do not know.
 *
 * Pinned rather than tracking the newest revision, and the reason is concrete: `2026-07-28` adds
 * `resultType` to `CallToolResult` and says servers implementing that version MUST send it. Advertising
 * a version whose MUSTs we do not satisfy is worse than advertising an older one we do.
 */
export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export type RpcId = string | number;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: unknown;
}

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export interface RpcHandler {
  /** Handle one request. Throw {@link RpcError} for a protocol-level failure. */
  handle(method: string, params: unknown): Promise<unknown>;
  /** Handle one notification. Never answered — replying to a notification is a protocol error. */
  notify?(method: string, params: unknown): void;
}

interface Writable {
  write(chunk: string): unknown;
}

interface Readable {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  setEncoding?(encoding: string): unknown;
}

export class RpcServer {
  private buffer = '';
  private out: Writable | undefined;
  private readonly handler: RpcHandler;
  private onEnd: (() => void) | undefined;

  constructor(handler: RpcHandler) {
    this.handler = handler;
  }

  /**
   * Attach to a stream pair. `onEnd` fires on stdin EOF, which is the only reliable "the client is
   * gone" signal a stdio server gets — `process.on('exit')` cannot await an async teardown, so a device
   * lock released there would never actually be released.
   */
  listen(input: Readable, output: Writable, onEnd?: () => void): void {
    this.out = output;
    this.onEnd = onEnd;
    input.setEncoding?.('utf8');
    input.on('data', chunk => {
      this.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    input.on('end', () => this.onEnd?.());
  }

  /** Feed raw stdin text. Exposed so a test can drive the framing without a process. */
  feed(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (line === '') {
        continue;
      }
      void this.dispatch(line);
    }
  }

  private send(payload: Record<string, unknown>): void {
    this.out?.write(`${JSON.stringify(payload)}\n`);
  }

  private fail(id: RpcId | undefined, code: number, message: string): void {
    // A notification gets no reply, even a failing one: answering one is itself a protocol error.
    if (id === undefined) {
      return;
    }
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private async dispatch(line: string): Promise<void> {
    let message: RpcRequest;
    try {
      message = JSON.parse(line) as RpcRequest;
    } catch {
      // No id to answer with, so there is nobody to tell. Dropping the line keeps the stream alive,
      // which is what the client half does too.
      return;
    }
    if (typeof message !== 'object' || message === null || typeof message.method !== 'string') {
      this.fail(
        (message as RpcRequest | null)?.id,
        JSON_RPC_ERRORS.invalidRequest,
        'not a request',
      );
      return;
    }

    if (message.id === undefined) {
      this.handler.notify?.(message.method, message.params);
      return;
    }

    try {
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        result: await this.handler.handle(message.method, message.params),
      });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : JSON_RPC_ERRORS.internal;
      this.fail(message.id, code, error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Answer the client's protocol version: echo theirs when we speak it, otherwise state our newest.
 *
 * Echoing rather than always answering with ours is what the specification asks for, and answering with
 * ours rather than erroring is what it permits when we cannot meet their request — a client that cannot
 * live with the answer is expected to disconnect.
 */
export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}
