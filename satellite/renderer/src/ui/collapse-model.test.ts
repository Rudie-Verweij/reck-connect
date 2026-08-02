import { describe, it, expect } from "vitest";
import { createCollapseModel } from "./collapse-model";
import {
  RAIL_MAX,
  RAIL_MINI,
  RAIL_COLLAPSE_AT,
  RAIL_STICKY_PX,
  RAIL_STRETCH_FACTOR,
  RAIL_EXPAND_COMMIT_PX,
  railDragDecision,
  railDragRelease,
} from "./rail-collapse";

// The rail's own behaviour is covered by rail-collapse.test.ts, which must stay
// UNEDITED through this extraction — it is the proof that generalizing the
// model didn't change the rail. These tests cover the generic factory at a
// second, deliberately different set of thresholds (the TOC's), plus an
// equivalence check between the factory and the rail's exported functions.

const TOC = createCollapseModel({
  max: 220,
  mini: 0,
  collapseAt: 120,
  stickyPx: 24,
  stretchFactor: 0.35,
  expandCommitPx: 20,
});

describe("createCollapseModel — dragDecision (expanded)", () => {
  it("resizes live above the collapse threshold", () => {
    expect(TOC.dragDecision(180, false)).toEqual({ kind: "resize", width: 180 });
  });

  it("clamps a resize to max", () => {
    expect(TOC.dragDecision(9999, false)).toEqual({ kind: "resize", width: 220 });
  });

  it("stretches elastically inside the sticky zone", () => {
    // 10px below the threshold → the panel trails at stretchFactor of that.
    const d = TOC.dragDecision(110, false);
    expect(d.kind).toBe("stretch");
    expect((d as { width: number }).width).toBe(Math.round(120 - 10 * 0.35));
  });

  it("stretch is damped and never exceeds the threshold", () => {
    for (let raw = 119; raw > 120 - 24; raw--) {
      const d = TOC.dragDecision(raw, false);
      expect(d.kind).toBe("stretch");
      const w = (d as { width: number }).width;
      // Damped: the panel gives ground more slowly than the pointer.
      expect(w).toBeGreaterThan(raw);
      // Rounding means the first pixel inside the zone still reports the
      // threshold itself (120 - 1*0.35 → 120). Same as the rail; the visible
      // effect is that the very first pixel of pull shows no movement.
      expect(w).toBeLessThanOrEqual(120);
    }
  });

  it("commits the collapse past the sticky zone", () => {
    expect(TOC.dragDecision(120 - 24 - 1, false)).toEqual({ kind: "collapse" });
  });

  it("does not collapse at the exact sticky boundary", () => {
    expect(TOC.dragDecision(120 - 24, false).kind).toBe("stretch");
  });
});

describe("createCollapseModel — dragDecision (mini)", () => {
  it("re-expands live once the pointer passes the threshold", () => {
    expect(TOC.dragDecision(150, true)).toEqual({ kind: "expand", width: 150 });
  });

  it("clamps a re-expand to max", () => {
    expect(TOC.dragDecision(9999, true)).toEqual({ kind: "expand", width: 220 });
  });

  it("tracks the pointer below the threshold so the panel reacts immediately", () => {
    expect(TOC.dragDecision(60, true)).toEqual({ kind: "track", width: 60 });
  });

  it("never tracks below mini", () => {
    expect(TOC.dragDecision(-50, true)).toEqual({ kind: "track", width: 0 });
  });
});

describe("createCollapseModel — dragRelease", () => {
  it("springs open after a committing pull from mini", () => {
    expect(TOC.dragRelease(0 + 20, true)).toEqual({ kind: "spring-expand" });
  });

  it("settles back to mini below the commit distance", () => {
    expect(TOC.dragRelease(19, true)).toEqual({ kind: "settle-mini" });
  });

  it("bounces back when released mid-stretch", () => {
    expect(TOC.dragRelease(110, false)).toEqual({ kind: "bounce-back" });
  });

  it("stays put when released at a legitimate width", () => {
    expect(TOC.dragRelease(180, false)).toEqual({ kind: "stay" });
  });
});

describe("the rail is an instance of the shared model", () => {
  // Guards the extraction itself: a rail-configured model must agree with the
  // rail's exported functions at every interesting width, in both states.
  const rail = createCollapseModel({
    max: RAIL_MAX,
    mini: RAIL_MINI,
    collapseAt: RAIL_COLLAPSE_AT,
    stickyPx: RAIL_STICKY_PX,
    stretchFactor: RAIL_STRETCH_FACTOR,
    expandCommitPx: RAIL_EXPAND_COMMIT_PX,
  });

  const widths = [
    -10, 0, RAIL_MINI, RAIL_MINI + 1, RAIL_MINI + RAIL_EXPAND_COMMIT_PX - 1,
    RAIL_MINI + RAIL_EXPAND_COMMIT_PX, 100,
    RAIL_COLLAPSE_AT - RAIL_STICKY_PX - 1, RAIL_COLLAPSE_AT - RAIL_STICKY_PX,
    RAIL_COLLAPSE_AT - 1, RAIL_COLLAPSE_AT, RAIL_COLLAPSE_AT + 1, 200,
    RAIL_MAX, RAIL_MAX + 50, 9999,
  ];

  it.each(widths)("dragDecision agrees at %i", (w) => {
    expect(rail.dragDecision(w, false)).toEqual(railDragDecision(w, false));
    expect(rail.dragDecision(w, true)).toEqual(railDragDecision(w, true));
  });

  it.each(widths)("dragRelease agrees at %i", (w) => {
    expect(rail.dragRelease(w, false)).toEqual(railDragRelease(w, false));
    expect(rail.dragRelease(w, true)).toEqual(railDragRelease(w, true));
  });
});
