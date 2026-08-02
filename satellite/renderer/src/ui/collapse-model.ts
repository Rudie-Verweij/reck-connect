// Shared expand/collapse drag model for resizable side panels.
//
// This is the rail's collapse behaviour, generalized. The rail
// (`./rail-collapse.ts`) was the first panel to need it; the file viewer's TOC
// sidebar is the second, and the user's instruction was explicit — the TOC must
// feel like the rail, not like a second, subtly-different implementation. So
// the thresholds became parameters and both panels are instances of the same
// model rather than two copies of the same arithmetic.
//
// `rail-collapse.ts` keeps the rail's own constants and re-exports a
// preconfigured instance, so `boot.ts` and `rail-collapse.test.ts` are
// untouched by this extraction — that test file is the safety net proving the
// rail's behaviour is byte-for-byte what it was.
//
// The width ANIMATOR (createWidthAnimator) was already generic and still lives
// in rail-collapse.ts; both panels use it directly.

export interface CollapseConfig {
  /** Expanded default width, and also the maximum. */
  max: number;
  /** The collapsed width. Panels collapse to this, never to zero. */
  mini: number;
  /** Dragging inward past this width begins the collapse gesture. */
  collapseAt: number;
  /**
   * Hysteresis: inside the sticky zone the collapse only commits after this
   * many extra pixels of pointer travel, so a slight overshoot can't collapse
   * the panel by accident.
   */
  stickyPx: number;
  /**
   * Elastic damping inside the sticky zone — the panel trails the pointer at
   * this fraction of its travel, so the pull reads as progress rather than a
   * stuck divider.
   */
  stretchFactor: number;
  /**
   * Dragging outward from mini, releasing beyond this small pull means
   * "expand" rather than settling back.
   */
  expandCommitPx: number;
}

export type CollapseDragDecision =
  | { kind: "resize"; width: number }
  | { kind: "stretch"; width: number }
  | { kind: "collapse" }
  | { kind: "expand"; width: number }
  | { kind: "track"; width: number };

export type CollapseDragRelease =
  | { kind: "spring-expand" }
  | { kind: "settle-mini" }
  | { kind: "bounce-back" }
  | { kind: "stay" };

export interface CollapseModel {
  /**
   * Classify a divider-drag position while the button is held. `rawWidth` is
   * the unclamped width the pointer implies (drag-start width + delta).
   *
   *  - expanded, above the threshold → live resize (clamped to `max`).
   *  - expanded, inside the sticky zone → elastic stretch.
   *  - expanded, past the sticky zone → collapse mid-drag.
   *  - mini, past the threshold → re-expand live at the pointer.
   *  - mini, below it → track the pointer outward from `mini`, so the panel
   *    reacts immediately instead of popping later.
   */
  dragDecision(rawWidth: number, mini: boolean): CollapseDragDecision;
  /**
   * Classify a drag release.
   *
   * Mini (a drag that crossed the threshold already re-expanded live): letting
   * go after even a small outward pull means "I meant to expand". Expanded
   * below the threshold means the drag ended mid-stretch without committing,
   * so the elastic snaps back.
   */
  dragRelease(width: number, mini: boolean): CollapseDragRelease;
}

export function createCollapseModel(cfg: CollapseConfig): CollapseModel {
  return {
    dragDecision(rawWidth: number, mini: boolean): CollapseDragDecision {
      if (mini) {
        if (rawWidth > cfg.collapseAt) {
          return { kind: "expand", width: Math.min(cfg.max, rawWidth) };
        }
        return { kind: "track", width: Math.max(cfg.mini, rawWidth) };
      }
      if (rawWidth < cfg.collapseAt - cfg.stickyPx) return { kind: "collapse" };
      if (rawWidth < cfg.collapseAt) {
        const overshoot = cfg.collapseAt - rawWidth;
        return {
          kind: "stretch",
          width: Math.round(cfg.collapseAt - overshoot * cfg.stretchFactor),
        };
      }
      return { kind: "resize", width: Math.min(cfg.max, rawWidth) };
    },

    dragRelease(width: number, mini: boolean): CollapseDragRelease {
      if (!mini) {
        if (width < cfg.collapseAt) return { kind: "bounce-back" };
        return { kind: "stay" };
      }
      if (width >= cfg.mini + cfg.expandCommitPx) return { kind: "spring-expand" };
      return { kind: "settle-mini" };
    },
  };
}
