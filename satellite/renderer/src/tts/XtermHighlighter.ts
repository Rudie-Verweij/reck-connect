import type { TtsBoundary } from "./TtsEngine";

export interface HighlighterMarker {
  dispose(): void;
}

export interface HighlighterDecoration {
  dispose(): void;
}

export interface HighlighterTerminal {
  buffer: { active: { baseY: number; cursorY: number } };
  registerMarker(cursorYOffset?: number): HighlighterMarker | undefined;
  registerDecoration(opts: {
    marker: HighlighterMarker;
    x?: number;
    width?: number;
    backgroundColor?: string;
    foregroundColor?: string;
    layer?: "bottom" | "top";
  }): HighlighterDecoration | undefined;
}

export interface HighlightTheme {
  backgroundColor: string;
  foregroundColor?: string;
}

export class XtermHighlighter {
  private term: HighlighterTerminal;
  private themeFn: () => HighlightTheme;
  private activeMarker: HighlighterMarker | null = null;
  private activeDecoration: HighlighterDecoration | null = null;
  private disposed = false;

  constructor(term: HighlighterTerminal, themeFn: () => HighlightTheme) {
    this.term = term;
    this.themeFn = themeFn;
  }

  highlight(boundary: TtsBoundary): void {
    if (this.disposed) return;
    this.disposeActive();

    const cursorAbs =
      this.term.buffer.active.baseY + this.term.buffer.active.cursorY;
    const cursorYOffset = boundary.line - cursorAbs;
    const marker = this.term.registerMarker(cursorYOffset);
    if (!marker) return;

    const theme = this.themeFn();
    const decoration = this.term.registerDecoration({
      marker,
      x: boundary.col,
      width: boundary.len,
      backgroundColor: theme.backgroundColor,
      foregroundColor: theme.foregroundColor,
      // "bottom" paints the highlight UNDER the cell text, so the word
      // being spoken renders crisply on top of a coloured backdrop —
      // like a marker highlight. "top" overlays the colour ABOVE the
      // text and washes it out (the failure mode users reported).
      layer: "bottom",
    });

    if (!decoration) {
      marker.dispose();
      return;
    }

    this.activeMarker = marker;
    this.activeDecoration = decoration;
  }

  clear(): void {
    if (this.disposed) return;
    this.disposeActive();
  }

  dispose(): void {
    this.disposeActive();
    this.disposed = true;
  }

  private disposeActive(): void {
    if (this.activeDecoration) {
      this.activeDecoration.dispose();
      this.activeDecoration = null;
    }
    if (this.activeMarker) {
      this.activeMarker.dispose();
      this.activeMarker = null;
    }
  }
}
