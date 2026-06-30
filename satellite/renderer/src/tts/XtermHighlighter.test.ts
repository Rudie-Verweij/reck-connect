import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  XtermHighlighter,
  type HighlighterTerminal,
  type HighlightTheme,
} from "./XtermHighlighter";

function makeEmitter() {
  const listeners = new Set<() => void>();
  return {
    on(cb: () => void) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    fire() {
      for (const cb of [...listeners]) cb();
    },
    size() {
      return listeners.size;
    },
  };
}

// Fake xterm whose buffer is an absolute-indexed array of line strings. The
// visible window is viewportY .. viewportY+rows-1.
function fakeTerm(
  init: { lines?: string[]; viewportY?: number; cols?: number; rows?: number } = {},
) {
  const state = {
    lines: init.lines ?? [],
    viewportY: init.viewportY ?? 0,
    cols: init.cols ?? 80,
    rows: init.rows ?? 24,
  };
  const render = makeEmitter();
  const scroll = makeEmitter();
  const resize = makeEmitter();

  const term: HighlighterTerminal = {
    get cols() {
      return state.cols;
    },
    get rows() {
      return state.rows;
    },
    buffer: {
      active: {
        get viewportY() {
          return state.viewportY;
        },
        get length() {
          return state.lines.length;
        },
        getLine(i: number) {
          const t = state.lines[i];
          return t === undefined ? undefined : { translateToString: () => t };
        },
      },
    },
    onRender: render.on,
    onScroll: scroll.on,
    onResize: resize.on,
  };

  return {
    term,
    state,
    fireRender: () => render.fire(),
    fireScroll: () => scroll.fire(),
    fireResize: () => resize.fire(),
    renderListeners: () => render.size(),
    scrollListeners: () => scroll.size(),
  };
}

function setup(
  init?: Parameters<typeof fakeTerm>[0],
  theme: HighlightTheme = { backgroundColor: "rgb(1, 2, 3)" },
) {
  const env = fakeTerm(init);
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const cell = { width: 8, height: 16 };
  let currentTheme = theme;
  const h = new XtermHighlighter(env.term, () => currentTheme, {
    overlayParent: parent,
    measureCell: () => cell,
  });
  const overlay = () =>
    parent.querySelector<HTMLDivElement>(".reck-tts-highlight");
  return {
    ...env,
    h,
    parent,
    cell,
    overlay,
    setTheme: (t: HighlightTheme) => {
      currentTheme = t;
    },
  };
}

const B = (line: number, col: number, word: string) => ({
  line,
  col,
  len: word.length,
  word,
  charIndex: 0,
});

describe("XtermHighlighter — re-find placement", () => {
  let s: ReturnType<typeof setup>;
  afterEach(() => {
    s.h.dispose();
    s.parent.remove();
  });

  it("places the overlay at the word's CURRENT position in the buffer", () => {
    s = setup({ lines: ["alpha beta gamma"], viewportY: 0 });
    s.h.highlight(B(0, 11, "gamma"));
    const el = s.overlay();
    expect(el).not.toBeNull();
    expect(el!.style.display).toBe("block");
    expect(el!.style.top).toBe("0px"); // row 0
    expect(el!.style.left).toBe("88px"); // col 11 * 8
    expect(el!.style.width).toBe("40px"); // 5 cells * 8
    expect(el!.style.backgroundColor).toBe("rgb(1, 2, 3)");
  });

  it("ignores a STALE snapshot column and finds the real position", () => {
    // boundary.col=99 is where the word WAS at snapshot time; the live buffer
    // has it at col 3. The highlight must land on the real position.
    s = setup({ lines: ["xx gamma here"], viewportY: 0 });
    s.h.highlight(B(0, 99, "gamma"));
    expect(s.overlay()!.style.left).toBe("24px"); // col 3 * 8, not col 99
  });

  it("hides when the word isn't visible at all", () => {
    s = setup({ lines: ["nothing to see"], viewportY: 0 });
    s.h.highlight(B(0, 0, "absent"));
    const el = s.overlay();
    expect(el === null || el.style.display === "none").toBe(true);
  });
});

