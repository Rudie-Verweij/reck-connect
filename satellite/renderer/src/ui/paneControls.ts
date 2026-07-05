// A per-surface top-right control stack. The search bar, the TTS control bar,
// and the History button all mount into ONE `.pane-controls` box so they stack
// vertically and snap to the top-right, never clipping. The visual order
// (search → TTS → history, history last) is enforced by CSS `order`, so it
// holds regardless of which control is created first or is currently present —
// whatever exists hugs the top-right, and History always sits at the bottom.
//
// The container is find-or-create + idempotent so the several owners that mount
// into it (SearchController, TtsController, PaneLayout for History) all resolve
// the same element without coordinating.

/** Find (or create) the `.pane-controls` stack that is a direct child of
 *  `anchor`. `anchor` is the positioned surface box — the pane wrapper, the
 *  popout body, the file-viewer root, or the transcript overlay root. */
export function ensurePaneControls(anchor: HTMLElement): HTMLElement {
  for (const child of Array.from(anchor.children)) {
    if (child.classList.contains("pane-controls")) return child as HTMLElement;
  }
  const stack = document.createElement("div");
  stack.className = "pane-controls";
  anchor.appendChild(stack);
  return stack;
}

export interface HistoryButtonOptions {
  /** Inner SVG markup for the clock icon. */
  icon: string;
  title?: string;
  onToggle(): void;
}

/** Ensure a single History (clock) button lives in `anchor`'s control stack.
 *  Idempotent — repeated calls return the existing button. */
export function ensureHistoryButton(
  anchor: HTMLElement,
  opts: HistoryButtonOptions,
): HTMLButtonElement {
  const stack = ensurePaneControls(anchor);
  for (const child of Array.from(stack.children)) {
    if (child.classList.contains("pane-controls-history")) {
      return child as HTMLButtonElement;
    }
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn pane-controls-history";
  btn.title = opts.title ?? "Chat history — scroll & search the full transcript";
  btn.innerHTML = opts.icon;
  btn.addEventListener("click", (e) => {
    // Don't let the click reach the pane/tab beneath (focus/select handlers).
    e.stopPropagation();
    opts.onToggle();
  });
  stack.appendChild(btn);
  return btn;
}
