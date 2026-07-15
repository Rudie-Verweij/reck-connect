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

const HISTORY_TITLE_IDLE = "Chat history — scroll & search the full transcript";
const HISTORY_TITLE_OPEN = "Back to live terminal (Esc)";

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
  // The clock doubles as the History-mode indicator: `aria-pressed` carries
  // the open/closed state (toggled via setHistoryButtonActive) and CSS keys
  // the persistent orange hue + rewind spin off it.
  btn.setAttribute("aria-pressed", "false");
  btn.dataset.idleTitle = opts.title ?? HISTORY_TITLE_IDLE;
  btn.title = btn.dataset.idleTitle;
  btn.innerHTML = opts.icon;
  btn.addEventListener("click", (e) => {
    // Don't let the click reach the pane/tab beneath (focus/select handlers).
    e.stopPropagation();
    opts.onToggle();
  });
  stack.appendChild(btn);
  return btn;
}

export interface MicButtonOptions {
  /** Inner SVG markup for the mic icon. */
  icon: string;
  title?: string;
  onToggle(): void;
}

const MIC_TITLE = "Voice dictation — click or press the hotkey to talk";

/** Ensure a single dictation (mic) button lives in `anchor`'s control stack.
 *  Idempotent — repeated calls return the existing button. */
export function ensureMicButton(
  anchor: HTMLElement,
  opts: MicButtonOptions,
): HTMLButtonElement {
  const stack = ensurePaneControls(anchor);
  for (const child of Array.from(stack.children)) {
    if (child.classList.contains("pane-controls-mic")) {
      return child as HTMLButtonElement;
    }
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn pane-controls-mic";
  // `data-state` (idle | listening | transcribing) drives the CSS treatment
  // (e.g. a pulsing hue while recording); see setMicButtonState.
  btn.dataset.state = "idle";
  btn.title = opts.title ?? MIC_TITLE;
  btn.innerHTML = opts.icon;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    opts.onToggle();
  });
  stack.appendChild(btn);
  return btn;
}

/** Reflect the dictation state on `anchor`'s mic button (no-op if absent). */
export function setMicButtonState(
  anchor: HTMLElement,
  state: "idle" | "preparing" | "listening" | "transcribing",
): void {
  const btn = anchor.querySelector<HTMLButtonElement>(
    ":scope > .pane-controls > .pane-controls-mic",
  );
  if (!btn) return;
  btn.dataset.state = state;
  btn.setAttribute("aria-pressed", state === "listening" ? "true" : "false");
}

/** Reflect the History overlay's open state on `anchor`'s clock button.
 *  While open the clock holds the orange "lit" hue (CSS keys off
 *  `aria-pressed`) and the tooltip flips to the way back. No-op when the
 *  anchor has no History button (non-Claude panes, teardown races). The
 *  `:scope >` selector only matches `anchor`'s own stack, never one in a
 *  nested surface. Every control — search bar, TTS bar, History clock,
 *  in live AND History mode — mounts into this single stack, so the CSS
 *  `order` (search → TTS → history) always holds. */
export function setHistoryButtonActive(anchor: HTMLElement, active: boolean): void {
  const btn = anchor.querySelector<HTMLButtonElement>(
    ":scope > .pane-controls > .pane-controls-history",
  );
  if (!btn) return;
  btn.setAttribute("aria-pressed", active ? "true" : "false");
  btn.title = active ? HISTORY_TITLE_OPEN : btn.dataset.idleTitle ?? HISTORY_TITLE_IDLE;
}
