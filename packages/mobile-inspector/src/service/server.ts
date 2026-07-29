/**
 * The local inspector service: it hosts the UI, streams recorder events to it, and takes commands back.
 *
 * Three endpoints on plain `node:http`, no WebSocket library (architecture.md ADR-013 — Node ships a WS
 * *client* but no server, and this protocol never needed bidirectional framing):
 *
 * - `GET /events`            an SSE stream of {@link ServerMessage}s, ids monotonic so `EventSource` can
 *                            resume from `Last-Event-ID` after a reload
 * - `POST /command`          one `{ seq, message }` envelope; answered `202`, results arrive as events
 * - `GET /frame/<frameId>`   the raw screenshot bytes for an `<img src>`
 * - `GET /` + `/assets/*`    the built UI
 *
 * The recording session belongs to this **launch**, not to a connection (ADR-011): a browser reload drops
 * the event stream and must cost the user nothing, so attaching is a re-sync rather than a fresh start.
 *
 * Security posture (ADR-010): loopback bind, random port, per-launch token on every request, loopback
 * `Origin` required, `HttpOnly; SameSite=Strict` cookie for the token-less asset requests the browser makes
 * on its own, and a strict CSP on the page. The client is untrusted even though it is local, so every
 * command is re-validated with `parseClientMessage` before it can reach a driver.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MobileInspectorDriver } from '@pwtap/mobile-core';

import { FrameStore } from './frameStore.js';
import { readLock, releaseLock, writeLock } from './instanceLock.js';
import { parseClientMessage, type RecorderEvent, type ServerMessage } from './protocol.js';
import { RecorderSession } from './recorderSession.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The Vite UI build output. Outside `dist/` so `tsc -b --clean` never removes it (see vite.config.ts). */
const UI_DIST = path.resolve(__dirname, '../../ui-dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * `connect-src 'self'` covers the SSE stream and the command POSTs; `img-src 'self'` covers frames now that
 * they are fetched rather than inlined as data URIs.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // CodeMirror injects styles at runtime
  "font-src 'self' data:",
  "img-src 'self'",
  "connect-src 'self'",
].join('; ');

/** Largest command body accepted, so a runaway client cannot exhaust memory. Sources are the big ones. */
const MAX_COMMAND_BYTES = 4 * 1024 * 1024;

export interface InspectorServiceOptions {
  /** Root of the scaffolded client project — drivers resolve against its `node_modules`. */
  projectRoot: string;
  /** Fixed port (mainly for tests); omit to let the OS pick a free loopback port. */
  port?: number;
  /** Bind host — must stay loopback in production; overridable only for automated tests. */
  host?: string;
  /**
   * Inject driver adapters instead of discovering them from the project. A test seam, and the same one the
   * recording engine takes — see `RecorderSession`.
   */
  drivers?: Map<string, MobileInspectorDriver>;
  /** Skip the one-inspector-per-project lock. Only for tests, which run several services at once. */
  skipInstanceLock?: boolean;
}

export interface InspectorServiceHandle {
  /** The URL to open, token included. */
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

/** Thrown by {@link startInspectorService} when this project already has a live inspector (ADR-011). */
export class InspectorAlreadyRunningError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(
      `[mobile-inspector] an inspector is already running for this project at ${url} — ` +
        'open that window instead of starting a second one, or close it first',
    );
    this.name = 'InspectorAlreadyRunningError';
    this.url = url;
  }
}

/** Constant-time token comparison, so a wrong token leaks nothing through timing. */
function tokenMatches(candidate: string | undefined | null, token: string): boolean {
  if (!candidate || candidate.length !== token.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

/** A browser always sends `Origin`; a non-browser client (curl, a test) sends none, which is fine. */
function isLoopbackOrigin(origin: string | undefined, host: string): boolean {
  if (!origin) {
    return true;
  }
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === host
    );
  } catch {
    return false;
  }
}

