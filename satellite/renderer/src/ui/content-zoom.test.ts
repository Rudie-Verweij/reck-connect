// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initContentZoom,
  sanitizeFactor,
  zoomedTerminalFontSize,
  TERMINAL_BASE_FONT_PX,
} from "./content-zoom";

let emit: ((factor: number) => void) | null = null;
let unsubCalls = 0;

function installZoomApi(): void {
  (window as unknown as { reckAPI: unknown }).reckAPI = {
    zoom: {
      onSet: (cb: (f: number) => void) => {
        emit = cb;
        return () => {
          unsubCalls++;
          emit = null;
        };
      },
    },
  };
}

beforeEach(() => {
  emit = null;
  unsubCalls = 0;
  document.documentElement.style.removeProperty("--content-zoom");
});

afterEach(() => {
  delete (window as unknown as { reckAPI?: unknown }).reckAPI;
});

describe("sanitizeFactor", () => {
  it("passes a plausible factor through", () => {
    expect(sanitizeFactor(1.25)).toBe(1.25);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "1.5"],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("falls back to 1 for %s", (_label, raw) => {
    // A NaN reaching a font-size blanks the surface — clamp, don't trust.
    expect(sanitizeFactor(raw)).toBe(1);
  });

  it("clamps absurd values instead of honouring them", () => {
    expect(sanitizeFactor(500)).toBeLessThanOrEqual(5);
    expect(sanitizeFactor(0.0001)).toBeGreaterThanOrEqual(0.2);
  });
});

describe("zoomedTerminalFontSize", () => {
  it("scales the base size", () => {
    expect(zoomedTerminalFontSize(2)).toBe(TERMINAL_BASE_FONT_PX * 2);
  });

  it("always returns whole pixels", () => {
    // Fractional sizes give fractional cells, which accumulate into a gap at
    // the right edge of the grid.
    for (const f of [0.7, 0.9, 1.1, 1.25, 1.75]) {
      expect(Number.isInteger(zoomedTerminalFontSize(f))).toBe(true);
    }
  });

  it("never returns less than 1px", () => {
    expect(zoomedTerminalFontSize(0.2, 1)).toBeGreaterThanOrEqual(1);
  });

  it("accepts a custom base size", () => {
    expect(zoomedTerminalFontSize(2, 10)).toBe(20);
  });
});

describe("initContentZoom", () => {
  it("sets the CSS variable to 1 on init", () => {
    installZoomApi();
    initContentZoom();
    expect(
      document.documentElement.style.getPropertyValue("--content-zoom"),
    ).toBe("1");
  });

  it("updates the variable when main pushes a new factor", () => {
    installZoomApi();
    const zoom = initContentZoom();
    emit!(1.5);
    expect(
      document.documentElement.style.getPropertyValue("--content-zoom"),
    ).toBe("1.5");
    expect(zoom.get()).toBe(1.5);
  });

  it("sanitizes a factor arriving over IPC", () => {
    installZoomApi();
    const zoom = initContentZoom();
    emit!(NaN);
    expect(zoom.get()).toBe(1);
  });

  it("works when the zoom API is absent", () => {
    // Harness pages have no preload; the variable must still be initialized.
    let zoom!: ReturnType<typeof initContentZoom>;
    expect(() => (zoom = initContentZoom())).not.toThrow();
    expect(zoom.get()).toBe(1);
    expect(
      document.documentElement.style.getPropertyValue("--content-zoom"),
    ).toBe("1");
  });

  it("applies the variable to the element it was given", () => {
    installZoomApi();
    const el = document.createElement("div");
    initContentZoom(el);
    emit!(1.25);
    expect(el.style.getPropertyValue("--content-zoom")).toBe("1.25");
  });

  describe("subscribers", () => {
    it("fires immediately with the current factor", () => {
      installZoomApi();
      const zoom = initContentZoom();
      emit!(1.5);
      const listener = vi.fn();
      zoom.subscribe(listener);
      // A terminal created after a zoom change must be correct without asking.
      expect(listener).toHaveBeenCalledWith(1.5);
    });

    it("fires on every change", () => {
      installZoomApi();
      const zoom = initContentZoom();
      const listener = vi.fn();
      zoom.subscribe(listener);
      listener.mockClear();
      emit!(1.25);
      emit!(0.9);
      expect(listener.mock.calls).toEqual([[1.25], [0.9]]);
    });

    it("stops firing after unsubscribe", () => {
      installZoomApi();
      const zoom = initContentZoom();
      const listener = vi.fn();
      const off = zoom.subscribe(listener);
      off();
      listener.mockClear();
      emit!(2);
      expect(listener).not.toHaveBeenCalled();
    });

    it("one throwing subscriber does not stop the others", () => {
      installZoomApi();
      const zoom = initContentZoom();
      const good = vi.fn();
      zoom.subscribe(() => {
        throw new Error("boom");
      });
      zoom.subscribe(good);
      good.mockClear();
      expect(() => emit!(1.5)).not.toThrow();
      expect(good).toHaveBeenCalledWith(1.5);
    });
  });

  describe("dispose", () => {
    it("unsubscribes from IPC and drops listeners", () => {
      installZoomApi();
      const zoom = initContentZoom();
      const listener = vi.fn();
      zoom.subscribe(listener);
      zoom.dispose();
      expect(unsubCalls).toBe(1);
    });
  });
});
