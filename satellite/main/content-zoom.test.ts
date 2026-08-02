import { describe, it, expect } from "vitest";
import {
  ZOOM_STEPS,
  DEFAULT_ZOOM,
  nearestStep,
  stepZoom,
  terminalFontSize,
} from "./content-zoom";

describe("ZOOM_STEPS", () => {
  it("includes 1 so 'reset' lands on a real step", () => {
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM);
  });

  it("is sorted ascending, so stepping in/out is monotonic", () => {
    expect([...ZOOM_STEPS]).toEqual([...ZOOM_STEPS].sort((a, b) => a - b));
  });
});

describe("nearestStep", () => {
  it("returns an exact step unchanged", () => {
    for (const step of ZOOM_STEPS) expect(nearestStep(step)).toBe(step);
  });

  it("snaps a between-steps value", () => {
    expect(nearestStep(1.2)).toBe(1.25);
    expect(nearestStep(1.02)).toBe(1);
  });

  it("clamps beyond either end", () => {
    expect(nearestStep(99)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    expect(nearestStep(0.01)).toBe(ZOOM_STEPS[0]);
  });

  it.each([
    ["a missing value", undefined],
    ["null", null],
    ["a string", "1.5"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["an object", {}],
  ])("resolves %s to the default", (_label, raw) => {
    // This is the sanitizer for a corrupted persisted value — a NaN escaping
    // here would become a NaN font size and blank the terminal.
    expect(nearestStep(raw)).toBe(DEFAULT_ZOOM);
  });
});

describe("stepZoom", () => {
  it("steps up and down through the ladder", () => {
    expect(stepZoom(1, "in")).toBe(1.1);
    expect(stepZoom(1.1, "in")).toBe(1.25);
    expect(stepZoom(1, "out")).toBe(0.9);
  });

  it("reset always returns to 1", () => {
    expect(stepZoom(2, "reset")).toBe(DEFAULT_ZOOM);
    expect(stepZoom(0.7, "reset")).toBe(DEFAULT_ZOOM);
    expect(stepZoom("nonsense", "reset")).toBe(DEFAULT_ZOOM);
  });

  it("stops at the ends instead of running off", () => {
    const max = ZOOM_STEPS[ZOOM_STEPS.length - 1];
    const min = ZOOM_STEPS[0];
    expect(stepZoom(max, "in")).toBe(max);
    expect(stepZoom(min, "out")).toBe(min);
  });

  it("snaps a between-steps current value before stepping", () => {
    // A hand-edited config must not strand the user between steps.
    expect(stepZoom(1.2, "in")).toBe(1.5);
    expect(stepZoom(1.2, "out")).toBe(1.1);
  });

  it("recovers from a corrupted current value", () => {
    expect(stepZoom(NaN, "in")).toBe(1.1);
    expect(stepZoom(undefined, "out")).toBe(0.9);
  });

  it("a full round trip returns to where it started", () => {
    let z: number = DEFAULT_ZOOM;
    for (let i = 0; i < 3; i++) z = stepZoom(z, "in");
    for (let i = 0; i < 3; i++) z = stepZoom(z, "out");
    expect(z).toBe(DEFAULT_ZOOM);
  });
});

describe("terminalFontSize", () => {
  it("scales the base size by the factor", () => {
    expect(terminalFontSize(13, 2)).toBe(26);
    expect(terminalFontSize(13, 1)).toBe(13);
  });

  it("rounds to whole pixels", () => {
    // Fractional sizes give fractional cell widths, which accumulate into a
    // visible gap at the right edge of the grid.
    expect(Number.isInteger(terminalFontSize(13, 1.1))).toBe(true);
    expect(Number.isInteger(terminalFontSize(13, 0.7))).toBe(true);
  });

  it("never returns a size below 1px", () => {
    expect(terminalFontSize(1, 0.7)).toBeGreaterThanOrEqual(1);
  });

  it("sanitizes a corrupted factor rather than producing NaN", () => {
    expect(terminalFontSize(13, NaN)).toBe(13);
    expect(terminalFontSize(13, Infinity)).toBe(13);
  });
});
