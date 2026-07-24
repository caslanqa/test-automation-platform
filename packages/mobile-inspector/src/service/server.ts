/**
 * Local, loopback-only HTTP + WebSocket service that hosts the bundled React UI and speaks the
 * protocol in `protocol.ts`. Bound to `127.0.0.1`/`::1` only, random port by default, and gated by a
 * per-launch session token — every request (HTTP asset fetch and the WS upgrade) must present it, and
 * every `Origin` header must itself be loopback, so nothing on the network (or a malicious page in
 * another tab) can drive a connected device. See `plan.md`'s "Bind the service to 127.0.0.1/::1..."
 * constraint.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer, type WebSocket } from 'ws';

import { parseClientMessage, type ServerMessage } from './protocol.js';
import { RecorderSession } from './recorderSession.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The Vite UI build output — see `ui/vite.config.ts`'s `build.outDir`. Kept outside `dist/` so a
// `tsc -b --clean` (which only removes tsc's own outputs) never touches the UI bundle.
const UI_DIST = path.resolve(__dirname, '../../ui-dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export interface InspectorServiceHandle {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface InspectorServiceOptions {
  /** Root of the scaffolded client project (drivers are resolved relative to its `node_modules`). */
  projectRoot: string;
  /** Fixed port (mainly for tests); omit for the OS to assign a free loopback port. */
  port?: number;
  /** Bind host — must stay loopback in production; overridable only for automated tests. */
  host?: string;
}

function isLoopbackOrigin(origin: string | undefined, host: string): boolean {
  if (!origin) {
    return true; // non-browser clients (curl, tests) send no Origin — HTTP(S) browsers always do
  }
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === host;
  } catch {
    return false;
  }
}

/** Start the inspector service. Resolve once the HTTP server is listening. */
export function startInspectorService(
  options: InspectorServiceOptions,
): Promise<InspectorServiceHandle> {
  const host = options.host ?? '127.0.0.1';
  const token = randomBytes(24).toString('hex');
  const sessions = new Set<RecorderSession>();

  const server = http.createServer((req, res) => {
    void handleHttp(req, res, token);
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const origin = req.headers.origin;
    if (url.searchParams.get('token') !== token || !isLoopbackOrigin(origin, host)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const session = new RecorderSession(options.projectRoot, message => sendJson(ws, message));
      sessions.add(session);
      ws.on('message', data => void onMessage(session, ws, data));
      ws.on('close', () => {
        sessions.delete(session);
        void session.close();
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${port}/?token=${token}`,
        port,
        token,
        close: async () => {
          for (const session of sessions) {
            await session.close();
          }
          wss.close();
          await new Promise<void>(res => server.close(() => res()));
        },
      });
    });
  });
}

async function onMessage(session: RecorderSession, ws: WebSocket, data: unknown): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    sendJson(ws, { type: 'error', message: 'malformed message: not JSON' });
    return;
  }
  const message = parseClientMessage(parsed);
  if (!message) {
    sendJson(ws, { type: 'error', message: 'malformed or unknown message' });
    return;
  }
  // The recording engine owns every command; the transport just validates and forwards.
  await session.dispatch(message);
}

function sendJson(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/** Read the launch token from a `Cookie` header, if present. */
function tokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'inspector_token') {
      return rest.join('=');
    }
  }
  return undefined;
}

/**
 * Serve the bundled UI. The launch token gates access, but the browser only puts it on the initial
 * page URL (`/?token=...`) — the relative `./assets/*` requests Vite emits carry no query string. So
 * we accept the token from the query param *or* a cookie, and set that cookie when the page URL
 * presents a valid query token, letting subsequent same-origin asset fetches through.
 */
async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const queryToken = url.searchParams.get('token');
  const cookieToken = tokenFromCookie(req.headers.cookie);
  if (queryToken !== token && cookieToken !== token) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  // The page URL carried a valid token — pin it in a loopback-only, same-site session cookie so the
  // token-less relative asset requests that follow are recognized.
  const setCookie =
    queryToken === token
      ? { 'set-cookie': `inspector_token=${token}; Path=/; SameSite=Strict` }
      : {};
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(UI_DIST, path.normalize(requested).replace(/^(\.\.[/\\])+/, ''));
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new Error('not a file');
    }
    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      ...setCookie,
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found — run `npm run build:ui` in @pwtap/mobile-inspector first');
  }
}
