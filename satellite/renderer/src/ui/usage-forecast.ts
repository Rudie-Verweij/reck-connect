// Geometry for the quota burn-rate forecast (issue #130). Pure math — no
// DOM, no uPlot, no canvas — so every case here is unit-testable with plain
// numbers. The painting lives in usage-forecast-paint.ts.
//
// The RATES are not computed here. They arrive on the histogram response,
// derived by the daemon from raw quota_samples, because the binned series
// this view plots is too coarse to fit at anything but Day/5m and its last
// value is a forward-filled per-bin MAX() rather than a reading. This
// module only turns three rates into three polylines in the chart's index
// space, and works out where they cross 100%.
//
// Index space, not time: uPlot is fed bin indices (see usage-view.ts), and
// bins are evenly spaced for every fixed-width bucket, so an instant maps to
// a fractional index by (t - firstBin) / width. The chart's own bin array
// already extends past `now` to the end of the period — the daemon emits
// dense bins across the whole range and simply leaves quota null after now —
// so the forecast fills slots that already exist rather than inventing them.

import type { UsageQuotaForecast } from "@client-core/api/client";

/**
 * How much of the plot the forecast may occupy, as a fraction of the bins
 * already drawn. Day view (288 x 5m) yields ~6h of tail, so a 5h window's
 * reset always fits. A 7d reset almost never does at any zoom — that is
 * expected, and is why `resetIdx` is nullable.
 */
export const HORIZON_TAIL_FRACTION = 0.25;

/** One projected line: 2 or 3 points in (binIndex, percent) space.
 *
 * Three when the projection reaches 100% before the horizon — the line
 * rises to the cap and then runs flat, because quota does not exceed its
 * limit. A single straight segment would draw through the top of the plot. */
export interface ProjectedLine {
  points: Array<[number, number]>;
  /** Unix seconds at which this rate reaches 100%, or null if it does not
   * before the window resets. Reported even when the crossing falls beyond
   * the drawn horizon, so the readout can still name the time. */
  crossesAt: number | null;
}

export interface ForecastGeometry {
  /** Fractional bin index of the projection origin — the latest ACTUAL
   * reading, which is not necessarily the last plotted bin. */
  originIdx: number;
  originPct: number;
  /** Where the drawn lines stop: the reset, or the horizon cap. */
  endIdx: number;
  /** Fractional bin index of the reset, or null when it lies beyond the
   * horizon cap and so cannot be drawn on this view. */
  resetIdx: number | null;
  resetsAt: number;
  low: ProjectedLine;
  centre: ProjectedLine;
  high: ProjectedLine;
}

export interface ForecastGeometryArgs {
  forecast: UsageQuotaForecast;
  /** Start of the first plotted bin, unix seconds. */
  firstBinSec: number;
  /** Fixed bin width in seconds. Calendar-month bins have no fixed width
   * and are not forecastable; callers gate on that before calling. */
  binWidthSec: number;
  /** How many bins are plotted. */
  binCount: number;
  /** Now, unix seconds. Injected rather than read from the clock so the
   * tests are not time-dependent. */
  now: number;
}

/** Clamp a projection to the axis. Quota cannot go below zero or above the
 * limit, so neither may the line drawn for it. */
function clampPct(pct: number): number {
  return Math.min(100, Math.max(0, pct));
}

/** Percent reached `seconds` after the origin at `ratePerHour`. */
export function projectPct(originPct: number, ratePerHour: number, seconds: number): number {
  return clampPct(originPct + (ratePerHour * seconds) / 3600);
}

/**
 * When a rate reaches 100%, or null if it never does before `resetsAt`.
 * A non-positive rate never gets there, and a projection that only crosses
 * after the window has already reset has not crossed at all.
 */
export function crossingTime(
  originTs: number,
  originPct: number,
  ratePerHour: number,
  resetsAt: number,
): number | null {
  if (!(ratePerHour > 0) || originPct >= 100) return null;
  const t = originTs + ((100 - originPct) / ratePerHour) * 3600;
  if (!Number.isFinite(t) || t > resetsAt) return null;
  return t;
}

