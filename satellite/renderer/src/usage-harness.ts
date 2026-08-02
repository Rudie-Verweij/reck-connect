// Dev/e2e harness for the usage overlay (issue #88). Serves the REAL
// openUsageOverlay against a synthetic ApiClient so the chart, bin
// selector, drill-down, and hover behaviour can be exercised (and
// screenshotted by Playwright) without a daemon or usage database.
//
// The stub replicates the daemon's binning contract: given a bucket
// ("<N>m|<N>h|<N>d" or "month"), it enumerates zero-filled bins over
// [since, until) and synthesizes a deterministic workload — a daily
// double-hump of activity plus quota ramps — so every granularity and
// bin width has a plausible shape. No Math.random: screenshots are
// reproducible.

import "./styles.css";
import { openUsageOverlay } from "./ui/usage-view";
import { bucketSeconds } from "./ui/usage-range";
import type {
  ApiClient,
  UsageHistogramBin,
  UsageHistogramParams,
  UsageHistogramResponse,
  UsagePlanDay,
} from "@client-core/api/client";

/** Tokens/sec of synthetic activity at a moment: two humps of work
 * (late morning, evening), zero overnight, deterministic jitter. */
function intensityAt(t: number): number {
  const d = new Date(t * 1000);
  const hour = d.getHours() + d.getMinutes() / 60;
  const morning = Math.exp(-((hour - 10.5) ** 2) / 4);
  const evening = Math.exp(-((hour - 20) ** 2) / 6);
  const intensity = Math.max(0, morning + 0.7 * evening - 0.05);
  const jitter = 0.6 + 0.4 * Math.abs(Math.sin(t * 7919));
  return 220 * intensity * jitter;
}

function makeBin(t: number, spanSec: number): UsageHistogramBin {
  const total = Math.round(intensityAt(t) * spanSec);
  const input = Math.round(total * 0.004);
  const output = Math.round(total * 0.002);
  const cacheCreation = Math.round(total * 0.09);
  const bin: UsageHistogramBin = {
    t,
    input,
    output,
    cache_creation: cacheCreation,
    cache_read: Math.max(0, total - input - output - cacheCreation),
    total,
    turns: total > 0 ? Math.max(1, Math.round(total / 400_000)) : 0,
  };
  if (total > 0) {
    const d = new Date(t * 1000);
    const hour = d.getHours() + d.getMinutes() / 60;
    bin.five_hour_peak = Math.min(95, Math.round(20 + total / (spanSec * 4)));
    bin.seven_day_peak = Math.min(90, Math.round(hour * 3 + 10));
  }
  return bin;
}

function synthHistogram(params: UsageHistogramParams): UsageHistogramResponse {
  const sec = bucketSeconds(params.bucket);
  const bins: UsageHistogramBin[] = [];
  if (sec !== null) {
    // Align to the caller's local midnight, exactly as the daemon does
    // (binStarts in daemon/internal/usage/histogram.go). Aligning to
    // the UTC epoch instead is invisible at widths that divide an hour
    // but puts 4-hour bins two hours off local midnight in UTC+2 — and
    // the day-boundary axis ticks would then sit inside a bin.
    const off = (params.tzOffsetMin ?? 0) * 60;
    for (let k = Math.floor((params.since + off) / sec); k * sec - off < params.until; k++) {
      bins.push(makeBin(k * sec - off, sec));
    }
  } else {
    // Calendar months in the local zone, matching the daemon.
    const start = new Date(params.since * 1000);
    let cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur.getTime() / 1000 < params.until) {
      const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      const span = (next.getTime() - cur.getTime()) / 1000;
      // Months aggregate a lot of idle time; scale down to an average.
      const bin = makeBin(Math.floor(cur.getTime() / 1000) + 12 * 3600, span / 8);
      bin.t = Math.floor(cur.getTime() / 1000);
      bins.push(bin);
      cur = next;
    }
  }
  // Mimic the daemon's quota forward-fill: quota is state, so
  // sample-less bins carry the last known percentage forward — but NEVER
  // past now (histogram.go). The bins themselves still exist across the
  // whole period, which is exactly the empty right-hand region the forecast
  // is drawn into. Tokens go quiet there too: turn_usage has no future rows.
  const now = Math.floor(Date.now() / 1000);
  let last5: number | undefined;
  let last7: number | undefined;
  for (const b of bins) {
    if (b.t > now) {
      b.five_hour_peak = undefined;
      b.seven_day_peak = undefined;
      b.input = b.output = b.cache_creation = b.cache_read = b.total = b.turns = 0;
      continue;
    }
    if (b.five_hour_peak !== undefined) last5 = b.five_hour_peak;
    else if (last5 !== undefined) b.five_hour_peak = last5;
    if (b.seven_day_peak !== undefined) last7 = b.seven_day_peak;
    else if (last7 !== undefined) b.seven_day_peak = last7;
  }
  return {
    enabled: true,
    bucket: params.bucket,
    since: params.since,
    until: params.until,
    bins,
    ...synthPlan(params),
    quota_forecast: synthForecast(bins),
  };
}

/**
 * Live 5h/7d windows with projected burn rates, as the daemon computes them
 * from raw quota_samples.
 *
 * Anchored on the real clock, not on the plotted range: the daemon's
 * `quota_forecast` describes what is true NOW and is deliberately not
 * range-scoped, so the harness must reproduce that or the range-contains-now
 * gate would never be exercised.
 *
 * The 5h rates are chosen so the upper bound crosses 100% before the window
 * resets and the centre does not — the case where the crossing marker and
 * the band's asymmetry both have to render.
 */
