/**
 * Service tests, driven over real HTTP against a real server on a loopback port.
 *
 * No browser is involved and none is needed: SSE, POST and an image endpoint are all plain HTTP, which is
 * most of why the transport was chosen (architecture.md ADR-013). The properties worth guarding are the ones
 * a manual click-through would never reveal — that a dropped event stream does **not** tear down the
 * recording (ADR-011), that an out-of-order command is refused instead of silently applied, that frame bytes
 * never travel inside an event, and that an unauthorized request gets nothing at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { ServerMessage } from '../src/service/protocol.js';
import { startInspectorService, type InspectorServiceHandle } from '../src/service/server.js';
import { fakeDriverMap, type FakeDriver } from './fakes/fakeDriver.js';

/** Centre of the login button in the fake driver's first screen. */
const LOGIN_BUTTON = { x: 200, y: 230 };

const running: InspectorServiceHandle[] = [];
after(async () => {
  await Promise.all(running.map(h => h.close()));
});

interface Service {
  handle: InspectorServiceHandle;
  driver: FakeDriver;
  base: string;
  token: string;
  dir: string;
}

async function startService(): Promise<Service> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-service-'));
  const { map, driver } = fakeDriverMap();
  const handle = await startInspectorService({
    projectRoot: dir,
    drivers: map,
    // Tests run several services at once, so the one-per-project lock is exercised separately.
    skipInstanceLock: true,
  });
  running.push(handle);
  return { handle, driver, base: `http://127.0.0.1:${handle.port}`, token: handle.token, dir };
}

/** An attached event stream, decoding SSE frames into messages as they arrive. */
class EventStream {
  readonly messages: ServerMessage[] = [];
  readonly ids: number[] = [];
  private buffer = '';
  private readonly controller = new AbortController();

  static async open(service: Service): Promise<EventStream> {
    const stream = new EventStream();
    const response = await fetch(`${service.base}/events?token=${service.token}`, {
      signal: stream.controller.signal,
    });
    assert.equal(response.status, 200, 'the event stream should attach');
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    void stream.consume(response.body as ReadableStream<Uint8Array>);
    return stream;
  }

  /** Set once the server ends the response, which is how a displaced client learns it is finished. */
  private finished = false;

