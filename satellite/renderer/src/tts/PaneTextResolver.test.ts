import { describe, it, expect } from "vitest";
import {
  chunkFromBufferLines,
  pixelToCell,
  resolveSpokenChunk,
  snapColToWordStart,
  type ResolverTerminal,
  type BufferLine,
} from "./PaneTextResolver";
import type { SpokenChunk } from "./TtsEngine";

// ── Pure helpers ────────────────────────────────────────────────────

describe("chunkFromBufferLines", () => {
  it("returns an empty chunk when given no lines", () => {
    const chunk = chunkFromBufferLines([], { line: 0, col: 0 });
    expect(chunk.text).toBe("");
    expect(chunk.rangeMap).toEqual([]);
  });

  it("emits one rangemap entry per word, starting at col 0 for full-line read", () => {
    const lines: BufferLine[] = [
      { absoluteLine: 0, text: "hello world" },
    ];
    const chunk = chunkFromBufferLines(lines, { line: 0, col: 0 });
    expect(chunk.text).toBe("hello world");
    expect(chunk.rangeMap).toEqual([
      { charStart: 0, charEnd: 5, line: 0, col: 0, len: 5 },
      { charStart: 6, charEnd: 11, line: 0, col: 6, len: 5 },
    ]);
  });

  it("offsets the first line by startCol when starting mid-line", () => {
    const lines: BufferLine[] = [
      { absoluteLine: 7, text: "hello world" },
    ];
    // Start reading at col 6 — only "world" is included on the first line.
    const chunk = chunkFromBufferLines(lines, { line: 7, col: 6 });
    expect(chunk.text).toBe("world");
    expect(chunk.rangeMap).toEqual([
      { charStart: 0, charEnd: 5, line: 7, col: 6, len: 5 },
    ]);
  });

  it("starts mid-word when col falls inside a word", () => {
    const lines: BufferLine[] = [
      { absoluteLine: 0, text: "hello world" },
    ];
    // col 2 → "llo world" — the partial word's rangemap entry uses col 2.
    const chunk = chunkFromBufferLines(lines, { line: 0, col: 2 });
    expect(chunk.text).toBe("llo world");
    expect(chunk.rangeMap).toEqual([
      { charStart: 0, charEnd: 3, line: 0, col: 2, len: 3 },
      { charStart: 4, charEnd: 9, line: 0, col: 6, len: 5 },
    ]);
  });

  it("joins multiple lines with newline; rangemap charStarts account for newlines", () => {
    const lines: BufferLine[] = [
      { absoluteLine: 0, text: "alpha beta" },
      { absoluteLine: 1, text: "gamma" },
    ];
    const chunk = chunkFromBufferLines(lines, { line: 0, col: 0 });
    expect(chunk.text).toBe("alpha beta\ngamma");
    expect(chunk.rangeMap).toEqual([
      { charStart: 0, charEnd: 5, line: 0, col: 0, len: 5 },
      { charStart: 6, charEnd: 10, line: 0, col: 6, len: 4 },
      { charStart: 11, charEnd: 16, line: 1, col: 0, len: 5 },
    ]);
  });

  it("trims trailing blank lines but keeps interior blanks", () => {
    const lines: BufferLine[] = [
      { absoluteLine: 0, text: "alpha" },
      { absoluteLine: 1, text: "" },
      { absoluteLine: 2, text: "beta" },
      { absoluteLine: 3, text: "" },
      { absoluteLine: 4, text: "" },
    ];
    const chunk = chunkFromBufferLines(lines, { line: 0, col: 0 });
    expect(chunk.text).toBe("alpha\n\nbeta");
    expect(chunk.rangeMap).toEqual([
      { charStart: 0, charEnd: 5, line: 0, col: 0, len: 5 },
      { charStart: 7, charEnd: 11, line: 2, col: 0, len: 4 },
    ]);
  });

  it("collapses 3+ consecutive interior blank lines to 1", () => {
    const lines: BufferLine[] = [
      { absoluteLine: 0, text: "alpha" },
      { absoluteLine: 1, text: "" },
      { absoluteLine: 2, text: "" },
      { absoluteLine: 3, text: "" },
      { absoluteLine: 4, text: "" },
      { absoluteLine: 5, text: "beta" },
    ];
    const chunk = chunkFromBufferLines(lines, { line: 0, col: 0 });
    expect(chunk.text).toBe("alpha\n\nbeta");
    expect(chunk.rangeMap).toHaveLength(2);
  });

  it("handles selection-style end clipping (endLine + endCol provided)", () => {
    const lines: BufferLine[] = [
      { absoluteLine: 0, text: "alpha beta gamma" },
      { absoluteLine: 1, text: "delta" },
    ];
    const chunk = chunkFromBufferLines(
      lines,
      { line: 0, col: 6 },
      { line: 0, col: 10 },
    );
    expect(chunk.text).toBe("beta");
    expect(chunk.rangeMap).toEqual([
      { charStart: 0, charEnd: 4, line: 0, col: 6, len: 4 },
    ]);
  });

  it("ignores leading whitespace at the first column when computing word col", () => {
    const lines: BufferLine[] = [
      { absoluteLine: 0, text: "  hello" },
    ];
    const chunk = chunkFromBufferLines(lines, { line: 0, col: 0 });
    expect(chunk.text).toBe("  hello");
    expect(chunk.rangeMap).toEqual([
      { charStart: 2, charEnd: 7, line: 0, col: 2, len: 5 },
    ]);
  });

  it("ignores entirely-whitespace lines in the rangemap", () => {
    const lines: BufferLine[] = [
      { absoluteLine: 0, text: "alpha" },
      { absoluteLine: 1, text: "    " },
      { absoluteLine: 2, text: "beta" },
    ];
    const chunk = chunkFromBufferLines(lines, { line: 0, col: 0 });
    // No word entries for whitespace-only line; absolute line numbers preserved.
    expect(chunk.rangeMap.map((e) => e.line)).toEqual([0, 2]);
  });
});

