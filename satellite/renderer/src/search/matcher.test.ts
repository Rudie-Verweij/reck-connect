import { describe, it, expect } from "vitest";
import { findMatches } from "./matcher";

const opts = (over: Partial<Parameters<typeof findMatches>[2]> = {}) => ({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...over,
});

describe("findMatches — substring mode", () => {
  it("returns no matches for an empty query", () => {
    const r = findMatches("the quick brown fox", "", opts());
    expect(r.ranges).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it("returns no matches for whitespace-only text with a real query", () => {
    const r = findMatches("    \n  ", "x", opts());
    expect(r.ranges).toEqual([]);
  });

  it("finds every non-overlapping occurrence with correct offsets", () => {
    const text = "foo bar foo baz foo";
    const r = findMatches(text, "foo", opts());
    expect(r.ranges).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
      { start: 16, end: 19 },
    ]);
    // the offsets must slice back to the query
    for (const m of r.ranges) expect(text.slice(m.start, m.end)).toBe("foo");
  });

  it("is case-insensitive by default", () => {
    const r = findMatches("Deep deep DEEP", "deep", opts());
    expect(r.ranges.map((m) => m.start)).toEqual([0, 5, 10]);
  });

  it("respects caseSensitive=true", () => {
    const r = findMatches("Deep deep DEEP", "deep", opts({ caseSensitive: true }));
    expect(r.ranges).toEqual([{ start: 5, end: 9 }]);
  });

  it("treats regex metacharacters literally in substring mode", () => {
    const text = "a.c abc axc a.c";
    const r = findMatches(text, "a.c", opts());
    expect(r.ranges).toEqual([
      { start: 0, end: 3 },
      { start: 12, end: 15 },
    ]);
  });

  it("does not corrupt offsets for case-insensitive matches (index-preserving)", () => {
    const text = "Straße STRASSE"; // length-changing toLowerCase pitfall guard
    const r = findMatches(text, "stra", opts());
    // first 'Stra' at 0; we only assert the first match maps back cleanly
    expect(text.slice(r.ranges[0].start, r.ranges[0].end).toLowerCase()).toBe("stra");
  });
});

describe("findMatches — whole word", () => {
  it("matches a standalone word but not a substring inside another word", () => {
    const text = "cat category scatter cat";
    const r = findMatches(text, "cat", opts({ wholeWord: true }));
    expect(r.ranges).toEqual([
      { start: 0, end: 3 },
      { start: 21, end: 24 },
    ]);
  });
});

describe("findMatches — regex mode", () => {
  it("matches a basic pattern", () => {
    const text = "abc axc a-c";
    const r = findMatches(text, "a.c", opts({ regex: true }));
    expect(r.ranges).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it("honours case sensitivity in regex mode", () => {
    const r1 = findMatches("ABC abc", "abc", opts({ regex: true }));
    expect(r1.ranges.map((m) => m.start)).toEqual([0, 4]);
    const r2 = findMatches("ABC abc", "abc", opts({ regex: true, caseSensitive: true }));
    expect(r2.ranges.map((m) => m.start)).toEqual([4]);
  });

  it("combines regex with whole word", () => {
    const text = "go gone going go";
    const r = findMatches(text, "go", opts({ regex: true, wholeWord: true }));
    expect(r.ranges).toEqual([
      { start: 0, end: 2 },
      { start: 14, end: 16 },
    ]);
  });

  it("returns an error (not a throw) for an invalid pattern", () => {
    const r = findMatches("anything", "a(", opts({ regex: true }));
    expect(r.ranges).toEqual([]);
    expect(typeof r.error).toBe("string");
    expect(r.error!.length).toBeGreaterThan(0);
  });

  it("skips zero-width matches and does not hang", () => {
    const r = findMatches("baa", "a*", opts({ regex: true }));
    // only the non-empty 'aa' run is reported
    expect(r.ranges).toEqual([{ start: 1, end: 3 }]);
  });

  it("does not match newlines with '.' across a multi-line buffer", () => {
    const r = findMatches("line1\nline2", "line.", opts({ regex: true }));
    expect(r.ranges).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
    ]);
  });
});
