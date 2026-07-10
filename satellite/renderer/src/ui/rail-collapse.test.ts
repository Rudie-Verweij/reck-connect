import { describe, it, expect } from "vitest";
import {
  RAIL_COLLAPSE_AT,
  RAIL_EXPAND_COMMIT_PX,
  RAIL_MAX,
  RAIL_MINI,
  RAIL_STICKY_PX,
  createWidthAnimator,
  projectInitials,
  railDragDecision,
  railDragRelease,
  type RailDragDecision,
  type RailDragRelease,
} from "./rail-collapse";

describe("projectInitials", () => {
  const cases: Array<[string, string]> = [
    ["reck-connect", "rc"],
    ["capero web", "cw"],
    ["whisper-bench", "wb"],
    ["snake_case_name", "sc"],
    ["dotted.name", "dn"],
    ["path/like", "pl"],
    ["docs", "do"],
    ["a", "a"],
    ["Mixed Case", "mc"],
    ["  padded   words  ", "pw"],
    ["émile-zola", "éz"],
    ["日本語", "日本"],
    ["--weird--", "we"],
    ["", "?"],
    ["   ", "?"],
    ["three word name", "tw"],
  ];
  for (const [name, want] of cases) {
    it(`derives ${JSON.stringify(want)} from ${JSON.stringify(name)}`, () => {
      expect(projectInitials(name)).toBe(want);
    });
  }
});

describe("railDragDecision", () => {
  const STICK_FLOOR = RAIL_COLLAPSE_AT - RAIL_STICKY_PX;
  const cases: Array<{
    desc: string;
    width: number;
    mini: boolean;
    want: RailDragDecision;
  }> = [
    // Expanded: live squeeze between the row minimum and the max.
    { desc: "expanded at max", width: RAIL_MAX, mini: false, want: { kind: "resize", width: RAIL_MAX } },
    { desc: "expanded above max clamps", width: 999, mini: false, want: { kind: "resize", width: RAIL_MAX } },
    { desc: "expanded mid-squeeze", width: 200, mini: false, want: { kind: "resize", width: 200 } },
    { desc: "expanded exactly at row minimum stays resize", width: RAIL_COLLAPSE_AT, mini: false, want: { kind: "resize", width: RAIL_COLLAPSE_AT } },
    // Expanded: the sticky zone pins the rail before the collapse commits.
    { desc: "expanded one below row minimum sticks", width: RAIL_COLLAPSE_AT - 1, mini: false, want: { kind: "stick" } },
    { desc: "expanded at sticky floor still sticks", width: STICK_FLOOR, mini: false, want: { kind: "stick" } },
    { desc: "expanded one below sticky floor collapses", width: STICK_FLOOR - 1, mini: false, want: { kind: "collapse" } },
    { desc: "expanded far below collapses", width: 10, mini: false, want: { kind: "collapse" } },
    // Mini: the rail tracks the pointer live until it commits past the row minimum.
    { desc: "mini inward of RAIL_MINI clamps to RAIL_MINI", width: 10, mini: true, want: { kind: "track", width: RAIL_MINI } },
    { desc: "mini small pull tracks the pointer", width: 100, mini: true, want: { kind: "track", width: 100 } },
    { desc: "mini exactly at row minimum still tracks", width: RAIL_COLLAPSE_AT, mini: true, want: { kind: "track", width: RAIL_COLLAPSE_AT } },
    { desc: "mini past row minimum re-expands at pointer", width: RAIL_COLLAPSE_AT + 1, mini: true, want: { kind: "expand", width: RAIL_COLLAPSE_AT + 1 } },
    { desc: "mini re-expand clamps to max", width: 500, mini: true, want: { kind: "expand", width: RAIL_MAX } },
  ];
  for (const c of cases) {
    it(c.desc, () => {
      expect(railDragDecision(c.width, c.mini)).toEqual(c.want);
    });
  }
});

describe("railDragRelease", () => {
  const COMMIT = RAIL_MINI + RAIL_EXPAND_COMMIT_PX;
  const cases: Array<{
    desc: string;
    width: number;
    mini: boolean;
    want: RailDragRelease;
  }> = [
    { desc: "expanded release stays", width: 200, mini: false, want: { kind: "stay" } },
    { desc: "expanded release inside old sticky zone stays", width: RAIL_COLLAPSE_AT, mini: false, want: { kind: "stay" } },
    { desc: "mini release with no pull settles back", width: RAIL_MINI, mini: true, want: { kind: "settle-mini" } },
    { desc: "mini release just under the commit settles back", width: COMMIT - 1, mini: true, want: { kind: "settle-mini" } },
    { desc: "mini release at the commit springs open", width: COMMIT, mini: true, want: { kind: "spring-expand" } },
    { desc: "mini release well past the commit springs open", width: 150, mini: true, want: { kind: "spring-expand" } },
  ];
  for (const c of cases) {
    it(c.desc, () => {
      expect(railDragRelease(c.width, c.mini)).toEqual(c.want);
    });
  }
});