// ── Word-snap helper ────────────────────────────────────────────────

describe("snapColToWordStart", () => {
  it("returns the same col when already at the start of a word", () => {
    expect(snapColToWordStart("hello world", 0)).toBe(0);
    expect(snapColToWordStart("hello world", 6)).toBe(6);
  });

  it("snaps backward to the start of the current word when mid-word", () => {
    expect(snapColToWordStart("hello world", 1)).toBe(0);
    expect(snapColToWordStart("hello world", 2)).toBe(0);
    expect(snapColToWordStart("hello world", 4)).toBe(0);
    expect(snapColToWordStart("hello world", 7)).toBe(6);
    expect(snapColToWordStart("hello world", 10)).toBe(6);
  });

  it("snaps forward to the next word's start when on whitespace", () => {
    expect(snapColToWordStart("hello world", 5)).toBe(6); // the single space
    expect(snapColToWordStart("hello   world", 5)).toBe(8); // multi-space gap
    expect(snapColToWordStart("hello   world", 6)).toBe(8);
    expect(snapColToWordStart("hello   world", 7)).toBe(8);
  });

  it("skips leading whitespace when col is at the start of a line", () => {
    expect(snapColToWordStart("  hello", 0)).toBe(2);
    expect(snapColToWordStart("    foo bar", 1)).toBe(4);
  });

  it("returns the original col when past the end of the text (no word ahead)", () => {
    expect(snapColToWordStart("hello", 5)).toBe(5);
    expect(snapColToWordStart("hello   ", 5)).toBe(8);
    expect(snapColToWordStart("hello   ", 7)).toBe(8);
    expect(snapColToWordStart("hello   ", 10)).toBe(10);
  });

  it("treats punctuation as part of the surrounding word (regex \\S)", () => {
    expect(snapColToWordStart("hello, world", 3)).toBe(0); // "hello," is one word
    expect(snapColToWordStart("hello, world", 5)).toBe(0); // the comma
    expect(snapColToWordStart("hello, world", 6)).toBe(7); // space → next word
  });

  it("handles empty text", () => {
    expect(snapColToWordStart("", 0)).toBe(0);
    expect(snapColToWordStart("", 5)).toBe(5);
  });
});

// ── Pixel → cell translation ────────────────────────────────────────

