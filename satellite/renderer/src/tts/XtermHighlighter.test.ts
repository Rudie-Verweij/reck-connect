import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  XtermHighlighter,
  type HighlighterTerminal,
} from "./XtermHighlighter";

interface FakeMarker {
  id: number;
  line: number; // absolute line (for assertions)
  cursorYOffset: number;
  isDisposed: boolean;
  dispose(): void;
}

interface FakeDecoration {
  id: number;
  marker: FakeMarker;
  x: number;
  width: number;
  backgroundColor: string;
  layer: string | undefined;
  isDisposed: boolean;
  dispose(): void;
}

function fakeTerm(opts: { baseY?: number; cursorY?: number } = {}) {
  let markerSeq = 0;
  let decoSeq = 0;
  const markers: FakeMarker[] = [];
  const decorations: FakeDecoration[] = [];

  const baseY = opts.baseY ?? 0;
  const cursorY = opts.cursorY ?? 0;
  const cursorAbs = baseY + cursorY;

  const term: HighlighterTerminal = {
    buffer: {
      active: {
        baseY,
        cursorY,
      },
    },
    registerMarker(offset = 0) {
      const m: FakeMarker = {
        id: ++markerSeq,
        cursorYOffset: offset,
        line: cursorAbs + offset,
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
      markers.push(m);
      return m;
    },
    registerDecoration(opts) {
      const d: FakeDecoration = {
        id: ++decoSeq,
        marker: opts.marker as FakeMarker,
        x: opts.x ?? 0,
        width: opts.width ?? 1,
        backgroundColor: opts.backgroundColor ?? "",
        layer: opts.layer,
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
      decorations.push(d);
      return d;
    },
  };
  return { term, markers, decorations };
}

describe("XtermHighlighter.highlight", () => {
  let env: ReturnType<typeof fakeTerm>;
  let h: XtermHighlighter;

  beforeEach(() => {
    env = fakeTerm({ baseY: 100, cursorY: 5 }); // cursorAbs = 105
    h = new XtermHighlighter(env.term, () => ({
      backgroundColor: "#cfe7ff",
    }));
  });

  afterEach(() => {
    h.dispose();
  });

  it("registers a marker at the correct absolute line", () => {
    h.highlight({
      line: 102,
      col: 6,
      len: 4,
      word: "beta",
      charIndex: 6,
    });

    expect(env.markers).toHaveLength(1);
    // cursorAbs=105, target line=102 → offset = 102 - 105 = -3
    expect(env.markers[0].cursorYOffset).toBe(-3);
    expect(env.markers[0].line).toBe(102);
  });

  it("registers a decoration with the correct x, width, and theme color", () => {
    h.highlight({
      line: 102,
      col: 6,
      len: 4,
      word: "beta",
      charIndex: 6,
    });

    expect(env.decorations).toHaveLength(1);
    const d = env.decorations[0];
    expect(d.x).toBe(6);
    expect(d.width).toBe(4);
    expect(d.backgroundColor).toBe("#cfe7ff");
  });

  it("registers the decoration on the BOTTOM layer (so the text reads on top of the highlight, not under it)", () => {
    h.highlight({
      line: 102,
      col: 6,
      len: 4,
      word: "beta",
      charIndex: 6,
    });
    expect(env.decorations[0].layer).toBe("bottom");
  });

  it("disposes the previous marker + decoration when highlighting a new word", () => {
    h.highlight({ line: 102, col: 0, len: 5, word: "alpha", charIndex: 0 });
    h.highlight({ line: 102, col: 6, len: 4, word: "beta", charIndex: 6 });

    expect(env.markers[0].isDisposed).toBe(true);
    expect(env.decorations[0].isDisposed).toBe(true);
    expect(env.markers[1].isDisposed).toBe(false);
    expect(env.decorations[1].isDisposed).toBe(false);
  });

  it("uses the latest theme on each highlight (theme can change live)", () => {
    let bg = "#cfe7ff";
    const h2 = new XtermHighlighter(env.term, () => ({ backgroundColor: bg }));

    h2.highlight({ line: 100, col: 0, len: 1, word: "a", charIndex: 0 });
    expect(env.decorations[0].backgroundColor).toBe("#cfe7ff");

    bg = "rgba(74,166,255,0.28)";
    h2.highlight({ line: 100, col: 1, len: 1, word: "b", charIndex: 1 });
    expect(env.decorations[1].backgroundColor).toBe("rgba(74,166,255,0.28)");
    h2.dispose();
  });
});

describe("XtermHighlighter.clear", () => {
  it("disposes the active decoration but the highlighter remains usable", () => {
    const env = fakeTerm();
    const h = new XtermHighlighter(env.term, () => ({
      backgroundColor: "#cfe7ff",
    }));

    h.highlight({ line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 });
    h.clear();
    expect(env.decorations[0].isDisposed).toBe(true);
    expect(env.markers[0].isDisposed).toBe(true);

    h.highlight({ line: 0, col: 6, len: 4, word: "beta", charIndex: 6 });
    expect(env.decorations).toHaveLength(2);
    expect(env.decorations[1].isDisposed).toBe(false);
    h.dispose();
  });

  it("is a no-op when nothing is currently highlighted", () => {
    const env = fakeTerm();
    const h = new XtermHighlighter(env.term, () => ({
      backgroundColor: "#cfe7ff",
    }));
    expect(() => h.clear()).not.toThrow();
    h.dispose();
  });
});

describe("XtermHighlighter.dispose", () => {
  it("disposes any active highlight and ignores subsequent highlight calls", () => {
    const env = fakeTerm();
    const h = new XtermHighlighter(env.term, () => ({
      backgroundColor: "#cfe7ff",
    }));
    h.highlight({ line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 });
    h.dispose();
    expect(env.decorations[0].isDisposed).toBe(true);

    // A highlight call after dispose should be a safe no-op.
    h.highlight({ line: 0, col: 6, len: 4, word: "beta", charIndex: 6 });
    expect(env.decorations).toHaveLength(1); // No new decoration was added.
  });
});

describe("XtermHighlighter resilience", () => {
  it("gracefully no-ops when the marker registration returns undefined (off-screen)", () => {
    const env = fakeTerm();
    // Override registerMarker to simulate off-screen failure.
    env.term.registerMarker = vi.fn(() => undefined);
    const h = new XtermHighlighter(env.term, () => ({
      backgroundColor: "#cfe7ff",
    }));
    expect(() =>
      h.highlight({
        line: 999,
        col: 0,
        len: 4,
        word: "test",
        charIndex: 0,
      }),
    ).not.toThrow();
    expect(env.decorations).toHaveLength(0);
    h.dispose();
  });
});
