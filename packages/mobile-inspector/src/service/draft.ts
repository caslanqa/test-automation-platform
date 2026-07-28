/**
 * The editable test source and its revision. One writer at a time: either generated from the action log, or
 * owned by the user once they type. Nothing here reacts to a device event — a disconnect must never cost the
 * user their draft, which is what used to make pressing Run empty the editor (§6, ADR-011).
 *
 * @example draft.regenerate(() => generateTestSource(…)); draft.takeOver(source, revision);
 */
export class Draft {
  private source = '';
  private revision = 0;
  private userOwned = false;

  get state(): { source: string; revision: number; userOwned: boolean } {
    return { source: this.source, revision: this.revision, userOwned: this.userOwned };
  }

  /** Replace the source from the action log. Ignored once the user owns the buffer. */
  regenerate(generate: () => string): boolean {
    if (this.userOwned) {
      return false;
    }
    this.source = generate();
    this.revision += 1;
    return true;
  }

  /** Splice one generated statement into a user-owned draft, so a new action is not simply lost. */
  spliceIntoUserDraft(insert: (source: string) => string): void {
    this.source = insert(this.source);
    this.revision += 1;
  }

  /**
   * Accept an edit from the editor. `basedOn` is the revision the client edited; an older one means the
   * server has moved on, so the edit is refused rather than allowed to clobber newer content.
   */
  takeOver(source: string, basedOn: number): boolean {
    if (basedOn < this.revision) {
      return false;
    }
    this.source = source;
    this.userOwned = true;
    this.revision += 1;
    return true;
  }

  /** Start a fresh recording: only a new connection resets ownership. */
  reset(): void {
    this.source = '';
    this.userOwned = false;
    this.revision += 1;
  }
}
