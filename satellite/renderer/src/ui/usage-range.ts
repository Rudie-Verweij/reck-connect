// Pure range math for the usage view (issue #88): granularity ↔ server
// bucket mapping, period snapping, prev/next stepping, drill-down /
// drill-up, and range labels. No DOM, no uPlot, no fetch — everything
// here is unit-testable with plain Dates.
//
// All periods are anchored in the *local* timezone via native Date
// component math (new Date(y, m, d) is local by construction). The
// server aligns its fixed-width hour/day bins to the same local
// midnight because the caller sends tz_offset_min. Caveat: the offset
// is a constant snapshot, so day bins spanning a DST switch drift by
// an hour — acceptable for a usage plot.

import type { UsageHistogramBucket } from "@client-core/api/client";

/** The four user-facing views. Each renders one period of bins. */
export type Granularity = "day" | "week" | "month" | "year";

/** Selectable bin widths per view, coarse default last-but-safe. The
 * daemon accepts any "<N>m|<N>h|<N>d" plus calendar "month"; these
 * lists keep the densest choice around ~2000 bins so the response
 * stays small. Fine widths turn the bars into a curve (the chart
 * switches to a line above ~96 bins). */
export const BIN_OPTIONS: Record<Granularity, UsageHistogramBucket[]> = {
  day: ["1m", "2m", "5m", "10m", "30m", "1h", "4h"],
  week: ["5m", "10m", "30m", "1h", "4h", "1d"],
  month: ["30m", "1h", "4h", "1d"],
  year: ["1d", "month"],
};

/** Default bin width per view: Day = hour bins, Week/Month = day bins,
 * Year = calendar-month bins. */
export function defaultBinFor(g: Granularity): UsageHistogramBucket {
  switch (g) {
    case "day":
      return "1h";
    case "week":
    case "month":
      return "1d";
    case "year":
      return "month";
  }
}

/** Fixed bin width in seconds, or null for calendar "month" bins.
 * Accepts the daemon's bucket grammar including legacy "hour"/"day". */
export function bucketSeconds(bucket: UsageHistogramBucket): number | null {
  if (bucket === "month") return null;
  if (bucket === "hour") return 3600;
  if (bucket === "day") return 86400;
  const m = /^(\d+)([mhd])$/.exec(bucket);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 86400;
  return n * unit;
}

/** All fixed bin widths, finest → coarsest (calendar "month" excluded —
 * it has no fixed width and never fits an arbitrary zoom span). */
export const FIXED_WIDTHS: UsageHistogramBucket[] = [
  "1m",
  "2m",
  "5m",
  "10m",
  "30m",
  "1h",
  "4h",
  "1d",
];

/** Bin widths that make sense for an arbitrary drag-zoom span: at
 * least ~6 bins (else there's nothing to see) and at most 2016 (the
 * densest count the standard views offer). Ultra-short spans fall back
 * to the finest width we have. */
export function widthsForSpan(spanSec: number): UsageHistogramBucket[] {
  const out = FIXED_WIDTHS.filter((b) => {
    const s = bucketSeconds(b);
    if (s === null) return false;
    const n = spanSec / s;
    return n >= 6 && n <= 2016;
  });
  return out.length > 0 ? out : [FIXED_WIDTHS[0]];
}

/** Default width for a zoom span: the finest choice that stays at or
 * under ~240 bins — detailed, but not fuzz. */
