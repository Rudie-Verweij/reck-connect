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
    for (let t = Math.floor(params.since / sec) * sec; t < params.until; t += sec) {
      bins.push(makeBin(t, sec));
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
  // sample-less bins carry the last known percentage forward.
  let last5: number | undefined;
  let last7: number | undefined;
  for (const b of bins) {
    if (b.five_hour_peak !== undefined) last5 = b.five_hour_peak;
    else if (last5 !== undefined) b.five_hour_peak = last5;
    if (b.seven_day_peak !== undefined) last7 = b.seven_day_peak;
    else if (last7 !== undefined) b.seven_day_peak = last7;
  }
  return { enabled: true, bucket: params.bucket, since: params.since, until: params.until, bins };
}

const stubApi = {
  getUsageHistogram: async (params: UsageHistogramParams) => synthHistogram(params),
  listProjects: async () => ({
    projects: [
      { id: "reck-connect", name: "reck-connect" },
      { id: "tokenwarden", name: "tokenwarden" },
    ],
  }),
} as unknown as ApiClient;

document.documentElement.setAttribute(
  "data-theme",
  new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light",
);
openUsageOverlay({ api: stubApi });
