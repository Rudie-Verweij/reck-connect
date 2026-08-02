// Content zoom model — pure helpers, no Electron.
//
// Replaces Electron's built-in `role: "viewMenu"` zoom, which called
// `webContents.setZoomLevel` and therefore scaled the ENTIRE page. That is wrong
// for this app in two ways:
//
//   1. Every window is `titleBarStyle: "hiddenInset"`, so the macOS traffic
//      lights float over our own title bar. The lights are drawn by the OS at a
//      fixed size, so a title bar that grows on ⌘+ slides out of alignment with
//      them — visible as the close button crowding or overlapping the title.
//
//   2. A terminal is a canvas. Page zoom scales the rendered bitmap rather than
//      re-laying-out the grid, so glyphs soften and the PTY geometry no longer
//      matches what the user sees. Terminals are meant to be zoomed by font
//      size, which reflows properly.
//
// So zoom is now content-only: the renderer multiplies content font sizes by
// this factor and re-fits terminals, while title bars ignore it entirely.

/** Zoom steps, as multipliers. 1 is unzoomed and must be present. */
export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export const DEFAULT_ZOOM = 1;

/** Config key holding the persisted factor. Must be in CONFIG_KEYS. */
export const CONTENT_ZOOM_KEY = "contentZoom";

/**
 * Snap an arbitrary factor to the nearest step.
 *
 * Persisted values are the input here, so this doubles as the sanitizer for a
 * corrupted config: anything non-finite or out of range resolves to a valid
 * step rather than producing a `NaN` font size.
 */
export function nearestStep(factor: unknown): number {
  if (typeof factor !== "number" || !Number.isFinite(factor)) return DEFAULT_ZOOM;
  let best: number = ZOOM_STEPS[0];
  let bestDelta = Math.abs(factor - best);
  for (const step of ZOOM_STEPS) {
    const delta = Math.abs(factor - step);
    // `<` not `<=` so ties keep the earlier (smaller) step deterministically.
    if (delta < bestDelta) {
      best = step;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * The next factor after a zoom command.
 *
 * `current` is snapped first, so a hand-edited config can't strand the user
 * between steps. Stepping past either end is a no-op rather than an error — it
 * matches how the OS treats a maxed-out zoom.
 */
export function stepZoom(current: unknown, direction: "in" | "out" | "reset"): number {
  if (direction === "reset") return DEFAULT_ZOOM;
  const snapped = nearestStep(current);
  const i = ZOOM_STEPS.indexOf(snapped as (typeof ZOOM_STEPS)[number]);
  const next = direction === "in" ? i + 1 : i - 1;
  if (next < 0 || next >= ZOOM_STEPS.length) return snapped;
  return ZOOM_STEPS[next];
}

/**
 * Terminal font size for a zoom factor, in px.
 *
 * Rounded to whole pixels: xterm measures a cell from the font metrics, and a
 * fractional size yields fractional cell widths that accumulate into a visible
 * gap at the right edge of the grid.
 */
export function terminalFontSize(baseSize: number, factor: number): number {
  return Math.max(1, Math.round(baseSize * nearestStep(factor)));
}
