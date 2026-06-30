import { describe, it, expect } from "vitest";
import { findWordOccurrences, relocateWord } from "./wordLocator";

describe("findWordOccurrences — whitespace-bounded matching", () => {
  it("finds a standalone word", () => {
    expect(findWordOccurrences("alpha beta gamma", "beta")).toEqual([6]);
  });

  it("finds multiple occurrences", () => {
    expect(findWordOccurrences("the cat sat on the mat", "the")).toEqual([0, 15]);
  });

  it("does NOT match inside a larger word", () => {
    expect(findWordOccurrences("theme of the theory", "the")).toEqual([9]);
  });

  it("matches at start and end of line", () => {
    expect(findWordOccurrences("run it", "run")).toEqual([0]);
    expect(findWordOccurrences("now run", "run")).toEqual([4]);
  });

  it("matches words touching punctuation as part of the token", () => {
    // The token is exactly "NORMALIZATION.md." (trailing dot included).
    expect(
      findWordOccurrences("see NORMALIZATION.md. for details", "NORMALIZATION.md."),
    ).toEqual([4]);
  });

  it("returns [] for an empty word or no match", () => {
    expect(findWordOccurrences("anything", "")).toEqual([]);
    expect(findWordOccurrences("anything", "zzz")).toEqual([]);
  });
});

describe("relocateWord — continuity disambiguation", () => {
  const lines = (rows: string[], startLine = 0) =>
    rows.map((text, idx) => ({ line: startLine + idx, text }));

  it("returns null when the word is not visible", () => {
    expect(relocateWord(lines(["alpha beta"]), "gamma", 0, 0)).toBeNull();
  });

  it("finds the single occurrence", () => {
    expect(relocateWord(lines(["alpha beta gamma"]), "gamma", 0, 0)).toEqual({
      line: 0,
      col: 11,
    });
  });

  it("picks the occurrence at/after the hint (reading advances forward)", () => {
    // "the" at col 0 and col 15 on line 0; hint just past the first one.
    const ls = lines(["the cat sat on the mat"]);
    expect(relocateWord(ls, "the", 0, 4)).toEqual({ line: 0, col: 15 });
  });

  it("prefers the nearest forward occurrence across lines", () => {
    const ls = lines(["x the", "y the", "z the"]); // "the" at col 2 on each
    // hint at line 1 col 0 → forward = lines 1,2; nearest = line 1.
    expect(relocateWord(ls, "the", 1, 0)).toEqual({ line: 1, col: 2 });
  });

  it("falls back to the nearest backward occurrence when none is forward", () => {
    const ls = lines(["the start", "middle", "end here"]);
    // hint past everything → no forward "the"; nearest backward is line 0.
    expect(relocateWord(ls, "the", 5, 0)).toEqual({ line: 0, col: 0 });
  });

  it("tracks the word to its new line after a repaint shifts it", () => {
    // Same word "guidance:" moved from line 16 to line 3 after a repaint.
    const before = lines(["", "", "guidance: here"], 14); // line 16
    expect(relocateWord(before, "guidance:", 16, 0)).toEqual({ line: 16, col: 0 });
    const after = lines(["guidance: here", "more", "stuff"], 3); // line 3
    // Hint still says line 16 (last known), but the only occurrence is line 3
    // → it relocates there instead of staying put / hiding.
    expect(relocateWord(after, "guidance:", 16, 0)).toEqual({ line: 3, col: 0 });
  });

  it("absolute line indices are preserved in the result", () => {
    const ls = lines(["foo", "bar word baz"], 100);
    expect(relocateWord(ls, "word", 100, 0)).toEqual({ line: 101, col: 4 });
  });
});
