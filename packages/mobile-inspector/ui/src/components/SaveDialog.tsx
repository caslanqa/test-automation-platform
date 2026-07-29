import { useEffect, useMemo, useRef, useState } from 'react';

import type { TestFileEntry } from '../protocol';

type SaveMode = 'new' | 'append';

export interface SaveResult {
  mode: SaveMode;
  targetPath: string;
  testName: string;
}

interface SaveDialogProps {
  /** The directory currently listed, and its subdirectories (server-provided, project-confined). */
  dirs: { path: string; entries: string[] };
  /** Ask the service to list a project-relative directory. */
  browse: (path: string) => void;
  /** Existing recorded test files under the project (refreshed by the parent via `listTestFiles`). */
  testFiles: TestFileEntry[];
  /**
   * File extension a "new file" save will produce, taken from the connected driver's own declaration
   * (`.maestro.ts` / `.appium.ts`) — the extension decides which Playwright project, gate variable and
   * timeout the saved test gets, so the preview must show the real one rather than a guess.
   */
  extension: string;
  onCancel: () => void;
  onConfirm: (result: SaveResult) => void;
}

/**
 * Modal for writing the recorded/edited test to disk. Two modes:
 * - "New file": pick a folder (defaults to the project's `tests/` dir) + a file name; refuses to
 *   overwrite an existing file (enforced server-side too).
 * - "Append to existing file": pick one of the project's existing recorded test files — the recorded
 *   test is merged into it, never overwriting the file's existing content.
 *
 * Rendered as a native `<dialog>` opened with `showModal()`, which supplies the focus trap, Escape
 * dismissal and focus restoration that a `<div>` overlay has to reimplement by hand.
 */
export function SaveDialog({
  testFiles,
  dirs,
  browse,
  extension,
  onCancel,
  onConfirm,
}: SaveDialogProps) {
  const [mode, setMode] = useState<SaveMode>('new');
  const [testName, setTestName] = useState('recorded flow');

  // "New file" mode state.
  const [location, setLocation] = useState('tests');
  const [fileName, setFileName] = useState('recorded-flow');

  // "Append" mode state.
  const [filter, setFilter] = useState('');
  const [selectedFile, setSelectedFile] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  // The component is mounted only while the dialog is open, so opening it on mount is the whole
  // lifecycle. `showModal()` (not the `open` attribute) is what makes the rest of the page inert.
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  useEffect(() => {
    if (mode === 'append' && !selectedFile && testFiles.length > 0) {
      setSelectedFile(testFiles[0].relativePath);
    }
  }, [mode, selectedFile, testFiles]);

  const filteredFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? testFiles.filter(
          f => f.name.toLowerCase().includes(q) || f.relativePath.toLowerCase().includes(q),
        )
      : testFiles;
  }, [testFiles, filter]);

  const preview =
    mode === 'new'
      ? `${location.replace(/\/+$/, '') || '.'}/${fileName || '…'}${extension}`
      : selectedFile;

  const canSave =
    testName.trim().length > 0 &&
    (mode === 'new' ? fileName.trim().length > 0 : selectedFile.trim().length > 0);

  function onSave(): void {
    if (!canSave) {
      return;
    }
    onConfirm({
      mode,
      targetPath: mode === 'new' ? `${location}/${fileName.trim()}` : selectedFile,
      testName: testName.trim(),
    });
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-save"
      aria-labelledby="save-dialog-title"
      // `cancel` is Escape; a click whose target is the dialog itself landed on the backdrop.
      onCancel={onCancel}
      onClick={event => {
        if (event.target === dialogRef.current) {
          onCancel();
        }
      }}
    >
      <div className="modal-body">
        <h3 id="save-dialog-title">Save test</h3>

        <div className="tabs save-mode-tabs">
          <button
            className={`tab${mode === 'new' ? ' active' : ''}`}
            onClick={() => setMode('new')}
          >
            New file
          </button>
          <button
            className={`tab${mode === 'append' ? ' active' : ''}`}
            onClick={() => setMode('append')}
          >
            Append to existing file
          </button>
        </div>

        <label className="field">
          Test title
          <input value={testName} onChange={e => setTestName(e.target.value)} />
        </label>

        {mode === 'new' ? (
          <>
            <label className="field">
              Location
              <input value={location} onChange={e => setLocation(e.target.value)} />
            </label>
            <div className="field">
              Browse ({dirs.path || 'project root'})
              <div className="app-list dir-list">
                {dirs.path !== '' && (
                  <button
                    className="app-row"
                    onClick={() => browse(parentOf(dirs.path))}
                    title="up one level"
                  >
                    <span className="app-name">../</span>
                  </button>
                )}
                {dirs.entries.map(name => {
                  const next = dirs.path ? `${dirs.path}/${name}` : name;
                  return (
                    <button
                      key={next}
                      className={`app-row${location === next ? ' active' : ''}`}
                      onClick={() => {
                        setLocation(next);
                        browse(next);
                      }}
                    >
                      <span className="app-name">{name}/</span>
                    </button>
                  );
                })}
                {dirs.entries.length === 0 && (
                  <div className="muted app-empty">no subdirectories here</div>
                )}
              </div>
            </div>
            <label className="field">
              File name
              <input value={fileName} onChange={e => setFileName(e.target.value)} />
            </label>
            <span className="muted save-preview">{preview} (must not already exist)</span>
          </>
        ) : (
          <>
            <label className="field">
              Existing test files ({filteredFiles.length})
              <div className="field-row">
                <input
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  placeholder="filter test files…"
                />
              </div>
            </label>
            <div className="app-list save-file-list">
              {filteredFiles.map(f => (
                <button
                  key={f.relativePath}
                  className={`app-row${selectedFile === f.relativePath ? ' active' : ''}`}
                  onClick={() => setSelectedFile(f.relativePath)}
                  title={f.relativePath}
                >
                  <span className="app-name">{f.name}</span>
                  <span className="app-id muted">{f.relativePath}</span>
                </button>
              ))}
              {filteredFiles.length === 0 && (
                <div className="muted app-empty">no existing test files found in the project</div>
              )}
            </div>
            <span className="muted save-preview">
              {selectedFile || 'no file selected'} (new test appended, existing content preserved)
            </span>
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={!canSave}>
            Save
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** One level up from a project-relative path; `''` is the project root. */
function parentOf(dir: string): string {
  const cut = dir.lastIndexOf('/');
  return cut > 0 ? dir.slice(0, cut) : '';
}
