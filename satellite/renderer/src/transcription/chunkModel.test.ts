import { describe, it, expect } from "vitest";
import {
  addOnset,
  alignWords,
  makeChunk,
  resolvedCount,
  shouldFlush,
  stepChunk,
  takeFlush,
  type ChunkState,
} from "./chunkModel";

const OPTS = { commitWordCount: 6, commitPauseMs: 700, ghostResetMs: 1200 };

describe("chunkModel.addOnset", () => {
  it("appends one blurred, textless segment per onset id", () => {
    let c = makeChunk();
    c = addOnset(c, 1);
    c = addOnset(c, 2);
    expect(c.segments).toEqual([
      { id: 1, state: "blurred", text: null },
      { id: 2, state: "blurred", text: null },
    ]);
  });

  it("is idempotent for a repeated id", () => {
    let c = addOnset(makeChunk(), 1);
    c = addOnset(c, 1);
    expect(c.segments).toHaveLength(1);
  });
});

describe("chunkModel.alignWords", () => {
  it("assigns words to blurred segments in order and crystallizes them", () => {
    let c = makeChunk();
    c = addOnset(c, 1);
    c = addOnset(c, 2);
    c = alignWords(c, ["open", "the"]);
    expect(c.segments).toEqual([
      { id: 1, state: "crystallizing", text: "open" },
      { id: 2, state: "crystallizing", text: "the" },
    ]);
  });

  it("marks an unchanged word sharp (so it stops re-animating)", () => {
    let c = alignWords(addOnset(makeChunk(), 1), ["open"]);
    c = alignWords(c, ["open"]);
    expect(c.segments[0].state).toBe("sharp");
  });

  it("re-crystallizes a revised word (aurth → auth)", () => {
    let c = alignWords(addOnset(makeChunk(), 1), ["aurth"]);
    c = alignWords(c, ["auth"]);
    expect(c.segments[0]).toEqual({ id: 1, state: "crystallizing", text: "auth" });
  });

  it("leaves trailing segments blurred when the transcriber is behind", () => {
    let c = makeChunk();
    c = addOnset(c, 1);
    c = addOnset(c, 2);
    c = addOnset(c, 3);
    c = alignWords(c, ["open"]);
    expect(c.segments.map((s) => s.state)).toEqual(["crystallizing", "blurred", "blurred"]);
  });

  it("appends extra words (transcriber split a blob) as synthetic segments", () => {
    let c = alignWords(addOnset(makeChunk(), 1), ["open", "the", "file"]);
    expect(c.segments).toHaveLength(3);
    expect(c.segments[0].id).toBe(1);
    expect(c.segments[1].id).toBeLessThan(0);
    expect(c.segments[2].id).toBeLessThan(0);
    expect(c.segments.every((s) => s.text !== null)).toBe(true);
  });
});

describe("chunkModel.shouldFlush", () => {
  const base = (words: string[]): ChunkState =>
    alignWords(
      words.reduce((c, _w, i) => addOnset(c, i + 1), makeChunk()),
      words,
    );

  it("never flushes an empty or all-blurred chunk", () => {
    expect(shouldFlush(makeChunk(), { msSinceVoice: 9999, commitWordCount: 6, commitPauseMs: 700 })).toBe(false);
    const blurred = addOnset(addOnset(makeChunk(), 1), 2);
    expect(shouldFlush(blurred, { msSinceVoice: 9999, commitWordCount: 6, commitPauseMs: 700 })).toBe(false);
  });

  it("flushes when the resolved word count is reached", () => {
    const c = base(["a", "b", "c", "d", "e", "f"]);
    expect(shouldFlush(c, { msSinceVoice: 0, commitWordCount: 6, commitPauseMs: 700 })).toBe(true);
  });

  it("flushes on a pause when at least one word is resolved", () => {
    const c = base(["hello"]);
    expect(shouldFlush(c, { msSinceVoice: 800, commitWordCount: 6, commitPauseMs: 700 })).toBe(true);
    expect(shouldFlush(c, { msSinceVoice: 300, commitWordCount: 6, commitPauseMs: 700 })).toBe(false);
  });
});

