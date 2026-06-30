// `OverlayScrollbar` — a reusable, auto-hiding, Reck-themed scrollbar that
// works over any `ScrollSurface` (terminal / markdown / CodeMirror). It
// fades in on scroll or wheel activity and fades out after a short idle,
// supports drag-to-scroll, and renders search-match tick marks along the
// track.
//
// Geometry is expressed in percentages (not pixels) so it needs no layout
// measurement — it works the same in the Electron renderer and under
// jsdom, and stays correct across resizes without a ResizeObserver.

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
  /** Recompute the thumb from the surface's current metrics. */
  update(): void;
  /** Render match tick marks at the given fractional positions (0..1). */
  setMatches(fractions: readonly number[]): void;
  /** Show the bar and (re)start the idle fade timer. */
  flashShow(): void;
  dispose(): void;
}

const DEFAULT_HIDE_DELAY_MS = 1400;
const DEFAULT_MIN_THUMB_PCT = 8;

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

  function update(): void {
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

  function onWheel(): void {
    // Recompute first: the bar may still be `--disabled` (display:none) from
    // construction (the pane was empty then). A wheel gesture is the signal
    // that the user wants to scroll, so clear the disabled state if there's
    // now scrollback, then flash into view.
    update();
    flashShow();
  }

  function onPointerDown(e: Event): void {
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
  // Recompute geometry (and clear `--disabled` once scrollback exists) when
  // the surface re-renders, WITHOUT flashing the bar into view — output and
  // in-place TUI redraws must not pop the scrollbar; only real scroll/wheel
  // does that.
  const offRender = opts.surface.onRender?.(() => update()) ?? null;
  opts.host.addEventListener("wheel", onWheel, { passive: true });
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
      opts.host.removeEventListener("wheel", onWheel);
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

/** Trim to 2 decimals and drop trailing zeros so "10.00%" → "10%". */
function trim(n: number): number {
  return Math.round(n * 100) / 100;
}
