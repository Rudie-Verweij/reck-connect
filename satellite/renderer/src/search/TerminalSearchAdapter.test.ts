// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  TerminalSearchAdapter,
  type SearchableTerminal,
} from "./TerminalSearchAdapter";

function fakeTerm(
  rowStrings: string[],
  opts: { rows: number; baseY: number; viewportY: number },
) {
  let vY = opts.viewportY;
  let lastScrollLine = -1;
  const lines = [...rowStrings];
  const render: Array<() => void> = [];
  const scroll: Array<() => void> = [];
  const resize: Array<() => void> = [];
  const sub = (arr: Array<() => void>) => (cb: () => void) => {
    arr.push(cb);
    return {
      dispose: () => {
        const i = arr.indexOf(cb);
        if (i >= 0) arr.splice(i, 1);
      },
    };
  };
  const term: SearchableTerminal = {
    rows: opts.rows,
    cols: 80,
    buffer: {
      active: {
        baseY: opts.baseY,
        get viewportY() {
          return vY;
        },
        length: lines.length,
        getLine: (y: number) =>
          y >= 0 && y < lines.length
            ? { translateToString: () => lines[y] }
            : undefined,
      },
    },
    scrollToLine: (l: number) => {
      lastScrollLine = l;
    },
    onRender: sub(render),
    onScroll: sub(scroll),
    onResize: sub(resize),
  };
  return {
    term,
    setViewportY: (v: number) => {
      vY = v;
    },
    setLine: (y: number, text: string) => {
      lines[y] = text;
    },
    emitRender: () => render.slice().forEach((cb) => cb()),
    emitScroll: () => scroll.slice().forEach((cb) => cb()),
    emitResize: () => resize.slice().forEach((cb) => cb()),
    getScrollLine: () => lastScrollLine,
    listenerCount: () => render.length + scroll.length + resize.length,
  };
}

let container: HTMLElement;
let screen: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  screen = document.createElement("div");
});

const CELL = () => ({ width: 8, height: 16 });

function make(f: ReturnType<typeof fakeTerm>) {
  return new TerminalSearchAdapter({
    container,
    term: f.term,
    overlayParent: screen,
    measureCell: CELL,
    doc: document,
  });
}

const rectsOf = () =>
  Array.from(
    screen.querySelectorAll<HTMLDivElement>(".reck-search-match-rect"),
  ).filter((el) => el.style.display !== "none");

const ROWS = ["foo bar", "baz foo", "qux", "foo end", "tail"];
// 'foo' is at flat offsets 0 (row0 col0), 12 (row1 col4), 20 (row3 col0).
const FOO_MATCHES = [
  { start: 0, end: 3 },
  { start: 12, end: 15 },
  { start: 20, end: 23 },
];

