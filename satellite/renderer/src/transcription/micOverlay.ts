// The floating dictation mic — the locked design from the voice-UX mockups.
//
// One circular mic button floats over every Claude pane, anchored to the
// pane's BOTTOM-LEFT corner (where Claude Code's status line starts) by a
// {dx, dy} offset that is SHARED across panes: drag any mic and every pane's
// mic moves with it, and the offset persists. Click (or ⌘⇧V) toggles
// dictation; right-click opens the Language / Hide menu (wired by
// initTranscription via event delegation on `.dictation-fab`).
//
// While dictating, a pill unfolds beside the button carrying the live volume
// meter and the GHOST TAIL — the words still settling, blurred, kept out of
// the real prompt so it never flickers (DictationBar drives the pill).

import type { DictationState } from "./TranscriptionEngine";
import {
  loadTranscriptionSettings,
  saveTranscriptionSettings,
} from "./transcriptionSettings";

const FAB_SIZE = 36;
// Pointer travel below this is a click, not a drag.
const DRAG_THRESHOLD_PX = 4;

interface Offset {
  dx: number;
  dy: number;
}

// ---- Shared state across every pane's mic -------------------------------

const instances = new Set<DictationFab>();
const byAnchor = new WeakMap<HTMLElement, DictationFab>();
let offset: Offset = { dx: 14, dy: 14 };
let visible = true;
let hydrated = false;
let persistTimer: number | null = null;

/** Load the persisted offset/visibility once; applies to fabs created since. */
async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const s = await loadTranscriptionSettings();
    offset = { ...s.micOffset };
    visible = s.enabled && s.showMicButton;
  } catch {
    // Defaults stand; the fab is cosmetic — never block on config.
  }
  for (const fab of instances) fab.sync();
}

function setSharedOffset(next: Offset): void {
  offset = next;
  for (const fab of instances) fab.sync();
}

/** Persist the offset (debounced — drags fire many moves). */
function persistOffset(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void (async () => {
      try {
        const s = await loadTranscriptionSettings();
        await saveTranscriptionSettings({ ...s, micOffset: { ...offset } });
      } catch {
        // Position resets next launch — annoying, not fatal.
      }
    })();
  }, 400);
}

/** Show/hide every pane's mic (the settings checkbox / Hide menu item). */
export function setDictationFabsVisible(v: boolean): void {
  visible = v;
  for (const fab of instances) fab.sync();
}

/** The fab for a pane wrapper, if one exists (DictationBar mounts its pill here). */
export function dictationFabFor(anchor: HTMLElement): DictationFab | null {
  return byAnchor.get(anchor) ?? null;
}

export interface DictationFabOptions {
  /** Inner SVG markup for the mic icon. */
  icon: string;
  onToggle(): void;
}

/** Create (or return) the floating mic for a pane wrapper. Idempotent. */
export function ensureDictationFab(
  anchor: HTMLElement,
  opts: DictationFabOptions,
): DictationFab {
  const existing = byAnchor.get(anchor);
  if (existing) return existing;
  const fab = new DictationFab(anchor, opts);
  byAnchor.set(anchor, fab);
  instances.add(fab);
  void hydrate();
  return fab;
}

export class DictationFab {
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
  /** Side container the DictationBar mounts the meter/ghost-tail pill into. */
  readonly pillSlot: HTMLElement;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(
    private readonly anchor: HTMLElement,
    opts: DictationFabOptions,
  ) {
    this.root = document.createElement("div");
    this.root.className = "dictation-fab";

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "dictation-fab-btn";
    this.button.dataset.state = "idle";
    this.button.title =
      "Voice dictation — click or hold ⌘⇧V to talk · drag to move · right-click for options";
    this.button.innerHTML = opts.icon;

    this.pillSlot = document.createElement("div");
    this.pillSlot.className = "dictation-fab-pillslot";

    this.root.append(this.button, this.pillSlot);
    this.anchor.appendChild(this.root);
    this.installDrag(opts.onToggle);
    // Panes resize constantly — splits added/removed, dividers dragged, the
    // window itself. Re-clamp on every size change so a mic parked far right
    // can never end up hidden behind a new pane or off-screen.
    this.resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.sync()) : null;
    this.resizeObserver?.observe(this.anchor);
    this.sync();
  }

  setState(state: DictationState): void {
    this.button.dataset.state = state;
    this.button.setAttribute("aria-pressed", state === "listening" ? "true" : "false");
  }

  /**
   * The offset actually rendered in THIS pane — the shared offset clamped so
   * the button stays fully on-screen. This is the source of truth for what
   * the user SEES (and therefore what a drag starts from), which can differ
   * from the shared `offset` when a larger pane placed the mic beyond this
   * pane's bounds.
   */
  renderedOffset(): Offset {
    const w = this.anchor.clientWidth;
    const h = this.anchor.clientHeight;
    const dx = w > FAB_SIZE ? Math.max(0, Math.min(offset.dx, w - FAB_SIZE)) : offset.dx;
    const dy = h > FAB_SIZE ? Math.max(0, Math.min(offset.dy, h - FAB_SIZE)) : offset.dy;
    return { dx, dy };
  }

  /** Re-apply the shared offset/visibility (clamped inside this pane). */
  sync(): void {
    const { dx, dy } = this.renderedOffset();
    this.root.style.left = `${dx}px`;
    this.root.style.bottom = `${dy}px`;
    this.root.style.display = visible ? "" : "none";
  }

  /**
   * Pointer handling: small travel = click (toggle); beyond the threshold
   * it's a drag that live-updates the SHARED offset, so the mic on every
   * pane glides in unison.
   */
  private installDrag(onToggle: () => void): void {
    let startX = 0;
    let startY = 0;
    let startOffset: Offset = offset;
    let dragging = false;
    let moved = false;

    this.button.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      // Drag from what's ON SCREEN, not the raw shared offset — otherwise, on
      // a pane where the mic was clamped into view, the drag would start from
      // an off-screen position and the button wouldn't move until you'd
      // dragged all the way back. "What you see is what you drag."
      startOffset = this.renderedOffset();
      this.button.setPointerCapture(e.pointerId);
    });
    this.button.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const mx = e.clientX - startX;
      const my = e.clientY - startY;
      if (!moved && Math.hypot(mx, my) < DRAG_THRESHOLD_PX) return;
      moved = true;
      this.root.classList.add("dragging");
      // Screen +x = anchor +dx; screen +y = anchor −dy (bottom-anchored).
      setSharedOffset({
        dx: Math.max(0, Math.round(startOffset.dx + mx)),
        dy: Math.max(0, Math.round(startOffset.dy - my)),
      });
    });
    const finish = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      this.root.classList.remove("dragging");
      try {
        this.button.releasePointerCapture(e.pointerId);
      } catch {
        // Capture already released.
      }
      if (moved) persistOffset();
      else onToggle();
    };
    this.button.addEventListener("pointerup", finish);
    this.button.addEventListener("pointercancel", (e) => {
      dragging = false;
      this.root.classList.remove("dragging");
      try {
        this.button.releasePointerCapture(e.pointerId);
      } catch {
        // Capture already released.
      }
    });
    // Swallow the synthetic click after pointerup so panes beneath don't
    // also react; toggle already ran in `finish`.
    this.button.addEventListener("click", (e) => e.stopPropagation());
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    instances.delete(this);
    byAnchor.delete(this.anchor);
    this.root.remove();
  }
}
