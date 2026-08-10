/**
 * The recorded action log. Append-only with a cursor, not a stack pair: the old two-stack model threw the
 * redo stack away on any non-append edit, so removing one step silently made everything you had just undone
 * unrecoverable. Pure in-memory — no device, no files (§6).
 *
 * Steps carry a stable id (§6), so a caller can come back to one later — to stamp the frame it produced, or
 * to retract it after the driver refused it — without depending on its position, which the user can change
 * while the device is still answering.
 *
 * @example const recorder = new Recorder(); recorder.append({ kind: 'back' }); recorder.undo();
 */
import type { MobileAction } from '@pwtap/mobile-core';

import type { TimelineEntry } from './protocol.js';

export class Recorder {
  private log: TimelineEntry[] = [];
  /** How many entries of `log` are live. Undo moves it back, redo forward; nothing is discarded. */
  private cursor = 0;
  /** Never reset, not even by {@link clear}: a stale id must not come to mean a different step. */
  private nextId = 1;

  /** The steps that make up the current recording. */
  get entries(): TimelineEntry[] {
    return this.log.slice(0, this.cursor);
  }

  /** The actions those steps hold, in order — what codegen consumes. */
  get actions(): MobileAction[] {
    return this.entries.map(entry => entry.action);
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.log.length;
  }

  /** Record a new action, dropping anything that was undone — a new branch replaces the abandoned one. */
  append(action: MobileAction): TimelineEntry {
    const entry: TimelineEntry = { id: this.nextId++, action };
    this.log = [...this.entries, entry];
    this.cursor = this.log.length;
    return entry;
  }

  /**
   * Remember which frame the screen showed once step `id` had run. Ignored for a step that is no longer
   * there, because the device answers after the user may already have undone it.
   */
  stamp(id: number, frameId: number): void {
    const entry = this.entries.find(candidate => candidate.id === id);
    if (entry) {
      entry.frameId = frameId;
    }
  }

  undo(): MobileAction | undefined {
    if (!this.canUndo) {
      return undefined;
    }
    this.cursor -= 1;
    return this.log[this.cursor].action;
  }

  redo(): MobileAction | undefined {
    if (!this.canRedo) {
      return undefined;
    }
    const entry = this.log[this.cursor];
    this.cursor += 1;
    return entry.action;
  }

  /**
   * Remove a specific action object, if it is still live. Used to retract an optimistically recorded action
   * the driver then refused: by identity, because the user may have undone or removed something in the
   * second or two the device took to answer, and removing "the last one" would then take the wrong step.
   */
  retract(action: MobileAction): boolean {
    const live = this.entries;
    for (let index = live.length - 1; index >= 0; index -= 1) {
      if (live[index].action === action) {
        return this.remove(index);
      }
    }
    return false;
  }

  /**
   * Remove one live step. This rewrites the log, so anything undone past this point is abandoned — the
   * alternative is a redo that reinserts a step around a hole the user deliberately made.
   */
  remove(index: number): boolean {
    const live = this.entries;
    if (index < 0 || index >= live.length) {
      return false;
    }
    this.log = [...live.slice(0, index), ...live.slice(index + 1)];
    this.cursor = this.log.length;
    return true;
  }

  clear(): void {
    this.log = [];
    this.cursor = 0;
  }
}
