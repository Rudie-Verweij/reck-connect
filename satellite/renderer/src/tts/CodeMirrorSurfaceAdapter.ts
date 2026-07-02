// `CodeMirrorSurfaceAdapter` — speaks the contents of a CodeMirror
// EditorView via the unified TTS controller. Word highlighting uses
// CodeMirror's own `Decoration.mark` system: a `StateField` holds the
// active decoration set, and `StateEffect`s drive set/clear transitions.
// No DOM mutation is needed — the editor view paints the decoration
// using its native rendering path.

import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { SpokenChunk, TtsBoundary, RangeMapEntry } from "./TtsEngine";
import type {
  SpeakSurfaceAdapter,
  SurfaceHighlightTheme,
  SurfaceKind,
  SurfacePoint,
} from "./SpeakSurfaceAdapter";

export interface CodeMirrorSurfaceAdapterOptions {
  /** Where to mount the SpeakControlBar. Typically the wrapper that
   *  contains the CodeMirror view. */
  container: HTMLElement;
  /** The CodeMirror EditorView whose document we speak. */
  view: EditorView;
}

const WORD_REGEX = /\S+/g;

// State effects/field that drive the highlight decoration. Defined at
// module scope so multiple adapter instances share the field shape;
// each instance still owns its own EditorView, so the field's value
// is per-view.
const addHighlight = StateEffect.define<{ from: number; to: number }>();
const clearHighlight = StateEffect.define<null>();

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    let result = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addHighlight)) {
        const { from, to } = e.value;
        const mark = Decoration.mark({ class: "cm-tts-highlight" }).range(from, to);
        result = Decoration.set([mark]);
      } else if (e.is(clearHighlight)) {
        result = Decoration.none;
      }
    }
    return result;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export class CodeMirrorSurfaceAdapter implements SpeakSurfaceAdapter {
  readonly kind: SurfaceKind = "codemirror";

  private readonly container: HTMLElement;
  private readonly view: EditorView;
  private disposed = false;
  private fieldInstalled = false;

  constructor(opts: CodeMirrorSurfaceAdapterOptions) {
    this.container = opts.container;
    this.view = opts.view;
    this.ensureFieldInstalled();
  }

  getContainerEl(): HTMLElement {
    return this.container;
  }

  resolveSpokenChunk(point?: SurfacePoint): SpokenChunk {
    if (this.disposed) return { text: "", rangeMap: [] };
    const fullText = this.view.state.doc.toString();
    if (!fullText) return { text: "", rangeMap: [] };

    // Honour the SurfacePoint so the
    // popup supports "speak from here". When `point` is provided, ask
    // CodeMirror for the doc offset at those viewport coords. The
    // returned chunk is the slice of the doc from that offset (snapped
    // backward to the start of the current word) to the end. Falling
    // back to the full doc is the no-point path — same shape as the
    // pre-fix behaviour, so terminal-style "no mouse position" reads
    // still work.
    let startOffset = 0;
    if (point) {
      const view = this.view as unknown as {
        posAtCoords?: (
          coords: { x: number; y: number },
          precise?: boolean,
        ) => number | null;
      };
      const offset = view.posAtCoords?.({ x: point.pixelX, y: point.pixelY });
      if (typeof offset === "number" && offset >= 0 && offset <= fullText.length) {
        startOffset = snapToWordStart(fullText, offset);
      }
    }

    const text = startOffset === 0 ? fullText : fullText.slice(startOffset);
    const rangeMap: RangeMapEntry[] = [];
    WORD_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_REGEX.exec(text)) !== null) {
      const word = m[0];
      const charStart = m.index;
      const charEnd = charStart + word.length;
      // line/col are unused by the codemirror highlight path (we mark
      // by absolute doc offset). When speak-from-here is active, the
      // highlight needs to address the FULL-DOC offset, not the chunk-
      // relative one, so we add `startOffset` to col.
      rangeMap.push({
        charStart,
        charEnd,
        line: 0,
        col: startOffset + charStart,
        len: word.length,
      });
    }
    return { text, rangeMap };
  }

  highlightBoundary(b: TtsBoundary): void {
    if (this.disposed) return;
    if (this.isViewDestroyed()) return;
    const from = b.col;
    const to = b.col + b.len;
    if (to > this.view.state.doc.length) return;
    try {
      this.view.dispatch({ effects: addHighlight.of({ from, to }) });
    } catch {
      // dispatch can throw if the view was destroyed mid-render; ignore.
    }
  }

  clearHighlight(): void {
    if (this.disposed) return;
    if (this.isViewDestroyed()) return;
    try {
      this.view.dispatch({ effects: clearHighlight.of(null) });
    } catch {
      // see highlightBoundary.
    }
  }

  setTheme(theme: SurfaceHighlightTheme): void {
    if (this.disposed) return;
    if (this.isViewDestroyed()) return;
    // The highlight is a CSS-class decoration (.cm-tts-highlight); drive its
    // colour through a custom property on the editor root so the class can
    // pick it up (with a translucent mix — see styles.css).
    try {
      this.view.dom.style.setProperty(
        "--cm-tts-highlight-bg",
        theme.backgroundColor,
      );
    } catch {
      // view.dom may be unavailable on a destroyed view; ignore.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.isViewDestroyed()) return;
    try {
      this.view.dispatch({ effects: clearHighlight.of(null) });
    } catch {
      // ignore
    }
  }

  private ensureFieldInstalled(): void {
    if (this.fieldInstalled) return;
    // Append the highlight field to the view's config so the
    // decoration set is recognised. Idempotent — if the field is
    // already present (e.g. multiple adapter installs over a single
    // view) the appendConfig is harmless because the field's identity
    // is stable.
    const ext: Extension = highlightField;
    try {
      this.view.dispatch({ effects: StateEffect.appendConfig.of(ext) });
      this.fieldInstalled = true;
    } catch {
      // If the view is already destroyed, give up silently.
    }
  }

  private isViewDestroyed(): boolean {
    // EditorView exposes no public `destroyed` flag; rely on the
    // `state` being unreadable as a proxy. A destroyed view throws
    // when you touch `.state`, but in practice it just returns the
    // last state. We try a defensive cast.
    const v = this.view as unknown as { _state?: EditorState | null };
    return v._state === null;
  }
}

/**
 * Snap an offset BACKWARD to the start of the current word so playback
 * always begins at a word boundary, never mid-syllable. Mirrors the
 * snap in PaneTextResolver. If `offset` is on whitespace, advances
 * FORWARD to the next non-whitespace; if past end of text, returns
 * `text.length`.
 */
function snapToWordStart(text: string, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;
  // Whitespace → walk forward to the next word.
  if (/\s/.test(text[offset])) {
    let i = offset;
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
  }
  // Inside a word → walk backward to the word's start.
  let i = offset;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}