export function defaultWidthForSpan(spanSec: number): UsageHistogramBucket {
  const options = widthsForSpan(spanSec);
  for (const b of options) {
    const s = bucketSeconds(b);
    if (s !== null && spanSec / s <= 240) return b;
  }
  return options[options.length - 1];
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Label for an arbitrary zoomed range, e.g. "Tue 14 Jul · 09:12–14:30"
 * (same local day) or "13 Jul 14:00 – 14 Jul 02:00" (crossing days).
 * `until` is the exclusive end and is shown as-is. */
export function rangeLabelFor(since: Date, until: Date): string {
  const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const dm = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  const sameDay =
    since.getFullYear() === until.getFullYear() &&
    since.getMonth() === until.getMonth() &&
    since.getDate() === until.getDate();
  if (sameDay) {
    return `${DAYS[since.getDay()]} ${dm(since)} · ${hm(since)}–${hm(until)}`;
  }
  return `${dm(since)} ${hm(since)} – ${dm(until)} ${hm(until)}`;
}

/** Human label for a bin-width option, e.g. "5 min", "1 hour", "Month". */
export function binOptionLabel(bucket: UsageHistogramBucket): string {
  if (bucket === "month") return "Month";
  const m = /^(\d+)([mhd])$/.exec(bucket);
  if (!m) return bucket;
  const n = Number(m[1]);
  const unit = m[2] === "m" ? "min" : m[2] === "h" ? (n === 1 ? "hour" : "hours") : n === 1 ? "day" : "days";
  return `${n} ${unit}`;
}

/** Half-open local period [start, until) containing `anchor`. Weeks
 * start on Monday (ISO). */
export function periodFor(g: Granularity, anchor: Date): { start: Date; until: Date } {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const d = anchor.getDate();
  switch (g) {
    case "day":
      return { start: new Date(y, m, d), until: new Date(y, m, d + 1) };
    case "week": {
      // getDay(): 0 = Sunday … 6 = Saturday; shift so Monday is day 0.
      const dow = (anchor.getDay() + 6) % 7;
      return { start: new Date(y, m, d - dow), until: new Date(y, m, d - dow + 7) };
    }
    case "month":
      return { start: new Date(y, m, 1), until: new Date(y, m + 1, 1) };
    case "year":
      return { start: new Date(y, 0, 1), until: new Date(y + 1, 0, 1) };
  }
}

/** Start of the adjacent period (dir = +1 next, -1 previous). `start`
 * must already be a period start (as produced by periodFor). */
export function stepPeriod(g: Granularity, start: Date, dir: 1 | -1): Date {
  const y = start.getFullYear();
  const m = start.getMonth();
  const d = start.getDate();
  switch (g) {
    case "day":
      return new Date(y, m, d + dir);
    case "week":
      return new Date(y, m, d + 7 * dir);
    case "month":
      return new Date(y, m + dir, 1);
    case "year":
      return new Date(y + dir, 0, 1);
  }
}

/** Finer view a clicked bin drills into, or null when already at hour
 * bins (Day view). Year → that month; Month/Week → that day. */
export function drillDown(g: Granularity): Granularity | null {
  switch (g) {
    case "year":
      return "month";
    case "month":
    case "week":
      return "day";
    case "day":
      return null;
  }
}

/** Coarser view for the ↑ button: a fixed, predictable ladder (the
 * granularity chips allow direct jumps anywhere anyway). */
export function drillUp(g: Granularity): Granularity | null {
  switch (g) {
    case "day":
      return "week";
    case "week":
      return "month";
    case "month":
      return "year";
    case "year":
      return null;
  }
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human label for the current period, e.g. "Tue 14 Jul 2026",
 * "Week of 13 Jul 2026", "July 2026", "2026". */
export function labelFor(g: Granularity, start: Date): string {
  const y = start.getFullYear();
  const mon = MONTHS[start.getMonth()];
  switch (g) {
    case "day":
      return `${DAYS[start.getDay()]} ${start.getDate()} ${mon.slice(0, 3)} ${y}`;
    case "week":
      return `Week of ${start.getDate()} ${mon.slice(0, 3)} ${y}`;
    case "month":
      return `${mon} ${y}`;
    case "year":
      return `${y}`;
  }
}

/** Axis tick / readout label for one bin start, sized to the bin
 * width: sub-day bins show a clock time (prefixed with the day when
 * the view spans several days), day-width bins show the date, month
 * bins the month. */
export function binLabelFor(
  g: Granularity,
  bucket: UsageHistogramBucket,
  binStart: Date,
): string {
  const sec = bucketSeconds(bucket);
  if (sec === null) return MONTHS[binStart.getMonth()].slice(0, 3);
  if (sec < 86400) {
    const hm = `${String(binStart.getHours()).padStart(2, "0")}:${String(binStart.getMinutes()).padStart(2, "0")}`;
    if (g === "day") return hm;
    if (g === "week") return `${DAYS[binStart.getDay()]} ${hm}`;
    return `${binStart.getDate()} · ${hm}`; // month/year with sub-day bins
  }
  switch (g) {
    case "week":
      return `${DAYS[binStart.getDay()]} ${binStart.getDate()}`;
    case "year":
      return `${binStart.getDate()} ${MONTHS[binStart.getMonth()].slice(0, 3)}`;
    default:
      return `${binStart.getDate()}`;
  }
}

/** True when the period after `start` begins in the future — the "›"
 * button disables there (no point paging past now). */
export function nextDisabled(g: Granularity, start: Date, now: Date): boolean {
  return stepPeriod(g, start, 1).getTime() > now.getTime();
}

/** Minutes east of UTC for the histogram request — what the daemon
 * needs to align bins to this machine's local midnight. */
export function tzOffsetMin(anchor: Date): number {
  return -anchor.getTimezoneOffset();
}
