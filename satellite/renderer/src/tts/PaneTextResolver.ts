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

export function resolveSpokenChunk(
  term: ResolverTerminal,
  point?: CellPoint,
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
    const lines = collectBufferLines(term, point.line, endLine);
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
