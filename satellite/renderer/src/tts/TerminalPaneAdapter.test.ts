// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { TerminalPaneAdapter } from "./TerminalPaneAdapter";
import type { ResolverTerminal } from "./PaneTextResolver";
import type { HighlighterTerminal } from "./XtermHighlighter";
import type { TtsBoundary } from "./TtsEngine";

// Combined fake — the real xterm Terminal satisfies both ResolverTerminal
// and HighlighterTerminal interfaces simultaneously (it has one buffer with
// all the required fields). We replicate that here with a single buffer
// object that carries every field both contracts need.
type FakeTerm = ResolverTerminal & HighlighterTerminal;

function fakeTerm(opts: {
  lines: string[];
  selection?: string;
  selectionPosition?: { start: { x: number; y: number }; end: { x: number; y: number } };
  baseY?: number;
  cursorY?: number;
}): FakeTerm {
  const baseY = opts.baseY ?? 0;
  const cursorY = opts.cursorY ?? 0;
  const noop = () => ({ dispose() {} });
  const term: FakeTerm = {
    cols: 80,
    rows: 24,
    getSelection: () => opts.selection ?? "",
    getSelectionPosition: () => opts.selectionPosition,
    buffer: {
      active: {
        viewportY: 0,
        baseY,
        cursorY,
        length: opts.lines.length,
        getLine: (i: number) => {
          if (i < 0 || i >= opts.lines.length) return undefined;
          const text = opts.lines[i];
          return {
            length: text.length,
            translateToString: () => text,
          };
        },
      },
    },
    // The overlay highlighter subscribes to these while a highlight is live.
    onRender: noop,
    onScroll: noop,
    onResize: noop,
  };
  return term;
}

function fakeXtermEl(): HTMLElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.left = "0px";
  el.style.top = "0px";
  el.style.width = "640px";
  el.style.height = "480px";
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      left: 0, top: 0, right: 640, bottom: 480,
      width: 640, height: 480, x: 0, y: 0, toJSON: () => ({}),
    }),
  });
  document.body.appendChild(el);
  return el;
}

function fakeContainer(): HTMLElement {
  const el = document.createElement("div");
  el.className = "pane-terminal";
  document.body.appendChild(el);
  return el;
}

