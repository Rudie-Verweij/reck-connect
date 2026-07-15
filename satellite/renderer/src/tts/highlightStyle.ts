// Shared visual treatment for the TTS reading-highlight overlay, used by
// EVERY surface (markdown / file-viewer + terminal) so the highlight looks
// identical everywhere.
//
// The overlay sits ON TOP of the text, so its fill is translucent (the word
// reads through it) — a plain alpha composite is mode-safe, tinting rather
// than washing in both light and dark themes. On its own, though, a flat
// translucent fill washes out to invisible over tinted / raised backgrounds
// (the orange user-turn cards, code blocks). So the overlay ALSO gets a
// full-opacity OUTLINE ring in the same colour, which reads on ANY
// background. Element opacity is intentionally never used — it would fade
// the ring along with the fill.

export const FILL_ALPHA = 0.5;
const OUTLINE_WIDTH = "1.5px";

/**
 * Translucent fill colour derived from a solid highlight colour. Emits
 * `rgba()` for hex inputs (universally parseable, incl. jsdom) and falls
 * back to `color-mix()` for non-hex CSS colours (rgb()/hsl()/named).
 */
export function fillFromColor(color: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${FILL_ALPHA})`;
  }
  return `color-mix(in srgb, ${color} ${FILL_ALPHA * 100}%, transparent)`;
}

/**
 * Paint the shared highlight look onto `el`: translucent fill + opaque ring
 * in `color`. Does NOT set element opacity (that would fade the ring too).
 */
export function applyHighlightColors(el: HTMLElement, color: string): void {
  el.style.background = fillFromColor(color);
  el.style.outline = `${OUTLINE_WIDTH} solid ${color}`;
}