function synthForecast(bins: UsageHistogramBin[]): UsageHistogramResponse["quota_forecast"] {
  const now = Math.floor(Date.now() / 1000);

  // Anchor on the last plotted value at or before now, so the projection
  // visually continues the series instead of starting at an unrelated
  // height. The real daemon anchors on the latest RAW reading, which is
  // near-identical at fine bins and is why the origin dot exists.
  const latest = (pick: (b: UsageHistogramBin) => number | undefined): number | undefined => {
    let out: number | undefined;
    for (const b of bins) {
      if (b.t > now) break;
      const v = pick(b);
      if (v !== undefined) out = v;
    }
    return out;
  };

  const fh = latest((b) => b.five_hour_peak);
  const sd = latest((b) => b.seven_day_peak);
  if (fh === undefined && sd === undefined) return undefined;

  return {
    // 5h rates put the upper bound through 100% before the window resets
    // while the centre stays under — the case where the crossing marker and
    // the band's asymmetry both have to render.
    ...(fh === undefined
      ? {}
      : {
          five_hour: {
            ts: now,
            used_percentage: fh,
            resets_at: now + 2 * 3600,
            window_start: now + 2 * 3600 - 5 * 3600,
            rate_centre: 8,
            rate_low: 3,
            rate_high: 40,
          },
        }),
    // A 7d window resets days out, so its marker falls past the horizon cap
    // on every view — the band is drawn clipped, with no reset line.
    ...(sd === undefined
      ? {}
      : {
          seven_day: {
            ts: now,
            used_percentage: sd,
            resets_at: now + 3 * 86400,
            window_start: now + 3 * 86400 - 7 * 86400,
            rate_centre: 0.9,
            rate_low: 0.3,
            rate_high: 1.8,
          },
        }),
  };
}

/**
 * Per-day plan attribution, day-granular whatever the bin width — as the
 * daemon does it (PlanDays in daemon/internal/usage/plan.go).
 *
 * Deliberately reproduces the STALE-SUBSCRIPTION case this feature exists
 * for: `subscription` says "pro" while `rate_limit_tier` says the account
 * is entitled to Max 5x. A harness that agreed with itself would pass
 * whether or not the view reads the right field.
 */
function synthPlan(
  params: UsageHistogramParams,
): Pick<UsageHistogramResponse, "plan_days" | "plan_summary"> {
  // ?tier= overrides the entitlement so both label paths can be exercised:
  // a tier that names a plan ("default_claude_max_5x" -> "Max 5x") and the
  // generic one a Pro account reports ("default_claude_ai"), which names no
  // plan and must fall back to the subscription rather than rendering "Ai".
  const tier =
    new URLSearchParams(location.search).get("tier") ?? "default_claude_max_5x";

  const plan_days: UsagePlanDay[] = [];
  const cur = new Date(params.since * 1000);
  cur.setHours(0, 0, 0, 0);
  while (cur.getTime() / 1000 < params.until && plan_days.length < 400) {
    plan_days.push({
      day: Math.floor(cur.getTime() / 1000),
      subscription: "pro",
      rate_limit_tier: tier,
    });
    cur.setDate(cur.getDate() + 1);
  }
  return { plan_days, plan_summary: { pro: plan_days.length } };
}

// Poll settings live in memory for the harness, so the gear dialog can be
// opened, edited and saved without a daemon.
let pollSettings = { enabled: true, intervalSec: 60, minIntervalSec: 5, maxIntervalSec: 86_400 };

const stubApi = {
  getUsageHistogram: async (params: UsageHistogramParams) => synthHistogram(params),
  listProjects: async () => ({
    projects: [
      { id: "reck-connect", name: "reck-connect" },
      { id: "tokenwarden", name: "tokenwarden" },
    ],
  }),
  getUsagePollSettings: async () => pollSettings,
  putUsagePollSettings: async (next: { enabled: boolean; intervalSec: number }) => {
    // Clamp like the daemon does, so the harness exercises the same
    // "echo back what was accepted" path the real client sees.
    const intervalSec = Math.min(
      Math.max(next.intervalSec, pollSettings.minIntervalSec),
      pollSettings.maxIntervalSec,
    );
    pollSettings = { ...pollSettings, enabled: next.enabled, intervalSec };
    return pollSettings;
  },
} as unknown as ApiClient;

/** The overlay remembers its view state through window.reckAPI.config, which
 *  only exists behind the Electron preload. Back it with sessionStorage so the
 *  harness exercises the real persistence path — and so a Playwright reload can
 *  assert the state actually came back. */
function installConfigStub(): void {
  (window as unknown as { reckAPI: unknown }).reckAPI = {
    config: {
      get: async <T>(k: string): Promise<T | null> => {
        const raw = sessionStorage.getItem(`harness:${k}`);
        return raw === null ? null : (JSON.parse(raw) as T);
      },
      set: async (k: string, v: unknown): Promise<boolean> => {
        sessionStorage.setItem(`harness:${k}`, JSON.stringify(v));
        return true;
      },
    },
  };
}

installConfigStub();
document.documentElement.setAttribute(
  "data-theme",
  new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light",
);
openUsageOverlay({ api: stubApi });
