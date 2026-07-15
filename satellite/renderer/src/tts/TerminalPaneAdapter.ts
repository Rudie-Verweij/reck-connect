// `TerminalPaneAdapter` — wraps an xterm-backed TerminalPane behind the
// SpeakSurfaceAdapter contract. It uses PaneTextResolver for chunk
// resolution, XtermHighlighter for per-word decoration. The adapter
// keeps a single XtermHighlighter alive across boundary events and
// disposes it together with the adapter.

import {
  pixelToCell,
  resolveSpokenChunk,
  resolveUpcomingChunk,
} from "./PaneTextResolver";
import type { ResolverTerminal } from "./PaneTextResolver";
import {
  XtermHighlighter,
  type HighlighterTerminal,
  type HighlightTheme,
} from "./XtermHighlighter";
import type { SpokenChunk, TtsBoundary } from "./TtsEngine";
import type {
  SpeakSurfaceAdapter,
  SurfaceKind,
  SurfacePoint,
} from "./SpeakSurfaceAdapter";

export interface TerminalPaneAdapterOptions {
  /** Underlying xterm Terminal instance (the same object satisfies both
   *  the resolver and highlighter contracts; we type-narrow inside). */
  term: ResolverTerminal & HighlighterTerminal;
  /** The xterm container — `term.element` when available, the wrapper
   *  otherwise. Used for pixel→cell math. */
  xtermEl: HTMLElement;
  /** The pane wrapper (`.pane-terminal` or popout body). Used as the
   *  control bar's mount parent. */
  containerEl: HTMLElement;
  /** Cell metrics from xterm's render service — pixel-to-cell math
   *  depends on these. */
  cellWidth: number;
  cellHeight: number;
  /** Highlight theme. Updated dynamically by re-binding via setTheme. */
  theme?: HighlightTheme;
  /** Debounce (ms) for content-change notifications used to re-resolve the
   *  upcoming words mid-playback. Coalesces bursts of TUI repaints. Default
   *  CONTENT_CHANGE_DEBOUNCE_MS; tests set 0 for synchronous behaviour. */
  contentChangeDebounceMs?: number;
}

/** Default debounce for scroll/render → re-resolve. */
const CONTENT_CHANGE_DEBOUNCE_MS = 150;

export class TerminalPaneAdapter implements SpeakSurfaceAdapter {
  readonly kind: SurfaceKind = "terminal";

  private readonly term: ResolverTerminal & HighlighterTerminal;
  private readonly xtermEl: HTMLElement;
  private readonly containerEl: HTMLElement;
  private readonly cellWidth: number;
  private readonly cellHeight: number;
  private theme: HighlightTheme;
  private highlighter: XtermHighlighter | null;
  private disposed = false;
  private readonly contentChangeDebounceMs: number;
  // Whether the active read came from a selection. Selection reads have
  // user-chosen boundaries, so they are NEVER re-resolved on scroll.
  private lastReadWasSelection = false;

  constructor(opts: TerminalPaneAdapterOptions) {
    this.term = opts.term;
    this.xtermEl = opts.xtermEl;
    this.containerEl = opts.containerEl;
    this.cellWidth = opts.cellWidth;
    this.cellHeight = opts.cellHeight;
    this.contentChangeDebounceMs =
      opts.contentChangeDebounceMs ?? CONTENT_CHANGE_DEBOUNCE_MS;
    this.theme = opts.theme ?? { backgroundColor: "rgba(255,255,0,0.6)" };
    // Anchor the highlight overlay to the xterm screen grid so (0,0) maps to
    // the top-left cell. Measure cell metrics LIVE on each reposition (off
    // xterm's render service, which updates on resize) so the highlight
    // stays aligned when the window changes size; fall back to the metrics
    // captured at construction.
    const overlayParent =
      (this.xtermEl.querySelector?.(".xterm-screen") as HTMLElement | null) ??
      this.xtermEl;
    this.highlighter = new XtermHighlighter(this.term, () => this.theme, {
      overlayParent,
      measureCell: () => this.measureCell(),
    });
  }

