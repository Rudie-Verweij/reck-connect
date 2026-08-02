import { describe, expect, it } from "vitest";
import type { UsageQuotaForecast } from "@client-core/api/client";
import {
  HORIZON_TAIL_FRACTION,
  MIN_BRIDGE_BINS,
  bridgeSegment,
  crossingTime,
  forecastGeometry,
  forecastXMax,
  projectPct,
} from "./usage-forecast";

// A Day view: 288 five-minute bins starting at local midnight.
const BIN = 300;
const FIRST = 1_770_000_000; // arbitrary, but fixed — nothing here is clock-dependent
const COUNT = 288;

/** `now` two hours into the day, i.e. at bin index 24. */
const NOW = FIRST + 2 * 3600;

function forecast(over: Partial<UsageQuotaForecast> = {}): UsageQuotaForecast {
  return {
    ts: NOW,
    used_percentage: 40,
    resets_at: NOW + 2 * 3600,
    window_start: NOW + 2 * 3600 - 5 * 3600,
    rate_centre: 10,
    rate_low: 5,
    rate_high: 20,
    ...over,
  };
}

const geom = (over: Partial<UsageQuotaForecast> = {}, now = NOW) =>
  forecastGeometry({
    forecast: forecast(over),
    firstBinSec: FIRST,
    binWidthSec: BIN,
    binCount: COUNT,
    now,
  });

describe("projectPct", () => {
  it("advances at the given rate", () => {
    expect(projectPct(40, 10, 3600)).toBe(50);
    expect(projectPct(40, 10, 1800)).toBe(45);
  });

  it("clamps to the axis — quota does not exceed its own limit", () => {
    expect(projectPct(90, 60, 3600)).toBe(100);
    expect(projectPct(10, -60, 3600)).toBe(0);
  });
});

describe("crossingTime", () => {
  it("finds when a rate reaches 100%", () => {
    // 40% climbing at 20 %/h needs 3 hours.
    expect(crossingTime(NOW, 40, 20, NOW + 10 * 3600)).toBe(NOW + 3 * 3600);
  });

  it("is null when the crossing falls after the window has reset", () => {
    // It would take 3h, but the window resets in 1h — so it never happens.
    expect(crossingTime(NOW, 40, 20, NOW + 3600)).toBeNull();
  });

  it("is null for a rate that never gets there", () => {
    expect(crossingTime(NOW, 40, 0, NOW + 100 * 3600)).toBeNull();
    expect(crossingTime(NOW, 40, -5, NOW + 100 * 3600)).toBeNull();
  });
});

