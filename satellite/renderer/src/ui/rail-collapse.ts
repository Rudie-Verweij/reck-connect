// Rail collapse model — pure helpers + the shared width animator.
//
// The mini rail (48px of project initials) is the ONLY collapsed state;
// the rail is never fully hidden. The expanded default width is also the
// maximum. Dragging the divider below RAIL_COLLAPSE_AT (the old 180px
// row minimum less 5%) collapses straight into mini mid-drag; dragging
// back out past the same threshold re-expands at the pointer position.
//
// Design mock: docs/design/sidebar-collapse-variations.html (branch
// docs/sidebar-collapse-exploration).

export const RAIL_MAX = 240;
export const RAIL_MINI = 48;
export const RAIL_COLLAPSE_AT = 171;
/** Hysteresis: dragging inward, the rail stays pinned at RAIL_COLLAPSE_AT for this many extra pixels of pointer travel before the collapse commits — guards against accidental collapses. */
export const RAIL_STICKY_PX = 50;
/** Dragging outward from mini, releasing beyond this small pull means "expand" — the rail springs open instead of settling back. */
export const RAIL_EXPAND_COMMIT_PX = 24;

export type RailMode = "expanded" | "mini";

/**
 * Two-character initials for the mini rail's project avatars. Two words
 * (split on whitespace, hyphens, underscores, dots, slashes) → first
 * character of each; a single word → its first two characters. Unicode-
 * aware (spread, not charAt) so astral/CJK names don't split surrogate
 * pairs.
 */
export function projectInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_./]+/u)
    .filter((w) => w.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    return [...words[0]].slice(0, 2).join("").toLowerCase();
  }
  return ([...words[0]][0] + [...words[1]][0]).toLowerCase();
}

export type RailDragDecision =
  | { kind: "resize"; width: number }
  | { kind: "stick" }
  | { kind: "collapse" }
  | { kind: "expand"; width: number }
  | { kind: "track"; width: number };

/**
 * Classify a divider-drag position while the button is held. `rawWidth`
 * is the unclamped width the pointer implies (drag start width +
 * pointer delta).
 *
 *  - expanded, above the row minimum → live resize (clamped to
 *    RAIL_MAX; rows squeeze between RAIL_MAX and RAIL_COLLAPSE_AT).
 *  - expanded, inside the sticky zone → the rail stays pinned at
 *    RAIL_COLLAPSE_AT until the pointer travels RAIL_STICKY_PX further,
 *    so a slight overshoot can't collapse it by accident.
 *  - expanded, past the sticky zone → collapse into mini mid-drag (the
 *    caller ends the drag and springs to RAIL_MINI).
 *  - mini, past the row minimum → re-expand live at the pointer.
 *  - mini, below the row minimum → track the pointer from RAIL_MINI
 *    outward so the rail reacts immediately instead of popping later.
 */
export function railDragDecision(rawWidth: number, mini: boolean): RailDragDecision {
  if (mini) {
    if (rawWidth > RAIL_COLLAPSE_AT) {
      return { kind: "expand", width: Math.min(RAIL_MAX, rawWidth) };
    }
    return { kind: "track", width: Math.max(RAIL_MINI, rawWidth) };
  }
  if (rawWidth < RAIL_COLLAPSE_AT - RAIL_STICKY_PX) return { kind: "collapse" };
  if (rawWidth < RAIL_COLLAPSE_AT) return { kind: "stick" };
  return { kind: "resize", width: Math.min(RAIL_MAX, rawWidth) };
}

export type RailDragRelease =
  | { kind: "spring-expand" }
  | { kind: "settle-mini" }
  | { kind: "stay" };

/**
 * Classify a drag release. Only meaningful while still in mini mode (a
 * drag that crossed the row minimum already re-expanded live): letting
 * go after even a small outward pull means "I meant to expand" and the
 * rail springs open; anything less settles back to RAIL_MINI.
 */
export function railDragRelease(width: number, mini: boolean): RailDragRelease {
  if (!mini) return { kind: "stay" };
  if (width >= RAIL_MINI + RAIL_EXPAND_COMMIT_PX) return { kind: "spring-expand" };
  return { kind: "settle-mini" };
}

export type RailEasing = "easeOut" | "spring";

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// easeOutBack — slight overshoot past the target, matching the mock's
// spring cubic-bezier(0.34, 1.2, 0.64, 1) feel on the drag-snap.
function easeOutSpring(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export interface AnimateOptions {
  durationMs: number;
  easing?: RailEasing;
  onDone?: () => void;
}

export interface WidthAnimator {
  animateTo(target: number, opts: AnimateOptions): void;
  cancel(): void;
  isAnimating(): boolean;
}

export interface WidthAnimatorDeps {
  /** Current width — sampled at animation start so a mid-flight retarget starts from where the rail visually is. */
  getWidth: () => number;
  /**
   * Applied every frame. MUST route through the same code path as a
   * mouse drag (update railWidth → applyGrid) so terminals see real
   * resize deltas, not a CSS-transition the ResizeObserver samples late.
   */
  onFrame: (width: number) => void;
  /** True → skip animation entirely: jump to the target, fire onDone. */
  reducedMotion?: () => boolean;
  // Injectable clock/scheduler for tests. Default to rAF + performance.now.
  now?: () => number;
  schedule?: (cb: () => void) => number;
  cancelSchedule?: (handle: number) => void;
}

export function createWidthAnimator(deps: WidthAnimatorDeps): WidthAnimator {
  const now = deps.now ?? (() => performance.now());
  const schedule = deps.schedule ?? ((cb: () => void) => requestAnimationFrame(cb));
  const cancelSchedule = deps.cancelSchedule ?? ((h: number) => cancelAnimationFrame(h));
  let handle: number | null = null;
  let animating = false;

  function cancel(): void {
    if (handle !== null) cancelSchedule(handle);
    handle = null;
    animating = false;
  }

  function animateTo(target: number, opts: AnimateOptions): void {
    cancel();
    const from = deps.getWidth();
    if (deps.reducedMotion?.() || opts.durationMs <= 0 || from === target) {
      deps.onFrame(target);
      opts.onDone?.();
      return;
    }
    const ease = opts.easing === "spring" ? easeOutSpring : easeOutCubic;
    const start = now();
    animating = true;
    const tick = () => {
      const t = Math.min(1, (now() - start) / opts.durationMs);
      deps.onFrame(Math.round(from + (target - from) * ease(t)));
      if (t < 1) {
        handle = schedule(tick);
      } else {
        handle = null;
        animating = false;
        opts.onDone?.();
      }
    };
    handle = schedule(tick);
  }

  return { animateTo, cancel, isAnimating: () => animating };
}
