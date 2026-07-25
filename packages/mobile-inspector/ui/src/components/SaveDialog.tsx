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
  testFiles: TestFileEntry[];
  pickSaveLocation: () => Promise<PickPathResult | null>;
  pickExistingTestFile: () => Promise<PickPathResult | null>;
  onCancel: () => void;
  onConfirm: (result: SaveResult) => void;
}

/** Save to a new project file or append the generated test to an existing mobile test. */
export function SaveDialog({
  testFiles,
  pickSaveLocation,
  pickExistingTestFile,
  onCancel,
  onConfirm,
}: SaveDialogProps) {
  const [mode, setMode] = useState<SaveMode>('new');
  const [testName, setTestName] = useState('recorded flow');
  const [location, setLocation] = useState('tests');
  const [fileName, setFileName] = useState('recorded-flow');
  const [filter, setFilter] = useState('');
  const [selectedFile, setSelectedFile] = useState('');

  useEffect(() => {
    if (mode === 'append' && !selectedFile && testFiles.length > 0) {
      setSelectedFile(testFiles[0].relativePath);
    }
  }, [mode, selectedFile, testFiles]);

  const filteredFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query
      ? testFiles.filter(
          file =>
            file.name.toLowerCase().includes(query) ||
            file.relativePath.toLowerCase().includes(query),
        )
      : testFiles;
  }, [filter, testFiles]);

  const preview =
    mode === 'new'
      ? `${location.replace(/\/+$/, '') || '.'}/${fileName || '...'}.mobile.ts`
      : selectedFile;
  const canSave =
    testName.trim().length > 0 &&
    (mode === 'new' ? fileName.trim().length > 0 : selectedFile.trim().length > 0);

  function save(): void {
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
      <div className="modal modal-save" onClick={event => event.stopPropagation()}>
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
          <input value={testName} onChange={event => setTestName(event.target.value)} />
        </label>

        {mode === 'new' ? (
          <>
            <label className="field">
              Location
              <div className="field-row">
                <input value={location} onChange={event => setLocation(event.target.value)} />
                <button
                  className="btn btn-small"
                  onClick={async () => {
                    const result = await pickSaveLocation();
                    if (result) {
                      setLocation(result.relativePath || '.');
                    }
                  }}
                >
                  Choose...
                </button>
              </div>
            </label>
            <label className="field">
              File name
              <input value={fileName} onChange={event => setFileName(event.target.value)} />
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
                  onChange={event => setFilter(event.target.value)}
                  placeholder="filter test files..."
                />
                <button
                  className="btn btn-small"
                  onClick={async () => {
                    const result = await pickExistingTestFile();
                    if (result) {
                      setSelectedFile(result.relativePath);
                    }
                  }}
                >
                  Browse...
                </button>
              </div>
            </label>
            <div className="app-list save-file-list">
              {filteredFiles.map(file => (
                <button
                  key={file.relativePath}
                  className={`app-row${selectedFile === file.relativePath ? ' active' : ''}`}
                  onClick={() => setSelectedFile(file.relativePath)}
                  title={file.relativePath}
                >
                  <span className="app-name">{file.name}</span>
                  <span className="app-id muted">{file.relativePath}</span>
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
          <button className="btn btn-primary" onClick={save} disabled={!canSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