  private measureCell(): { width: number; height: number } {
    const dims = (
      this.term as unknown as {
        _core?: {
          _renderService?: {
            dimensions?: {
              css?: { cell?: { width?: number; height?: number } };
              actualCellWidth?: number;
              actualCellHeight?: number;
            };
          };
        };
      }
    )._core?._renderService?.dimensions;
    const width = dims?.css?.cell?.width ?? dims?.actualCellWidth ?? this.cellWidth;
    const height =
      dims?.css?.cell?.height ?? dims?.actualCellHeight ?? this.cellHeight;
    return { width, height };
  }

  getContainerEl(): HTMLElement {
    return this.containerEl;
  }

  setTheme(theme: HighlightTheme): void {
    this.theme = theme;
  }

  resolveSpokenChunk(point?: SurfacePoint): SpokenChunk {
    // Selection always wins.
    const sel = this.term.getSelection();
    if (sel && sel.length > 0) {
      this.lastReadWasSelection = true;
      return resolveSpokenChunk(this.term);
    }
    this.lastReadWasSelection = false;
    if (!point) return { text: "", rangeMap: [] };
    const rect = this.xtermEl.getBoundingClientRect();
    const cell = pixelToCell({
      pixelX: point.pixelX,
      pixelY: point.pixelY,
      containerLeft: rect.left,
      containerTop: rect.top,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      viewportTopLine: this.term.buffer.active.viewportY,
      cols: this.term.cols,
      rows: this.term.rows,
    });
    // In a full-screen TUI (alt-screen), strip the pinned status/input block
    // from the very first read so a later status-only repaint leaves the
    // upcoming tail identical → no swap, no gap.
    return resolveSpokenChunk(this.term, cell, {
      excludeStatusLine: this.isAltScreen(),
    });
  }

  /** Re-resolve the visible screen (minus the status line) for a live swap, or
   *  null when re-resolution must not happen: a selection read (fixed
   *  boundaries) or a non-alt-screen pane (no pinned status line; scrollback
   *  keeps its fixed clicked-point scope). */
  resolveUpcomingChunk(): SpokenChunk | null {
    if (this.disposed) return null;
    if (this.lastReadWasSelection || !this.isAltScreen()) return null;
    return resolveUpcomingChunk(this.term, { excludeStatusLine: true });
  }

  /** Notify (debounced) when the visible content may have changed — a TUI
   *  repaints in place (onRender) or the viewport scrolls (onScroll). Mirrors
   *  XtermHighlighter's subscription set. Returns an unsubscribe fn. */
  onContentChange(cb: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = (): void => {
      if (this.disposed) return;
      if (this.contentChangeDebounceMs <= 0) {
        cb();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        cb();
      }, this.contentChangeDebounceMs);
    };
    const subs = [
      this.term.onRender(fire),
      this.term.onScroll(fire),
    ];
    if (this.term.onResize) subs.push(this.term.onResize(fire));
    return () => {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const s of subs) s.dispose();
    };
  }

  private isAltScreen(): boolean {
    return this.term.buffer.active.type === "alternate";
  }

  highlightBoundary(b: TtsBoundary): void {
    if (this.disposed) return;
    this.highlighter?.highlight(b);
  }

  clearHighlight(): void {
    if (this.disposed) return;
    this.highlighter?.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.highlighter?.dispose();
    this.highlighter = null;
  }

  // Test introspection — surfaces the live highlighted boundary so tests can
  // assert boundary→highlight forwarding through the real adapter. The
  // overlay highlighter tracks a single active highlight (not a history), so
  // this returns the one live boundary or nothing.
  __highlights(): TtsBoundary[] {
    const b = (
      this.highlighter as unknown as { activeBoundary?: TtsBoundary | null }
    )?.activeBoundary;
    return b ? [b] : [];
  }
}
