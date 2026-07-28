import { javascript } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef, useState } from 'react';

import type { ClientMessage } from '../protocol';

interface CodeEditorProps {
  source: string;
  revision: number;
  send: (message: ClientMessage) => void;
}

/**
 * The authoritative test source, backed by a CodeMirror 6 editor (TypeScript syntax highlighting,
 * line numbers, bracket matching, search — all worker-free so it runs under the Electron host's strict
 * `default-src 'none'` CSP on `file://`). User edits are debounced and sent to main as revision-guarded
 * `editCode`; server-generated updates flow back via `source`/`revision` and only overwrite the buffer
 * while the editor isn't focused, so live typing is never clobbered.
 *
 * (Chosen over Monaco, which needs bundled web workers that are brittle under `file://` + strict CSP.)
 */
export function CodeEditor({ source, revision, send }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sendRef = useRef(send);
  const revisionRef = useRef(revision);
  const applyingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  sendRef.current = send;
  revisionRef.current = revision;

  // Create the editor once.
  useEffect(() => {
    if (!hostRef.current) {
      return;
    }
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: source,
        extensions: [
          basicSetup,
          javascript({ typescript: true }),
          oneDark,
          EditorView.updateListener.of(update => {
            if (!update.docChanged || applyingRef.current) {
              return;
            }
            const next = update.state.doc.toString();
            clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => {
              sendRef.current({ type: 'editCode', source: next, revision: revisionRef.current });
            }, 250);
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      clearTimeout(debounceRef.current);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Sync server-pushed source into the buffer when it differs and the editor isn't focused.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const current = view.state.doc.toString();
    if (source === current || view.hasFocus) {
      return;
    }
    applyingRef.current = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: source } });
    applyingRef.current = false;
  }, [source, revision]);

  async function copy(): Promise<void> {
    const text = viewRef.current?.state.doc.toString() ?? '';
    if (text) {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  }

  return (
    <div className="code-editor">
      <div className="panel-title">
        Test source
        <div className="panel-title-actions">
          <span className="muted rev">rev {revision}</span>
          <button className="btn btn-small" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <div ref={hostRef} className="code-cm" />
    </div>
  );
}
