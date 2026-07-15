// A single shared hover tooltip for xterm links (file paths + URLs).
//
// xterm's link-provider `hover`/`leave` callbacks fire with the hover
// MouseEvent; we render a small overlay near the cursor telling the user
// what ⌘+click does ("view file" for a path, "open in browser" for a
// URL). Rendered on document.body (position: fixed) so the pane's
// overflow can't clip it, and pointer-events:none so it never eats the
// click. One reused element — hovering another link just re-labels it.

let tooltipEl: HTMLDivElement | null = null;

function ensureEl(): HTMLDivElement {
  if (tooltipEl && tooltipEl.isConnected) return tooltipEl;
  const el = document.createElement("div");
  el.className = "reck-link-tooltip";
  el.setAttribute("role", "tooltip");
  el.style.display = "none";
  document.body.appendChild(el);
  tooltipEl = el;
  return el;
}

const CURSOR_GAP = 12;

export function showLinkTooltip(text: string, ev: MouseEvent): void {
  const el = ensureEl();
  el.textContent = text;
  el.style.display = "block";
  // Measure after making it visible so width/height are real, then clamp
  // to the viewport (flip above the cursor if it would overflow the
  // bottom, nudge left if it would overflow the right edge).
  const rect = el.getBoundingClientRect();
  let x = ev.clientX + CURSOR_GAP;
  let y = ev.clientY + CURSOR_GAP;
  if (x + rect.width > window.innerWidth) {
    x = window.innerWidth - rect.width - CURSOR_GAP;
  }
  if (y + rect.height > window.innerHeight) {
    y = ev.clientY - rect.height - CURSOR_GAP;
  }
  el.style.left = `${Math.max(CURSOR_GAP, x)}px`;
  el.style.top = `${Math.max(CURSOR_GAP, y)}px`;
}

export function hideLinkTooltip(): void {
  if (tooltipEl) tooltipEl.style.display = "none";
}

/** Test hook: drop the shared element so a fresh DOM starts clean. */
export function __resetLinkTooltipForTests(): void {
  tooltipEl?.remove();
  tooltipEl = null;
}
