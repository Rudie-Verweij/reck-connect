// Usage view (issue #88): an overlay modal plotting token burn over
// time — orange bars of tokens per bin (the daemon's authoritative
// per-turn counts) with the account's 5h / 7d quota peaks as lines on
// a 0–100% axis. Four granularities (Day = hour bins, Week/Month = day
// bins, Year = month bins), ‹ › paging, click-a-bar drill-down, ↑
// drill-up, and a project filter. All binning happens on the daemon
// (GET /usage/histogram); this module owns only view state and chrome.
//
// Charting is uPlot: tiny, fast, and unopinionated enough to inherit
// the reck look — every color is read from the app's CSS custom
// properties at build time, and the chart is rebuilt when the theme
// flips.

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ApiClient, UsageHistogramBin } from "@client-core/api/client";
import {
  binLabelFor,
  bucketFor,
  drillDown,
  drillUp,
  labelFor,
  nextDisabled,
  periodFor,
  stepPeriod,
  tzOffsetMin,
  type Granularity,
} from "./usage-range";
import { iconClose } from "./icons";

export interface UsageOverlayOpts {
  api: ApiClient;
}

const GRANULARITIES: Granularity[] = ["day", "week", "month", "year"];

/** "41.2M", "12.3k", "941" — mono-friendly compact token counts. */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
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
  let periodStart = periodFor(granularity, new Date()).start;
  let projectId = ""; // "" = all projects
  let bins: UsageHistogramBin[] = [];
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
        <label class="usage-project-label">Project
          <select class="usage-project"><option value="">All projects</option></select>
        </label>
      </div>
      <div class="usage-chart-wrap">
        <div class="usage-chart"></div>
        <div class="usage-note" hidden></div>
      </div>
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
  const projectSel = overlay.querySelector(".usage-project") as HTMLSelectElement;

  for (const g of GRANULARITIES) {
    const chip = document.createElement("button");
    chip.className = "usage-chip";
    chip.dataset.g = g;
    chip.textContent = g[0].toUpperCase() + g.slice(1);
    chip.addEventListener("click", () => {
      if (g === granularity) return;
      granularity = g;
      periodStart = periodFor(g, new Date()).start;
      void refresh();
    });
    chipsEl.appendChild(chip);
  }

  overlay.querySelectorAll<HTMLButtonElement>(".usage-pager").forEach((btn) => {
    btn.addEventListener("click", () => {
      periodStart = stepPeriod(granularity, periodStart, Number(btn.dataset.dir) as 1 | -1);
      void refresh();
    });
  });

  drillUpBtn.addEventListener("click", () => {
    const up = drillUp(granularity);
    if (!up) return;
    granularity = up;
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

  async function refresh(): Promise<void> {
    // Reflect state in the chrome immediately, then fetch.
    chipsEl.querySelectorAll<HTMLElement>(".usage-chip").forEach((c) => {
      c.classList.toggle("active", c.dataset.g === granularity);
    });
    periodEl.textContent = labelFor(granularity, periodStart);
    drillUpBtn.disabled = drillUp(granularity) === null;
    nextBtn.disabled = nextDisabled(granularity, periodStart, new Date());
    chartWrap.classList.add("loading");
    note("");

    inflight?.abort();
    const ac = new AbortController();
    inflight = ac;
    const { start, until } = periodFor(granularity, periodStart);
    try {
      const resp = await opts.api.getUsageHistogram(
        {
          bucket: bucketFor(granularity),
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
    const when = binLabelFor(granularity, new Date(b.t * 1000));
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

    const width = chartEl.clientWidth || 720;
    const opt: uPlot.Options = {
      width,
      height: 300,
      padding: [12, 8, 0, 8],
      cursor: { drag: { x: false, y: false } },
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
          incrs: [1, 2, 3, 6],
          values: (_u, splits) =>
            splits.map((s) =>
              Number.isInteger(s) && bins[s] ? binLabelFor(granularity, new Date(bins[s].t * 1000)) : "",
            ),
        },
        {
          scale: "tok",
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
        {
          label: "Tokens",
          scale: "tok",
          stroke: orange,
          fill: orange + "d9", // ~85% alpha over the theme background
          paths: uPlot.paths.bars!({ size: [0.6, 100] }),
          points: { show: false },
        },
        {
          label: "5h quota",
          scale: "pct",
          stroke: sage,
          width: 1.5,
          spanGaps: true,
          points: { show: true, size: 4 },
        },
        {
          label: "7d quota",
          scale: "pct",
          stroke: mustard,
          width: 1.5,
          spanGaps: true,
          points: { show: true, size: 4 },
        },
      ],
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            renderReadout(typeof idx === "number" ? idx : null);
          },
        ],
        init: [
          (u) => {
            u.over.addEventListener("click", () => {
              const idx = u.cursor.idx;
              const down = drillDown(granularity);
              if (typeof idx !== "number" || !bins[idx] || !down) return;
              const binDate = new Date(bins[idx].t * 1000);
              granularity = down;
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
  ro = new ResizeObserver(() => {
    if (chart && chartEl.clientWidth > 0) {
      chart.setSize({ width: chartEl.clientWidth, height: 300 });
    }
  });
  ro.observe(chartEl);

  void refresh();
}
