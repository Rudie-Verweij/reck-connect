// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createOverlayScrollbar, type OverlayScrollbar } from "./OverlayScrollbar";
import type { ScrollMetrics, ScrollSurface } from "./scrollSurfaces";

function fakeSurface(initial: ScrollMetrics, ownsScrollInit = false) {
  const m: ScrollMetrics = { ...initial };
  let owns = ownsScrollInit;
  let cbs: Array<() => void> = [];
  let renderCbs: Array<() => void> = [];
  const surface: ScrollSurface = {
    getMetrics: () => ({ ...m }),
    scrollToFraction: vi.fn(),
    onScroll: (cb) => {
      cbs.push(cb);
      return () => {
        cbs = cbs.filter((c) => c !== cb);
      };
    },
    onRender: (cb) => {
      renderCbs.push(cb);
      return () => {
        renderCbs = renderCbs.filter((c) => c !== cb);
      };
    },
    ownsScroll: () => owns,
  };
  return {
    surface,
    setMetrics: (nm: Partial<ScrollMetrics>) => Object.assign(m, nm),
    setOwnsScroll: (v: boolean) => (owns = v),
    fireScroll: () => cbs.slice().forEach((c) => c()),
    fireRender: () => renderCbs.slice().forEach((c) => c()),
    subCount: () => cbs.length,
    renderSubCount: () => renderCbs.length,
  };
}

/** A `wheel` event with the deltas jsdom's bare Event doesn't carry. */
function wheelEvent(deltaY: number, deltaMode = 0): WheelEvent {
  const e = new Event("wheel", { bubbles: true, cancelable: true }) as WheelEvent;
  Object.defineProperty(e, "deltaY", { value: deltaY, configurable: true });
  Object.defineProperty(e, "deltaMode", { value: deltaMode, configurable: true });
  return e;
}

const disabled = () =>
  track().classList.contains("reck-scrollbar--disabled");
const visible = () => track().classList.contains("visible");

let host: HTMLElement;
let sb: OverlayScrollbar;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  host.style.position = "relative";
  document.body.appendChild(host);
});

