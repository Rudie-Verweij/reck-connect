// `TerminalSearchAdapter` — search over an xterm.js terminal. It reads the
// whole `buffer.active`, so a plain shell's full scrollback is searchable; a
// full-screen mouse-tracking TUI (Claude Code, less, vim) keeps NO scrollback
// (it repaints the visible screen in place), so there only what's on screen
// is searchable — there is no off-screen text to find anywhere.
// Matches are painted as a DOM overlay over `.xterm-screen`
// whose position is RE-DERIVED from the live viewport on every render —
// exactly like the TTS `XtermHighlighter` (and reusing its pure
// `computeHighlightRect`). This is what makes the highlight stay wrapped
// around the text as the user scrolls or the TUI repaints in place, rather
// than detaching (the failure mode of buffer-line-anchored xterm
// decorations under Claude's mouse-tracking TUI, where `viewportY` never
// moves and cells are redrawn in place).
//
// Text model: each PHYSICAL buffer row is one line in the flat search text,
// joined with "\n". A flat match offset maps to (row, col) via a cached
// per-row offset index. Single-line queries never cross a row boundary, so
// every match resolves to one (row, col, len). On every reposition we
// re-validate that the cell still holds the matched text, so a stale match
// (whose text the TUI overwrote) hides instead of painting on the wrong word.

import type { OffsetRange } from "./matcher";
import type { SearchSurfaceAdapter, SurfaceKind } from "./SearchSurfaceAdapter";
import { computeHighlightRect } from "../tts/highlightGeometry";

export interface SearchableBufferLine {
  translateToString(trimRight?: boolean): string;
}

export interface SearchableDisposable {
  dispose(): void;
}

export interface SearchableTerminal {
  readonly rows: number;
  readonly cols: number;
  /** xterm root element (`.xterm`); the overlay parent (`.xterm-screen`) is
   *  derived from it when one isn't supplied explicitly. */
  readonly element?: HTMLElement;
  buffer: {
    active: {
      /** Max scroll-top (scrollback size) — clamps scroll-to-match. */
      baseY: number;
      /** Buffer line currently at the top of the viewport. Drives the
       *  highlight's vertical tracking: `screenRow = row - viewportY`. */
      viewportY: number;
      /** Total lines in the buffer (scrollback + viewport). */
      length: number;
      getLine(y: number): SearchableBufferLine | undefined;
    };
  };
  scrollToLine(line: number): void;
  /** Fires on every repaint (new output, in-place TUI redraw, scroll). */
  onRender(cb: () => void): SearchableDisposable;
  onScroll(cb: () => void): SearchableDisposable;
  onResize?(cb: () => void): SearchableDisposable;
}

export interface CellMetrics {
  width: number;
  height: number;
}

export interface TerminalSearchAdapterOptions {
  container: HTMLElement;
  term: SearchableTerminal;
  /** Background colour (any CSS colour) for non-active matches. */
  matchColor?: string;
  /** Background colour for the active match — brighter, to stand out. */
  activeColor?: string;
  /** Element the match overlay mounts into; should be `.xterm-screen` so
   *  (0,0) maps to the top-left cell. Falls back to deriving it from
   *  `term.element`. Pass `null` to disable the overlay (no DOM). */
  overlayParent?: HTMLElement | null;
  /** Live cell metrics in px, re-read on every reposition so resize stays
   *  aligned. Falls back to measuring the overlay parent against cols/rows. */
  measureCell?: () => CellMetrics;
  /** Document used to create overlay nodes (injectable for tests). */
  doc?: Document;
}

interface RowSpan {
  row: number;
  start: number;
  end: number; // exclusive of the trailing "\n"
}

/** One match resolved to buffer coordinates + the text it matched. The text
 *  is the re-validation key: on reposition we only paint a rect if the cell
 *  still holds it. */
interface PaintedMatch {
  row: number;
  col: number;
  text: string;
  active: boolean;
}

// Cap the painted rects so a query that matches thousands of cells across a
// 5000-line scrollback can't stall the renderer. The active match is always
// included; navigation (next/prev) + the scrollbar ticks cover the rest.
const MAX_MATCH_RECTS = 1000;

