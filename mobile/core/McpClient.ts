import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';

/** A single MCP `tools/call` result (the MCP `CallToolResult` shape). */
export interface McpToolResult {
  /** Result content parts. Text parts carry `text`; image parts carry base64 `data` + `mimeType`. */
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  /** True when the tool reported a failure (e.g. a Maestro command failed). */
  isError?: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A minimal JSON-RPC 2.0 client for an MCP server spoken over a child process's STDIO
 * (newline-delimited messages, as the MCP stdio transport specifies). Purpose-built for
 * `maestro mcp`: spawn once, `initialize`, then `callTool` per command against the warm device
 * driver. This is NOT a general MCP client — only the request/response + `initialized`-notification
 * subset Maestro needs. One instance drives exactly one `maestro mcp` process (one device).
 */
export class McpClient {
  private readonly proc: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = '';
  private stderrTail = '';
  private exited = false;

  /**
   * Spawn the MCP server process and start reading its stdout. Call {@link initialize} before any
   * {@link callTool}.
   *
   * @param command Executable (e.g. `maestro`), pre-resolved or on PATH.
   * @param args Process args (e.g. `['mcp', '--no-viewer']`).
   * @param env Environment for the child (Android runs inject the SDK env so Maestro finds adb).
   */
  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', chunk => this.onStdout(chunk as string));
    // Maestro logs progress to stderr (its stdout is a pristine JSON-RPC channel). Keep only a tail,
    // surfaced if the spawn or handshake fails so the error message carries the real cause.
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', chunk => {
      this.stderrTail = `${this.stderrTail}${chunk as string}`.slice(-4000);
    });
    this.proc.on('error', (err: NodeJS.ErrnoException) => this.failAll(spawnError(command, err)));
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      this.failAll(
        new Error(
          `[mobile] 'maestro mcp' exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})${
            this.stderrTail.trim() ? `\n${this.stderrTail.trim()}` : ''
          }`
        )
      );
    });
  }

  /** Split the stdout stream on newlines and dispatch each complete JSON-RPC message by id. */
  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      newline = this.stdoutBuffer.indexOf('\n');
      if (!line) {
        continue;
      }
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a stray non-JSON line — ignore; responses we care about are valid JSON
      }
      if (typeof message.id !== 'number') {
        continue; // a server-initiated notification/request — we don't handle those
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) {
        continue;
      }
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(new Error(message.error.message ?? 'MCP error'));
      } else {
        waiter.resolve(message.result);
      }
    }
  }

  /** Reject every in-flight request — the process died or errored, so none will ever get a reply. */
  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  private write(payload: object): void {
    this.proc.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  /** Send a JSON-RPC request and await its response (matched by id), rejecting after `timeoutMs`. */
  private request(method: string, params: object, timeoutMs: number): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new Error("[mobile] 'maestro mcp' is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`[mobile] 'maestro mcp' request '${method}' timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** MCP initialize handshake: negotiate capabilities, then send the required `initialized` note. */
  async initialize(timeoutMs = 30_000): Promise<void> {
    await this.request(
      'initialize',
      {
        // A widely-supported baseline; MCP servers negotiate down and echo a compatible version.
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'playwright-ai-mobile', version: '1.0.0' },
      },
      timeoutMs
    );
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  }

  /** Call an MCP tool by name and return its `CallToolResult` (content parts + `isError`). */
  async callTool(name: string, args: object, timeoutMs = 60_000): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return result as McpToolResult;
  }

  /**
   * Stop the server and WAIT for it to fully exit. Ending stdin gives the MCP transport EOF, which
   * makes Maestro shut its device driver down cleanly (its `run` loop returns and tears the session
   * down). Awaiting the real exit — not just firing a signal — is essential: the next test on the
   * same device must not spawn its `maestro mcp` until this one's driver has released the port, or
   * the two overlap and the driver dies ("Failed to connect to 127.0.0.1:<port>"). SIGKILL is only a
   * backstop if graceful shutdown hangs past `timeoutMs`.
   */
  async close(timeoutMs = 15_000): Promise<void> {
    if (this.exited) {
      return;
    }
    const exited = new Promise<void>(resolve => this.proc.once('exit', () => resolve()));
    try {
      this.proc.stdin?.end();
    } catch {
      /* stdin already closed */
    }
    const kill = setTimeout(() => this.proc.kill('SIGKILL'), timeoutMs);
    try {
      await exited;
    } finally {
      clearTimeout(kill);
    }
  }
}

/** Map a spawn error to an actionable message; a missing binary is the common case. */
function spawnError(command: string, err: NodeJS.ErrnoException): Error {
  if (err.code === 'ENOENT') {
    return new Error(
      `[mobile] '${command}' not found on PATH — install Maestro (https://maestro.mobile.dev) or set MAESTRO_BIN`
    );
  }
  return err;
}
