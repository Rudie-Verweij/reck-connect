// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { fillFromColor, applyHighlightColors, FILL_ALPHA } from "./highlightStyle";

describe("fillFromColor", () => {
  it("converts 6-digit hex to rgba at the fill alpha", () => {
    expect(fillFromColor("#ffc96b")).toBe("rgba(255, 201, 107, 0.5)");
  });

  it("expands 3-digit hex", () => {
    expect(fillFromColor("#0a0")).toBe("rgba(0, 170, 0, 0.5)");
  });

  it("is case-insensitive and tolerates surrounding space", () => {
    expect(fillFromColor("  #FFC96B ")).toBe("rgba(255, 201, 107, 0.5)");
  });

  it("falls back to color-mix for non-hex colours", () => {
    expect(fillFromColor("rebeccapurple")).toBe(
      `color-mix(in srgb, rebeccapurple ${FILL_ALPHA * 100}%, transparent)`,
    );
  });
});

describe("applyHighlightColors", () => {
  it("paints a translucent fill + opaque ring and never sets element opacity", () => {
    const el = document.createElement("div");
    applyHighlightColors(el, "#ffc96b");
    expect(el.style.background).toBe("rgba(255, 201, 107, 0.5)");
    expect(el.style.outline).toBe("1.5px solid #ffc96b");
    expect(el.style.opacity).toBe("");
  });
});
