import type { RangeMapEntry, SpokenChunk } from "./TtsEngine";

export interface BufferLine {
  absoluteLine: number;
  text: string;
}

export interface CellPoint {
  line: number;
  col: number;
}

export interface PixelToCellInput {
  pixelX: number;
  pixelY: number;
  containerLeft: number;
  containerTop: number;
  cellWidth: number;
  cellHeight: number;
  viewportTopLine: number;
  cols: number;
  rows: number;
}

export interface ResolverTerminal {
  cols: number;
  rows: number;
  getSelection(): string;
  getSelectionPosition(): {
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | undefined;
  buffer: {
    active: {
      length: number;
      viewportY: number;
      baseY: number;
      cursorY: number;
      /** xterm buffer type — "alternate" is a full-screen TUI (Claude/Codex).
       *  Optional so pure-resolver tests need not supply it; the adapter reads
       *  it to gate status-line stripping + scroll re-resolution. */
      type?: "normal" | "alternate";
      getLine(idx: number):
        | {
            length: number;
            translateToString(
              trimRight?: boolean,
              startColumn?: number,
              endColumn?: number,
            ): string;
          }
        | undefined;
    };
  };
}

const WORD_REGEX = /\S+/g;

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// ── Status-line detection (alt-screen TUIs) ─────────────────────────
//
// A full-screen TUI (Claude Code, Codex, …) pins a status/input block to the
// bottom of the screen. When we read "from the clicked cell to the end of the
// buffer" that block gets spoken as if it were content. We detect and exclude
// it. App-agnostic: we key off the box-drawing/rule border that virtually
// every such input box draws, bounded to the bottom few rows so a misdetection
// can never eat more than `maxRows` of real content.
//
// Iteration note: a temporal heuristic (bottom rows that don't change between
// renders are chrome) and per-app profiles would make this more robust; the
// pure border+cursor rule below is enough for v1 and is unit-testable.

/** Default cap on how many bottom rows the status block may span. */
export const STATUS_LINE_MAX_ROWS = 6;

/** Fraction of a row's non-space glyphs that must be border characters for
 *  the row to count as a border/rule line. */
const BORDER_RATIO = 0.6;

// Box-drawing (U+2500–257F), block elements (U+2580–259F), and the ASCII rule
// characters used for separators. A single char is tested, so no /g state.
const BORDER_CHAR = /[─-╿▀-▟=_-]/;

/**
 * True when `text`, ignoring surrounding whitespace, is mostly border/rule
 * glyphs — the top or bottom edge of a TUI input box (`╭────╮`, `╰────╯`), a
 * horizontal rule (`──────`, `------`, `======`). A prose line with the odd
 * hyphen stays well under the ratio and is not flagged.
 */
export function isBorderRow(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  let nonSpace = 0;
  let border = 0;
  for (const ch of trimmed) {
    if (/\s/.test(ch)) continue;
    nonSpace += 1;
    if (BORDER_CHAR.test(ch)) border += 1;
  }
  if (nonSpace === 0) return false;
  return border / nonSpace >= BORDER_RATIO;
}

/**
 * Identify the pinned bottom status block within `lines` (a contiguous,
 * absolute-indexed run ending at the bottom of the screen), or null if none is
 * found. Returns the inclusive absolute-line range to exclude from speech.
 *
 * Strategy (bounded to the bottom `maxRows`):
 *  1. The topmost border row in the window → the top edge of the input box;
 *     strip from there to the bottom (captures the box body + any hint rows
 *     below it).
 *  2. Fallback: if the cursor sits in the window and no border was found,
 *     strip the cursor's contiguous non-blank block down to the bottom.
 *  3. Otherwise null (strip nothing — never eat content on a guess).
 */
export function detectStatusLineRange(
  lines: ReadonlyArray<BufferLine>,
  cursorAbsLine: number,
  opts?: { maxRows?: number },
): { startLine: number; endLine: number } | null {
  if (lines.length === 0) return null;
  const maxRows = opts?.maxRows ?? STATUS_LINE_MAX_ROWS;
  const bottomIdx = lines.length - 1;
  const bottomLine = lines[bottomIdx].absoluteLine;
  const topLine = lines[0].absoluteLine;
  const windowStartIdx = Math.max(0, lines.length - maxRows);

  // A status block is pinned to the BOTTOM and always has content above it.
  // A candidate that starts at the very first provided line would strip
  // everything — that's never a status line, so we refuse it (speak normally).
  const rangeFrom = (
    startLine: number,
  ): { startLine: number; endLine: number } | null =>
    startLine <= topLine ? null : { startLine, endLine: bottomLine };

  // (1) topmost border row in the bottom window.
  for (let i = windowStartIdx; i <= bottomIdx; i++) {
    if (isBorderRow(lines[i].text)) {
      return rangeFrom(lines[i].absoluteLine);
    }
  }

  // (2) cursor fallback — cursor parked in the bottom window with no border.
  const windowStartLine = lines[windowStartIdx].absoluteLine;
  if (cursorAbsLine >= windowStartLine && cursorAbsLine <= bottomLine) {
    // Walk up from the cursor's row while rows are non-blank (its block top),
    // not above the window.
    let startIdx = bottomIdx;
    for (let i = bottomIdx; i >= windowStartIdx; i--) {
      if (lines[i].absoluteLine > cursorAbsLine) continue;
      if (lines[i].text.trim() === "") break;
      startIdx = i;
    }
    return rangeFrom(lines[startIdx].absoluteLine);
  }

  return null;
}

/** Drop lines whose absolute index falls inside `range` (inclusive). */
function excludeLineRange(
  lines: ReadonlyArray<BufferLine>,
  range: { startLine: number; endLine: number } | null,
): BufferLine[] {
  if (!range) return lines.slice();
  return lines.filter(
    (bl) => bl.absoluteLine < range.startLine || bl.absoluteLine > range.endLine,
  );
}

/**
 * Snap a column index to the start of a word so speech reads full
 * words rather than starting mid-syllable.
 *
 *  - On a non-whitespace char  → walk BACKWARD to the start of the
 *                                 current word (the char after the
 *                                 nearest preceding whitespace, or 0).
 *  - On whitespace             → walk FORWARD to the start of the
 *                                 next word (the next non-whitespace
 *                                 char). If no next word exists on
 *                                 this line, returns the index of the
 *                                 first absent char (caller decides
 *                                 whether to advance lines).
 *
 * Examples on `"alpha beta gamma"`:
 *   col 2  → 0   (mid "alpha"; back to start of "alpha")
 *   col 5  → 6   (the space; forward to start of "beta")
 *   col 12 → 11  (mid "gamma"; back to start of "gamma")
 *
 * Punctuation that touches a word counts as part of the word, since
 * \S matches any non-whitespace.
 */
export function snapColToWordStart(text: string, col: number): number {
  if (col < 0) col = 0;
  // Already past the end of the line — nothing to snap to. The caller
  // (resolver) will move on to the next line.
  if (col >= text.length) return col;

  // On whitespace → advance forward to next non-whitespace.
  while (col < text.length && /\s/.test(text[col])) {
    col++;
  }
  // Hit end of line while skipping whitespace — return that index;
  // the caller falls through to subsequent lines.
  if (col >= text.length) return col;

  // Now on non-whitespace. Walk back to the start of the word (the
  // char after the nearest preceding whitespace, or 0).
  while (col > 0 && !/\s/.test(text[col - 1])) {
    col--;
  }
  return col;
}

export function pixelToCell(input: PixelToCellInput): CellPoint {
  const relX = input.pixelX - input.containerLeft;
  const relY = input.pixelY - input.containerTop;
  const rawCol = Math.floor(relX / input.cellWidth);
  const rawRow = Math.floor(relY / input.cellHeight);
  const col = clamp(rawCol, 0, input.cols - 1);
  const viewportRow = clamp(rawRow, 0, input.rows - 1);
  return {
    line: input.viewportTopLine + viewportRow,
    col,
  };
}

interface SlicedLine {
  absoluteLine: number;
  text: string;
  bufferColOffset: number;
}

export function chunkFromBufferLines(
  lines: ReadonlyArray<BufferLine>,
  start: CellPoint,
  end?: CellPoint,
): SpokenChunk {
  if (lines.length === 0) {
    return { text: "", rangeMap: [] };
  }

  // 1. Filter to lines within [start.line, end?.line ?? Infinity].
  const filtered = lines.filter(
    (bl) =>
      bl.absoluteLine >= start.line &&
      (end === undefined || bl.absoluteLine <= end.line),
  );

  // 2. Slice each kept line by start/end columns.
  const sliced: SlicedLine[] = filtered.map((bl) => {
    const sliceStart = bl.absoluteLine === start.line ? start.col : 0;
    const sliceEnd =
      end !== undefined && bl.absoluteLine === end.line
        ? end.col
        : bl.text.length;
    const safeStart = clamp(sliceStart, 0, bl.text.length);
    const safeEnd = clamp(sliceEnd, safeStart, bl.text.length);
    return {
      absoluteLine: bl.absoluteLine,
      text: bl.text.slice(safeStart, safeEnd),
      bufferColOffset: safeStart,
    };
  });

  // 3. Trim trailing blank lines.
  while (sliced.length > 0 && sliced[sliced.length - 1].text.trim() === "") {
    sliced.pop();
  }

  // 4. Collapse runs of interior blanks to a single blank line.
  const collapsed: SlicedLine[] = [];
  let inBlankRun = false;
  for (const ln of sliced) {
    const isBlank = ln.text.trim() === "";
    if (isBlank) {
      if (!inBlankRun && collapsed.length > 0) {
        collapsed.push(ln);
      }
      inBlankRun = true;
    } else {
      collapsed.push(ln);
      inBlankRun = false;
    }
  }

  // 5. Build text + rangemap.
  const parts: string[] = [];
  const rangeMap: RangeMapEntry[] = [];
  let cursor = 0;
  for (let i = 0; i < collapsed.length; i++) {
    const ln = collapsed[i];
    if (i > 0) cursor += 1; // newline separator
    const lineStartChar = cursor;
    parts.push(ln.text);

    WORD_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WORD_REGEX.exec(ln.text)) !== null) {
      const word = match[0];
      const wordIdx = match.index;
      rangeMap.push({
        charStart: lineStartChar + wordIdx,
        charEnd: lineStartChar + wordIdx + word.length,
        line: ln.absoluteLine,
        col: ln.bufferColOffset + wordIdx,
        len: word.length,
      });
    }
    cursor += ln.text.length;
  }

  return { text: parts.join("\n"), rangeMap };
}

