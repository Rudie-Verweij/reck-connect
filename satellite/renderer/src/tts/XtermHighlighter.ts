import type { TtsBoundary } from "./TtsEngine";
import { computeHighlightRect } from "./highlightGeometry";
import { applyHighlightColors } from "./highlightStyle";
import { relocateWord, type BufferTextLine } from "./wordLocator";

// XtermHighlighter — paints the TTS reading highlight as a DOM overlay whose
// position is RE-FOUND in the live terminal text on every render.
//
// Why not anchor to a buffer line: Claude's TUI runs in mouse-tracking mode
// and repaints cells in place (scrolling the wheel does NOT scroll xterm's
// viewport — viewportY never moves). A highlight pinned to a buffer line ends
// up pointing at whatever the TUI later redrew there. Instead we treat the
// spoken word like a live search: each render we locate the word in the
// current visible buffer and move the overlay to it, disambiguating repeated
// words by reading-order continuity (see wordLocator). When the word isn't
// visible we hide rather than paint a stale box. This tracks the text through
// in-place repaints AND ordinary scrolls, and is renderer-agnostic.

export interface HighlighterDisposable {
  dispose(): void;
}

export interface HighlighterBufferLine {
  translateToString(trimRight?: boolean): string;
}

export interface HighlighterTerminal {
  readonly cols: number;
  readonly rows: number;
  /** xterm root element (`.xterm`); used to derive the overlay parent when
   *  one isn't supplied explicitly. */
  readonly element?: HTMLElement;
  buffer: {
    active: {
      /** Buffer line currently at the top of the viewport. */
      viewportY: number;
      /** Total lines in the buffer (scrollback + viewport). */
      length: number;
      getLine(index: number): HighlighterBufferLine | undefined;
    };
  };
  onRender(listener: () => void): HighlighterDisposable;
  onScroll(listener: () => void): HighlighterDisposable;
  onResize?(listener: () => void): HighlighterDisposable;
}

export interface HighlightTheme {
  backgroundColor: string;
  foregroundColor?: string;
}

export interface CellMetrics {
  width: number;
  height: number;
}

export interface XtermHighlighterOptions {
  /** Element the overlay is appended to — should be the `.xterm-screen` so
   *  (0,0) maps to the top-left of the cell grid. Falls back to deriving it
   *  from `term.element`. */
  overlayParent?: HTMLElement | null;
  /** Live cell metrics in px, re-read on every reposition so resize stays
   *  aligned. Falls back to measuring the overlay parent against cols/rows. */
  measureCell?: () => CellMetrics;
  /** Document used to create the overlay (injectable for tests). */
  doc?: Document;
}

const OVERLAY_CLASS = "reck-tts-highlight";

export class XtermHighlighter {
  private readonly term: HighlighterTerminal;
  private readonly themeFn: () => HighlightTheme;
  private readonly overlayParent: HTMLElement | null;
  private readonly measureCell: () => CellMetrics;
  private readonly doc: Document | null;
  private overlay: HTMLDivElement | null = null;
  private activeBoundary: TtsBoundary | null = null;
  // Last found position — the continuity hint that disambiguates repeated
  // words. Reset between reads so a new read starts from its own snapshot.
  private lastLine: number | null = null;
  private lastCol: number | null = null;
  private subs: HighlighterDisposable[] = [];
  private disposed = false;

  constructor(
    term: HighlighterTerminal,
    themeFn: () => HighlightTheme,
    opts: XtermHighlighterOptions = {},
  ) {
    this.term = term;
    this.themeFn = themeFn;
    this.overlayParent = opts.overlayParent ?? deriveOverlayParent(term);
    this.doc =
      opts.doc ??
      this.overlayParent?.ownerDocument ??
      (typeof document !== "undefined" ? document : null);
    this.measureCell =
      opts.measureCell ?? (() => measureFromParent(this.overlayParent, term));
  }

  highlight(boundary: TtsBoundary): void {
    if (this.disposed) return;
    const prev = this.activeBoundary;
    if (this.lastLine === null) {
      // First word of the read: seed the continuity hint from the snapshot
      // (the freshest guess we have before the TUI repaints).
      this.lastLine = boundary.line;
      this.lastCol = boundary.col;
    } else if (prev) {
      // Advance the hint past the previously-spoken word so the next word —
      // even an identical repeat ("the ... the") — is searched for FORWARD
      // of where we just were, not re-selecting the same occurrence.
      this.lastCol = (this.lastCol ?? 0) + prev.word.length;
    }
    this.activeBoundary = boundary;
    // Subscribe lazily, only while a highlight is live. The adapter that owns
    // this highlighter is created fresh per playback and released via
    // clear()/dispose() — episode-scoped listeners leave nothing behind.
    this.subscribe();
    this.reposition();
  }