function buildLine(
  args: ForecastGeometryArgs,
  ratePerHour: number,
  originIdx: number,
  endIdx: number,
  toIdx: (t: number) => number,
): ProjectedLine {
  const { forecast } = args;
  const originPct = forecast.used_percentage;
  const crossesAt = crossingTime(forecast.ts, originPct, ratePerHour, forecast.resets_at);

  const points: Array<[number, number]> = [[originIdx, clampPct(originPct)]];
  if (crossesAt !== null) {
    const crossIdx = toIdx(crossesAt);
    if (crossIdx < endIdx) {
      // Rise to the cap, then run flat to the horizon.
      points.push([crossIdx, 100], [endIdx, 100]);
      return { points, crossesAt };
    }
  }
  const endSec = args.firstBinSec + endIdx * args.binWidthSec;
  points.push([endIdx, projectPct(originPct, ratePerHour, endSec - forecast.ts)]);
  return { points, crossesAt };
}

/**
 * Turn one bucket's forecast into drawable geometry, or null when there is
 * nothing worth drawing on this view.
 *
 * Null when the window has already reset (it describes the past), or when
 * the horizon leaves no room to the right of the origin — which is what
 * happens on a range that ends before now, e.g. after paging back a week.
 */
export function forecastGeometry(args: ForecastGeometryArgs): ForecastGeometry | null {
  const { forecast, firstBinSec, binWidthSec, binCount, now } = args;
  if (!(binWidthSec > 0) || binCount <= 0) return null;
  if (forecast.resets_at <= now) return null;

  const toIdx = (t: number) => (t - firstBinSec) / binWidthSec;

  const originIdx = toIdx(forecast.ts);
  const rawResetIdx = toIdx(forecast.resets_at);
  // Never draw more future than a quarter of the data already on screen:
  // a 7d window would otherwise squash a day's detail into a sliver.
  const cap = binCount - 1 + HORIZON_TAIL_FRACTION * binCount;
  const endIdx = Math.min(rawResetIdx, cap);
  if (!(endIdx > originIdx)) return null;

  return {
    originIdx,
    originPct: clampPct(forecast.used_percentage),
    endIdx,
    resetIdx: rawResetIdx <= cap ? rawResetIdx : null,
    resetsAt: forecast.resets_at,
    low: buildLine(args, forecast.rate_low, originIdx, endIdx, toIdx),
    centre: buildLine(args, forecast.rate_centre, originIdx, endIdx, toIdx),
    high: buildLine(args, forecast.rate_high, originIdx, endIdx, toIdx),
  };
}

/** The x-extent the chart's scale must cover to show the forecast, in bin
 * indices. Returns the plot's own right edge when there is no forecast. */
export function forecastXMax(geometries: Array<ForecastGeometry | null>, binCount: number): number {
  let max = binCount - 0.5;
  for (const g of geometries) {
    if (g && g.endIdx > max) max = g.endIdx;
  }
  return max;
}

/** Smallest gap, in bins, worth drawing a bridge across. Below this the
 * last bin and the latest reading effectively coincide and the segment
 * would be sub-pixel. */
export const MIN_BRIDGE_BINS = 0.05;

/**
 * The segment joining where the plotted line stops to where the projection
 * starts, or null when there is nothing worth drawing.
 *
 * These are genuinely different points, and the difference grows with bin
 * width: a bin is drawn at its START, so the bin containing `now` is
 * plotted up to a full bin-width in the past, while the forecast begins at
 * the latest actual reading. At 30-minute bins that leaves half an hour of
 * blank, which reads as the projection having lost the series rather than
 * continuing it.
 *
 * The segment spans real elapsed time the binning has not caught up with,
 * so it is data rather than projection — the caller draws it solid, in the
 * series colour.
 */
export function bridgeSegment(
  geometry: ForecastGeometry,
  connectFrom: readonly [number, number] | undefined,
): [[number, number], [number, number]] | null {
  if (!connectFrom) return null;
  const [idx, pct] = connectFrom;
  if (Math.abs(geometry.originIdx - idx) < MIN_BRIDGE_BINS) return null;
  return [
    [idx, pct],
    [geometry.originIdx, geometry.originPct],
  ];
}