describe("pixelToCell", () => {
  it("maps the top-left pixel to the top-left visible cell", () => {
    const cell = pixelToCell({
      pixelX: 0,
      pixelY: 0,
      containerLeft: 0,
      containerTop: 0,
      cellWidth: 8,
      cellHeight: 16,
      viewportTopLine: 100,
      cols: 80,
      rows: 24,
    });
    expect(cell).toEqual({ line: 100, col: 0 });
  });

  it("maps mid-cell pixels to the cell column", () => {
    const cell = pixelToCell({
      pixelX: 24,
      pixelY: 32,
      containerLeft: 0,
      containerTop: 0,
      cellWidth: 8,
      cellHeight: 16,
      viewportTopLine: 100,
      cols: 80,
      rows: 24,
    });
    // 24/8 = 3, 32/16 = 2 → viewportLine 100+2 = 102
    expect(cell).toEqual({ line: 102, col: 3 });
  });

  it("subtracts the container offset", () => {
    const cell = pixelToCell({
      pixelX: 124,
      pixelY: 232,
      containerLeft: 100,
      containerTop: 200,
      cellWidth: 8,
      cellHeight: 16,
      viewportTopLine: 50,
      cols: 80,
      rows: 24,
    });
    expect(cell).toEqual({ line: 52, col: 3 });
  });

  it("clamps col to [0, cols-1]", () => {
    const cell = pixelToCell({
      pixelX: 9999,
      pixelY: 0,
      containerLeft: 0,
      containerTop: 0,
      cellWidth: 8,
      cellHeight: 16,
      viewportTopLine: 0,
      cols: 80,
      rows: 24,
    });
    expect(cell.col).toBe(79);
  });

  it("clamps line to [viewportTop, viewportTop+rows-1]", () => {
    const cell = pixelToCell({
      pixelX: 0,
      pixelY: -50, // Above container
      containerLeft: 0,
      containerTop: 0,
      cellWidth: 8,
      cellHeight: 16,
      viewportTopLine: 100,
      cols: 80,
      rows: 24,
    });
    expect(cell.line).toBe(100);
  });

  it("clamps to last visible row when below the viewport", () => {
    const cell = pixelToCell({
      pixelX: 0,
      pixelY: 9999,
      containerLeft: 0,
      containerTop: 0,
      cellWidth: 8,
      cellHeight: 16,
      viewportTopLine: 100,
      cols: 80,
      rows: 24,
    });
    expect(cell.line).toBe(123); // 100 + 24 - 1
  });
});

// ── End-to-end resolver ─────────────────────────────────────────────

function fakeTerm(opts: {
  lines: string[];
  cols?: number;
  rows?: number;
  viewportY?: number;
  selection?: string;
  selectionPosition?: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
}): ResolverTerminal {
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const viewportY = opts.viewportY ?? 0;
  const lines = opts.lines;
  return {
    cols,
    rows,
    getSelection: () => opts.selection ?? "",
    getSelectionPosition: () => opts.selectionPosition,
    buffer: {
      active: {
        viewportY,
        baseY: 0,
        cursorY: 0,
        length: lines.length,
        getLine: (idx: number) => {
          if (idx < 0 || idx >= lines.length) return undefined;
          const text = lines[idx];
          return {
            length: text.length,
            translateToString: () => text,
          };
        },
      },
    },
  };
}

