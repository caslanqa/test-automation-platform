import { useEffect, useMemo, useState } from 'react';

import type { PickPathResult } from '../global';
import type { TestFileEntry } from '../protocol';

type SaveMode = 'new' | 'append';

export interface SaveResult {
  mode: SaveMode;
  targetPath: string;
  testName: string;
}

interface SaveDialogProps {
  /** Existing recorded test files under the project (refreshed by the parent via `listTestFiles`). */
  testFiles: TestFileEntry[];
  pickSaveLocation: () => Promise<PickPathResult | null>;
  pickExistingTestFile: () => Promise<PickPathResult | null>;
  onCancel: () => void;
  onConfirm: (result: SaveResult) => void;
}

/**
 * Modal for writing the recorded/edited test to disk. Two modes:
 * - "New file": pick a folder (defaults to the project's `tests/` dir) + a file name; refuses to
 *   overwrite an existing file (enforced server-side too).
 * - "Append to existing file": pick one of the project's existing `*.mobile.ts` files (from an
 *   in-app list or a native file browser) — the recorded test is merged into it, never overwriting
 *   the file's existing content.
 */
export function SaveDialog({
  testFiles,
  pickSaveLocation,
  pickExistingTestFile,
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

  async function onChooseLocation(): Promise<void> {
    const result = await pickSaveLocation();
    if (result) {
      setLocation(result.relativePath || '.');
    }
  }

  async function onBrowseExisting(): Promise<void> {
    const result = await pickExistingTestFile();
    if (result) {
      setSelectedFile(result.relativePath);
    }
  }

  const preview =
    mode === 'new'
      ? `${location.replace(/\/+$/, '') || '.'}/${fileName || '…'}.mobile.ts`
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
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-save" onClick={e => e.stopPropagation()}>
        <h3>Save test</h3>

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
              <div className="field-row">
                <input value={location} onChange={e => setLocation(e.target.value)} />
                <button className="btn btn-small" onClick={onChooseLocation}>
                  Choose…
                </button>
              </div>
            </label>
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
                <button className="btn btn-small" onClick={onBrowseExisting}>
                  Browse…
                </button>
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
    </div>
  );
}