describe("TerminalPaneAdapter", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reports kind 'terminal'", () => {
    const adapter = new TerminalPaneAdapter({
      term: fakeTerm({ lines: ["alpha"] }),
      xtermEl: fakeXtermEl(),
      containerEl: fakeContainer(),
      cellWidth: 8,
      cellHeight: 16,
    });
    expect(adapter.kind).toBe("terminal");
  });

  it("getContainerEl returns the wrapper element", () => {
    const container = fakeContainer();
    const adapter = new TerminalPaneAdapter({
      term: fakeTerm({ lines: ["alpha"] }),
      xtermEl: fakeXtermEl(),
      containerEl: container,
      cellWidth: 8,
      cellHeight: 16,
    });
    expect(adapter.getContainerEl()).toBe(container);
  });

  it("resolveSpokenChunk reads from the active selection when present", () => {
    const adapter = new TerminalPaneAdapter({
      term: fakeTerm({
        lines: ["alpha beta", "gamma"],
        selection: "alpha",
        selectionPosition: { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
      }),
      xtermEl: fakeXtermEl(),
      containerEl: fakeContainer(),
      cellWidth: 8,
      cellHeight: 16,
    });
    const chunk = adapter.resolveSpokenChunk({ pixelX: 999, pixelY: 999 });
    expect(chunk.text).toBe("alpha");
  });

  it("resolveSpokenChunk reads from the mouse point when no selection", () => {
    const adapter = new TerminalPaneAdapter({
      term: fakeTerm({ lines: ["alpha beta", "gamma"] }),
      xtermEl: fakeXtermEl(),
      containerEl: fakeContainer(),
      cellWidth: 8,
      cellHeight: 16,
    });
    // pixelX=48, cellWidth=8 → col=6 ('beta' starts at col 6 in 'alpha beta')
    // pixelY=0, cellHeight=16 → line 0
    const chunk = adapter.resolveSpokenChunk({ pixelX: 48, pixelY: 0 });
    expect(chunk.text).toBe("beta\ngamma");
  });

  it("resolveSpokenChunk returns empty chunk when neither selection nor point present", () => {
    const adapter = new TerminalPaneAdapter({
      term: fakeTerm({ lines: ["alpha"] }),
      xtermEl: fakeXtermEl(),
      containerEl: fakeContainer(),
      cellWidth: 8,
      cellHeight: 16,
    });
    const chunk = adapter.resolveSpokenChunk();
    expect(chunk.text).toBe("");
    expect(chunk.rangeMap).toEqual([]);
  });

  it("highlightBoundary delegates to XtermHighlighter (anchors a marker + paints an overlay)", () => {
    const term = fakeTerm({ lines: ["alpha"] });
    const adapter = new TerminalPaneAdapter({
      term,
      xtermEl: fakeXtermEl(),
      containerEl: fakeContainer(),
      cellWidth: 8,
      cellHeight: 16,
      theme: { backgroundColor: "#abc", foregroundColor: "#fed" },
    });
    const boundary: TtsBoundary = {
      line: 0, col: 0, len: 5, word: "alpha", charIndex: 0,
    };
    adapter.highlightBoundary(boundary);
    // "alpha" is on the only visible line → a visible overlay is painted.
    const overlay = document.querySelector<HTMLDivElement>(".reck-tts-highlight");
    expect(overlay).not.toBeNull();
    expect(overlay!.style.display).toBe("block");
    // Introspection reflects the live boundary (not a silent empty array).
    expect(adapter.__highlights()).toEqual([boundary]);
    adapter.clearHighlight();
    expect(adapter.__highlights()).toEqual([]);
  });

  it("clearHighlight disposes the active decoration", () => {
    const term = fakeTerm({ lines: ["alpha"] });
    const adapter = new TerminalPaneAdapter({
      term,
      xtermEl: fakeXtermEl(),
      containerEl: fakeContainer(),
      cellWidth: 8,
      cellHeight: 16,
    });
    adapter.highlightBoundary({ line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 });
    expect(() => adapter.clearHighlight()).not.toThrow();
  });

  it("dispose clears the highlighter", () => {
    const term = fakeTerm({ lines: ["alpha"] });
    const adapter = new TerminalPaneAdapter({
      term,
      xtermEl: fakeXtermEl(),
      containerEl: fakeContainer(),
      cellWidth: 8,
      cellHeight: 16,
    });
    adapter.highlightBoundary({ line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 });
    expect(() => adapter.dispose()).not.toThrow();
    // After dispose, further highlightBoundary calls become no-ops.
    adapter.highlightBoundary({ line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 });
    expect(adapter.__highlights()).toEqual([]);
  });

  it("setTheme recolours the highlight overlay (configured colour)", () => {
    const term = fakeTerm({ lines: ["alpha"] });
    const adapter = new TerminalPaneAdapter({
      term,
      xtermEl: fakeXtermEl(),
      containerEl: fakeContainer(),
      cellWidth: 8,
      cellHeight: 16,
    });
    adapter.setTheme({ backgroundColor: "#090807" }); // rgb(9, 8, 7)
    adapter.highlightBoundary({ line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 });
    const overlay = document.querySelector<HTMLDivElement>(".reck-tts-highlight");
    expect(overlay).not.toBeNull();
    // Shared translucent fill + opaque ring (same look as the markdown surface).
    expect(overlay!.style.background).toBe("rgba(9, 8, 7, 0.5)");
    expect(overlay!.style.outline).toBe("1.5px solid #090807");
  });
});

// ── Content-change re-resolution (scroll → recompute) ───────────────