describe("TerminalSearchAdapter", () => {
  it("reports its kind and container", () => {
    const f = fakeTerm(ROWS, { rows: 5, baseY: 0, viewportY: 0 });
    const a = make(f);
    expect(a.kind).toBe("terminal");
    expect(a.getContainerEl()).toBe(container);
  });

  it("getText joins physical rows with newlines (scrollback included)", () => {
    const f = fakeTerm(ROWS, { rows: 5, baseY: 0, viewportY: 0 });
    const a = make(f);
    expect(a.getText()).toBe("foo bar\nbaz foo\nqux\nfoo end\ntail");
  });

  it("paints an overlay rect per visible match at the right pixel position", () => {
    const f = fakeTerm(ROWS, { rows: 5, baseY: 0, viewportY: 0 });
    const a = make(f);
    a.getText();
    a.highlightMatches(FOO_MATCHES, 1);
    const rects = rectsOf();
    expect(rects.length).toBe(3);
    // row0 col0 -> (0,0); row1 col4 -> (32,16); row3 col0 -> (0,48). w=3*8=24.
    expect(rects.map((r) => r.style.left)).toEqual(["0px", "32px", "0px"]);
    expect(rects.map((r) => r.style.top)).toEqual(["0px", "16px", "48px"]);
    expect(rects.map((r) => r.style.width)).toEqual(["24px", "24px", "24px"]);
  });

  it("gives the active match a different (brighter) colour", () => {
    const f = fakeTerm(ROWS, { rows: 5, baseY: 0, viewportY: 0 });
    const a = make(f);
    a.getText();
    a.highlightMatches(FOO_MATCHES, 1);
    const rects = rectsOf();
    // index 1 is the active match (row1).
    expect(rects[1].style.backgroundColor).not.toBe(rects[0].style.backgroundColor);
    expect(rects[2].style.backgroundColor).toBe(rects[0].style.backgroundColor);
  });

  it("repositions matches when the viewport scrolls (the core fix)", () => {
    const f = fakeTerm(ROWS, { rows: 5, baseY: 0, viewportY: 0 });
    const a = make(f);
    a.getText();
    a.highlightMatches(FOO_MATCHES, 1);
    expect(rectsOf().length).toBe(3);

    // Scroll so the viewport top is buffer line 2: rows 0 and 1 go off the
    // top (no rect), row 3 moves up to screen-row 1 (top = 16px).
    f.setViewportY(2);
    f.emitScroll();
    const rects = rectsOf();
    expect(rects.length).toBe(1);
    expect(rects[0].style.top).toBe("16px");
  });

  it("also repositions on a plain render tick (in-place TUI redraw)", () => {
    const f = fakeTerm(ROWS, { rows: 5, baseY: 0, viewportY: 0 });
    const a = make(f);
    a.getText();
    a.highlightMatches(FOO_MATCHES, 0);
    f.setViewportY(3);
    f.emitRender();
    // Only row 3 (screen-row 0) and row 4 stay on screen; of our matches just
    // row 3 (offset 20) is visible.
    const rects = rectsOf();
    expect(rects.length).toBe(1);
    expect(rects[0].style.top).toBe("0px");
  });

  it("hides a match whose cell no longer holds the matched text", () => {
    const f = fakeTerm(ROWS, { rows: 5, baseY: 0, viewportY: 0 });
    const a = make(f);
    a.getText();
    a.highlightMatches(FOO_MATCHES, 1);
    expect(rectsOf().length).toBe(3);
    // The TUI repaints row 0 with different text — the stale match must drop
    // rather than paint on the wrong word.
    f.setLine(0, "xxx bar");
    f.emitRender();
    expect(rectsOf().length).toBe(2);
  });

  it("clearHighlights removes the overlay and detaches listeners", () => {
    const f = fakeTerm(ROWS, { rows: 5, baseY: 0, viewportY: 0 });
    const a = make(f);
    a.getText();
    a.highlightMatches(FOO_MATCHES, 0);
    expect(f.listenerCount()).toBe(3); // render + scroll + resize
    a.clearHighlights();
    expect(f.listenerCount()).toBe(0);
    expect(screen.querySelector(".reck-search-overlay")).toBeNull();
    expect(() => f.emitRender()).not.toThrow();
    expect(rectsOf().length).toBe(0);
  });

  it("does not stack listeners across re-highlight (navigation)", () => {
    const f = fakeTerm(ROWS, { rows: 5, baseY: 0, viewportY: 0 });
    const a = make(f);
    a.getText();
    a.highlightMatches(FOO_MATCHES, 0);
    a.highlightMatches(FOO_MATCHES, 1);
    a.highlightMatches(FOO_MATCHES, 2);
    expect(f.listenerCount()).toBe(3);
  });

  it("scrollToMatch centres the matched row in the viewport", () => {
    const f = fakeTerm(ROWS, { rows: 3, baseY: 2, viewportY: 2 });
    const a = make(f);
    a.getText();
    a.scrollToMatch({ start: 20, end: 23 }); // row 3
    // row 3 - floor(3/2)=1 -> 2, clamped to [0, baseY=2]
    expect(f.getScrollLine()).toBe(2);
  });

  it("fractionForOffset maps a match to its row fraction", () => {
    const f = fakeTerm(ROWS, { rows: 5, baseY: 0, viewportY: 0 });
    const a = make(f);
    a.getText();
    expect(a.fractionForOffset(20)).toBeCloseTo(0.6, 5); // row3 / length5
    expect(a.fractionForOffset(0)).toBe(0);
  });

  it("is a no-op after dispose", () => {
    const f = fakeTerm(ROWS, { rows: 5, baseY: 0, viewportY: 0 });
    const a = make(f);
    a.getText();
    a.highlightMatches(FOO_MATCHES, 0);
    a.dispose();
    expect(f.listenerCount()).toBe(0);
    expect(screen.querySelector(".reck-search-overlay")).toBeNull();
    a.highlightMatches(FOO_MATCHES, 0);
    expect(rectsOf().length).toBe(0);
    expect(() => a.dispose()).not.toThrow();
  });
});
