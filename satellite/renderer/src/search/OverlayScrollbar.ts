// `OverlayScrollbar` — a reusable, auto-hiding, Reck-themed scrollbar that
// works over any `ScrollSurface` (terminal / markdown / CodeMirror). It
// fades in on scroll or wheel activity and fades out after a short idle,
// supports drag-to-scroll, and renders search-match tick marks along the
// track.
//
// Geometry is expressed in percentages (not pixels) so it needs no layout
// measurement — it works the same in the Electron renderer and under
// jsdom, and stays correct across resizes without a ResizeObserver.
//
// Two behaviours, chosen from `surface.ownsScroll()`:
//
//   • Truthful  (plain-shell terminal, markdown, CodeMirror): the thumb's size
//     and position come from the real scroll metrics, and the native wheel
//     scrolls the surface. Unchanged.
//   • TUI pane  (mouse-tracking TUI — Claude Code, less, vim): there is NO
//     exact position to draw — the app runs on the alternate screen (no xterm
//     scrollback) and grabs the wheel. We do NOT fake a thumb; we keep the bar
//     hidden and translate the wheel into PgUp/PgDn keystrokes sent to the PTY
//     (`surface.pageScroll`) so the app scrolls its own transcript. (Claude
//     2.1.150+ ignores wheel-as-mouse for scroll; PgUp/PgDn works regardless.)

import type { ScrollSurface } from "./scrollSurfaces";

export interface OverlayScrollbarOptions {
  /** Positioned-relative element to mount the bar into (the pane wrapper
   *  or viewer body's offset parent). */
  host: HTMLElement;
  surface: ScrollSurface;
  /** Idle delay before fading out. Default 1400ms. */
  hideDelayMs?: number;
  /** Minimum thumb size as a percentage of the track. Default 8. */
  minThumbPct?: number;
}

export interface OverlayScrollbar {
  /** Recompute the thumb from the surface's current metrics (or, in a
   *  mouse-tracking pane, from the simulated wheel-delta position). */
  update(): void;
  /** Render match tick marks at the given fractional positions (0..1). */
  setMatches(fractions: readonly number[]): void;
  /** Show the bar and (re)start the idle fade timer. */
  flashShow(): void;
  dispose(): void;
}

const DEFAULT_HIDE_DELAY_MS = 1400;
const DEFAULT_MIN_THUMB_PCT = 8;

// Wheel → PgUp/PgDn stepping for a mouse-tracking TUI pane. A TUI only scrolls
// by whole pages (PgUp/PgDn), so we accumulate normalized wheel delta and emit
// one page key per ~notch — a trackpad swipe pages a few times, not dozens.
const PAGE_STEP_PX = 100;
const WHEEL_LINE_PX = 16; // deltaMode 1 (lines) → px
const WHEEL_PAGE_PX = 800; // deltaMode 2 (pages) → px

