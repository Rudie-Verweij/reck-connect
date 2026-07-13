import { describe, expect, it } from "vitest";
import { formatPaneUsage } from "./pane-layout";

describe("formatPaneUsage", () => {
  it("returns empty string for undefined or empty usage", () => {
    expect(formatPaneUsage(undefined)).toBe("");
    expect(formatPaneUsage({})).toBe("");
  });

  it("renders context only", () => {
    expect(formatPaneUsage({ context_pct: 43 })).toBe("ctx 43%");
  });

  it("renders five-hour only", () => {
    expect(formatPaneUsage({ five_hour_pct: 61 })).toBe("5h 61%");
  });

  it("joins both with a middot", () => {
    expect(formatPaneUsage({ context_pct: 43, five_hour_pct: 61 })).toBe("ctx 43% · 5h 61%");
  });

  it("rounds fractional percentages", () => {
    expect(formatPaneUsage({ context_pct: 43.4, five_hour_pct: 60.6 })).toBe("ctx 43% · 5h 61%");
  });

  it("ignores NaN (never renders 'NaN%')", () => {
    expect(formatPaneUsage({ context_pct: Number.NaN, five_hour_pct: 61 })).toBe("5h 61%");
  });

  it("does not render seven_day_pct (badge is ctx + 5h only)", () => {
    expect(formatPaneUsage({ seven_day_pct: 30 })).toBe("");
  });
});
