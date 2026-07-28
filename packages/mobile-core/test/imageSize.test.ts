/**
 * Dimension-reader tests. `readImageSize` is what gives every `ScreenFrame` its `width`/`height`, and
 * those numbers drive the coordinate transform for every recorded tap — a silent misread here lands
 * clicks on the wrong device pixel, so the headers are asserted byte-exactly rather than round-tripped
 * through a real screenshot.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readImageSize } from '../src/imageSize.js';

/** Minimal valid PNG prefix: 8-byte signature + an IHDR chunk carrying width/height. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** Minimal baseline JPEG: SOI followed by an SOF0 segment carrying height/width. */
function jpegHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(21);
  buf.writeUInt16BE(0xffd8, 0); // SOI
  buf.writeUInt16BE(0xffc0, 2); // SOF0
  buf.writeUInt16BE(17, 4); // segment length
  buf.writeUInt8(8, 6); // sample precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

test('reads PNG dimensions from the IHDR chunk', () => {
  assert.deepEqual(readImageSize(pngHeader(1080, 2400)), { width: 1080, height: 2400 });
});

test('reads JPEG dimensions from the SOF0 segment', () => {
  assert.deepEqual(readImageSize(jpegHeader(828, 1792)), { width: 828, height: 1792 });
});

test('does not transpose portrait and landscape', () => {
  assert.deepEqual(readImageSize(pngHeader(2400, 1080)), { width: 2400, height: 1080 });
  assert.deepEqual(readImageSize(jpegHeader(1792, 828)), { width: 1792, height: 828 });
});

test('skips a JPEG segment that precedes the SOF marker', () => {
  // A real Maestro screenshot carries APP0/JFIF before SOF0, so the reader must walk past it. Note that
  // a JPEG segment's 2-byte length field counts *itself*: `6` here means four bytes of payload.
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x06]), Buffer.from('JFIF', 'ascii')]);
  const sof = jpegHeader(828, 1792).subarray(2); // everything after the SOI marker
  const withApp0 = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);

  assert.deepEqual(readImageSize(withApp0), { width: 828, height: 1792 });
});

test('returns undefined for a buffer that is neither PNG nor JPEG', () => {
  assert.equal(readImageSize(Buffer.from('not an image at all, just text')), undefined);
  assert.equal(readImageSize(Buffer.alloc(0)), undefined);
});

test('returns undefined for a truncated PNG rather than reading past the buffer', () => {
  assert.equal(readImageSize(pngHeader(10, 10).subarray(0, 20)), undefined);
});
