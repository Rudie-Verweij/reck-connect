// CodeMirror 6 surface for the file viewer.
//
// Mounts a CodeMirror EditorView with extension-based language detection,
// theme adapter (cream / dark via a wrapper data-attribute), and a
// minimal extension set. Read-only by default; the future edit + auto-save
// phase (P4) toggles editability.

import {
  Compartment,
  EditorState,
  StateEffect,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// Round 3 Issue D2 — programmatic content swaps (auto-reload, conflict
// resolution, manual-merge accept) tag their dispatch with this user-event
// annotation. The updateListener checks for it and SKIPS `opts.onChange`
// so the disk-driven write never re-enters the auto-save pipeline. This
// is the renderer-side breaker for the write→watch→reload→onChange→save
// cycle that produced ~50ms popup flicker after the file-viewer shipped.
export const SILENT_LOAD_USER_EVENT = "reck.silent-load";
import {
  LanguageDescription,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";

export interface CodeEditorOptions {
  initialContent: string;
  /**
   * Used for extension-based language detection. We never read the file
   * through this string — it's just for `pickLanguageForPath`.
   */
  filePath: string;
  theme: "light" | "dark";
  parent: HTMLElement;
  /** Default true; pass false to allow user edits (P4). */
  readOnly?: boolean;
  /** Called with each user edit. Optional — used by P4 auto-save. */
  onChange?: (content: string) => void;
}

export interface CodeEditorHandle {
  /** The underlying EditorView. Exposed for the SpeakSurfaceAdapter. */
  view: EditorView;
  /** Current document text. */
  getContent(): string;
  /**
   * Replace the document text wholesale. Bypasses readOnly.
   *
   * `opts.silent` (Round 3 D2): when true the dispatch carries the
   * `reck.silent-load` userEvent annotation and the updateListener
   * suppresses the `onChange` callback for this transaction. Callers
   * use this for disk-driven content swaps (auto-reload, conflict
   * Force-theirs, manual-merge accept) so they don't re-trigger the
   * auto-save pipeline and recurse into a reload loop.
   */
  setContent(content: string, opts?: { silent?: boolean }): void;
  /**
   * Round 5 Phase W — flip CodeMirror's readOnly state at runtime
   * without rebuilding the editor. Used by the lock toggle. Wraps
   * `EditorState.readOnly.of(...)` + `EditorView.editable.of(...)` in
   * a Compartment so the dispatch is a single reconfigure transaction.
   */
  setReadOnly(readOnly: boolean): void;
  /** Tear down the editor and remove its DOM. */
  dispose(): void;
}

/**
 * Resolve a `LanguageDescription` for a file path by matching its extension
 * against the `@codemirror/language-data` registry. Returns null when the
 * extension isn't recognised. The caller awaits `desc.load()` to fetch the
 * actual parser at first use.
 */
export function pickLanguageForPath(filePath: string): LanguageDescription | null {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  const ext = extensionOf(filePath);
  if (!ext) return null;
  // language-data exposes `extensions: string[]` per descriptor.
  for (const lang of languages) {
    if (lang.extensions.includes(ext)) return lang;
  }
  return null;
}

function extensionOf(filePath: string): string {
  const i = filePath.lastIndexOf(".");
  if (i <= 0 || i === filePath.length - 1) return "";
  return filePath.slice(i + 1);
}

export function mountCodeEditor(opts: CodeEditorOptions): CodeEditorHandle {
  const wrapper = document.createElement("div");
  wrapper.className = "file-viewer-code-editor";
  wrapper.setAttribute("data-theme", opts.theme);
  opts.parent.appendChild(wrapper);

  // Round 5 Phase W — wrap readOnly state in a Compartment so the
  // lock toggle can flip it without rebuilding the editor. Compartment
  // is CodeMirror 6's mechanism for swappable extensions: dispatch a
  // reconfigure effect to replace the wrapped extensions.
  const readOnlyCompartment = new Compartment();
  const initialReadOnly = opts.readOnly !== false;
  const readOnlyExtension = (ro: boolean): Extension => [
    EditorView.editable.of(!ro),
    EditorState.readOnly.of(ro),
  ];
  const extensions: Extension[] = [
    readOnlyCompartment.of(readOnlyExtension(initialReadOnly)),
    syntaxHighlighting(defaultHighlightStyle),
    EditorView.lineWrapping,
  ];
  if (opts.onChange) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        // Round 3 D2 — suppress onChange for programmatic silent loads.
        // CodeMirror exposes the userEvent annotation per-transaction;
        // any transaction in this batch tagged as silent-load means the
        // change came from a disk-driven swap, not the user.
        const isSilent = update.transactions.some((tr) =>
          tr.isUserEvent(SILENT_LOAD_USER_EVENT),
        );
        if (isSilent) return;
        opts.onChange!(update.state.doc.toString());
      }),
    );
  }

  const state = EditorState.create({
    doc: opts.initialContent,
    extensions,
  });
  const view = new EditorView({ state, parent: wrapper });

  // Lazy-load the language grammar — first-use cost, not on-mount.
  const lang = pickLanguageForPath(opts.filePath);
  if (lang) {
    void lang
      .load()
      .then((support) => {
        view.dispatch({
          effects: StateEffect.appendConfig.of([support]),
        });
      })
      .catch(() => {
        // Grammar load failure → fall through to no highlighting.
      });
  }

  return {
    view,
    getContent: () => view.state.doc.toString(),
    setContent: (content: string, setOpts?: { silent?: boolean }) => {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: content,
        },
        annotations: setOpts?.silent
          ? [Transaction.userEvent.of(SILENT_LOAD_USER_EVENT)]
          : undefined,
      });
    },
    setReadOnly: (readOnly: boolean) => {
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(
          readOnlyExtension(readOnly),
        ),
      });
    },
    dispose: () => {
      view.destroy();
      wrapper.remove();
    },
  };
}