describe("forecastGeometry", () => {
  it("maps the origin and the reset into bin-index space", () => {
    const g = geom()!;
    expect(g).not.toBeNull();
    expect(g.originIdx).toBe(24); // 2h in at 5-minute bins
    expect(g.resetIdx).toBe(48); // 4h in
    expect(g.endIdx).toBe(48); // the reset is well inside the cap
    expect(g.originPct).toBe(40);
  });

  it("draws a straight segment when the projection stays under 100%", () => {
    const g = geom()!;
    // low = 5 %/h over 2h -> 50%.
    expect(g.low.points).toEqual([
      [24, 40],
      [48, 50],
    ]);
    expect(g.low.crossesAt).toBeNull();
  });

  it("rises to the cap then runs flat once it reaches 100%", () => {
    // 40% at 60 %/h reaches 100% in exactly one hour — bin index 36.
    const g = geom({ rate_high: 60 })!;
    expect(g.high.points).toEqual([
      [24, 40],
      [36, 100],
      [48, 100],
    ]);
    expect(g.high.crossesAt).toBe(NOW + 3600);
  });

  it("keeps the bounds ordered all the way to the horizon", () => {
    const g = geom()!;
    const endPct = (line: { points: Array<[number, number]> }) =>
      line.points[line.points.length - 1][1];
    expect(endPct(g.low)).toBeLessThanOrEqual(endPct(g.centre));
    expect(endPct(g.centre)).toBeLessThanOrEqual(endPct(g.high));
  });

  it("projects from the reading's own timestamp, not from the plot edge", () => {
    // The latest reading is 30 minutes stale; the line must start there.
    const g = geom({ ts: NOW - 1800, used_percentage: 35 })!;
    expect(g.originIdx).toBe(18);
    expect(g.originPct).toBe(35);
  });

  describe("the horizon cap", () => {
    it("stops a far-off reset at a quarter of the plot", () => {
      // A 7d window: the reset is days away and cannot be drawn here.
      const g = geom({ resets_at: NOW + 5 * 86400 })!;
      const cap = COUNT - 1 + HORIZON_TAIL_FRACTION * COUNT;
      expect(g.endIdx).toBe(cap);
      expect(g.resetIdx).toBeNull(); // caller reports the time as text instead
    });

    it("leaves a reset inside the cap drawable", () => {
      const g = geom()!;
      expect(g.resetIdx).not.toBeNull();
      expect(g.endIdx).toBe(g.resetIdx);
    });
  });

  describe("withholds geometry", () => {
    it("when the window has already reset", () => {
      expect(geom({ resets_at: NOW - 60 })).toBeNull();
    });

    it("when the range ends before now — e.g. after paging back a week", () => {
      // Origin and reset both sit past the right edge, so there is no room
      // to the right of the origin to draw into.
      const past = FIRST - 30 * 86400;
      expect(
        forecastGeometry({
          forecast: forecast(),
          firstBinSec: past,
          binWidthSec: BIN,
          binCount: COUNT,
          now: NOW,
        }),
      ).toBeNull();
    });

    it("for calendar bins, which have no fixed width", () => {
      expect(
        forecastGeometry({
          forecast: forecast(),
          firstBinSec: FIRST,
          binWidthSec: 0,
          binCount: COUNT,
          now: NOW,
        }),
      ).toBeNull();
    });

    it("for an empty plot", () => {
      expect(
        forecastGeometry({
          forecast: forecast(),
          firstBinSec: FIRST,
          binWidthSec: BIN,
          binCount: 0,
          now: NOW,
        }),
      ).toBeNull();
    });
  });
});

describe("forecastXMax", () => {
  it("is the plot's own edge when nothing is forecast", () => {
    expect(forecastXMax([null, null], COUNT)).toBe(COUNT - 0.5);
  });

  it("stretches to the furthest horizon so no line is clipped", () => {
    const near = geom()!;
    const far = geom({ resets_at: NOW + 5 * 86400 })!;
    expect(forecastXMax([near, far], COUNT)).toBe(far.endIdx);
  });

  it("never shrinks the plot below its own data", () => {
    // A forecast ending inside the plotted range must not pull the axis in.
    const g = geom({ resets_at: NOW + 600 })!;
    expect(forecastXMax([g], COUNT)).toBe(COUNT - 0.5);
  });
});

describe("bridgeSegment", () => {
  it("joins the last plotted bin to the projection's origin", () => {
    // The reported bug: at 30-minute bins the last bin is drawn at its
    // START, so it sits up to a full bin-width behind the latest reading
    // and the projection appeared to begin out of nowhere.
    const g = geom()!;
    expect(g.originIdx).toBe(24); // the reading, 2h in
    const seg = bridgeSegment(g, [22, 36]); // last bin drawn 10 min earlier
    expect(seg).toEqual([
      [22, 36],
      [24, 40],
    ]);
  });

  it("is null when the gap is too small to see", () => {
    // Fine bins: the last bin and the latest reading effectively coincide,
    // and the segment would be sub-pixel.
    const g = geom()!;
    expect(bridgeSegment(g, [g.originIdx, g.originPct])).toBeNull();
    expect(bridgeSegment(g, [g.originIdx - MIN_BRIDGE_BINS / 2, 40])).toBeNull();
  });

  it("is null when the series has no plotted point to join from", () => {
    expect(bridgeSegment(geom()!, undefined)).toBeNull();
  });

  it("bridges backwards too, if a bin is drawn ahead of the reading", () => {
    // Defensive: the sign of the gap should not matter.
    const g = geom()!;
    expect(bridgeSegment(g, [26, 44])).toEqual([
      [26, 44],
      [24, 40],
    ]);
  });
});