  /** Resolves true when the server has ended this stream, false if it is still open after `timeoutMs`. */
  async ended(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.finished) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        this.buffer += decoder.decode(chunk, { stream: true });
        let split = this.buffer.indexOf('\n\n');
        while (split !== -1) {
          this.push(this.buffer.slice(0, split));
          this.buffer = this.buffer.slice(split + 2);
          split = this.buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Aborted by `close()` — expected.
    }
    this.finished = true;
  }

  private push(frame: string): void {
    for (const line of frame.split('\n')) {
      if (line.startsWith('id: ')) {
        this.ids.push(Number(line.slice(4)));
      } else if (line.startsWith('data: ')) {
        this.messages.push(JSON.parse(line.slice(6)) as ServerMessage);
      }
    }
  }

  /**
   * Wait for a message of `type`, optionally one satisfying `where`.
   *
   * The predicate matters more than it looks: several events of the same type arrive over a session (a
   * `timeline` on connect, another after each action), so asserting on "the latest `timeline`" right after
   * a command would happily match the *previous* one and pass or fail on timing.
   */
  async waitFor<T extends ServerMessage['type']>(
    type: T,
    where?: (message: Extract<ServerMessage, { type: T }>) => boolean,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = [...this.messages]
        .reverse()
        .find(
          (m): m is Extract<ServerMessage, { type: T }> =>
            m.type === type && (!where || where(m as Extract<ServerMessage, { type: T }>)),
        );
      if (found) {
        return found;
      }
      if (Date.now() >= deadline) {
        assert.fail(
          `no "${type}" event within ${timeoutMs}ms; saw: ${this.messages.map(m => m.type).join(', ')}`,
        );
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  close(): void {
    this.controller.abort();
  }
}

let seq = 0;
async function command(service: Service, message: unknown, override?: number): Promise<Response> {
  return fetch(`${service.base}/command?token=${service.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seq: override ?? ++seq, message }),
  });
}

const connect = (service: Service): Promise<Response> =>
  command(service, {
    type: 'connect',
    driver: 'fake',
    options: { platform: 'android', device: 'Pixel_7_API_34', appId: 'com.example.app' },
  });

test('every endpoint refuses a request without the launch token', async () => {
  const service = await startService();

  for (const url of ['/', '/events', '/frame/0']) {
    const response = await fetch(`${service.base}${url}`);
    assert.equal(response.status, 403, `${url} should be gated`);
    await response.body?.cancel();
  }
  const posted = await fetch(`${service.base}/command`, { method: 'POST', body: '{}' });
  assert.equal(posted.status, 403);
});

test('a wrong token is refused just like a missing one', async () => {
  const service = await startService();

  const response = await fetch(`${service.base}/?token=${'0'.repeat(service.token.length)}`);
  assert.equal(response.status, 403);
});

test('a non-loopback Origin is refused even with a valid token', async () => {
  const service = await startService();

  const response = await fetch(`${service.base}/?token=${service.token}`, {
    headers: { origin: 'https://evil.example.com' },
  });

  assert.equal(response.status, 403, 'a page on another origin must not be able to drive a device');
});

test('connecting streams the device state, and frames arrive as metadata only', async () => {
  const service = await startService();
  const events = await EventStream.open(service);

  assert.equal((await connect(service)).status, 202);

  const connected = await events.waitFor('connected');
  assert.equal(connected.device.name, 'Pixel_7_API_34');
  const frame = await events.waitFor('frame');
  assert.equal(frame.frame.width, 400);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(frame.frame, 'imageBase64'),
    `image bytes must not travel inside an event: ${JSON.stringify(frame.frame)}`,
  );

  events.close();
});

test('the frame endpoint serves the real image bytes', async () => {
  const service = await startService();
  const events = await EventStream.open(service);
  await connect(service);
  const frame = await events.waitFor('frame');

  const response = await fetch(
    `${service.base}/frame/${frame.frame.frameId}?token=${service.token}`,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(
    [...bytes.subarray(0, 4)],
    [0x89, 0x50, 0x4e, 0x47],
    'the endpoint should return a PNG, not base64 text',
  );

  events.close();
});

test('an unknown frame id is a 404 rather than a hang', async () => {
  const service = await startService();

  const response = await fetch(`${service.base}/frame/9999?token=${service.token}`);

  assert.equal(response.status, 404);
});

test('an unchanged screen reports the id the client already has, and sends no new frame', async () => {
  const service = await startService();
  const events = await EventStream.open(service);
  await connect(service);
  const first = await events.waitFor('frame');

  // The fake driver renders the same screen until an action advances it, so a refresh is byte-identical.
  await command(service, { type: 'refreshFrame' });
  const unchanged = await events.waitFor('frameUnchanged');

  assert.equal(unchanged.frameId, first.frame.frameId, 'the UI should keep its cached image');
  const frames = events.messages.filter(m => m.type === 'frame');
  assert.equal(frames.length, 1, 'an idle screen must not re-send megabytes');

  events.close();
});

test('a command that arrives out of order is refused and reported', async () => {
  const service = await startService();
  const events = await EventStream.open(service);
  await connect(service);

  const replayed = await command(service, { type: 'refreshHierarchy' }, 1);

  assert.equal(replayed.status, 409, 'POSTs can race in a way WS framing used to hide');
  const error = await events.waitFor('error');
  assert.match(error.message, /out of order/);

  events.close();
});

test('a malformed command is rejected before it can reach a driver', async () => {
  const service = await startService();
  const events = await EventStream.open(service);

  const bad = await command(service, { type: 'perform', action: { kind: 'fill' } });

  assert.equal(bad.status, 400);
  assert.match((await events.waitFor('error')).message, /malformed or unknown/);
  assert.equal(service.driver.session, undefined, 'nothing should have reached the driver');

  events.close();
});

test('a second client takes the view over instead of being refused', async () => {
  // This used to answer 409. Found in the field: `mobile-inspect` opens a window AND prints the URL, so
  // opening that URL — which the README invites — was refused, and an EventSource that receives a non-200
  // never retries, leaving a page that rendered and stayed deaf forever. Two clients still never share the
  // device: the older view is told it was displaced (ADR-011 — the session belongs to the launch).
  const service = await startService();
  const first = await EventStream.open(service);
  await connect(service);
  await first.waitFor('frame');

  const second = await EventStream.open(service);

  assert.equal(
    await first.waitFor('displaced').then(() => true),
    true,
    'the old view must be told',
  );
  // The recording is untouched: the new view re-syncs the live session rather than starting a fresh one.
  assert.equal((await second.waitFor('connected')).device.platform, 'android');
  second.close();
});

test('the displaced client is closed, so it cannot reconnect and displace back', async () => {
  const service = await startService();
  const first = await EventStream.open(service);

  const second = await EventStream.open(service);
  await first.waitFor('displaced');

  // The server ends the old response; a client that keeps reading sees the stream finish.
  assert.equal(await first.ended(), true, 'the displaced stream must be ended by the server');
  second.close();
});

test('a reattached client starts its own command ordering, so a reload can still record', async () => {
  // The field defect behind "taps never become code": the sequence guard was launch-wide while a browser
  // counts from 1 on every page load, so after a reload EVERY command came back `409 command 1 arrived
  // after 5`. Frames need no command, so the screen kept updating and the page looked perfectly alive.
  const service = await startService();
  const first = await EventStream.open(service);
  await connect(service);
  await first.waitFor('frame');
  await command(service, { type: 'tapAt', ...LOGIN_BUTTON, frameId: 0 });
  await first.waitFor('timeline', t => t.entries.length === 1);
  first.close();
  await new Promise(resolve => setTimeout(resolve, 50));

  const second = await EventStream.open(service);
  // A fresh page's very first command is #1, however many the previous one sent.
  const response = await command(service, { type: 'tapAt', ...LOGIN_BUTTON, frameId: 0 }, 1);

  assert.equal(response.status, 202, 'a reloaded page must not have its commands refused');
  const timeline = await second.waitFor('timeline', t => t.entries.length === 2);
  assert.equal(timeline.entries.length, 2, 'the recording continues rather than stalling');
  second.close();
});

test('within one client, an out-of-order command is still refused', async () => {
  // The guard itself must survive the fix: it exists because independent POSTs can race (ADR-013).
  const service = await startService();
  const events = await EventStream.open(service);
  await command(service, { type: 'listDrivers' }, 5);

  const late = await command(service, { type: 'listDrivers' }, 3);

  assert.equal(late.status, 409);
  events.close();
});

test('losing the event stream does NOT end the recording — reattaching resyncs it', async () => {
  const service = await startService();
  const first = await EventStream.open(service);
  await connect(service);
  await first.waitFor('frame');
  await command(service, { type: 'tapAt', ...LOGIN_BUTTON, frameId: 0 });
  await first.waitFor('timeline', t => t.entries.length === 1);

  // Exactly what pressing F5 does.
  first.close();
  await new Promise(resolve => setTimeout(resolve, 50));

  const second = await EventStream.open(service);

  assert.equal(service.driver.session?.closed, false, 'the device session must survive a reload');
  assert.equal((await second.waitFor('connected')).device.name, 'Pixel_7_API_34');
  assert.equal((await second.waitFor('timeline')).entries.length, 1, 'the recording must survive');
  assert.match((await second.waitFor('code')).source, /mobileApp\.tap/);
  assert.equal(
    second.messages.filter(m => m.type === 'connected').length,
    1,
    'resync, not reconnect',
  );
  // A reloaded page holds no frame, so the resync must carry full metadata rather than a bare id —
  // otherwise the UI could fetch the image but not translate a click on it.
  const replayed = await second.waitFor('frame');
  assert.equal(replayed.frame.width, 400, 'the resynced frame must be renderable and clickable');

  second.close();
});

test('event ids are monotonic so EventSource can resume from Last-Event-ID', async () => {
  const service = await startService();
  const events = await EventStream.open(service);
  await connect(service);
  await events.waitFor('frame');

  assert.ok(events.ids.length > 1, 'events should carry ids');
  const ascending = events.ids.every((id, i) => i === 0 || id > events.ids[i - 1]);
  assert.ok(ascending, `ids must increase: ${events.ids.join(', ')}`);

  events.close();
});

test('closing the service tears the launch down, including the driver session', async () => {
  const service = await startService();
  const events = await EventStream.open(service);
  await connect(service);
  await events.waitFor('connected');
  const driverSession = service.driver.session;

  await service.handle.close();

  assert.equal(driverSession?.closed, true, 'a closed launch must never leak a device lock');
  await assert.rejects(
    () => fetch(`${service.base}/?token=${service.token}`),
    'the port should be closed',
  );
  events.close();
});

test('a second inspector for the same project is refused with the first one’s URL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwtap-lock-'));
  const { map } = fakeDriverMap();
  const first = await startInspectorService({ projectRoot: dir, drivers: map });
  running.push(first);

  await assert.rejects(
    () => startInspectorService({ projectRoot: dir, drivers: fakeDriverMap().map }),
    (error: Error) => {
      assert.match(error.message, /already running/);
      assert.match(error.message, new RegExp(`${first.port}`), 'it must point at the live one');
      return true;
    },
  );

  // Once the first launch is gone the lock is reclaimable, so the next launch succeeds.
  await first.close();
  const second = await startInspectorService({ projectRoot: dir, drivers: fakeDriverMap().map });
  running.push(second);
  assert.ok(second.port > 0);
});
