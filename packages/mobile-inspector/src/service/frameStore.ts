/**
 * Holds recent frame bytes so the UI can fetch them from `GET /frame/<frameId>` instead of receiving
 * base64 inside an event (architecture.md ADR-013).
 *
 * Two jobs beyond storage. It **deduplicates**: an idle screen produces byte-identical captures, and
 * re-sending those is the single biggest waste in the old protocol, so an unchanged frame reports the id
 * the UI already has rather than a new one. And it **forgets**: only the last few frames are kept, because
 * a long session at one frame per second would otherwise hold every screenshot it ever took in memory.
 */
import { createHash } from 'node:crypto';

import type { ScreenFrame } from '@pwtap/mobile-core';

import type { ScreenFrameMeta } from './protocol.js';

/**
 * How many frames stay fetchable. More than one because a slow `<img>` request for the previous frame must
 * still resolve after a newer one arrives; small because each entry is a full screenshot.
 */
const RETAINED_FRAMES = 3;

export interface StoredFrame {
  bytes: Buffer;
  contentType: string;
}

/** What the transport should do with a captured frame. */
export type FrameOutcome =
  { kind: 'new'; meta: ScreenFrameMeta } | { kind: 'unchanged'; frameId: number };

/** Sniff the encoding from the bytes themselves — Maestro returns JPEG, Appium PNG. */
function contentTypeOf(bytes: Buffer): string {
  const isPng =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  return isPng ? 'image/png' : 'image/jpeg';
}

export class FrameStore {
  private readonly frames = new Map<number, StoredFrame>();
  private lastHash: string | undefined;
  private lastFrameId: number | undefined;
  /**
   * Metadata for the newest frame. Retained because a re-attaching client may have no frame at all — a
   * reload starts with an empty page — and `frameUnchanged` carries only an id. Without the dimensions and
   * coordinate space, the UI could fetch the image but not translate a click on it.
   */
  private lastMeta: ScreenFrameMeta | undefined;

  /**
   * Take a captured frame, keep its bytes, and report what the UI should be told. A frame whose bytes match
   * the previous one is NOT stored again: the previous id is still valid and still cached by the browser.
   */
  accept(frame: ScreenFrame): FrameOutcome {
    const bytes = Buffer.from(frame.imageBase64, 'base64');
    const hash = createHash('sha1').update(bytes).digest('hex');
    if (hash === this.lastHash && this.lastFrameId !== undefined) {
      return { kind: 'unchanged', frameId: this.lastFrameId };
    }
    this.lastHash = hash;
    this.lastFrameId = frame.frameId;
    this.frames.set(frame.frameId, { bytes, contentType: contentTypeOf(bytes) });
    while (this.frames.size > RETAINED_FRAMES) {
      const oldest = this.frames.keys().next();
      if (oldest.done) {
        break;
      }
      this.frames.delete(oldest.value);
    }
    // Strip the bytes: everything else is the metadata the UI needs for coordinate transforms.
    const { imageBase64: _bytes, ...meta } = frame;
    this.lastMeta = meta;
    return { kind: 'new', meta };
  }

  get(frameId: number): StoredFrame | undefined {
    return this.frames.get(frameId);
  }

  /** The frame a re-attaching client should render immediately (ADR-011), metadata included. */
  get latest(): ScreenFrameMeta | undefined {
    return this.lastMeta;
  }

  clear(): void {
    this.frames.clear();
    this.lastHash = undefined;
    this.lastFrameId = undefined;
    this.lastMeta = undefined;
  }
}