export function createOverlayScrollbar(
  opts: OverlayScrollbarOptions,
): OverlayScrollbar {
  const hideDelayMs = opts.hideDelayMs ?? DEFAULT_HIDE_DELAY_MS;
  const minThumbPct = opts.minThumbPct ?? DEFAULT_MIN_THUMB_PCT;

  const track = document.createElement("div");
  track.className = "reck-scrollbar";
  const thumb = document.createElement("div");
  thumb.className = "reck-scrollbar-thumb";
  const ticksLayer = document.createElement("div");
  ticksLayer.className = "reck-scrollbar-ticks";
  track.appendChild(ticksLayer);
  track.appendChild(thumb);
  opts.host.appendChild(track);

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let dragging = false;
  let disposed = false;
  // Accumulated normalized wheel delta for TUI-pane page stepping (px).
  let wheelAcc = 0;

  /** True when the surface owns scrolling — a mouse-tracking TUI (Claude Code,
   *  less, vim). Re-evaluated per call because Claude toggles mouse tracking on
   *  launch/exit within a single long-lived pane. */
  function isTuiPane(): boolean {
    return opts.surface.ownsScroll?.() === true;
  }

  function update(): void {
    if (isTuiPane()) {
      // No exact position exists (alt-screen, no xterm scrollback). Don't fake
      // a thumb — scrolling is handled by wheel → PgUp/PgDn. Keep the bar out
      // of the way.
      track.classList.add("reck-scrollbar--disabled");
      return;
    }
    renderTruthful();
  }

  // Truthful: size and position the thumb from the real scroll metrics, and
  // disable the bar when there's nothing to scroll.
  function renderTruthful(): void {
    const m = opts.surface.getMetrics();
    const scrollable = m.scrollHeight - m.clientHeight;
    if (scrollable <= 0 || m.scrollHeight <= 0) {
      track.classList.add("reck-scrollbar--disabled");
      return;
    }
    track.classList.remove("reck-scrollbar--disabled");
    const heightPct = Math.max(
      minThumbPct,
      Math.min(100, (m.clientHeight / m.scrollHeight) * 100),
    );
    const fraction = clamp01(m.scrollTop / scrollable);
    const topPct = fraction * (100 - heightPct);
    thumb.style.height = `${trim(heightPct)}%`;
    thumb.style.top = `${trim(topPct)}%`;
  }

  function setMatches(fractions: readonly number[]): void {
    ticksLayer.replaceChildren();
    for (const f of fractions) {
      const tick = document.createElement("div");
      tick.className = "reck-scrollbar-tick";
      tick.style.top = `${trim(clamp01(f) * 100)}%`;
      ticksLayer.appendChild(tick);
    }
  }

  function flashShow(): void {
    track.classList.add("visible");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (!dragging) track.classList.remove("visible");
    }, hideDelayMs);
  }

  function onScroll(): void {
    update();
    flashShow();
  }

  function onWheel(e: WheelEvent): void {
    if (isTuiPane()) {
      // Claude 2.1.150+ turns the wheel into arrow keys, and the alt-screen has
      // no scrollback to move. Drive the robust keyboard scroll instead: wheel
      // → PgUp/PgDn into the PTY, accumulated so one notch ≈ one page (a
      // trackpad swipe doesn't fly through). Swallow the event (capture phase)
      // so xterm's broken wheel handler never runs.
      const dy = wheelDeltaPx(e);
      if (dy === 0) return; // horizontal / empty — leave it alone
      wheelAcc += dy;
      const dir = wheelAcc < 0 ? -1 : 1;
      while (Math.abs(wheelAcc) >= PAGE_STEP_PX) {
        opts.surface.pageScroll?.(dir);
        wheelAcc -= dir * PAGE_STEP_PX;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Truthful mode: do NOT preventDefault — the native scroll is what moves
    // the viewport and fires onScroll. Recompute and flash the bar into view.
    update();
    flashShow();
  }

  function onPointerDown(e: Event): void {
    // Drag-to-drive is only meaningful in truthful mode. In a mouse-tracking
    // pane the bar is hidden and the wheel pages via PgUp/PgDn, so there's
    // nothing to drag — swallow the grab.
    if (isTuiPane()) return;
    dragging = true;
    track.classList.add("reck-scrollbar--dragging");
    track.classList.add("visible");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    seekTo(e as MouseEvent);
  }

  function onPointerMove(e: Event): void {
    if (!dragging) return;
    seekTo(e as MouseEvent);
  }

  function onPointerUp(): void {
    dragging = false;
    track.classList.remove("reck-scrollbar--dragging");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    flashShow();
  }

  function seekTo(e: MouseEvent): void {
    const rect = track.getBoundingClientRect();
    const height = rect.height || 1; // jsdom has no layout
    const fraction = clamp01((e.clientY - rect.top) / height);
    opts.surface.scrollToFraction(fraction);
  }

  const offScroll = opts.surface.onScroll(onScroll);
  // Recompute geometry (and clear `--disabled` once scrollback exists, or
  // re-paint the simulated thumb at its current position) when the surface
  // re-renders, WITHOUT flashing the bar into view — output and in-place TUI
  // redraws must not pop the scrollbar; only real scroll/wheel does that.
  const offRender = opts.surface.onRender?.(() => update()) ?? null;
  // Capture phase + non-passive: a mouse-tracking TUI (Claude Code) consumes
  // the wheel to scroll its own view, so it never bubbles to the host.
  // Capture fires `onWheel` BEFORE xterm/the TUI swallows it (so the bar still
  // tracks over a terminal pane), and non-passive lets simulated mode
  // `preventDefault()` the native viewport scroll.
  opts.host.addEventListener("wheel", onWheel, { passive: false, capture: true });
  thumb.addEventListener("pointerdown", onPointerDown);

  // Resize of the host (pane re-layout, font change) changes the metrics too.
  // Guarded — jsdom has no ResizeObserver.
  let resizeObs: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObs = new ResizeObserver(() => update());
    resizeObs.observe(opts.host);
  }

  update();

  return {
    update,
    setMatches,
    flashShow,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (hideTimer) clearTimeout(hideTimer);
      offScroll();
      offRender?.();
      resizeObs?.disconnect();
      opts.host.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      track.remove();
    },
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Normalize a wheel event's delta to pixels (lines and pages → px). */
function wheelDeltaPx(e: WheelEvent): number {
  const d = typeof e.deltaY === "number" ? e.deltaY : 0;
  if (e.deltaMode === 1) return d * WHEEL_LINE_PX;
  if (e.deltaMode === 2) return d * WHEEL_PAGE_PX;
  return d;
}

/** Trim to 2 decimals and drop trailing zeros so "10.00%" → "10%". */
function trim(n: number): number {
  return Math.round(n * 100) / 100;
}
