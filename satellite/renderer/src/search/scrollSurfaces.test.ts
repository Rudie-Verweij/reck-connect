// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { domScrollSurface, terminalScrollSurface } from "./scrollSurfaces";

describe("domScrollSurface", () => {
  it("reads metrics off the element", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 200, configurable: true });
    el.scrollTop = 300;
    const s = domScrollSurface(el);
    expect(s.getMetrics()).toEqual({ scrollTop: 300, scrollHeight: 1000, clientHeight: 200 });
  });

  it("scrollToFraction sets scrollTop to a fraction of the scrollable range", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 200, configurable: true });
    const s = domScrollSurface(el);
    s.scrollToFraction(0.5); // (1000-200)*0.5 = 400
    expect(el.scrollTop).toBe(400);
  });

  it("onScroll subscribes and the returned thunk unsubscribes", () => {
    const el = document.createElement("div");
    const cb = vi.fn();
    const off = domScrollSurface(el).onScroll(cb);
    el.dispatchEvent(new Event("scroll"));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    el.dispatchEvent(new Event("scroll"));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("terminalScrollSurface", () => {
  function fakeTerm() {
    let scrollCb: (() => void) | null = null;
    return {
      term: {
        rows: 24,
        buffer: { active: { length: 1000, baseY: 976, viewportY: 488 } },
        scrollToLine: vi.fn(),
        onScroll: (cb: () => void) => {
          scrollCb = cb;
          return { dispose: () => (scrollCb = null) };
        },
      },
      fire: () => scrollCb?.(),
      hasSub: () => scrollCb !== null,
    };
  }

  it("maps buffer geometry to scroll metrics", () => {
    const f = fakeTerm();
    const s = terminalScrollSurface(f.term);
    expect(s.getMetrics()).toEqual({ scrollTop: 488, scrollHeight: 1000, clientHeight: 24 });
  });

  it("scrollToFraction maps to a buffer line via scrollToLine", () => {
    const f = fakeTerm();
    const s = terminalScrollSurface(f.term);
    s.scrollToFraction(0.5); // 0.5 * baseY(976) = 488
    expect(f.term.scrollToLine).toHaveBeenCalledWith(488);
  });

  it("onScroll wires term.onScroll and disposes on unsubscribe", () => {
    const f = fakeTerm();
    const cb = vi.fn();
    const off = terminalScrollSurface(f.term).onScroll(cb);
    f.fire();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(f.hasSub()).toBe(false);
  });
});

describe("terminalScrollSurface — ownsScroll (mouse-tracking detection)", () => {
  function baseTerm() {
    return {
      rows: 24,
      buffer: { active: { length: 100, baseY: 76, viewportY: 0 } },
      scrollToLine: vi.fn(),
      onScroll: () => ({ dispose: () => {} }),
    };
  }

  it("is false for a plain shell — mouseTrackingMode 'none' or no modes at all", () => {
    const none = terminalScrollSurface({ ...baseTerm(), modes: { mouseTrackingMode: "none" } });
    expect(none.ownsScroll?.()).toBe(false);
    // A fake/old terminal without a `modes` field defaults to truthful.
    const bare = terminalScrollSurface(baseTerm());
    expect(bare.ownsScroll?.()).toBe(false);
  });

  it("is true for a mouse-tracking TUI — any non-'none' mode (Claude Code, less, vim)", () => {
    for (const mode of ["x10", "vt200", "drag", "any"] as const) {
      const s = terminalScrollSurface({ ...baseTerm(), modes: { mouseTrackingMode: mode } });
      expect(s.ownsScroll?.()).toBe(true);
    }
  });

  it("reflects a live mode flip (plain shell → Claude Code launches → exits)", () => {
    const term = { ...baseTerm(), modes: { mouseTrackingMode: "none" } };
    const s = terminalScrollSurface(term);
    expect(s.ownsScroll?.()).toBe(false);
    term.modes.mouseTrackingMode = "any"; // claude starts
    expect(s.ownsScroll?.()).toBe(true);
    term.modes.mouseTrackingMode = "none"; // claude exits
    expect(s.ownsScroll?.()).toBe(false);
  });
});

describe("domScrollSurface — ownsScroll", () => {
  it("leaves ownsScroll unset so DOM scrollers always render truthfully", () => {
    expect(domScrollSurface(document.createElement("div")).ownsScroll).toBeUndefined();
  });
});
