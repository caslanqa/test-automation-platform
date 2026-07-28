/**
 * The recorded action log. Append-only with a cursor, not a stack pair: the old two-stack model threw the
 * redo stack away on any non-append edit, so removing one step silently made everything you had just undone
 * unrecoverable. Pure in-memory — no device, no files (§6).
 *
 * @example const recorder = new Recorder(); recorder.append({ kind: 'back' }); recorder.undo();
 */
import type { MobileAction } from '@pwtap/mobile-core';

export class Recorder {
  private log: MobileAction[] = [];
  /** How many entries of `log` are live. Undo moves it back, redo forward; nothing is discarded. */
  private cursor = 0;

  /** The actions that make up the current recording. */
  get actions(): MobileAction[] {
    return this.log.slice(0, this.cursor);
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.log.length;
  }

  /** Record a new action, dropping anything that was undone — a new branch replaces the abandoned one. */
  append(action: MobileAction): void {
    this.log = [...this.actions, action];
    this.cursor = this.log.length;
  }

  undo(): MobileAction | undefined {
    if (!this.canUndo) {
      return undefined;
    }
    this.cursor -= 1;
    return this.log[this.cursor];
  }

  redo(): MobileAction | undefined {
    if (!this.canRedo) {
      return undefined;
    }
    const action = this.log[this.cursor];
    this.cursor += 1;
    return action;
  }

  /**
   * Remove one live action. This rewrites the log, so anything undone past this point is abandoned — the
   * alternative is a redo that reinserts a step around a hole the user deliberately made.
   */
  remove(index: number): boolean {
    const live = this.actions;
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
