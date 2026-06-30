// Pure geometry for the TTS reading highlight.
//
// The highlight is a DOM overlay positioned over the xterm screen grid
// (NOT an xterm decoration — see XtermHighlighter for why). Its on-screen
// position is a pure function of the word's anchored buffer line, the
// current viewport scroll position, and the live cell metrics. Keeping
// the math here (free of any DOM or xterm dependency) makes the
// scroll/resize/off-screen behaviour exhaustively unit-testable.

export interface HighlightRect {
  /** px from the left edge of the screen grid. */
  left: number;
  /** px from the top edge of the screen grid. */
  top: number;
  /** px width of the highlighted span. */
  width: number;
  /** px height (one cell). */
  height: number;
}

export interface HighlightGeometryInput {
  /** Absolute buffer line the word is anchored to (the live `marker.line`).
   *  xterm reports a disposed/evicted marker as a negative line. */
  markerLine: number;
  /** Buffer line currently at the top of the viewport (`buffer.active.viewportY`).
   *  Changes as the user scrolls — this is what makes the highlight track. */
  viewportY: number;
  /** Visible rows in the viewport. */
  rows: number;
  /** Columns in the grid (used to clamp a word that overruns the edge). */
  cols: number;
  /** Start column of the word within its line. */
  col: number;
  /** Word length in cells. */
  len: number;
  /** Live cell width in px. */
  cellWidth: number;
  /** Live cell height in px. */
  cellHeight: number;
}

/**
 * Compute the pixel rect for the highlight, or `null` when it should be
 * hidden (marker disposed, word scrolled out of the viewport, metrics not
 * yet measured, or an empty span).
 */
export function computeHighlightRect(
  i: HighlightGeometryInput,
): HighlightRect | null {
  // Marker evicted from scrollback / disposed.
  if (i.markerLine < 0) return null;
  // Cell metrics not measured yet (e.g. a 0×0 container pre-layout).
  if (i.cellWidth <= 0 || i.cellHeight <= 0) return null;

  // Where the anchored line currently sits on screen. Scrolling up lowers
  // viewportY, so a fixed buffer line moves DOWN the screen — and off the
  // bottom — exactly mirroring the text.
  const screenRow = i.markerLine - i.viewportY;
  if (screenRow < 0 || screenRow >= i.rows) return null;

  // Clamp the horizontal span to the grid so a word that overruns the
  // right edge highlights only the visible cells.
  const startCol = Math.max(0, Math.min(i.col, i.cols));
  const endCol = Math.max(startCol, Math.min(i.col + i.len, i.cols));
  const widthCells = endCol - startCol;
  if (widthCells <= 0) return null;

  return {
    left: startCol * i.cellWidth,
    top: screenRow * i.cellHeight,
    width: widthCells * i.cellWidth,
    height: i.cellHeight,
  };
}
