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
    pageScroll: vi.fn(() => true),
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

describe("OverlayScrollbar — mouse-tracking TUI pane (Claude / less / vim)", () => {
  // No exact position exists: Claude runs on the alternate screen (no xterm
  // scrollback) and 2.1.150+ repurposes the wheel to arrow keys. So we DON'T
  // fake a thumb — we translate the wheel to PgUp/PgDn (surface.pageScroll)
  // and keep the bar out of the way, swallowing the event so xterm's broken
  // wheel path never runs.
  const FROZEN = { scrollTop: 0, scrollHeight: 25, clientHeight: 25 };

  it("keeps the bar disabled — never draws a guessed thumb", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    sb.update();
    expect(disabled()).toBe(true);
  });

  it("wheel-up pages up (dir -1), wheel-down pages down (dir +1)", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    host.dispatchEvent(wheelEvent(-100));
    expect(f.surface.pageScroll).toHaveBeenCalledWith(-1);
    host.dispatchEvent(wheelEvent(100));
    expect(f.surface.pageScroll).toHaveBeenCalledWith(1);
  });

  it("accumulates sub-page wheel deltas — one page per ~100px, not per event", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    host.dispatchEvent(wheelEvent(-40));
    host.dispatchEvent(wheelEvent(-40)); // -80, still below the page step
    expect(f.surface.pageScroll).not.toHaveBeenCalled();
    host.dispatchEvent(wheelEvent(-40)); // -120 → crosses one page
    expect(f.surface.pageScroll).toHaveBeenCalledTimes(1);
    expect(f.surface.pageScroll).toHaveBeenCalledWith(-1);
  });

  it("swallows the wheel (preventDefault + stopImmediatePropagation) so xterm never sees it", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    const e = wheelEvent(-100);
    const pd = vi.spyOn(e, "preventDefault");
    const si = vi.spyOn(e, "stopImmediatePropagation");
    host.dispatchEvent(e);
    expect(pd).toHaveBeenCalled();
    expect(si).toHaveBeenCalled();
  });

  it("ignores a horizontal-only wheel (deltaY 0)", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    host.dispatchEvent(wheelEvent(0));
    expect(f.surface.pageScroll).not.toHaveBeenCalled();
  });

  it("the thumb drag is inert (no scrollToFraction — the bar is passive)", () => {
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    thumb().dispatchEvent(new MouseEvent("pointerdown", { clientY: 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 50, bubbles: true }));
    expect(f.surface.scrollToFraction).not.toHaveBeenCalled();
  });

  it("leaves the wheel alone inside a .reck-native-scroll child (transcript overlay)", () => {
    // The History overlay mounts INSIDE the pane wrapper this capture
    // listener sits on. Its DOM scrolls natively — remapping its wheel
    // to PgUp/PgDn would freeze the overlay and page the hidden TUI.
    const f = fakeSurface(FROZEN, true);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    const overlay = document.createElement("div");
    overlay.className = "reck-native-scroll";
    const inner = document.createElement("p");
    overlay.appendChild(inner);
    host.appendChild(overlay);
    const e = wheelEvent(-200);
    const pd = vi.spyOn(e, "preventDefault");
    const si = vi.spyOn(e, "stopImmediatePropagation");
    inner.dispatchEvent(e);
    expect(f.surface.pageScroll).not.toHaveBeenCalled();
    expect(pd).not.toHaveBeenCalled();
    expect(si).not.toHaveBeenCalled();
  });
});

describe("OverlayScrollbar — truthful (plain shell) wheel is untouched", () => {
  it("does NOT preventDefault or remap the wheel — native scroll must still work", () => {
    const f = fakeSurface({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 }, false);
    sb = createOverlayScrollbar({ host, surface: f.surface });
    const e = wheelEvent(-100);
    const spy = vi.spyOn(e, "preventDefault");
    host.dispatchEvent(e);
    expect(spy).not.toHaveBeenCalled();
    expect(f.surface.pageScroll).not.toHaveBeenCalled();
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