function tokenFromCookie(cookieHeader: string | undefined): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'inspector_token') {
      return rest.join('=');
    }
  }
  return undefined;
}

/** One attached client's event stream, plus the bookkeeping for resuming it. */
interface Subscriber {
  response: http.ServerResponse;
}

export async function startInspectorService(
  options: InspectorServiceOptions,
): Promise<InspectorServiceHandle> {
  const host = options.host ?? '127.0.0.1';
  const projectRoot = path.resolve(options.projectRoot);
  const token = randomBytes(24).toString('hex');

  if (!options.skipInstanceLock) {
    const existing = await readLock(projectRoot);
    if (existing) {
      throw new InspectorAlreadyRunningError(
        `http://${host}:${existing.port}/?token=${existing.token}`,
      );
    }
  }

  const frames = new FrameStore();
  /** Monotonic event id: `EventSource` reports the last one it saw, which is how a reload resumes. */
  let nextEventId = 1;
  let subscriber: Subscriber | undefined;
  /**
   * Rejects a command that arrives out of order — POSTs can race in a way WS framing used to hide. Scoped to
   * the ATTACHED CLIENT, not the launch: a browser counts from 1 on every page load, so a launch-wide
   * counter refused every command from a reloaded page (`command 1 arrived after 5`) while frames kept
   * arriving. The page looked alive and recorded nothing — the defect users reported as taps that never
   * became code. Ordering only ever needed to hold within one client's own stream of POSTs (ADR-013).
   */
  let lastSeq = 0;

  function writeEvent(message: ServerMessage): void {
    const id = nextEventId++;
    if (!subscriber || subscriber.response.writableEnded) {
      return;
    }
    subscriber.response.write(`id: ${id}\ndata: ${JSON.stringify(message)}\n\n`);
  }

  /**
   * The engine's events become wire events here. A frame's bytes are diverted into the store and replaced
   * by metadata plus an id, or collapsed into `frameUnchanged` when the screen has not moved.
   */
  function emit(event: RecorderEvent): void {
    if (event.type !== 'frame') {
      writeEvent(event);
      return;
    }
    const outcome = frames.accept(event.frame);
    writeEvent(
      outcome.kind === 'new'
        ? { type: 'frame', frame: outcome.meta }
        : { type: 'frameUnchanged', frameId: outcome.frameId },
    );
  }

  // ONE session for the whole launch. Attaching a client re-syncs it; detaching leaves it alone.
  const recorder = new RecorderSession(projectRoot, emit, options.drivers);

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
      }
      res.end('internal error');
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const queryToken = url.searchParams.get('token');
    const authorized =
      tokenMatches(queryToken, token) || tokenMatches(tokenFromCookie(req.headers.cookie), token);

    if (!authorized || !isLoopbackOrigin(req.headers.origin, host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    if (url.pathname === '/events') {
      attach(req, res);
      return;
    }
    if (url.pathname === '/command') {
      await acceptCommand(req, res);
      return;
    }
    if (url.pathname.startsWith('/frame/')) {
      serveFrame(url.pathname.slice('/frame/'.length), res);
      return;
    }
    await serveAsset(url, queryToken, res);
  }

  function attach(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Two clients must never share one device and one draft, but refusing the NEW one was the wrong end to
    // cut: `mobile-inspect` opens a window and prints the URL, so opening that URL — which the README
    // invites — got a 409, and an EventSource that receives a non-200 never retries. The page then rendered
    // and stayed deaf forever. The session belongs to the launch (ADR-011), so the newest view wins: the
    // previous one is told it was displaced and stops, and the recording is untouched either way.
    if (subscriber && !subscriber.response.writableEnded) {
      const previous = subscriber.response;
      previous.write(`id: ${nextEventId++}\ndata: ${JSON.stringify({ type: 'displaced' })}\n\n`);
      previous.end();
      subscriber = undefined;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    subscriber = { response: res };
    lastSeq = 0; // a new client is a new ordering domain
    req.on('close', () => {
      if (subscriber?.response === res) {
        subscriber = undefined; // detached, NOT torn down — the session outlives the connection
      }
    });

    // Re-sync: current device/timeline/draft from the engine, last frame from our own store.
    for (const event of recorder.snapshot()) {
      emit(event);
    }
    // A full `frame`, not `frameUnchanged`: a reloaded page holds no frame at all, and only the metadata
    // carries the dimensions and coordinate space a click needs to be translated. The bytes are already in
    // the browser cache under this id, so nothing is re-downloaded.
    const latest = frames.latest;
    if (latest) {
      writeEvent({ type: 'frame', frame: latest });
    }
  }

  async function acceptCommand(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('use POST');
      return;
    }
    let body = '';
    let tooLarge = false;
    for await (const chunk of req) {
      body += String(chunk);
      if (body.length > MAX_COMMAND_BYTES) {
        tooLarge = true;
        break;
      }
    }
    if (tooLarge) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('command too large');
      return;
    }

    let envelope: { seq?: unknown; message?: unknown };
    try {
      envelope = JSON.parse(body) as { seq?: unknown; message?: unknown };
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('malformed JSON');
      return;
    }
    if (typeof envelope.seq !== 'number' || !Number.isInteger(envelope.seq)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('missing command sequence number');
      return;
    }
    if (envelope.seq <= lastSeq) {
      // Out of order or replayed. Surfaced rather than silently applied: a reordered `tapAt` would
      // otherwise act on a screen the user was not looking at (§6 — nothing fails silently).
      res.writeHead(409, { 'content-type': 'text/plain' });
      res.end(`command ${envelope.seq} arrived after ${lastSeq}`);
      emit({
        type: 'error',
        message: `a command arrived out of order and was ignored (#${envelope.seq} after #${lastSeq})`,
      });
      return;
    }
    const message = parseClientMessage(envelope.message);
    if (!message) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('malformed or unknown command');
      emit({ type: 'error', message: 'malformed or unknown command' });
      return;
    }
    lastSeq = envelope.seq;
    // Answered immediately; every result reaches the client as an event, so one causal order holds.
    res.writeHead(202, { 'content-type': 'text/plain' });
    res.end('accepted');
    await recorder.dispatch(message);
  }

  function serveFrame(rawId: string, res: http.ServerResponse): void {
    const frame = frames.get(Number.parseInt(rawId, 10));
    if (!frame) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('frame expired');
      return;
    }
    res.writeHead(200, {
      'content-type': frame.contentType,
      'content-length': String(frame.bytes.length),
      // Frame ids are unique per capture, so a stored frame is safe to cache hard.
      'cache-control': 'private, max-age=3600, immutable',
    });
    res.end(frame.bytes);
  }

  async function serveAsset(
    url: URL,
    queryToken: string | null,
    res: http.ServerResponse,
  ): Promise<void> {
    // The page URL carries the token; the relative `./assets/*` requests that follow carry none, so pin it
    // in a cookie the browser will send with them.
    const setCookie = tokenMatches(queryToken, token)
      ? { 'set-cookie': `inspector_token=${token}; Path=/; HttpOnly; SameSite=Strict` }
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
        'content-security-policy': CSP,
        ...setCookie,
      });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found — run `npm run build:ui` in @pwtap/mobile-inspector first');
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  if (!options.skipInstanceLock) {
    await writeLock(projectRoot, { port, token, pid: process.pid });
  }

  let closed = false;
  return {
    url: `http://${host}:${port}/?token=${token}`,
    port,
    token,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      subscriber?.response.end();
      subscriber = undefined;
      // Teardown of the LAUNCH: releases the device lock, kills any run, removes temp files (ADR-011).
      await recorder.close();
      frames.clear();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (!options.skipInstanceLock) {
        await releaseLock(projectRoot);
      }
    },
  };
}