  clear(): void {
    if (this.disposed) return;
    this.unsubscribe();
    this.activeBoundary = null;
    this.lastLine = null;
    this.lastCol = null;
    this.removeOverlay();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.activeBoundary = null;
    this.lastLine = null;
    this.lastCol = null;
    this.removeOverlay();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private reposition(): void {
    if (this.disposed) return;
    const boundary = this.activeBoundary;
    if (!boundary) {
      this.hide();
      return;
    }

    const hit = this.locate(boundary.word);
    if (!hit) {
      this.hide();
      return;
    }
    this.lastLine = hit.line;
    this.lastCol = hit.col;

    const cell = this.measureCell();
    const rect = computeHighlightRect({
      markerLine: hit.line,
      viewportY: this.term.buffer.active.viewportY,
      rows: this.term.rows,
      cols: this.term.cols,
      col: hit.col,
      len: boundary.word.length,
      cellWidth: cell.width,
      cellHeight: cell.height,
    });
    if (!rect) {
      this.hide();
      return;
    }

    const el = this.ensureOverlay();
    if (!el) return;
    const theme = this.themeFn();
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    // Shared translucent fill + opaque ring so the terminal highlight looks
    // identical to the markdown / file-viewer surfaces.
    applyHighlightColors(el, theme.backgroundColor);
    if (theme.foregroundColor) el.style.color = theme.foregroundColor;
    el.style.display = "block";
  }

  /** Re-find the word in the current visible buffer, or null if it isn't
   *  on screen. Only the visible rows are searched — an off-screen word can't
   *  be highlighted anyway, and it keeps the per-render cost tiny. */
  private locate(word: string): { line: number; col: number } | null {
    const ba = this.term.buffer.active;
    const top = Math.max(0, ba.viewportY);
    const bottom = Math.min(ba.viewportY + this.term.rows - 1, ba.length - 1);
    const lines: BufferTextLine[] = [];
    for (let i = top; i <= bottom; i++) {
      const text = ba.getLine(i)?.translateToString(true) ?? "";
      lines.push({ line: i, text });
    }
    return relocateWord(
      lines,
      word,
      this.lastLine ?? top,
      this.lastCol ?? 0,
    );
  }

  private ensureOverlay(): HTMLDivElement | null {
    if (this.overlay) return this.overlay;
    if (!this.overlayParent || !this.doc) return null;
    const el = this.doc.createElement("div");
    el.className = OVERLAY_CLASS;
    el.style.position = "absolute";
    el.style.pointerEvents = "none";
    el.style.zIndex = "5";
    el.style.borderRadius = "2px";
    el.style.display = "none";
    this.overlayParent.appendChild(el);
    this.overlay = el;
    return el;
  }

  private hide(): void {
    if (this.overlay) this.overlay.style.display = "none";
  }

  private subscribe(): void {
    if (this.subs.length > 0) return; // already tracking
    // Reposition whenever the terminal repaints: render (in-place TUI redraw
    // or new output), scroll, and resize are the cases where the word moves.
    this.subs.push(this.term.onRender(() => this.reposition()));
    this.subs.push(this.term.onScroll(() => this.reposition()));
    if (this.term.onResize) {
      this.subs.push(this.term.onResize(() => this.reposition()));
    }
  }

  private unsubscribe(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }

  private removeOverlay(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }
}

function deriveOverlayParent(term: HighlighterTerminal): HTMLElement | null {
  const root = term.element;
  if (!root) return null;
  const screen = root.querySelector?.(".xterm-screen") as HTMLElement | null;
  return screen ?? root;
}

function measureFromParent(
  parent: HTMLElement | null,
  term: HighlighterTerminal,
): CellMetrics {
  if (!parent || term.cols <= 0 || term.rows <= 0) {
    return { width: 0, height: 0 };
  }
  return {
    width: parent.clientWidth / term.cols,
    height: parent.clientHeight / term.rows,
  };
}