// Reck orange, translucent so the cell text reads through the tint. The
// active match is the brighter "glow" tone — these are the colour parameters
// (overridable via options, mirroring the TTS highlight colour setup).
const DEFAULT_MATCH_COLOR = "rgba(212, 104, 58, 0.30)"; // --claude-orange
const DEFAULT_ACTIVE_COLOR = "rgba(232, 135, 92, 0.65)"; // --claude-orange-glow

const OVERLAY_CLASS = "reck-search-overlay";
const RECT_CLASS = "reck-search-match-rect";

export class TerminalSearchAdapter implements SearchSurfaceAdapter {
  readonly kind: SurfaceKind = "terminal";

  private readonly container: HTMLElement;
  private readonly term: SearchableTerminal;
  private readonly matchColor: string;
  private readonly activeColor: string;
  private readonly overlayParent: HTMLElement | null;
  private readonly measureCell: () => CellMetrics;
  private readonly doc: Document | null;
  private disposed = false;

  private rowSpans: RowSpan[] = [];
  private lastText = "";
  private paintedMatches: PaintedMatch[] = [];
  private overlay: HTMLDivElement | null = null;
  private rects: HTMLDivElement[] = [];
  private subs: SearchableDisposable[] = [];

  constructor(opts: TerminalSearchAdapterOptions) {
    this.container = opts.container;
    this.term = opts.term;
    this.matchColor = opts.matchColor ?? DEFAULT_MATCH_COLOR;
    this.activeColor = opts.activeColor ?? DEFAULT_ACTIVE_COLOR;
    this.overlayParent =
      opts.overlayParent !== undefined
        ? opts.overlayParent
        : deriveOverlayParent(opts.term);
    this.doc =
      opts.doc ??
      this.overlayParent?.ownerDocument ??
      (typeof document !== "undefined" ? document : null);
    this.measureCell =
      opts.measureCell ?? (() => measureFromParent(this.overlayParent, opts.term));
  }

  getContainerEl(): HTMLElement {
    return this.container;
  }

  getText(): string {
    if (this.disposed) return "";
    const parts: string[] = [];
    this.rowSpans = [];
    let cursor = 0;
    const len = this.term.buffer.active.length;
    for (let y = 0; y < len; y++) {
      const line = this.term.buffer.active.getLine(y);
      const text = line ? line.translateToString(true) : "";
      const start = cursor;
      parts.push(text);
      this.rowSpans.push({ row: y, start, end: start + text.length });
      cursor += text.length;
      if (y < len - 1) {
        parts.push("\n");
        cursor += 1;
      }
    }
    this.lastText = parts.join("");
    return this.lastText;
  }

  highlightMatches(ranges: readonly OffsetRange[], activeIndex: number): void {
    if (this.disposed) return;
    if (this.rowSpans.length === 0) this.getText();

    // Resolve each match to buffer coords + the text it matched (the
    // re-validation key). Respect the cap but never drop the active match.
    const limit = Math.min(ranges.length, MAX_MATCH_RECTS);
    const painted: PaintedMatch[] = [];
    for (let i = 0; i < ranges.length; i++) {
      if (i >= limit && i !== activeIndex) continue;
      const loc = this.locate(ranges[i].start);
      if (!loc) continue;
      const text = this.lastText.slice(ranges[i].start, ranges[i].end);
      if (!text) continue;
      painted.push({ row: loc.row, col: loc.col, text, active: i === activeIndex });
    }
    this.paintedMatches = painted;

    // Subscribe lazily, only while a highlight is live (mirrors the TTS
    // XtermHighlighter): render / scroll / resize are when the word moves.
    this.subscribe();
    this.reposition();
  }

  scrollToMatch(range: OffsetRange): void {
    if (this.disposed) return;
    if (this.rowSpans.length === 0) this.getText();
    const loc = this.locate(range.start);
    if (!loc) return;
    const top = loc.row - Math.floor(this.term.rows / 2);
    const maxTop = this.term.buffer.active.baseY;
    this.term.scrollToLine(Math.max(0, Math.min(top, maxTop)));
  }

  clearHighlights(): void {
    if (this.disposed) return;
    this.unsubscribe();
    this.paintedMatches = [];
    this.removeOverlay();
  }

