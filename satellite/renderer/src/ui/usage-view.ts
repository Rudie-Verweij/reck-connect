// Usage view (issue #88): an overlay modal plotting token burn over
// time — tokens per bin (the daemon's authoritative per-turn counts)
// with the account's 5h / 7d quota peaks as lines on a 0–100% axis.
// Four granularities with a selectable bin width each (Day: 1 min–4 h,
// Week: 5 min–1 day, Month: 30 min–1 day, Year: 1 day/month); coarse
// widths render bars, fine widths (>96 bins) switch to an area curve.
// ‹ › paging, click-to-drill-down, ↑ drill-up, project filter. All
// binning happens on the daemon (GET /usage/histogram); this module
// owns only view state and chrome.
//
// Charting is uPlot: tiny, fast, and unopinionated enough to inherit
// the reck look — every color is read from the app's CSS custom
// properties at build time, and the chart is rebuilt when the theme
// flips. The legend is non-live (labels/toggles only) and the readout
// line has a reserved height, so hovering never changes the card's
// layout — that was the v1 "chart grows on hover" bug.

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type {
  ApiClient,
  UsageHistogramBin,
  UsageHistogramBucket,
} from "@client-core/api/client";
import {
  BIN_OPTIONS,
  binLabelFor,
  binOptionLabel,
  bucketSeconds,
  defaultBinFor,
  defaultWidthForSpan,
  drillDown,
  drillUp,
  labelFor,
  nextDisabled,
  periodFor,
  rangeLabelFor,
  stepPeriod,
  tzOffsetMin,
  widthsForSpan,
  type Granularity,
} from "./usage-range";
import { iconClose } from "./icons";

export interface UsageOverlayOpts {
  api: ApiClient;
}

const GRANULARITIES: Granularity[] = ["day", "week", "month", "year"];

/** "41.2M", "700k", "941" — mono-friendly compact token counts
 * (trailing ".0" trimmed). */