afterEach(() => {
  sb?.dispose();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const track = () => host.querySelector(".reck-scrollbar") as HTMLElement;
const thumb = () => host.querySelector(".reck-scrollbar-thumb") as HTMLElement;

describe("OverlayScrollbar — thumb geometry", () => {
  it("sizes and positions the thumb from the metrics", () => {
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    sb = createOverlayScrollbar({ host, surface: f.surface });
    sb.update();
    expect(thumb().style.height).toBe("10%"); // 100/1000
    expect(thumb().style.top).toBe("0%");

    f.setMetrics({ scrollTop: 900 }); // max scroll
    f.fireScroll();
    expect(thumb().style.top).toBe("90%"); // 1 * (100 - 10)
  });

  it("disables the bar when the content is not scrollable", () => {
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
    sb = createOverlayScrollbar({ host, surface: f.surface });
    sb.update();
    expect(track().classList.contains("reck-scrollbar--disabled")).toBe(true);
  });
});

describe("OverlayScrollbar — auto-hide", () => {
  it("shows on scroll and hides after the idle delay", () => {
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    sb = createOverlayScrollbar({ host, surface: f.surface, hideDelayMs: 1000 });
    expect(track().classList.contains("visible")).toBe(false);

    f.fireScroll();
    expect(track().classList.contains("visible")).toBe(true);

    vi.advanceTimersByTime(999);
    expect(track().classList.contains("visible")).toBe(true);
    vi.advanceTimersByTime(2);
    expect(track().classList.contains("visible")).toBe(false);
  });

  it("shows on wheel over the host", () => {
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    sb = createOverlayScrollbar({ host, surface: f.surface, hideDelayMs: 1000 });
    host.dispatchEvent(new Event("wheel"));
    expect(track().classList.contains("visible")).toBe(true);
  });
});

describe("OverlayScrollbar — metrics refresh", () => {
  it("recomputes geometry on a render tick WITHOUT showing the bar", () => {
    // Empty pane at construction → disabled.
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
    sb = createOverlayScrollbar({ host, surface: f.surface });
    expect(disabled()).toBe(true);

    // Scrollback grows; a render tick fires (new output / in-place redraw).
    f.setMetrics({ scrollHeight: 1000 });
    f.fireRender();
    expect(disabled()).toBe(false); // enabled now there's overflow
    expect(visible()).toBe(false); // but NOT flashed into view — output mustn't pop it
  });

  it("a wheel gesture enables AND shows a previously-disabled bar", () => {
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
    sb = createOverlayScrollbar({ host, surface: f.surface, hideDelayMs: 1000 });
    expect(disabled()).toBe(true);

    f.setMetrics({ scrollHeight: 1000 });
    host.dispatchEvent(new Event("wheel"));
    expect(disabled()).toBe(false);
    expect(visible()).toBe(true);
  });

  it("recomputes on host resize via ResizeObserver", () => {
    const observers: Array<() => void> = [];
    class FakeRO {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
    }
    const prev = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
    try {
      const f = fakeSurface({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
      sb = createOverlayScrollbar({ host, surface: f.surface });
      expect(disabled()).toBe(true);
      f.setMetrics({ scrollHeight: 1000 });
      observers.forEach((cb) => cb()); // simulate a host resize
      expect(disabled()).toBe(false);
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = prev;
    }
  });
});

describe("OverlayScrollbar — match ticks", () => {
  it("renders one tick per fraction at the right position", () => {
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    sb = createOverlayScrollbar({ host, surface: f.surface });
    sb.setMatches([0, 0.5, 1]);
    const ticks = host.querySelectorAll(".reck-scrollbar-tick");
    expect(ticks.length).toBe(3);
    expect((ticks[1] as HTMLElement).style.top).toBe("50%");
  });

  it("replaces ticks on a subsequent setMatches and clears on empty", () => {
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    sb = createOverlayScrollbar({ host, surface: f.surface });
    sb.setMatches([0.2, 0.4]);
    expect(host.querySelectorAll(".reck-scrollbar-tick").length).toBe(2);
    sb.setMatches([]);
    expect(host.querySelectorAll(".reck-scrollbar-tick").length).toBe(0);
  });
});

describe("OverlayScrollbar — drag", () => {
  it("dragging the thumb scrolls the surface and toggles a dragging class", () => {
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    sb = createOverlayScrollbar({ host, surface: f.surface });
    thumb().dispatchEvent(new MouseEvent("pointerdown", { clientY: 5, bubbles: true }));
    expect(track().classList.contains("reck-scrollbar--dragging")).toBe(true);

    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 50, bubbles: true }));
    expect(f.surface.scrollToFraction).toHaveBeenCalled();
    const arg = (f.surface.scrollToFraction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(arg).toBeGreaterThanOrEqual(0);
    expect(arg).toBeLessThanOrEqual(1);

    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(track().classList.contains("reck-scrollbar--dragging")).toBe(false);
  });
});

describe("OverlayScrollbar — simulated mode (mouse-tracking TUI)", () => {
  // In a Claude Code / less / vim pane xterm's viewportY is frozen, so the
  // metrics are meaningless. The thumb is driven by cumulative wheel delta:
  // a SIM_TRAVEL of 4000px maps to the track, the thumb is a fixed 16% tall,
  // and bottom=84% top / top=0%.
  const FROZEN = { scrollTop: 25, scrollHeight: 25, clientHeight: 25 };

  it("starts pinned to the bottom and is never disabled despite zero overflow", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    expect(disabled()).toBe(false);
    expect(thumb().style.height).toBe("16%");
    expect(thumb().style.top).toBe("84%"); // (1 - 0) * (100 - 16)
  });

  it("wheel-up raises the thumb, wheel-down lowers it back to the bottom", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    host.dispatchEvent(wheelEvent(-2000)); // up 2000px → simPos=2000 → frac 0.5
    expect(thumb().style.top).toBe("42%"); // (1 - 0.5) * 84
    host.dispatchEvent(wheelEvent(2000)); // down 2000px → back to bottom
    expect(thumb().style.top).toBe("84%");
  });

  it("clamps at the top (SIM_TRAVEL) and the bottom (0)", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    host.dispatchEvent(wheelEvent(-100000)); // far past the travel budget
    expect(thumb().style.top).toBe("0%"); // pinned at the top
    host.dispatchEvent(wheelEvent(100000)); // far past the bottom
    expect(thumb().style.top).toBe("84%"); // pinned at the bottom
  });

  it("normalizes line-mode wheel deltas (deltaMode 1) by the line height", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    host.dispatchEvent(wheelEvent(-125, 1)); // 125 lines * 16px = 2000px → 0.5
    expect(thumb().style.top).toBe("42%");
  });

  it("preventDefault()s the wheel in simulated mode to stop native scroll", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    const e = wheelEvent(-100);
    const spy = vi.spyOn(e, "preventDefault");
    host.dispatchEvent(e);
    expect(spy).toHaveBeenCalled();
  });

  it("does NOT preventDefault in truthful mode — native scroll must still work", () => {
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 }, false);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    const e = wheelEvent(-100);
    const spy = vi.spyOn(e, "preventDefault");
    host.dispatchEvent(e);
    expect(spy).not.toHaveBeenCalled();
  });

  it("flashes the bar into view on a wheel gesture", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface, hideDelayMs: 1000 });
    host.dispatchEvent(wheelEvent(-100));
    expect(visible()).toBe(true);
  });

  it("does not drive the surface when the thumb is dragged (passive indicator)", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    thumb().dispatchEvent(new MouseEvent("pointerdown", { clientY: 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 50, bubbles: true }));
    expect(f.surface.scrollToFraction).not.toHaveBeenCalled();
  });

  it("re-renders the simulated thumb on a render tick without resetting simPos", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    host.dispatchEvent(wheelEvent(-2000)); // simPos → 2000, top 42%
    f.fireRender(); // an in-place TUI redraw
    expect(thumb().style.top).toBe("42%"); // unchanged, NOT pinned back to bottom
    expect(disabled()).toBe(false);
  });
});

describe("OverlayScrollbar — dispose", () => {
  it("removes the DOM and unsubscribes from scroll", () => {
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    sb = createOverlayScrollbar({ host, surface: f.surface });
    expect(f.subCount()).toBe(1);
    expect(f.renderSubCount()).toBe(1);
    sb.dispose();
    expect(host.querySelector(".reck-scrollbar")).toBeNull();
    expect(f.subCount()).toBe(0);
    expect(f.renderSubCount()).toBe(0);
    expect(() => sb.dispose()).not.toThrow();
  });
});
