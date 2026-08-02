// Renderer side of content-only zoom.
//
// Main owns the factor — the step ladder, the persistence and the View menu all
// live in main/content-zoom.ts — and pushes it over `zoom:set`. This module is
// the single place the renderer applies it, in two ways:
//
//   1. `--content-zoom` on the root element, which CSS-driven content surfaces
//      multiply their font-size by.
//   2. A subscriber list for surfaces CSS can't scale: a terminal is a canvas,
//      so it has to be resized via xterm's `fontSize` and then re-fit.
//
// Title bars are absent from both paths ON PURPOSE. The macOS traffic lights are
// drawn by the OS at a fixed size, so a title bar that grew with zoom slid out
// of alignment with the close button. See ui/window-header.ts.
//
// The ladder is deliberately NOT duplicated here — main's is authoritative, and
// the renderer can't import from main (separate tsconfig, and main must not be
// pulled into the renderer bundle). What is checked below is only the boundary
// guard any IPC value deserves.

/** Base terminal font size at zoom 1 — mirrors TerminalPane's own default. */
export const TERMINAL_BASE_FONT_PX = 13;

/**
 * Widest factor the renderer will accept off the wire. Not the step ladder —
 * just a sanity range, so a corrupted message can't produce a 400px font or a
 * zero-height cell.
 */
const MIN_FACTOR = 0.2;
const MAX_FACTOR = 5;

/**
 * Boundary guard for an incoming factor. A `NaN` reaching a font-size blanks
 * the surface it lands on, which is a confusing failure to debug from a
 * screenshot — so clamp rather than trust.
 */
export function sanitizeFactor(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, raw));
}

/**
 * Terminal font size in whole pixels for a factor.
 *
 * Rounded because xterm derives cell width from font metrics: a fractional size
 * gives fractional cells that accumulate into a visible gap at the right edge.
 */
export function zoomedTerminalFontSize(
  factor: number,
  basePx: number = TERMINAL_BASE_FONT_PX,
): number {
  return Math.max(1, Math.round(basePx * sanitizeFactor(factor)));
}

export type ZoomListener = (factor: number) => void;

export interface ContentZoomController {
  /** Current factor. */
  get(): number;
  /**
   * Subscribe to changes. The listener fires IMMEDIATELY with the current
   * factor, so a terminal created after a zoom change is correct without having
   * to ask. Returns an unsubscribe thunk.
   */
  subscribe(listener: ZoomListener): () => void;
  dispose(): void;
}

/**
 * Wire up content zoom for this window. `root` carries the custom property.
 *
 * Safe to call where `window.reckAPI.zoom` is absent (harness pages, tests that
 * don't stub it): the variable still gets its initial value, zoom just never
 * changes.
 */
export function initContentZoom(
  root: HTMLElement = document.documentElement,
): ContentZoomController {
  let factor = 1;
  const listeners = new Set<ZoomListener>();

  /** One bad subscriber must not stop the rest from resizing — nor break the
   *  caller that is merely registering one. Both fire paths go through here. */
  function safeCall(listener: ZoomListener): void {
    try {
      listener(factor);
    } catch (e) {
      console.warn("[zoom] listener failed:", e);
    }
  }

  function apply(next: unknown): void {
    factor = sanitizeFactor(next);
    root.style.setProperty("--content-zoom", String(factor));
    for (const listener of listeners) safeCall(listener);
  }

  const zoomApi = (
    window as unknown as {
      reckAPI?: { zoom?: { onSet?: (cb: (f: number) => void) => () => void } };
    }
  ).reckAPI?.zoom;
  const unsub = zoomApi?.onSet?.((next) => apply(next));
  apply(factor);

  return {
    get: () => factor,
    subscribe(listener: ZoomListener): () => void {
      listeners.add(listener);
      safeCall(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      unsub?.();
      listeners.clear();
    },
  };
}
