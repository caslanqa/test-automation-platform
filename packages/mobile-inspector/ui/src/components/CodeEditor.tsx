import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef, useState } from 'react';

import type { ClientMessage, MobileApp, MobileNode } from '../protocol';

interface CodeEditorProps {
  source: string;
  revision: number;
  /** The live accessibility tree, so completion can offer locators that exist on THIS screen. */
  hierarchy: MobileNode[];
  send: (message: ClientMessage) => void;
}

/**
 * The signature shown beside each `MobileApp` method.
 *
 * Typed as a total `Record` over the interface's own keys, so a method added to the facade fails
 * `typecheck:ui` until it is listed here. The list was hand-maintained before and drifted within one release:
 * `doubleTap`, `eraseText`, `hideKeyboard` and `scrollUntilVisible` joined the IR and the editor kept offering
 * completion as though they did not exist — a silence, which is the failure mode §6 exists to prevent.
 */
const MOBILE_APP_SIGNATURES: Record<keyof MobileApp, string> = {
  tap: '(locator)',
  doubleTap: '(locator)',
  fill: '(locator, value)',
  eraseText: '(locator, options?)',
  hideKeyboard: '()',
  longPress: '(locator, options?)',
  swipe: "('up' | 'down' | 'left' | 'right', options?)",
  scroll: "('up' | 'down' | 'left' | 'right', options?)",
  scrollUntilVisible: '(locator, options?)',
  drag: '(from, to)',
  pinch: '(scale, options?)',
  pressKey: "('back' | 'home' | 'enter' | …)",
  back: '()',
  waitFor: '(locator, options?)',
  isVisible: '(locator, options?) → boolean',
  screenshot: '(name?) → path',
};

const MOBILE_APP_METHODS: Completion[] = Object.entries(MOBILE_APP_SIGNATURES).map(
  ([label, detail]) => ({ label, detail, type: 'method' }),
);

/** Completions for `mobileApp.` — the facade the generated test drives. */
function methodCompletions(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/mobileApp\.\w*/);
  if (!before) {
    return null;
  }
  return {
    from: before.from + 'mobileApp.'.length,
    options: MOBILE_APP_METHODS,
    validFor: /\w*/,
  };
}

/**
 * Locator literals for the elements that are on screen right now.
 *
 * This is the one completion a generic TypeScript editor cannot offer and the reason Maestro Studio's editor
 * feels connected to the device: the alternative is reading an id off the tree panel and typing it back in,
 * which is exactly where a typo becomes a locator that silently never matches. Ranked the way the locator
 * engine ranks: accessibility id, then resource id, then text.
 */
function locatorCompletions(
  nodes: MobileNode[],
  context: CompletionContext,
): CompletionResult | null {
  const before = context.matchBefore(/\{[\s\w]*/);
  if (!before) {
    return null;
  }
  return { from: before.from, options: locatorOptions(nodes), validFor: /\{[\s\w]*/ };
}

/** How many locators to offer. A native screen has hundreds of nodes and a menu of hundreds helps nobody. */
const MAX_LOCATOR_OPTIONS = 60;

function locatorOptions(nodes: MobileNode[]): Completion[] {
  const options = new Map<string, Completion>();
  const visit = (node: MobileNode): void => {
    const strategies: [string, string | undefined, number][] = [
      ['accessibilityId', node.accessibilityId, 92],
      ['resourceId', node.resourceId, 80],
      ['text', node.text, 58],
    ];
    for (const [strategy, value, boost] of strategies) {
      if (value) {
        const literal = `{ ${strategy}: ${JSON.stringify(value)} }`;
        options.set(literal, {
          label: literal,
          detail: node.className,
          type: 'variable',
          // The editor's own ordering, matching the locator engine's stability ranking.
          boost: boost - 58,
        });
      }
    }
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return [...options.values()].slice(0, MAX_LOCATOR_OPTIONS);
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
export function CodeEditor({ source, revision, hierarchy, send }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sendRef = useRef(send);
  const revisionRef = useRef(revision);
  /** Read through a ref: the editor is built once, and the tree it should complete from is the current one. */
  const hierarchyRef = useRef(hierarchy);
  hierarchyRef.current = hierarchy;
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
          autocompletion({
            override: [
              methodCompletions,
              context => locatorCompletions(hierarchyRef.current, context),
            ],
          }),
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