  fractionForOffset(offset: number): number | null {
    if (this.disposed) return null;
    if (this.rowSpans.length === 0) this.getText();
    const loc = this.locate(offset);
    if (!loc) return null;
    const len = this.term.buffer.active.length;
    return len > 0 ? loc.row / len : 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.unsubscribe();
    this.removeOverlay();
    this.disposed = true;
    this.rowSpans = [];
    this.paintedMatches = [];
    this.lastText = "";
  }

  // ── Internals ─────────────────────────────────────────────────────

  /** Re-derive every visible match rect from the live viewport. Called on
   *  highlight and on every render/scroll/resize. */
  private reposition(): void {
    if (this.disposed) return;
    const overlay = this.ensureOverlay();
    if (!overlay) return;

    const cell = this.measureCell();
    const viewportY = this.term.buffer.active.viewportY;
    const rows = this.term.rows;
    const cols = this.term.cols;

    let r = 0;
    for (const m of this.paintedMatches) {
      // Guard against in-place TUI repaints: only paint if the cell STILL
      // holds the matched text, otherwise the offset is stale and we'd
      // highlight whatever was redrawn there.
      const line =
        this.term.buffer.active.getLine(m.row)?.translateToString(true) ?? "";
      if (line.slice(m.col, m.col + m.text.length) !== m.text) continue;

      const rect = computeHighlightRect({
        markerLine: m.row,
        viewportY,
        rows,
        cols,
        col: m.col,
        len: m.text.length,
        cellWidth: cell.width,
        cellHeight: cell.height,
      });
      if (!rect) continue;

      const el = this.ensureRect(r++);
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      el.style.backgroundColor = m.active ? this.activeColor : this.matchColor;
      el.style.display = "block";
    }
    // Hide any pooled rects we didn't use this pass.
    for (; r < this.rects.length; r++) this.rects[r].style.display = "none";
  }

  private locate(offset: number): { row: number; col: number } | null {
    // Binary search for the row span whose start is the greatest <= offset.
    let lo = 0;
    let hi = this.rowSpans.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.rowSpans[mid].start <= offset) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans < 0) return null;
    const span = this.rowSpans[ans];
    if (offset > span.end) return null; // fell into the synthetic "\n" gap
    return { row: span.row, col: offset - span.start };
  }

  private ensureOverlay(): HTMLDivElement | null {
    if (this.overlay) return this.overlay;
    if (!this.overlayParent || !this.doc) return null;
    const el = this.doc.createElement("div");
    el.className = OVERLAY_CLASS;
    el.style.position = "absolute";
    el.style.left = "0";
    el.style.top = "0";
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.pointerEvents = "none";
    el.style.overflow = "hidden";
    // Match the TTS highlight overlay's layer (proven to paint above the
    // WebGL text canvas in `.xterm-screen`). Translucent rects let the cell
    // text read through.
    el.style.zIndex = "5";
    this.overlayParent.appendChild(el);
    this.overlay = el;
    return el;
  }

  private ensureRect(i: number): HTMLDivElement {
    let el = this.rects[i];
    if (!el) {
      // ensureOverlay() ran first, so this.overlay + this.doc are set.
      el = this.doc!.createElement("div");
      el.className = RECT_CLASS;
      el.style.position = "absolute";
      el.style.pointerEvents = "none";
      el.style.borderRadius = "2px";
      this.overlay!.appendChild(el);
      this.rects[i] = el;
    }
    return el;
  }

  private subscribe(): void {
    if (this.subs.length > 0) return; // already tracking
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
    this.rects = [];
  }
}

function deriveOverlayParent(term: SearchableTerminal): HTMLElement | null {
  const root = term.element;
  if (!root) return null;
  const screen = root.querySelector?.(".xterm-screen") as HTMLElement | null;
  return screen ?? root;
}

function measureFromParent(
  parent: HTMLElement | null,
  term: SearchableTerminal,
): CellMetrics {
  if (!parent || term.cols <= 0 || term.rows <= 0) {
    return { width: 0, height: 0 };
  }
  return {
    width: parent.clientWidth / term.cols,
    height: parent.clientHeight / term.rows,
  };
}