describe("resolveSpokenChunk — selection priority", () => {
  it("uses the selection when one is present", () => {
    const term = fakeTerm({
      lines: ["alpha beta gamma"],
      selection: "beta",
      selectionPosition: {
        start: { x: 6, y: 0 },
        end: { x: 9, y: 0 }, // xterm end is *exclusive* of last char position; len=4 → 9
      },
    });
    const chunk = resolveSpokenChunk(term);
    expect(chunk.text).toBe("beta");
    expect(chunk.rangeMap[0]).toMatchObject({ line: 0, col: 6, len: 4 });
  });

  it("ignores the mouse point when a selection is present", () => {
    const term = fakeTerm({
      lines: ["alpha beta", "gamma delta"],
      selection: "alpha",
      selectionPosition: { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
    });
    const chunk = resolveSpokenChunk(term, { line: 1, col: 0 });
    expect(chunk.text).toBe("alpha");
  });
});

describe("resolveSpokenChunk — point-driven", () => {
  it("reads from the given (line, col) to the end of the buffer", () => {
    const term = fakeTerm({
      lines: ["alpha beta", "gamma"],
    });
    const chunk = resolveSpokenChunk(term, { line: 0, col: 6 });
    expect(chunk.text).toBe("beta\ngamma");
  });

  it("returns an empty chunk when no selection and no point", () => {
    const term = fakeTerm({ lines: ["alpha beta"] });
    const chunk = resolveSpokenChunk(term);
    expect(chunk.text).toBe("");
    expect(chunk.rangeMap).toEqual([]);
  });

  it("returns an empty chunk when the buffer is empty", () => {
    const term = fakeTerm({ lines: [] });
    const chunk = resolveSpokenChunk(term, { line: 0, col: 0 });
    expect(chunk.text).toBe("");
  });
});

describe("resolveSpokenChunk — word-snap on point-driven reads", () => {
  it("snaps backward to the start of the word when the mouse lands mid-word", () => {
    const term = fakeTerm({ lines: ["alpha beta gamma"] });
    // col 2 is inside "alpha" — speech should start at col 0 ("alpha"),
    // not at col 2 ("pha beta gamma").
    const chunk = resolveSpokenChunk(term, { line: 0, col: 2 });
    expect(chunk.text).toBe("alpha beta gamma");
    expect(chunk.rangeMap[0]).toMatchObject({
      line: 0,
      col: 0,
      len: 5,
    });
  });

  it("snaps backward when the mouse is on the last char of a word", () => {
    const term = fakeTerm({ lines: ["alpha beta"] });
    // col 4 — the 'a' at the end of "alpha".
    const chunk = resolveSpokenChunk(term, { line: 0, col: 4 });
    expect(chunk.text).toBe("alpha beta");
  });

  it("snaps forward to the next word when the mouse is on whitespace", () => {
    const term = fakeTerm({ lines: ["alpha beta gamma"] });
    // col 5 — the space between "alpha" and "beta".
    const chunk = resolveSpokenChunk(term, { line: 0, col: 5 });
    expect(chunk.text).toBe("beta gamma");
    expect(chunk.rangeMap[0]).toMatchObject({
      line: 0,
      col: 6,
      len: 4,
    });
  });

  it("skips leading whitespace at the start of a line", () => {
    const term = fakeTerm({ lines: ["    indented"] });
    const chunk = resolveSpokenChunk(term, { line: 0, col: 0 });
    // After snapping, col 0 → col 4 (start of "indented"); the slice
    // from that point on is the spoken text, hence no leading spaces.
    expect(chunk.text).toBe("indented");
    expect(chunk.rangeMap[0]).toMatchObject({ line: 0, col: 4 });
  });

  it("does NOT snap when the read is selection-driven", () => {
    // Selection wins; whatever the user explicitly selected is read
    // verbatim, even if it starts mid-word.
    const term = fakeTerm({
      lines: ["alpha beta"],
      selection: "lpha",
      selectionPosition: { start: { x: 1, y: 0 }, end: { x: 4, y: 0 } },
    });
    const chunk = resolveSpokenChunk(term, { line: 0, col: 2 });
    expect(chunk.text).toBe("lpha");
  });
});

describe("resolveSpokenChunk — basic non-ASCII tolerance", () => {
  it("does not crash on multibyte input (Japanese)", () => {
    const term = fakeTerm({
      lines: ["こんにちは world"],
    });
    const chunk = resolveSpokenChunk(term, { line: 0, col: 0 });
    // We don't assert exact column-mapping for wide chars in v1, only
    // that the text is captured and the rangemap is internally consistent.
    expect(chunk.text).toContain("こんにちは");
    expect(chunk.text).toContain("world");
    for (const e of chunk.rangeMap) {
      expect(e.charEnd).toBeGreaterThan(e.charStart);
      expect(e.line).toBeGreaterThanOrEqual(0);
      expect(e.col).toBeGreaterThanOrEqual(0);
    }
  });
});
