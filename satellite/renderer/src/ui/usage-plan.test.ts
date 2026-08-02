import { describe, expect, it } from "vitest";
import { planLabel, planRangeLabel, planShares } from "./usage-plan";

describe("planLabel", () => {
  it("maps known tiers to display text", () => {
    expect(planLabel("max")).toBe("Max");
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("team")).toBe("Team");
    expect(planLabel("enterprise")).toBe("Enterprise");
  });

  it("calls an API-key/3P session 'API', not 'none'", () => {
    expect(planLabel("none")).toBe("API");
  });

  it("title-cases a tier it has never seen rather than dropping it", () => {
    expect(planLabel("ultra")).toBe("Ultra");
  });

  it("returns empty for unknown and missing", () => {
    expect(planLabel("unknown")).toBe("");
    expect(planLabel(undefined)).toBe("");
    expect(planLabel("")).toBe("");
  });
});

describe("planShares", () => {
  it("orders by day count, largest first", () => {
    const got = planShares({ pro: 5, max: 40, free: 10 });
    expect(got.map((s) => s.subscription)).toEqual(["max", "free", "pro"]);
    expect(got.map((s) => s.days)).toEqual([40, 10, 5]);
  });

  it("breaks ties alphabetically so render order is stable", () => {
    const got = planShares({ pro: 7, max: 7, free: 7 });
    expect(got.map((s) => s.subscription)).toEqual(["free", "max", "pro"]);
  });

  it("drops unknown days and zero counts", () => {
    const got = planShares({ max: 3, unknown: 99, pro: 0 });
    expect(got.map((s) => s.subscription)).toEqual(["max"]);
  });

  it("handles missing input", () => {
    expect(planShares(undefined)).toEqual([]);
    expect(planShares({})).toEqual([]);
  });
});

describe("planRangeLabel", () => {
  it("shows just the tier when the range is on one plan", () => {
    expect(planRangeLabel({ max: 30 })).toBe("Max");
  });

  it("ignores unknown days when deciding the range is single-tier", () => {
    // Days before tracking started must not make a single-plan range
    // look mixed.
    expect(planRangeLabel({ max: 30, unknown: 12 })).toBe("Max");
  });

  it("shows the day composition when the range spans tiers", () => {
    expect(planRangeLabel({ max: 40, free: 10, pro: 5 })).toBe(
      "40d Max · 10d Free · 5d Pro",
    );
  });

  it("returns empty when there is nothing to say", () => {
    expect(planRangeLabel(undefined)).toBe("");
    expect(planRangeLabel({})).toBe("");
    expect(planRangeLabel({ unknown: 30 })).toBe("");
  });
});