function collectBufferLines(
  term: ResolverTerminal,
  startLine: number,
  endLine: number,
): BufferLine[] {
  const out: BufferLine[] = [];
  const safeStart = Math.max(0, startLine);
  const safeEnd = Math.min(endLine, term.buffer.active.length - 1);
  for (let i = safeStart; i <= safeEnd; i++) {
    const bl = term.buffer.active.getLine(i);
    if (!bl) continue;
    out.push({ absoluteLine: i, text: bl.translateToString() });
  }
  return out;
}

export interface ResolveOptions {
  /** Exclude the pinned bottom status/input block from the spoken text.
   *  Callers set this only in alt-screen TUIs (see TerminalPaneAdapter). */
  excludeStatusLine?: boolean;
}

export function resolveSpokenChunk(
  term: ResolverTerminal,
  point?: CellPoint,
  opts?: ResolveOptions,
): SpokenChunk {
  // (1) Selection wins.
  const sel = term.getSelection();
  if (sel && sel.length > 0) {
    const pos = term.getSelectionPosition();
    if (pos) {
      const startLine = pos.start.y;
      const startCol = pos.start.x;
      const endLine = pos.end.y;
      // xterm's selectionPosition end is INCLUSIVE; our slice is exclusive.
      const endColExclusive = pos.end.x + 1;
      const lines = collectBufferLines(term, startLine, endLine);
      return chunkFromBufferLines(
        lines,
        { line: startLine, col: startCol },
        { line: endLine, col: endColExclusive },
      );
    }
  }

  // (2) Point-driven from-here-to-end.
  if (point) {
    const endLine = term.buffer.active.length - 1;
    const collected = collectBufferLines(term, point.line, endLine);
    const lines = opts?.excludeStatusLine
      ? excludeLineRange(collected, detectStatusLineRange(collected, cursorAbsLine(term)))
      : collected;
    // Snap the start to a word boundary so we always speak full words.
    // Selection-based reads (branch above) are NOT snapped — the user
    // explicitly chose those boundaries.
    const startLineText = lines.find(
      (l) => l.absoluteLine === point.line,
    )?.text;
    const snappedCol =
      startLineText !== undefined
        ? snapColToWordStart(startLineText, point.col)
        : point.col;
    return chunkFromBufferLines(lines, { line: point.line, col: snappedCol });
  }

  // (3) Nothing.
  return { text: "", rangeMap: [] };
}

/** Absolute buffer line of the cursor (scroll offset + viewport-relative row). */
function cursorAbsLine(term: ResolverTerminal): number {
  return term.buffer.active.baseY + term.buffer.active.cursorY;
}

/**
 * Re-resolve "what is on screen right now, minus the status line" for a live
 * TTS session. Reads only the visible window `[viewportY, viewportY+rows-1]`
 * (not the whole buffer) so, as a TUI repaints, the recomputed chunk tracks
 * the current screen. Selection-agnostic by design — the controller only calls
 * this for non-selection reads. Returns an empty chunk if nothing is visible.
 */
export function resolveUpcomingChunk(
  term: ResolverTerminal,
  opts?: ResolveOptions,
): SpokenChunk {
  const ba = term.buffer.active;
  const top = Math.max(0, ba.viewportY);
  const bottom = Math.min(ba.viewportY + term.rows - 1, ba.length - 1);
  if (bottom < top) return { text: "", rangeMap: [] };
  const collected = collectBufferLines(term, top, bottom);
  const lines = opts?.excludeStatusLine
    ? excludeLineRange(collected, detectStatusLineRange(collected, cursorAbsLine(term)))
    : collected;
  return chunkFromBufferLines(lines, { line: top, col: 0 });
}
