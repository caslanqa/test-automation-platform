/**
 * Minimal, dependency-free PNG/JPEG dimension readers — used to build a {@link ScreenFrame}'s
 * `width`/`height` from a raw screenshot buffer (Maestro's `take_screenshot` returns JPEG, Appium's
 * `saveScreenshot`/`takeScreenshot` returns PNG). Deliberately not a new npm dependency: the repo's
 * "minimal new dependencies" convention, and both formats' relevant header is a handful of bytes.
 */

/** Read `{ width, height }` from a PNG buffer's `IHDR` chunk, or `undefined` if not a valid PNG. */
function readPngSize(buf: Buffer): { width: number; height: number } | undefined {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return undefined;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Read `{ width, height }` from a baseline/progressive JPEG's SOFn marker segment. */
function readJpegSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return undefined; // not a JPEG (missing SOI marker)
  }
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1; // resync — skip stray fill bytes
      continue;
    }
    const marker = buf[offset + 1];
    // SOF0..SOF15, excluding DHT(C4)/JPG(C8)/DAC(CC) which share the range but aren't SOF markers.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (isSof) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2; // SOI/EOI carry no length field
      continue;
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

/** Read `{ width, height }` from a PNG or JPEG buffer; `undefined` if neither format is recognized. */
export function readImageSize(buf: Buffer): { width: number; height: number } | undefined {
  return readPngSize(buf) ?? readJpegSize(buf);
}

/**
 * The interaction coordinate space to report for a capture, with orientation resolved against the image.
 *
 * A driver reads that space once — it costs a device round trip — while the screen can rotate underneath it,
 * so after a rotation the two disagree about which axis is the longer one and every click lands transposed.
 * Both adapters need exactly this reconciliation, so it lives here beside the header readers rather than
 * twice. Returns `undefined` when the driver could not determine a space at all, which the caller reports as
 * "the image size is the coordinate space".
 *
 * @example orientCoordinateSpace({ width: 2400, height: 1080 }, { width: 1080, height: 2400 })
 */
export function orientCoordinateSpace(
  image: { width: number; height: number },
  coordinate: { width: number; height: number } | undefined,
): { width: number; height: number } | undefined {
  if (!coordinate) {
    return undefined;
  }
  const sameOrientation = image.width > image.height === coordinate.width > coordinate.height;
  return sameOrientation ? coordinate : { width: coordinate.height, height: coordinate.width };
}