describe("createWidthAnimator", () => {
  // Deterministic harness: a manual clock plus a queue of scheduled
  // frames the test drains one at a time.
  function harness(startWidth: number, opts: { reducedMotion?: boolean } = {}) {
    let clock = 0;
    let width = startWidth;
    const frames: Array<() => void> = [];
    const widths: number[] = [];
    const animator = createWidthAnimator({
      getWidth: () => width,
      onFrame: (w) => {
        width = w;
        widths.push(w);
      },
      reducedMotion: () => opts.reducedMotion === true,
      now: () => clock,
      schedule: (cb) => frames.push(cb) - 1,
      cancelSchedule: (h) => {
        frames[h] = () => {};
      },
    });
    const step = (ms: number) => {
      clock += ms;
      // Drain everything queued at this instant (cancelled frames are
      // noop-ed in place); frames scheduled by the callbacks land in
      // the next step, like real rAF.
      const pending = frames.splice(0, frames.length);
      for (const cb of pending) cb();
    };
    return { animator, step, widths, getWidth: () => width };
  }

  it("eases from the current width and lands exactly on the target", () => {
    const h = harness(240);
    let done = false;
    h.animator.animateTo(48, { durationMs: 160, onDone: () => (done = true) });
    expect(h.animator.isAnimating()).toBe(true);
    h.step(40);
    expect(h.getWidth()).toBeLessThan(240);
    expect(h.getWidth()).toBeGreaterThan(48);
    h.step(40);
    h.step(40);
    h.step(40); // t = 1
    expect(h.getWidth()).toBe(48);
    expect(done).toBe(true);
    expect(h.animator.isAnimating()).toBe(false);
    // Monotonic shrink for a plain ease-out — no oscillation.
    for (let i = 1; i < h.widths.length; i++) {
      expect(h.widths[i]).toBeLessThanOrEqual(h.widths[i - 1]);
    }
  });

  it("cancel stops mid-flight and suppresses onDone", () => {
    const h = harness(240);
    let done = false;
    h.animator.animateTo(48, { durationMs: 160, onDone: () => (done = true) });
    h.step(40);
    const midWidth = h.getWidth();
    h.animator.cancel();
    h.step(40);
    h.step(1000);
    expect(h.getWidth()).toBe(midWidth);
    expect(done).toBe(false);
    expect(h.animator.isAnimating()).toBe(false);
  });

  it("reduced motion jumps straight to the target and fires onDone", () => {
    const h = harness(240, { reducedMotion: true });
    let done = false;
    h.animator.animateTo(48, { durationMs: 160, onDone: () => (done = true) });
    expect(h.getWidth()).toBe(48);
    expect(done).toBe(true);
    expect(h.widths).toEqual([48]);
    expect(h.animator.isAnimating()).toBe(false);
  });

  it("no-op when already at the target", () => {
    const h = harness(48);
    let done = false;
    h.animator.animateTo(48, { durationMs: 160, onDone: () => (done = true) });
    expect(done).toBe(true);
    expect(h.animator.isAnimating()).toBe(false);
  });

  it("retargeting mid-flight starts from the current width", () => {
    const h = harness(240);
    h.animator.animateTo(48, { durationMs: 160 });
    h.step(80);
    const mid = h.getWidth();
    let done = false;
    h.animator.animateTo(240, { durationMs: 160, onDone: () => (done = true) });
    h.step(160);
    expect(h.getWidth()).toBe(240);
    expect(done).toBe(true);
    // The reversal never dipped below where the first leg left off.
    const reversal = h.widths.slice(h.widths.indexOf(mid) + 1);
    for (const w of reversal) expect(w).toBeGreaterThanOrEqual(mid);
  });

  it("wiggle sequencing: two chained legs return to the base width", () => {
    const h = harness(240);
    const base = 240;
    const seen: string[] = [];
    h.animator.animateTo(base + 12, {
      durationMs: 140,
      onDone: () => {
        seen.push("out");
        h.animator.animateTo(base, {
          durationMs: 140,
          onDone: () => seen.push("back"),
        });
      },
    });
    h.step(70);
    h.step(70); // leg 1 done
    expect(h.getWidth()).toBe(base + 12);
    h.step(70);
    h.step(70); // leg 2 done
    expect(h.getWidth()).toBe(base);
    expect(seen).toEqual(["out", "back"]);
  });

  it("spring easing overshoots past the target then settles on it", () => {
    const h = harness(240);
    h.animator.animateTo(48, { durationMs: 200, easing: "spring" });
    for (let i = 0; i < 20; i++) h.step(10);
    expect(h.getWidth()).toBe(48);
    expect(Math.min(...h.widths)).toBeLessThan(48);
  });
});
