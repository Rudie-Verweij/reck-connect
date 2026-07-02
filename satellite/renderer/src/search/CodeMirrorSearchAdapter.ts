// `CodeMirrorSearchAdapter` — search over a CodeMirror 6 EditorView.
// Mirrors the TTS `CodeMirrorSurfaceAdapter`: a module-scope `StateField`
// holds the match decoration set, driven by `StateEffect`s, installed on
// the live view via `appendConfig`. No DOM mutation — the editor paints
// the marks through its native rendering path. Scroll-to-match uses
// `EditorView.scrollIntoView`.

import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { OffsetRange } from "./matcher";
import type { SearchSurfaceAdapter, SurfaceKind } from "./SearchSurfaceAdapter";

export interface CodeMirrorSearchAdapterOptions {
  container: HTMLElement;
  view: EditorView;
}

interface MatchPayload {
  ranges: readonly OffsetRange[];
  activeIndex: number;
}

const setMatches = StateEffect.define<MatchPayload>();
const clearMatches = StateEffect.define<null>();

const matchMark = Decoration.mark({ class: "cm-reck-search-match" });
const activeMark = Decoration.mark({ class: "cm-reck-search-match-active" });

function buildDecorations(state: EditorState, payload: MatchPayload): DecorationSet {
  const docLen = state.doc.length;
  const decos = [];
  for (let i = 0; i < payload.ranges.length; i++) {
    const r = payload.ranges[i];
    const from = Math.max(0, Math.min(r.start, docLen));
    const to = Math.max(from, Math.min(r.end, docLen));
    if (to <= from) continue;
    decos.push((i === payload.activeIndex ? activeMark : matchMark).range(from, to));
  }
  // `true` → sort the ranges defensively before building the set.
  return Decoration.set(decos, true);
}

const matchField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    let result = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMatches)) result = buildDecorations(tr.state, e.value);
      else if (e.is(clearMatches)) result = Decoration.none;
    }
    return result;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export class CodeMirrorSearchAdapter implements SearchSurfaceAdapter {
  readonly kind: SurfaceKind = "codemirror";

  private readonly container: HTMLElement;
  private readonly view: EditorView;
  private disposed = false;

  constructor(opts: CodeMirrorSearchAdapterOptions) {
    this.container = opts.container;
    this.view = opts.view;
    this.installField();
  }

  getContainerEl(): HTMLElement {
    return this.container;
  }

  getText(): string {
    if (this.disposed || this.isViewDestroyed()) return "";
    return this.view.state.doc.toString();
  }

  highlightMatches(ranges: readonly OffsetRange[], activeIndex: number): void {
    if (this.disposed || this.isViewDestroyed()) return;
    try {
      this.view.dispatch({ effects: setMatches.of({ ranges, activeIndex }) });
    } catch {
      // dispatch can throw if the view was destroyed mid-render; ignore.
    }
  }

  scrollToMatch(range: OffsetRange): void {
    if (this.disposed || this.isViewDestroyed()) return;
    const docLen = this.view.state.doc.length;
    const pos = Math.max(0, Math.min(range.start, docLen));
    try {
      this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    } catch {
      // ignore — view may be tearing down.
    }
  }

  clearHighlights(): void {
    if (this.disposed || this.isViewDestroyed()) return;
    try {
      this.view.dispatch({ effects: clearMatches.of(null) });
    } catch {
      // ignore
    }
  }

  fractionForOffset(offset: number): number | null {
    if (this.disposed || this.isViewDestroyed()) return null;
    try {
      const docLen = this.view.state.doc.length;
      const pos = Math.max(0, Math.min(offset, docLen));
      const block = this.view.lineBlockAt(pos);
      const height = this.view.contentHeight;
      return height > 0 ? Math.max(0, Math.min(1, block.top / height)) : 0;
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.isViewDestroyed()) return;
    try {
      this.view.dispatch({ effects: clearMatches.of(null) });
    } catch {
      // ignore
    }
  }

  /** Test introspection: number of active match decorations. */
  __matchCount(): number {
    const set = this.view.state.field(matchField, false);
    return set ? set.size : 0;
  }

  private installField(): void {
    const ext: Extension = matchField;
    try {
      this.view.dispatch({ effects: StateEffect.appendConfig.of(ext) });
    } catch {
      // view already destroyed — nothing to install.
    }
  }

  private isViewDestroyed(): boolean {
    const v = this.view as unknown as { _state?: EditorState | null };
    return v._state === null;
  }
}