describe("chunkModel.takeFlush", () => {
  it("commits the leading resolved run and preserves the blurred tail", () => {
    let c = makeChunk();
    c = addOnset(c, 1);
    c = addOnset(c, 2);
    c = addOnset(c, 3);
    c = alignWords(c, ["open", "the"]); // seg 3 still blurred
    const r = takeFlush(c);
    expect(r.committedText).toBe("open the");
    expect(r.committedCount).toBe(2);
    expect(r.rest.committedWords).toBe(2);
    expect(r.rest.segments).toEqual([{ id: 3, state: "blurred", text: null }]);
  });

  it("stops at the first blurred gap so committed text stays in order", () => {
    // seg1 resolved, seg2 blurred, seg3 resolved (out-of-order resolution).
    let c: ChunkState = { segments: [
      { id: 1, state: "sharp", text: "one" },
      { id: 2, state: "blurred", text: null },
      { id: 3, state: "crystallizing", text: "three" },
    ], committedWords: 0 };
    const r = takeFlush(c);
    expect(r.committedText).toBe("one");
    expect(r.rest.segments.map((s) => s.id)).toEqual([2, 3]);
  });

  it("resolvedCount ignores blurred segments", () => {
    let c = addOnset(addOnset(makeChunk(), 1), 2);
    c = alignWords(c, ["hi"]);
    expect(resolvedCount(c)).toBe(1);
  });
});

describe("chunkModel.stepChunk", () => {
  it("commits nothing while the phrase is short and speech is ongoing", () => {
    const chunk = addOnset(addOnset(makeChunk(), 1), 2);
    const r = stepChunk(chunk, ["open", "the"], { ...OPTS, msSinceVoice: 100 }, false);
    expect(r.commits).toEqual([]);
    expect(r.cleared).toBe(false);
    expect(r.chunk.segments.map((s) => s.text)).toEqual(["open", "the"]);
  });

  it("commits the phrase on a pause and advances the committed offset", () => {
    let chunk = makeChunk();
    chunk = addOnset(addOnset(addOnset(chunk, 1), 2), 3);
    const r = stepChunk(chunk, ["fix", "the", "bug"], { ...OPTS, msSinceVoice: 900 }, false);
    expect(r.commits).toEqual(["fix the bug"]);
    expect(r.chunk.committedWords).toBe(3);
    expect(r.chunk.segments).toEqual([]);
  });

  it("commits everything remaining on final", () => {
    const chunk = addOnset(makeChunk(), 1);
    const r = stepChunk(chunk, ["done"], { ...OPTS, msSinceVoice: 0 }, true);
    expect(r.commits).toEqual(["done"]);
    expect(r.cleared).toBe(true);
    expect(r.chunk.committedWords).toBe(1);
  });

  it("clears phantom blobs after a long silence with nothing resolved", () => {
    const chunk = addOnset(addOnset(makeChunk(), 1), 2);
    const r = stepChunk(chunk, [], { ...OPTS, msSinceVoice: 2000 }, false);
    expect(r.commits).toEqual([]);
    expect(r.cleared).toBe(true);
    expect(r.chunk.segments).toEqual([]);
  });

  it("commits ALL crystallized text after >1s silence and drops leftover blobs", () => {
    // 2 resolved words + 1 trailing blurred onset that never transcribed.
    let chunk = makeChunk();
    chunk = addOnset(addOnset(addOnset(chunk, 1), 2), 3);
    const r = stepChunk(chunk, ["hello", "world"], { ...OPTS, msSinceVoice: 1100 }, false);
    expect(r.commits.join(" ")).toBe("hello world");
    expect(r.cleared).toBe(true);
    expect(r.chunk.segments).toEqual([]);
    // Only the two real (transcript) words advance the committed offset.
    expect(r.chunk.committedWords).toBe(2);
  });

  it("keeps trailing blobs during a short (<1s) mid-phrase pause", () => {
    // A brief pause commits the resolved phrase but must NOT drop the pending
    // blurred onset (its word may still arrive from a laggy transcriber).
    let chunk = makeChunk();
    chunk = addOnset(addOnset(chunk, 1), 2);
    const r = stepChunk(chunk, ["open"], { ...OPTS, msSinceVoice: 750 }, false);
    expect(r.commits).toEqual(["open"]);
    expect(r.cleared).toBe(false);
    expect(r.chunk.segments.map((s) => s.state)).toEqual(["blurred"]);
  });
});
