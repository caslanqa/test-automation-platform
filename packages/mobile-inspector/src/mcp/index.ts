/**
 * The MCP server: five methods, nine tools, no SDK.
 *
 * Everything the specification requires of a tools-only stdio server and nothing else. `initialize`,
 * `notifications/initialized`, `ping`, `tools/list`, `tools/call`; anything else answers `-32601`.
 * `notifications/cancelled` is ignored on purpose — replying to a notification is itself a protocol
 * error, and we have nothing to cancel.
 *
 * @example
 * const server = createMcpServer('/path/to/project');
 * server.listen(process.stdin, process.stdout, () => server.shutdown());
 */
import { JSON_RPC_ERRORS, RpcError, RpcServer, negotiateVersion } from './rpc.js';
import { SERVER_INSTRUCTIONS, TOOLS } from './schemas.js';
import { McpMobileSession } from './session.js';
import { callTool } from './tools.js';

/** Read from the package rather than hardcoded, so a release cannot leave it stale. */
export const SERVER_NAME = 'pwtap-mobile';

export interface McpServer {
  listen: RpcServer['listen'];
  /** Close the device session. Idempotent, and the whole reason stdin EOF is wired to it. */
  shutdown(): Promise<void>;
  /** Exposed for tests, which drive the tools without a transport. */
  readonly session: McpMobileSession;
}

export function createMcpServer(projectDir: string, version = '0.0.0'): McpServer {
  const session = new McpMobileSession(projectDir);

  const rpc = new RpcServer({
    async handle(method, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case 'initialize':
          return {
            // All three are required by the specification; a client that gets a partial result here
            // typically fails with something unrelated-looking three calls later.
            protocolVersion: negotiateVersion(args.protocolVersion),
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version },
            instructions: SERVER_INSTRUCTIONS,
          };

        case 'ping':
          return {};

        case 'tools/list':
          return { tools: TOOLS };

        case 'tools/call': {
          if (typeof args.name !== 'string') {
            throw new RpcError(JSON_RPC_ERRORS.invalidParams, "'name' is required");
          }
          // A tool that refuses returns `isError: true` rather than throwing: a refusal is a result the
          // model should read and act on, where a protocol error is a transport failure it cannot.
          return callTool(args.name, args.arguments, session);
        }

        default:
          throw new RpcError(JSON_RPC_ERRORS.methodNotFound, `unknown method '${method}'`);
      }
    },
    notify() {
      // `notifications/initialized` and `notifications/cancelled` both land here and both are correctly
      // ignored: there is no post-initialize setup to do, and no long call to cancel.
    },
  });

  return {
    listen: rpc.listen.bind(rpc),
    shutdown: async () => {
      await session.disconnect();
    },
    session,
  };
}