describe("TerminalPaneAdapter — content-change re-resolution", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // A term whose onRender/onScroll listeners can be fired on demand, with a
  // controllable buffer type (alt-screen vs normal).
  function firableTerm(opts: {
    lines: string[];
    type?: "normal" | "alternate";
    selection?: string;
    selectionPosition?: { start: { x: number; y: number }; end: { x: number; y: number } };
  }) {
    const renderCbs: Array<() => void> = [];
    const scrollCbs: Array<() => void> = [];
    const sub = (arr: Array<() => void>) => (cb: () => void) => {
      arr.push(cb);
      return {
        dispose() {
          const i = arr.indexOf(cb);
          if (i >= 0) arr.splice(i, 1);
        },
      };
    };
    const term: FakeTerm = {
      cols: 80,
      rows: 24,
      getSelection: () => opts.selection ?? "",
      getSelectionPosition: () => opts.selectionPosition,
      buffer: {
        active: {
          viewportY: 0,
          baseY: 0,
          cursorY: 0,
          type: opts.type ?? "alternate",
          length: opts.lines.length,
          getLine: (i: number) => {
            if (i < 0 || i >= opts.lines.length) return undefined;
            const text = opts.lines[i];
            return { length: text.length, translateToString: () => text };
          },
        },
      },
      onRender: sub(renderCbs),
      onScroll: sub(scrollCbs),
      onResize: sub([]),
    };
    return {
      term,
      fireRender: () => renderCbs.forEach((f) => f()),
      fireScroll: () => scrollCbs.forEach((f) => f()),
    };
  }

  function mkAdapter(term: FakeTerm, contentChangeDebounceMs = 0): TerminalPaneAdapter {
    return new TerminalPaneAdapter({
      term,
      xtermEl: fakeXtermEl(),
      containerEl: fakeContainer(),
      cellWidth: 8,
      cellHeight: 16,
      contentChangeDebounceMs,
    });
  }

  it("resolveUpcomingChunk returns the visible screen minus the status line (alt-screen)", () => {
    const { term } = firableTerm({
      lines: ["read this line", "and this one", "╭────────╮", "│ input  │", "╰────────╯"],
      type: "alternate",
    });
    const adapter = mkAdapter(term);
    adapter.resolveSpokenChunk({ pixelX: 0, pixelY: 0 }); // non-selection point read
    expect(adapter.resolveUpcomingChunk()?.text).toBe("read this line\nand this one");
  });

  it("resolveUpcomingChunk returns null off alt-screen (normal buffer)", () => {
    const { term } = firableTerm({ lines: ["alpha", "beta"], type: "normal" });
    const adapter = mkAdapter(term);
    adapter.resolveSpokenChunk({ pixelX: 0, pixelY: 0 });
    expect(adapter.resolveUpcomingChunk()).toBeNull();
  });

  it("resolveUpcomingChunk returns null after a selection read", () => {
    const { term } = firableTerm({
      lines: ["alpha beta"],
      type: "alternate",
      selection: "alpha",
      selectionPosition: { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
    });
    const adapter = mkAdapter(term);
    adapter.resolveSpokenChunk({ pixelX: 0, pixelY: 0 }); // selection wins → flagged
    expect(adapter.resolveUpcomingChunk()).toBeNull();
  });

  it("onContentChange fires on render and scroll, then stops after unsubscribe", () => {
    const { term, fireRender, fireScroll } = firableTerm({ lines: ["x"], type: "alternate" });
    const adapter = mkAdapter(term);
    let calls = 0;
    const off = adapter.onContentChange(() => {
      calls++;
    });
    fireRender();
    fireScroll();
    expect(calls).toBe(2);
    off();
    fireRender();
    fireScroll();
    expect(calls).toBe(2);
  });

  it("onContentChange debounces a burst into a single call", async () => {
    const { term, fireRender } = firableTerm({ lines: ["x"], type: "alternate" });
    const adapter = mkAdapter(term, 20);
    let calls = 0;
    adapter.onContentChange(() => {
      calls++;
    });
    fireRender();
    fireRender();
    fireRender();
    expect(calls).toBe(0); // debounced
    await new Promise((r) => setTimeout(r, 35));
    expect(calls).toBe(1);
  });
});
