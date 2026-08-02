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
// Past `now` the quota series get a burn-rate forecast: three projected
// lines to the window's reset with a band between the bounds. The rates
// come from the daemon (computed over raw samples, not these bins); the
// geometry is usage-forecast.ts and the drawing usage-forecast-paint.ts.
//
// The x axis is owned by usage-axis.ts and is deliberately NOT derived
// from the bin width (issue #106): a calendar view ticks on its own
// unit — hours for Day, days for Week/Month, months for Year — so
// changing bin width redraws the data at a different density without
// relabelling the axis under you. Drag-zoomed ranges are the exception
// and still label per bin, having no calendar unit to pin to.
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
  UsagePlanDay,
  UsageQuotaForecast,
  UsageQuotaForecasts,
  UsageHistogramBucket,
} from "@client-core/api/client";
import {
  BIN_OPTIONS,
  DAYS,
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
import { MIN_TICK_PX, axisTicksFor } from "./usage-axis";
import { currentTierLabel, planRangeLabel } from "./usage-plan";
import { forecastGeometry, forecastXMax } from "./usage-forecast";
import { paintForecast, type ForecastLayer } from "./usage-forecast-paint";
import { iconClose, iconDownload, iconGear } from "./icons";
import { confirmDialogOpen } from "./confirmDialog";
import { openUsageExportDialog } from "./usage-export-dialog";
import { openUsagePollDialog } from "./usage-poll-dialog";
import {
  SESSION_VIEW,
  bucketFor,
  noSeriesVisible,
  type UsageBuckets,
  type UsageViewKey,
} from "./usage-prefs";
import { loadUsagePrefs, saveUsagePrefs } from "../config";

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
  // Bin width per granularity, not one shared value: "1 minute" is a
  // considered choice on Day and not offered at all on Year, so a single
  // remembered width meant glancing at Week threw the Day choice away.
  let buckets: UsageBuckets = {};
  let bucket: UsageHistogramBucket = bucketFor(buckets, granularity);
  let periodStart = periodFor(granularity, new Date()).start;
  // Drag-zoom range. Non-null replaces the calendar period with an
  // arbitrary [since, until) span; ↑ or a granularity chip exits.
  let custom: { since: Date; until: Date } | null = null;
  // Set by uPlot's setSelect hook so the click handler on the same
  // mouseup doesn't ALSO fire a drill-down.
  let justSelected = false;
  let projectId = ""; // "" = all projects
  let bins: UsageHistogramBin[] = [];
  // Per-day plan attribution for the visible range. Carries the entitlement
  // (`rate_limit_tier`), which is what distinguishes Max 5x from Max 20x —
  // `plan_summary` is keyed by subscription alone and cannot.
  let planDays: UsagePlanDay[] = [];
  // Live 5h/7d windows and their projected burn rates. Describes NOW, not
  // the plotted range — renderChart checks the range contains now.
  let forecasts: UsageQuotaForecasts | undefined;
  // True while the range is pinned to the live 5h window by the Session
  // chip. It is a `custom` range like any other — this only remembers that
  // the chip put us there, so the chip can read as active and the label can
  // say "Session" instead of a bare pair of timestamps.
  let sessionMode = false;

  /** Which view the bin width is remembered against. Session is a view in
   *  its own right, not a zoom gesture — a width picked there used to be
   *  discarded because it rides on a custom range. A genuine drag-zoom
   *  returns null: its width is derived from the span and remembering it
   *  would let a transient gesture redefine a calendar view. */
  function viewKey(): UsageViewKey | null {
    if (sessionMode) return SESSION_VIEW;
    return custom ? null : granularity;
  }
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
        <span class="usage-plan" hidden></span>
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
        <div class="usage-no-series" hidden>
          <span>No series selected — pick Tokens, 5h quota or 7d quota below.</span>
        </div>
        <div class="usage-note" hidden></div>
        <div class="usage-chart-actions">
          <button class="icon-btn usage-poll-settings" title="Quota polling…">${iconGear}</button>
          <button class="icon-btn usage-download" title="Export usage data as CSV">${iconDownload}</button>
        </div>
      </div>
      <div class="usage-legend" role="group" aria-label="Series"></div>
      <div class="usage-readout" aria-live="polite"></div>
      <div class="usage-stats"></div>
    </div>
  `;
  const card = overlay.querySelector(".usage-card") as HTMLElement;
  const chipsEl = overlay.querySelector(".usage-chips") as HTMLElement;
  const planEl = overlay.querySelector(".usage-plan") as HTMLElement;
  const periodEl = overlay.querySelector(".usage-period") as HTMLElement;
  const drillUpBtn = overlay.querySelector(".usage-drill-up") as HTMLButtonElement;
  const nextBtn = overlay.querySelector('.usage-pager[data-dir="1"]') as HTMLButtonElement;
  const chartWrap = overlay.querySelector(".usage-chart-wrap") as HTMLElement;
  const chartEl = overlay.querySelector(".usage-chart") as HTMLElement;
  const noteEl = overlay.querySelector(".usage-note") as HTMLElement;
  const noSeriesEl = overlay.querySelector(".usage-no-series") as HTMLElement;
  const readoutEl = overlay.querySelector(".usage-readout") as HTMLElement;
  const statsEl = overlay.querySelector(".usage-stats") as HTMLElement;
  const legendEl = overlay.querySelector(".usage-legend") as HTMLElement;
  const binsSel = overlay.querySelector(".usage-bins") as HTMLSelectElement;
  const projectSel = overlay.querySelector(".usage-project:not(.usage-bins)") as HTMLSelectElement;
  const downloadBtn = overlay.querySelector(".usage-download") as HTMLButtonElement;
  const pollSettingsBtn = overlay.querySelector(".usage-poll-settings") as HTMLButtonElement;
  // Mirrors projectSel's options so the export dialog can offer the
  // same filter without refetching the project list.
  const projectOptions: Array<{ id: string; name: string }> = [{ id: "", name: "All projects" }];

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
  /**
   * Remember the shape of the view. Fire-and-forget: a failed write costs the
   * setting on next open, and must never interrupt looking at the chart.
   *
   * The anchor date is intentionally absent — see ui/usage-prefs.ts.
   */
  function persist(): void {
    void saveUsagePrefs({
      granularity,
      buckets: { ...buckets },
      session: sessionMode,
      projectId,
      shown: { ...shown },
    }).catch(
      (e) => console.warn("[usage] could not persist view state:", e),
    );
  }

  /** Push `shown` onto the toggle buttons — needed when prefs restore a state
   *  the buttons were not built with. */
  function syncToggleButtons(): void {
    for (const t of SERIES_TOGGLES) {
      const btn = legendEl.querySelector<HTMLButtonElement>(
        `.usage-series-toggle[data-series="${t.key}"]`,
      );
      if (!btn) continue;
      btn.classList.toggle("off", !shown[t.key]);
      btn.setAttribute("aria-pressed", String(shown[t.key]));
    }
  }

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
      persist();
    });
    legendEl.appendChild(btn);
  }

  // The live 5h window, ahead of the calendar views: it is the range you
  // are actually inside, and the only one whose right-hand edge is a
  // deadline rather than a date. Spans exactly [window start, reset], so
  // the session opens at the left edge and expires at the right.
  //
  // Disabled until a forecast arrives, since the window's bounds come from
  // `quota_forecast` — there is nothing to pin to before then.
  const sessionChip = document.createElement("button");
  sessionChip.className = "usage-chip usage-chip-session";
  sessionChip.dataset.g = "session";
  sessionChip.textContent = "Session";
  sessionChip.disabled = true;
  sessionChip.title = "The live 5-hour quota window";
  /** Pin the range to the live 5h window. Reports whether it could — the
   *  bounds come from `quota_forecast`, so there is nothing to pin to
   *  before a response has landed. */
  function enterSession(): boolean {
    const w = forecasts?.five_hour;
    if (!w) return false;
    custom = { since: new Date(w.window_start * 1000), until: new Date(w.resets_at * 1000) };
    sessionMode = true;
    return true;
  }

  sessionChip.addEventListener("click", () => {
    if (enterSession()) void refresh();
  });
  chipsEl.appendChild(sessionChip);

  for (const g of GRANULARITIES) {
    const chip = document.createElement("button");
    chip.className = "usage-chip";
    chip.dataset.g = g;
    chip.textContent = g[0].toUpperCase() + g.slice(1);
    chip.addEventListener("click", () => {
      if (g === granularity && custom === null) return;
      custom = null;
      sessionMode = false;
      granularity = g;
      bucket = bucketFor(buckets, granularity);
      periodStart = periodFor(g, new Date()).start;
      void refresh();
    });
    chipsEl.appendChild(chip);
  }

  binsSel.addEventListener("change", () => {
    bucket = binsSel.value;
    const view = viewKey();
    if (view) buckets = { ...buckets, [view]: bucket };
    void refresh();
  });

  overlay.querySelectorAll<HTMLButtonElement>(".usage-pager").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dir = Number(btn.dataset.dir) as 1 | -1;
      // Paging lands on the window BEFORE or AFTER this one, which is no
      // longer the session you are in.
      sessionMode = false;
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
    sessionMode = false;
    if (custom) {
      // Exit zoom back to the calendar view containing the range start.
      periodStart = periodFor(granularity, custom.since).start;
      custom = null;
      bucket = bucketFor(buckets, granularity);
      void refresh();
      return;
    }
    const up = drillUp(granularity);
    if (!up) return;
    granularity = up;
    bucket = bucketFor(buckets, up);
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
    // A modal on top of us (the CSV export dialog) owns its own Escape.
    // This listener is on `window`, whose capture phase runs BEFORE the
    // dialog's on `document` — without this guard Escape would close the
    // whole view out from under the dialog and stopPropagation would keep
    // the dialog's own handler from ever running, stranding it on screen.
    if (confirmDialogOpen()) return;
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
  const projectsLoaded = opts.api
    .listProjects()
    .then(({ projects }) => {
      for (const p of projects) {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name;
        projectSel.appendChild(o);
        projectOptions.push({ id: p.id, name: p.name });
      }
    })
    .catch(() => {});

  // Export: hand the dialog exactly the range/bin/project on screen, so
  // "current view" means what it says even after paging or a drag-zoom.
  downloadBtn.addEventListener("click", () => {
    const { start, until } = currentRange();
    void openUsageExportDialog({
      api: opts.api,
      view: {
        since: Math.floor(start.getTime() / 1000),
        until: Math.floor(until.getTime() / 1000),
        bucket,
        projectId,
        tzOffsetMin: tzOffsetMin(start),
      },
      projects: projectOptions,
    });
  });

  // Polling settings. A saved change alters what lands in the store from
  // now on, not what is already plotted, so there is nothing to refresh
  // here — the next refresh() picks up whatever the new cadence wrote.
  pollSettingsBtn.addEventListener("click", () => {
    void openUsagePollDialog({ api: opts.api });
  });

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
    // Session is a fixed five-hour span, so it offers Day's widths rather
    // than span-derived ones — and remembers its own choice among them.
    const options = sessionMode
      ? BIN_OPTIONS.day
      : custom
        ? widthsForSpan(spanSec)
        : BIN_OPTIONS[granularity];
    binsSel.innerHTML = "";
    for (const b of options) {
      const o = document.createElement("option");
      o.value = b;
      o.textContent = binOptionLabel(b);
      binsSel.appendChild(o);
    }
    // The width always follows the VIEW, not whatever was left over from
    // the one before it. Repairing only an invalid width was not enough:
    // switching Week (30m) -> Session kept 30m, because 30m is a legal Day
    // width — so Session's own remembered choice never came back. A width
    // the user picks is written into `buckets` first, so reading it back
    // here returns their selection, not a default.
    const view = viewKey();
    bucket = view ? bucketFor(buckets, view) : defaultWidthForSpan(spanSec);
    if (!options.includes(bucket)) {
      bucket = view ? defaultBinFor(view === SESSION_VIEW ? "day" : view) : options[0];
    }
    binsSel.value = bucket;
  }

  async function refresh(): Promise<void> {
    // Every non-toggle state change funnels through here — granularity chips,
    // bin select, project select, paging, drill up/down — so this is the one
    // place that has to remember them. (Paging only moves the anchor date,
    // which isn't persisted, so those writes are no-ops.)
    persist();
    // Reflect state in the chrome immediately, then fetch.
    chipsEl.querySelectorAll<HTMLElement>(".usage-chip").forEach((c) => {
      c.classList.toggle(
        "active",
        c.dataset.g === "session"
          ? sessionMode
          : custom === null && c.dataset.g === granularity,
      );
    });
    rebuildBinOptions();
    periodEl.textContent = sessionMode
      ? `Session · ${rangeLabelFor(custom!.since, custom!.until)}`
      : custom
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
        planDays = [];
        forecasts = undefined;
        renderPlan(undefined);
        renderChart();
        note("Usage tracking isn't enabled on this station.");
        return;
      }
      bins = resp.bins ?? [];
      planDays = resp.plan_days ?? [];
      forecasts = resp.quota_forecast;
      // The chip pins to [window_start, resets_at], which only exist once a
      // forecast has arrived.
      sessionChip.disabled = !forecasts?.five_hour;
      renderPlan(resp.plan_summary);
      renderChart();
      if (!bins.some((b) => b.total > 0 || b.five_hour_peak !== undefined)) {
        note("No usage recorded this period — Claude panes write here as they work.");
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      console.warn("[usage-view] histogram fetch failed", err);
      bins = [];
      planDays = [];
      forecasts = undefined;
      renderPlan(undefined);
      renderChart();
      note("Couldn't reach the station — check the connection and try again.");
    } finally {
      if (inflight === ac) {
        chartWrap.classList.remove("loading");
      }
    }
  }

  // Plan attribution for the visible range. Always day-granular: a range
  // on one tier reads as that tier, a range spanning several reads as its
  // day composition. Hidden entirely when there is nothing to say, so the
  // header doesn't carry a dangling separator on a station that has never
  // recorded a plan.
  function renderPlan(summary: Record<string, number> | undefined): void {
    const label = planRangeLabel(summary, planDays);
    planEl.textContent = label;
    planEl.hidden = label === "";
    planEl.title = label === "" ? "" : `Subscription plan over this period: ${label}`;
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
    sessionMode = false;
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
    // The tier belongs next to the numbers it gives meaning to: "peak 5h
    // 87%" is 87% OF something, and 87% of Max 5x is not 87% of Pro. The
    // range END rather than its composition, since that is the tier the
    // peak was measured against.
    const tier = currentTierLabel(planDays);
    if (tier !== "") parts.push(tier);
    statsEl.textContent = parts.join(" · ");
  }

  /**
   * Readout for the forecast region — everything right of the last bin.
   *
   * uPlot's `cursor.idx` snaps to a real data point, so it cannot express
   * "the pointer is out past the data"; the x VALUE under the cursor can.
   * Returns "" when the pointer is still over the plotted data, so the
   * caller falls through to the per-bin readout.
   *
   * This is where the crossing time gets said out loud. The band flattening
   * against the ceiling shows THAT you top out; only text can say when.
   */
  function forecastReadout(xVal: number, layers: ForecastLayer[]): string {
    if (layers.length === 0 || xVal <= bins.length - 1) return "";
    const parts: string[] = ["projected"];
    for (const l of layers) {
      const g = l.geometry;
      if (xVal > g.endIdx) continue;
      const at = (line: { points: Array<[number, number]> }) => {
        // Linear between the polyline's points; 2 or 3 of them, so a scan
        // is cheaper and clearer than anything smarter.
        for (let i = 1; i < line.points.length; i++) {
          const [x0, y0] = line.points[i - 1];
          const [x1, y1] = line.points[i];
          if (xVal <= x1) {
            const t = x1 === x0 ? 0 : (xVal - x0) / (x1 - x0);
            return Math.round(y0 + (y1 - y0) * t);
          }
        }
        return Math.round(line.points[line.points.length - 1][1]);
      };
      parts.push(`${l.label} ${at(g.low)}–${at(g.high)}%`);
      const cross = g.high.crossesAt ?? g.centre.crossesAt;
      if (cross !== null) parts.push(`100% from ~${whenLabel(cross)}`);
    }
    return parts.length > 1 ? parts.join(" · ") : "";
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

  /**
   * Local clock time for a reset or crossing, with the weekday prepended
   * once it is not today.
   *
   * A bare "12:45" for something 16 hours away reads as this afternoon —
   * which is exactly the wrong answer to "when do I run out". A 7d window
   * resets days out, so this is the common case, not the edge case.
   */
  function whenLabel(unixSeconds: number): string {
    const d = new Date(unixSeconds * 1000);
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    return sameDay ? hm : `${DAYS[d.getDay()]} ${hm}`;
  }

  /**
   * Drawable forecast layers for the visible quota series.
   *
   * Gated on three things. The bucket must have a fixed width — a burn
   * forecast across calendar months is meaningless, and there is no index
   * arithmetic for them anyway. The series must be toggled on, so hiding
   * "5h quota" hides its projection too. And the plotted range must contain
   * now: `quota_forecast` describes the LIVE windows and is deliberately not
   * range-scoped, so paging back to March would otherwise draw today's
   * projection over March's data.
   */
  function forecastLayers(sage: string, mustard: string): ForecastLayer[] {
    const width = bucketSeconds(bucket);
    if (width === null || bins.length === 0) return [];
    const now = Date.now() / 1000;
    const range = currentRange();
    const inRange =
      range.start.getTime() / 1000 <= now && now < range.until.getTime() / 1000;
    if (!inRange) return [];

    /** The last bin that actually carries a value for a series, as
     *  (index, percent) — where the drawn line stops.
     *
     *  This is NOT where the forecast starts, and at coarse bins the two are
     *  far apart: a bin is plotted at its START, so the bin holding `now` is
     *  drawn up to a full bin-width in the past while the forecast begins at
     *  the latest actual reading. At 30-minute bins that leaves a half-hour
     *  of blank between the line and the projection. The layer carries this
     *  point so the painter can bridge it. */
    const lastPlotted = (pick: (b: UsageHistogramBin) => number | undefined):
      [number, number] | undefined => {
      for (let i = bins.length - 1; i >= 0; i--) {
        const v = pick(bins[i]);
        if (v !== undefined) return [i, v];
      }
      return undefined;
    };

    const wanted: Array<{
      forecast: UsageQuotaForecast | undefined;
      color: string;
      label: string;
      visible: boolean;
      connectFrom: [number, number] | undefined;
    }> = [
      {
        forecast: forecasts?.five_hour,
        color: sage,
        label: "5h",
        visible: shown.fiveHour,
        connectFrom: lastPlotted((b) => b.five_hour_peak),
      },
      {
        forecast: forecasts?.seven_day,
        color: mustard,
        label: "7d",
        visible: shown.sevenDay,
        connectFrom: lastPlotted((b) => b.seven_day_peak),
      },
    ];
    const out: ForecastLayer[] = [];
    for (const w of wanted) {
      if (!w.forecast || !w.visible) continue;
      const geometry = forecastGeometry({
        forecast: w.forecast,
        firstBinSec: bins[0].t,
        binWidthSec: width,
        binCount: bins.length,
        now,
      });
      if (!geometry) continue;
      out.push({
        geometry,
        color: w.color,
        label: w.label,
        formatTime: whenLabel,
        connectFrom: w.connectFrom,
      });
    }
    return out;
  }

  function renderChart(): void {
    chart?.destroy();
    chart = null;
    chartEl.innerHTML = "";
    renderStats();
    renderReadout(null);
    // With every series toggled off the plot is blank, which is
    // indistinguishable from "no usage in this period". Say which it is.
    noSeriesEl.hidden = !noSeriesVisible(shown);
    if (bins.length === 0) return;

    const orange = cssVar("--claude-orange") || "#d4683a";
    const sage = cssVar("--wes-sage") || "#7a9c6d";
    const mustard = cssVar("--wes-mustard") || "#c9982e";
    const mustardDeep = cssVar("--wes-mustard-deep") || "#a37a24";
    const gridCol = cssVar("--app-border") || "#e0ddd3";
    const textDim = cssVar("--app-text-muted") || "#8a877d";

    // Forecast geometry for whichever quota series are visible. Computed
    // before the options object because the x scale has to be widened to
    // make room for it.
    const layers = forecastLayers(sage, mustard);
    const xMax = forecastXMax(
      layers.map((l) => l.geometry),
      bins.length,
    );

    const xs = bins.map((_, i) => i);
    const totals = bins.map((b) => (b.total > 0 ? b.total : 0));
    const fiveHour = bins.map((b) => b.five_hour_peak ?? null);
    const sevenDay = bins.map((b) => b.seven_day_peak ?? null);

    // Fine bin widths make bars sub-pixel; switch to an area curve so
    // the shape reads as a burn-rate line instead of a picket fence.
    const asLine = bins.length > 96;

    const width = chartWrap.clientWidth || 720;

    // Room the plot area itself gets, once the y axes and padding are
    // taken off — the budget the tick count is fitted to. Mirrors the
    // `padding` and axis `size` values set below; an estimate is fine,
    // it only decides how many labels we ask for.
    const plotWidthPx =
      width -
      (shown.tokens ? 52 + 8 : 28) -
      (shown.fiveHour || shown.sevenDay ? 40 + 8 : 8);

    // Calendar ticks for the four standard views. A drag-zoomed range
    // gets `null` and falls back to labelling whatever bins uPlot's own
    // splits land on, since an arbitrary span has no calendar unit.
    const range = currentRange();
    const calendarTicks =
      custom === null
        ? axisTicksFor({
            granularity,
            start: range.start,
            until: range.until,
            binStartsSec: bins.map((b) => b.t),
            binWidthSec: bucketSeconds(bucket),
            plotWidthPx,
          })
        : null;

    const xAxis: uPlot.Axis = {
      stroke: textDim,
      grid: { show: false },
      ticks: { show: false },
      font: `10px ${cssVar("--font-mono") || "monospace"}`,
      space: MIN_TICK_PX,
    };
    if (calendarTicks) {
      // Keyed by the split value rather than by position: uPlot hands
      // `values` whatever `splits` returned, and keying on identity
      // survives it filtering or reordering the array on us.
      const labelByIdx = new Map(calendarTicks.map((t) => [t.idx, t.label]));
      xAxis.splits = () => calendarTicks.map((t) => t.idx);
      xAxis.values = (_u, splits) => splits.map((s) => labelByIdx.get(s) ?? "");
    } else {
      xAxis.values = (_u, splits) =>
        splits.map((s) =>
          Number.isInteger(s) && bins[s]
            ? binLabelFor(labelGranularity(), bucket, new Date(bins[s].t * 1000))
            : "",
        );
    }

    // The export button floats at the plot area's top-right corner. Its inset
    // mirrors the right padding below plus the pct axis, which only exists
    // while a quota series is shown — same condition as the axis itself.
    chartWrap.style.setProperty(
      "--usage-plot-right",
      `${8 + (shown.fiveHour || shown.sevenDay ? 40 : 0)}px`,
    );

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
        // Widened past the data when a forecast is drawn — the projection
        // lives entirely to the right of the last bin.
        x: { time: false, range: [-0.5, xMax] },
        tok: { range: (_u, _min, max) => [0, Math.max(max, 10)] },
        pct: { range: [0, 100] },
      },
      axes: [
        xAxis,
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
        // Last pass, so the projection sits over the data rather than
        // under it. See usage-forecast-paint.ts for why this is a draw
        // hook and not uPlot's native `bands`.
        draw: [
          (u) => paintForecast(u, { layers, bandColor: mustardDeep, textColor: textDim }),
        ],
        setCursor: [
          (u) => {
            const left = u.cursor.left;
            if (typeof left === "number" && left >= 0) {
              const projected = forecastReadout(u.posToVal(left, "x"), layers);
              if (projected !== "") {
                readoutEl.textContent = projected;
                return;
              }
            }
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
              bucket = bucketFor(buckets, down);
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

  // Restore the remembered view, then do the first fetch — one round trip, and
  // no flash of the default view first.
  //
  // The project filter waits for the option list: assigning a <select> value
  // before its <option> exists silently keeps the old value, which would have
  // quietly dropped a remembered project filter. A remembered project that no
  // longer exists leaves the select on "All projects", and reading the value
  // back keeps state and chrome in agreement.
  void (async () => {
    const prefs = await loadUsagePrefs().catch(() => null);
    if (prefs) {
      granularity = prefs.granularity;
      buckets = prefs.buckets;
      bucket = bucketFor(buckets, granularity);
      Object.assign(shown, prefs.shown);
      // Deliberately NOT restored: the anchor date. Reopening a "Day" view
      // shows today, not the day last paged to.
      periodStart = periodFor(granularity, new Date()).start;
      syncToggleButtons();
      if (prefs.projectId) {
        await projectsLoaded;
        projectSel.value = prefs.projectId;
        projectId = projectSel.value;
      }
    }
    await refresh();

    // Session last, and only after that first fetch: the window's bounds
    // ride in on `quota_forecast`, so there is nothing to pin to until a
    // response has landed. Costs a second round trip, but only for someone
    // who was actually in the session view when they closed it — and the
    // alternative is opening on a view they did not leave.
    if (prefs?.session && enterSession()) {
      await refresh();
    }
  })();
}
