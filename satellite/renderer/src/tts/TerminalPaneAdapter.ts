// `TerminalPaneAdapter` — wraps an xterm-backed TerminalPane behind the
// SpeakSurfaceAdapter contract. It uses PaneTextResolver for chunk
// resolution, XtermHighlighter for per-word decoration. The adapter
// keeps a single XtermHighlighter alive across boundary events and
// disposes it together with the adapter.

import { pixelToCell, resolveSpokenChunk } from "./PaneTextResolver";
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
}

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

  constructor(opts: TerminalPaneAdapterOptions) {
    this.term = opts.term;
    this.xtermEl = opts.xtermEl;
    this.containerEl = opts.containerEl;
    this.cellWidth = opts.cellWidth;
    this.cellHeight = opts.cellHeight;
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
      return resolveSpokenChunk(this.term);
    }
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
    return resolveSpokenChunk(this.term, cell);
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