export function fmtTokens(n: number): string {
  const compact = (v: number, suffix: string) =>
    `${v.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  if (n >= 1e9) return compact(n / 1e9, "B");
  if (n >= 1e6) return compact(n / 1e6, "M");
  if (n >= 1e3) return compact(n / 1e3, "k");
  return String(n);
}

let openOverlay: HTMLElement | null = null;

/** Open the usage overlay (singleton — a second call focuses the
 * existing one). Self-contained: fetches its own project list and
 * histogram data from `opts.api`. */
export function openUsageOverlay(opts: UsageOverlayOpts): void {
  if (openOverlay) {
    (openOverlay.querySelector(".usage-card") as HTMLElement | null)?.focus();
    return;
  }

  // ---- view state -------------------------------------------------
  let granularity: Granularity = "week";
  let bucket: UsageHistogramBucket = defaultBinFor(granularity);
  let periodStart = periodFor(granularity, new Date()).start;
  // Drag-zoom range. Non-null replaces the calendar period with an
  // arbitrary [since, until) span; ↑ or a granularity chip exits.
  let custom: { since: Date; until: Date } | null = null;
  // Set by uPlot's setSelect hook so the click handler on the same
  // mouseup doesn't ALSO fire a drill-down.
  let justSelected = false;
  let projectId = ""; // "" = all projects
  let bins: UsageHistogramBin[] = [];
  // Series visibility, keyed to uPlot series index 1/2/3. Owned here
  // (not by uPlot's legend) so toggles survive the chart rebuilds that
  // every granularity/bin/theme change triggers.
  const shown = { tokens: true, fiveHour: true, sevenDay: true };
  let inflight: AbortController | null = null;
  let chart: uPlot | null = null;
  let ro: ResizeObserver | null = null;
  const prevFocus = document.activeElement as HTMLElement | null;

  // ---- chrome -----------------------------------------------------
  const overlay = document.createElement("div");
  overlay.className = "usage-overlay";
  overlay.innerHTML = `
    <div class="usage-card" role="dialog" aria-label="Usage" tabindex="-1">
      <div class="usage-head">
        <h2 class="usage-title">Usage</h2>
        <div class="usage-chips" role="tablist"></div>
        <button class="icon-btn usage-close" title="Close (Esc)">${iconClose}</button>
      </div>
      <div class="usage-nav">
        <button class="usage-pager" data-dir="-1" title="Previous period">‹</button>
        <span class="usage-period"></span>
        <button class="usage-pager" data-dir="1" title="Next period">›</button>
        <button class="usage-drill-up" title="Zoom out">↑</button>
        <span class="usage-nav-spacer"></span>
        <label class="usage-project-label">Bins
          <select class="usage-project usage-bins" title="Bin width"></select>
        </label>
        <label class="usage-project-label">Project
          <select class="usage-project"><option value="">All projects</option></select>
        </label>
      </div>
      <div class="usage-chart-wrap">
        <div class="usage-chart"></div>
        <div class="usage-note" hidden></div>
      </div>
      <div class="usage-legend" role="group" aria-label="Series"></div>
      <div class="usage-readout" aria-live="polite"></div>
      <div class="usage-stats"></div>
    </div>
  `;
  const card = overlay.querySelector(".usage-card") as HTMLElement;
  const chipsEl = overlay.querySelector(".usage-chips") as HTMLElement;
  const periodEl = overlay.querySelector(".usage-period") as HTMLElement;
  const drillUpBtn = overlay.querySelector(".usage-drill-up") as HTMLButtonElement;
  const nextBtn = overlay.querySelector('.usage-pager[data-dir="1"]') as HTMLButtonElement;
  const chartWrap = overlay.querySelector(".usage-chart-wrap") as HTMLElement;
  const chartEl = overlay.querySelector(".usage-chart") as HTMLElement;
  const noteEl = overlay.querySelector(".usage-note") as HTMLElement;
  const readoutEl = overlay.querySelector(".usage-readout") as HTMLElement;
  const statsEl = overlay.querySelector(".usage-stats") as HTMLElement;
  const legendEl = overlay.querySelector(".usage-legend") as HTMLElement;
  const binsSel = overlay.querySelector(".usage-bins") as HTMLSelectElement;
  const projectSel = overlay.querySelector(".usage-project:not(.usage-bins)") as HTMLSelectElement;

  // Series toggles: one pill per data series (swatch + label). State
  // lives in `shown`; an existing chart is flipped in place via
  // setSeries, and renderChart re-applies the flags on rebuild.
  const SERIES_TOGGLES: Array<{
    key: keyof typeof shown;
    label: string;
    cssColor: string;
    seriesIdx: number;
  }> = [
    { key: "tokens", label: "Tokens", cssColor: "--claude-orange", seriesIdx: 1 },
    { key: "fiveHour", label: "5h quota", cssColor: "--wes-sage", seriesIdx: 2 },
    { key: "sevenDay", label: "7d quota", cssColor: "--wes-mustard", seriesIdx: 3 },
  ];
  for (const t of SERIES_TOGGLES) {
    const btn = document.createElement("button");
    btn.className = "usage-series-toggle";
    btn.dataset.series = t.key;
    btn.setAttribute("aria-pressed", "true");
    btn.title = `Show/hide ${t.label}`;
    const swatch = document.createElement("span");
    swatch.className = "usage-series-swatch";
    swatch.style.background = `var(${t.cssColor})`;
    btn.appendChild(swatch);
    btn.appendChild(document.createTextNode(t.label));
    btn.addEventListener("click", () => {
      shown[t.key] = !shown[t.key];
      btn.classList.toggle("off", !shown[t.key]);
      btn.setAttribute("aria-pressed", String(shown[t.key]));
      // Full rebuild (instant at ≤2k points) rather than setSeries, so
      // an axis with no visible series disappears instead of showing a
      // meaningless autoscaled 0–10 scale.
      renderChart();
    });
    legendEl.appendChild(btn);
  }

  for (const g of GRANULARITIES) {
    const chip = document.createElement("button");
    chip.className = "usage-chip";
    chip.dataset.g = g;
    chip.textContent = g[0].toUpperCase() + g.slice(1);
    chip.addEventListener("click", () => {
      if (g === granularity && custom === null) return;
      custom = null;
      granularity = g;
      bucket = defaultBinFor(g);
      periodStart = periodFor(g, new Date()).start;
      void refresh();
    });
    chipsEl.appendChild(chip);
  }

  binsSel.addEventListener("change", () => {
    bucket = binsSel.value;
    void refresh();
  });

  overlay.querySelectorAll<HTMLButtonElement>(".usage-pager").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dir = Number(btn.dataset.dir) as 1 | -1;
      if (custom) {
        // Page a zoomed range by its own span.
        const span = custom.until.getTime() - custom.since.getTime();
        custom = {
          since: new Date(custom.since.getTime() + span * dir),
          until: new Date(custom.until.getTime() + span * dir),
        };
      } else {
        periodStart = stepPeriod(granularity, periodStart, dir);
      }
      void refresh();
    });
  });

  drillUpBtn.addEventListener("click", () => {
    if (custom) {
      // Exit zoom back to the calendar view containing the range start.
      periodStart = periodFor(granularity, custom.since).start;
      custom = null;
      bucket = defaultBinFor(granularity);
      void refresh();
      return;
    }
    const up = drillUp(granularity);
    if (!up) return;
    granularity = up;
    bucket = defaultBinFor(up);
    periodStart = periodFor(up, periodStart).start;
    void refresh();
  });

  projectSel.addEventListener("change", () => {
    projectId = projectSel.value;
    void refresh();
  });

  const close = () => {
    inflight?.abort();
    chart?.destroy();
    ro?.disconnect();
    themeWatch.disconnect();
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
    openOverlay = null;
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  (overlay.querySelector(".usage-close") as HTMLButtonElement).addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("keydown", onKey, true);

  // Theme flips restyle the whole app via data-theme on <html>; uPlot
  // bakes colors in at construct time, so rebuild the plot.
  const themeWatch = new MutationObserver(() => renderChart());
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  document.body.appendChild(overlay);
  openOverlay = overlay;
  card.focus();

  // Project filter options are best-effort decoration: the view works
  // fine as "All projects" when the list fetch fails.
  void opts.api
    .listProjects()
    .then(({ projects }) => {
      for (const p of projects) {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name;
        projectSel.appendChild(o);
      }
    })
    .catch(() => {});

  // ---- data + chart ------------------------------------------------
  function note(msg: string) {
    noteEl.textContent = msg;
    noteEl.hidden = msg === "";
  }

  function currentRange(): { start: Date; until: Date } {
    if (custom) return { start: custom.since, until: custom.until };
    return periodFor(granularity, periodStart);
  }

  function rebuildBinOptions(): void {
    const spanSec = (currentRange().until.getTime() - currentRange().start.getTime()) / 1000;
    const options = custom ? widthsForSpan(spanSec) : BIN_OPTIONS[granularity];
    binsSel.innerHTML = "";
    for (const b of options) {
      const o = document.createElement("option");
      o.value = b;
      o.textContent = binOptionLabel(b);
      binsSel.appendChild(o);
    }
    if (!options.includes(bucket)) {
      bucket = custom ? defaultWidthForSpan(spanSec) : defaultBinFor(granularity);
    }
    binsSel.value = bucket;
  }

  async function refresh(): Promise<void> {
    // Reflect state in the chrome immediately, then fetch.
    chipsEl.querySelectorAll<HTMLElement>(".usage-chip").forEach((c) => {
      c.classList.toggle("active", custom === null && c.dataset.g === granularity);
    });
    rebuildBinOptions();
    periodEl.textContent = custom
      ? rangeLabelFor(custom.since, custom.until)
      : labelFor(granularity, periodStart);
    drillUpBtn.disabled = custom === null && drillUp(granularity) === null;
    drillUpBtn.title = custom ? "Exit zoom" : "Zoom out";
    nextBtn.disabled = custom
      ? custom.until.getTime() > Date.now()
      : nextDisabled(granularity, periodStart, new Date());
    chartWrap.classList.add("loading");
    note("");

    inflight?.abort();
    const ac = new AbortController();
    inflight = ac;
    const { start, until } = currentRange();
    try {
      const resp = await opts.api.getUsageHistogram(
        {
          bucket,
          since: Math.floor(start.getTime() / 1000),
          until: Math.floor(until.getTime() / 1000),
          projectId: projectId || undefined,
          tzOffsetMin: tzOffsetMin(start),
        },
        { signal: ac.signal },
      );
      if (ac.signal.aborted) return;
      if (!resp.enabled) {
        bins = [];
        renderChart();
        note("Usage tracking isn't enabled on this station.");
        return;
      }
      bins = resp.bins ?? [];
      renderChart();
      if (!bins.some((b) => b.total > 0 || b.five_hour_peak !== undefined)) {
        note("No usage recorded this period — Claude panes write here as they work.");
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      console.warn("[usage-view] histogram fetch failed", err);
      bins = [];
      renderChart();
      note("Couldn't reach the station — check the connection and try again.");
    } finally {
      if (inflight === ac) {
        chartWrap.classList.remove("loading");
      }
    }
  }

  function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Granularity used for bin LABELS only: a zoomed range labels like a
  // day when it stays inside one, like a week when it crosses days.
  function labelGranularity(): Granularity {
    if (!custom) return granularity;
    const s = custom.since;
    const u = new Date(custom.until.getTime() - 1);
    const sameDay =
      s.getFullYear() === u.getFullYear() &&
      s.getMonth() === u.getMonth() &&
      s.getDate() === u.getDate();
    return sameDay ? "day" : "week";
  }

  // Translate a drag selection (fractional bin indices) into a custom
  // range and re-fetch at a width suited to the new span.
  function zoomToSelection(i0: number, i1: number): void {
    if (bins.length === 0) return;
    let lo = Math.round(Math.min(i0, i1));
    let hi = Math.round(Math.max(i0, i1));
    lo = Math.max(0, Math.min(bins.length - 1, lo));
    hi = Math.max(0, Math.min(bins.length - 1, hi));
    if (hi <= lo) hi = Math.min(bins.length - 1, lo + 1);
    if (hi === lo) return; // single-bin view: nothing to zoom into
    const sec = bucketSeconds(bucket);
    const endT =
      hi + 1 < bins.length
        ? bins[hi + 1].t
        : sec !== null
          ? bins[hi].t + sec
          : Math.floor(
              new Date(
                new Date(bins[hi].t * 1000).getFullYear(),
                new Date(bins[hi].t * 1000).getMonth() + 1,
                1,
              ).getTime() / 1000,
            );
    custom = { since: new Date(bins[lo].t * 1000), until: new Date(endT * 1000) };
    bucket = defaultWidthForSpan(endT - bins[lo].t);
    void refresh();
  }

  function renderStats(): void {
    const total = bins.reduce((a, b) => a + b.total, 0);
    const turns = bins.reduce((a, b) => a + b.turns, 0);
    const peak5h = bins.reduce<number | null>(
      (a, b) => (b.five_hour_peak !== undefined && (a === null || b.five_hour_peak > a) ? b.five_hour_peak : a),
      null,
    );
    const parts = [`Σ ${fmtTokens(total)} tokens`, `${turns} turns`];
    if (peak5h !== null) parts.push(`peak 5h ${Math.round(peak5h)}%`);
    statsEl.textContent = parts.join(" · ");
  }

  function renderReadout(idx: number | null): void {
    if (idx === null || !bins[idx]) {
      readoutEl.textContent = "";
      return;
    }
    const b = bins[idx];
    const when = binLabelFor(labelGranularity(), bucket, new Date(b.t * 1000));
    const parts = [
      `${when}`,
      `${fmtTokens(b.total)} tokens (in ${fmtTokens(b.input)} · out ${fmtTokens(b.output)} · cache ${fmtTokens(b.cache_creation + b.cache_read)})`,
      `${b.turns} turns`,
    ];
    if (b.five_hour_peak !== undefined) parts.push(`5h ${Math.round(b.five_hour_peak)}%`);
    if (b.seven_day_peak !== undefined) parts.push(`7d ${Math.round(b.seven_day_peak)}%`);
    readoutEl.textContent = parts.join(" · ");
  }

  function renderChart(): void {
    chart?.destroy();
    chart = null;
    chartEl.innerHTML = "";
    renderStats();
    renderReadout(null);
    if (bins.length === 0) return;

    const orange = cssVar("--claude-orange") || "#d4683a";
    const sage = cssVar("--wes-sage") || "#7a9c6d";
    const mustard = cssVar("--wes-mustard") || "#c9982e";
    const gridCol = cssVar("--app-border") || "#e0ddd3";
    const textDim = cssVar("--app-text-muted") || "#8a877d";

    const xs = bins.map((_, i) => i);
    const totals = bins.map((b) => (b.total > 0 ? b.total : 0));
    const fiveHour = bins.map((b) => b.five_hour_peak ?? null);
    const sevenDay = bins.map((b) => b.seven_day_peak ?? null);

    // Fine bin widths make bars sub-pixel; switch to an area curve so
    // the shape reads as a burn-rate line instead of a picket fence.
    const asLine = bins.length > 96;

    const width = chartWrap.clientWidth || 720;
    const opt: uPlot.Options = {
      width,
      height: 300,
      // Extra left padding when the token axis is hidden, so the first
      // x tick label doesn't clip at the card edge.
      padding: [12, 8, 0, shown.tokens ? 8 : 28],
      // Horizontal drag selects a time span to zoom into (setScale off:
      // WE re-fetch the span at a finer bin width instead of letting
      // uPlot crop the loaded data).
      cursor: { drag: { x: true, y: false, setScale: false } },
      // uPlot's built-in legend is off entirely: the .usage-legend
      // toggle pills own series visibility (uPlot's legend also
      // resized itself on hover when live, shifting the card layout).
      legend: { show: false },
      scales: {
        x: { time: false, range: [-0.5, bins.length - 0.5] },
        tok: { range: (_u, _min, max) => [0, Math.max(max, 10)] },
        pct: { range: [0, 100] },
      },
      axes: [
        {
          stroke: textDim,
          grid: { show: false },
          ticks: { show: false },
          font: `10px ${cssVar("--font-mono") || "monospace"}`,
          space: 70,
          values: (_u, splits) =>
            splits.map((s) =>
              Number.isInteger(s) && bins[s]
                ? binLabelFor(labelGranularity(), bucket, new Date(bins[s].t * 1000))
                : "",
            ),
        },
        {
          scale: "tok",
          show: shown.tokens,
          stroke: textDim,
          grid: { stroke: gridCol, width: 1 },
          ticks: { show: false },
          font: `10px ${cssVar("--font-mono") || "monospace"}`,
          size: 52,
          values: (_u, splits) => splits.map((s) => fmtTokens(s)),
        },
        {
          scale: "pct",
          side: 1,
          show: shown.fiveHour || shown.sevenDay,
          stroke: textDim,
          grid: { show: false },
          ticks: { show: false },
          font: `10px ${cssVar("--font-mono") || "monospace"}`,
          size: 40,
          values: (_u, splits) => splits.map((s) => `${s}%`),
        },
      ],
      series: [
        {},
        asLine
          ? {
              label: "Tokens",
              scale: "tok",
              show: shown.tokens,
              stroke: orange,
              width: 1.5,
              fill: orange + "2e", // ~18% alpha area under the curve
              paths: uPlot.paths.spline!(),
              points: { show: false },
            }
          : {
              label: "Tokens",
              scale: "tok",
              show: shown.tokens,
              stroke: orange,
              fill: orange + "d9", // ~85% alpha over the theme background
              paths: uPlot.paths.bars!({ size: [0.6, 100] }),
              points: { show: false },
            },
        {
          label: "5h quota",
          scale: "pct",
          show: shown.fiveHour,
          stroke: sage,
          width: 1.5,
          spanGaps: true,
          // Stepped, not interpolated: quota is state — the consumed %
          // holds until the next sample changes it. The daemon
          // forward-fills sample-less bins with the last known value
          // (up to "now"), so the line runs to the present even across
          // idle stretches.
          paths: uPlot.paths.stepped!({ align: 1 }),
          // Point markers read well on coarse bins but fuzz the line
          // into a caterpillar at hundreds of bins.
          points: { show: !asLine, size: 4 },
        },
        {
          label: "7d quota",
          scale: "pct",
          show: shown.sevenDay,
          stroke: mustard,
          width: 1.5,
          spanGaps: true,
          paths: uPlot.paths.stepped!({ align: 1 }),
          points: { show: !asLine, size: 4 },
        },
      ],
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            renderReadout(typeof idx === "number" ? idx : null);
          },
        ],
        setSelect: [
          (u) => {
            if (u.select.width < 8) return; // a twitchy click, not a drag
            const i0 = u.posToVal(u.select.left, "x");
            const i1 = u.posToVal(u.select.left + u.select.width, "x");
            justSelected = true;
            zoomToSelection(i0, i1);
          },
        ],
        init: [
          (u) => {
            u.over.addEventListener("click", () => {
              // The mouseup that ends a drag-zoom also fires click.
              if (justSelected) {
                justSelected = false;
                return;
              }
              // Inside a zoomed range, drag is the navigation tool;
              // the calendar drill ladder doesn't apply.
              if (custom) return;
              const idx = u.cursor.idx;
              const down = drillDown(granularity);
              if (typeof idx !== "number" || !bins[idx] || !down) return;
              const binDate = new Date(bins[idx].t * 1000);
              granularity = down;
              bucket = defaultBinFor(down);
              periodStart = periodFor(down, binDate).start;
              void refresh();
            });
          },
        ],
      },
    };
    chart = new uPlot(opt, [xs, totals, fiveHour, sevenDay], chartEl);
  }

  // Keep the plot sized to the card (the overlay is responsive).
  // Observe the WRAP, not chartEl: uPlot's own DOM (canvas + legend)
  // lives inside chartEl, so observing it feeds the observer with the
  // chart's own resizes — the v1 grow-on-hover loop. The width guard
  // stops redundant setSize churn from height-only changes.
  ro = new ResizeObserver(() => {
    const w = chartWrap.clientWidth;
    if (chart && w > 0 && Math.abs(w - chart.width) > 1) {
      chart.setSize({ width: w, height: 300 });
    }
  });
  ro.observe(chartWrap);

  void refresh();
}