describe("XtermHighlighter — tracking through repaint / scroll", () => {
  let s: ReturnType<typeof setup>;
  afterEach(() => {
    s.h.dispose();
    s.parent.remove();
  });

  it("follows the word when an in-place repaint moves it to another line", () => {
    s = setup({ lines: ["", "", "guidance: here"], viewportY: 0 });
    s.h.highlight(B(2, 0, "guidance:"));
    expect(s.overlay()!.style.top).toBe("32px"); // row 2
    // Claude repaints: the same word is now on line 0.
    s.state.lines = ["guidance: here", "", ""];
    s.fireRender();
    expect(s.overlay()!.style.top).toBe("0px"); // followed the text up
  });

  it("follows a real viewport scroll (viewportY change)", () => {
    const lines = ["L0", "L1", "L2", "L3", "L4", "needle here", "L6", "L7"];
    s = setup({ lines, viewportY: 0, rows: 8 });
    s.h.highlight(B(5, 0, "needle"));
    expect(s.overlay()!.style.top).toBe(`${5 * 16}px`); // row 5
    s.state.viewportY = 3; // scrolled down 3
    s.fireScroll();
    expect(s.overlay()!.style.top).toBe(`${2 * 16}px`); // row 2 now
  });

  it("hides when the word scrolls out of the visible window", () => {
    const lines = ["top needle", ...Array.from({ length: 40 }, (_, i) => `L${i}`)];
    s = setup({ lines, viewportY: 0, rows: 8 });
    s.h.highlight(B(0, 4, "needle"));
    expect(s.overlay()!.style.display).toBe("block");
    s.state.viewportY = 20; // line 0 no longer visible
    s.fireScroll();
    expect(s.overlay()!.style.display).toBe("none");
  });

  it("hides when the word is repainted away entirely", () => {
    s = setup({ lines: ["guidance: here"], viewportY: 0 });
    s.h.highlight(B(0, 0, "guidance:"));
    expect(s.overlay()!.style.display).toBe("block");
    s.state.lines = ["a totally different table row"];
    s.fireRender();
    expect(s.overlay()!.style.display).toBe("none");
  });

  it("re-shows when the word reappears after being gone", () => {
    s = setup({ lines: ["guidance: x"], viewportY: 0 });
    s.h.highlight(B(0, 0, "guidance:"));
    s.state.lines = ["something else"];
    s.fireRender();
    expect(s.overlay()!.style.display).toBe("none");
    s.state.lines = ["now guidance: again"];
    s.fireRender();
    expect(s.overlay()!.style.display).toBe("block");
    expect(s.overlay()!.style.left).toBe("32px"); // col 4 * 8
  });
});

describe("XtermHighlighter — repeated-word disambiguation", () => {
  let s: ReturnType<typeof setup>;
  afterEach(() => {
    s.h.dispose();
    s.parent.remove();
  });

  it("advances to the NEXT occurrence for a repeated word", () => {
    s = setup({ lines: ["the cat the dog"], viewportY: 0 });
    s.h.highlight(B(0, 0, "the")); // first "the"
    expect(s.overlay()!.style.left).toBe("0px");
    s.h.highlight(B(0, 8, "the")); // second "the"
    expect(s.overlay()!.style.left).toBe(`${8 * 8}px`); // advanced to col 8
  });
});

describe("XtermHighlighter — resize realignment", () => {
  it("realigns to new cell metrics on resize", () => {
    const s = setup({ lines: ["alpha beta"], viewportY: 0 });
    s.h.highlight(B(0, 6, "beta"));
    expect(s.overlay()!.style.left).toBe(`${6 * 8}px`);
    s.cell.width = 10;
    s.cell.height = 20;
    s.fireResize();
    expect(s.overlay()!.style.left).toBe(`${6 * 10}px`);
    expect(s.overlay()!.style.height).toBe("20px");
    s.h.dispose();
    s.parent.remove();
  });
});

describe("XtermHighlighter — theme", () => {
  it("uses the latest theme colour on each reposition", () => {
    const s = setup({ lines: ["alpha"], viewportY: 0 });
    s.h.highlight(B(0, 0, "alpha"));
    expect(s.overlay()!.style.backgroundColor).toBe("rgb(1, 2, 3)");
    s.setTheme({ backgroundColor: "rgb(4, 5, 6)" });
    s.fireRender();
    expect(s.overlay()!.style.backgroundColor).toBe("rgb(4, 5, 6)");
    s.h.dispose();
    s.parent.remove();
  });
});

describe("XtermHighlighter — lifecycle / leak safety", () => {
  it("subscribes while live and releases everything on clear()", () => {
    const s = setup({ lines: ["alpha beta"], viewportY: 0 });
    s.h.highlight(B(0, 6, "beta"));
    expect(s.scrollListeners()).toBe(1);
    expect(s.overlay()).not.toBeNull();
    s.h.clear();
    expect(s.overlay()).toBeNull(); // removed
    expect(s.scrollListeners()).toBe(0); // listeners released
    // Re-highlighting after clear works.
    s.h.highlight(B(0, 0, "alpha"));
    expect(s.scrollListeners()).toBe(1);
    expect(s.overlay()!.style.display).toBe("block");
    s.h.dispose();
    s.parent.remove();
  });

  it("dispose() removes the overlay, unsubscribes, and ignores later calls", () => {
    const s = setup({ lines: ["alpha"], viewportY: 0 });
    s.h.highlight(B(0, 0, "alpha"));
    s.h.dispose();
    expect(s.overlay()).toBeNull();
    expect(s.renderListeners()).toBe(0);
    expect(s.scrollListeners()).toBe(0);
    s.h.highlight(B(0, 0, "alpha")); // no-op after dispose
    expect(s.overlay()).toBeNull();
    s.parent.remove();
  });

  it("resets continuity between reads (clear)", () => {
    const s = setup({ lines: ["the cat the dog"], viewportY: 0 });
    s.h.highlight(B(0, 0, "the"));
    s.h.highlight(B(0, 8, "the")); // advanced to col 8
    expect(s.overlay()!.style.left).toBe("64px");
    s.h.clear();
    // New read starts fresh → first "the" again, not continuing from col 8.
    s.h.highlight(B(0, 0, "the"));
    expect(s.overlay()!.style.left).toBe("0px");
    s.h.dispose();
    s.parent.remove();
  });
});
