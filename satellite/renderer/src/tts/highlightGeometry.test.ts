import { describe, it, expect } from "vitest";
import { computeHighlightRect } from "./highlightGeometry";

// A baseline on-screen input: a 4-cell word at buffer line 102, while the
// viewport top is buffer line 100 → it sits on screen row 2. Cells are
// 8×16 px, grid is 80×24.
function baseInput() {
  return {
    markerLine: 102,
    viewportY: 100,
    rows: 24,
    cols: 80,
    col: 6,
    len: 4,
    cellWidth: 8,
    cellHeight: 16,
  };
}

describe("computeHighlightRect — on-screen positioning", () => {
  it("maps a visible word to its pixel rect", () => {
    const r = computeHighlightRect(baseInput());
    expect(r).not.toBeNull();
    // screenRow = 102 - 100 = 2 → top = 2 * 16 = 32
    expect(r).toEqual({ left: 48, top: 32, width: 32, height: 16 });
  });

  it("places the word on row 0 when it is at the viewport top", () => {
    const r = computeHighlightRect({ ...baseInput(), markerLine: 100 });
    expect(r?.top).toBe(0);
  });
});

describe("computeHighlightRect — scroll tracking", () => {
  it("moves DOWN on screen as the viewport scrolls UP into history", () => {
    // Same word (markerLine 102). Scrolling up lowers viewportY, so the
    // word's screen row — and thus `top` — increases.
    const before = computeHighlightRect({ ...baseInput(), viewportY: 100 });
    const after = computeHighlightRect({ ...baseInput(), viewportY: 98 });
    expect(before?.top).toBe(32); // row 2
    expect(after?.top).toBe(64); // row 4 — followed the text downward
  });

  it("recomputes `left` purely from the column (scroll-independent)", () => {
    // viewportY 90 keeps the word on-screen (row 12); `left` depends only
    // on the column, never the vertical scroll position.
    const r = computeHighlightRect({ ...baseInput(), viewportY: 90 });
    expect(r?.top).toBe(12 * 16);
    expect(r?.left).toBe(48); // col 6 * 8, unchanged by vertical scroll
  });
});

describe("computeHighlightRect — off-screen + disposed → null (hidden)", () => {
  it("returns null when the word scrolled above the viewport", () => {
    // markerLine 102, viewportY 110 → screenRow = -8
    expect(computeHighlightRect({ ...baseInput(), viewportY: 110 })).toBeNull();
  });

  it("returns null when the word scrolled below the viewport", () => {
    // markerLine 102, viewportY 70 → screenRow 32 ≥ rows(24)
    expect(computeHighlightRect({ ...baseInput(), viewportY: 70 })).toBeNull();
  });

  it("returns null on the last visible row boundary (row === rows is off)", () => {
    // screenRow exactly rows (24) is the first off-screen row.
    expect(
      computeHighlightRect({ ...baseInput(), markerLine: 124, viewportY: 100 }),
    ).toBeNull();
    // row 23 (the last visible) is still on-screen.
    expect(
      computeHighlightRect({ ...baseInput(), markerLine: 123, viewportY: 100 }),
    ).not.toBeNull();
  });

  it("returns null when the marker is disposed (line < 0)", () => {
    expect(computeHighlightRect({ ...baseInput(), markerLine: -1 })).toBeNull();
  });

  it("returns null when cell metrics are not yet measured (0×0)", () => {
    expect(
      computeHighlightRect({ ...baseInput(), cellWidth: 0, cellHeight: 0 }),
    ).toBeNull();
  });
});

describe("computeHighlightRect — column clamping", () => {
  it("clamps a word that overruns the right edge to the last column", () => {
    // col 78, len 5 on an 80-col grid → clamp end to 80 → width 2 cells.
    const r = computeHighlightRect({ ...baseInput(), col: 78, len: 5 });
    expect(r?.left).toBe(78 * 8);
    expect(r?.width).toBe(2 * 8);
  });

  it("returns null when the start column is at/after the right edge", () => {
    expect(computeHighlightRect({ ...baseInput(), col: 80, len: 3 })).toBeNull();
  });

  it("returns null for a zero-length boundary", () => {
    expect(computeHighlightRect({ ...baseInput(), len: 0 })).toBeNull();
  });
});
