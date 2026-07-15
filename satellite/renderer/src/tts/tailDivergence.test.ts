import { describe, it, expect } from "vitest";
import { findTailDivergence } from "./tailDivergence";
import { chunkFromBufferLines, type BufferLine } from "./PaneTextResolver";
import type { SpokenChunk } from "./TtsEngine";

/** Build a SpokenChunk from lines of text (absolute lines from 0). */
function chunk(...texts: string[]): SpokenChunk {
  const lines: BufferLine[] = texts.map((text, i) => ({
    absoluteLine: i,
    text,
  }));
  return chunkFromBufferLines(lines, { line: 0, col: 0 });
}

/** Char index of the Nth (0-based) word in a chunk. */
function wordCharStart(c: SpokenChunk, n: number): number {
  return c.rangeMap[n].charStart;
}

describe("findTailDivergence", () => {
  it("reports no change when the upcoming tail is identical", () => {
    const old = chunk("alpha beta gamma");
    const next = chunk("alpha beta gamma");
    const d = findTailDivergence(old, next, 0);
    expect(d.changed).toBe(false);
    expect(d.aligned).toBe(true);
  });

  it("detects a pure append (new content continues past the old end)", () => {
    const old = chunk("alpha beta");
    const next = chunk("alpha beta gamma delta");
    const d = findTailDivergence(old, next, 0);
    expect(d.changed).toBe(true);
    // Old finishes before it diverges → divCharOld is the old chunk's end.
    expect(d.divCharOld).toBe(old.text.length);
    // Resume at the first appended word ("gamma").
    expect(d.divCharNew).toBe(wordCharStart(next, 2));
  });

  it("detects a changed word mid-tail", () => {
    const old = chunk("alpha beta gamma");
    const next = chunk("alpha beta delta");
    const d = findTailDivergence(old, next, 0);
    expect(d.changed).toBe(true);
    expect(d.divCharOld).toBe(wordCharStart(old, 2)); // "gamma"
    expect(d.divCharNew).toBe(wordCharStart(next, 2)); // "delta"
  });

  it("detects truncation (old has words the new chunk lacks)", () => {
    const old = chunk("alpha beta gamma delta");
    const next = chunk("alpha beta");
    const d = findTailDivergence(old, next, 0);
    expect(d.changed).toBe(true);
    expect(d.divCharOld).toBe(wordCharStart(old, 2)); // first vanished word
    expect(d.divCharNew).toBe(next.text.length); // resume at (empty) new end
  });

  it("aligns duplicate words by reading-order continuity (forward occurrence)", () => {
    // Cursor is on the SECOND "the" (charIndex 8). The aligner must resume
    // there, not at the first "the" (charIndex 0).
    const old = chunk("the cat the dog");
    const next = chunk("the cat the dog");
    const d = findTailDivergence(old, next, 8);
    expect(d.changed).toBe(false);
    expect(d.resumeCharNew).toBe(8);
  });

  it("realigns the current word even when earlier text shifted", () => {
    // The first "the" was replaced; the current word (second "the") is still
    // present, just at a new position — alignment finds it, no false change.
    const old = chunk("the cat the dog");
    const next = chunk("XX cat the dog");
    const d = findTailDivergence(old, next, 8);
    expect(d.changed).toBe(false);
    expect(d.aligned).toBe(true);
  });

  it("does not align (and does not swap) when the current word is gone", () => {
    const old = chunk("alpha beta");
    const next = chunk("wholly unrelated content");
    const d = findTailDivergence(old, next, 0);
    expect(d.aligned).toBe(false);
    expect(d.changed).toBe(false);
  });

  it("reports no change when the cursor is past the last word", () => {
    const old = chunk("alpha beta");
    const next = chunk("alpha beta gamma");
    const d = findTailDivergence(old, next, old.text.length + 5);
    expect(d.changed).toBe(false);
  });
});
