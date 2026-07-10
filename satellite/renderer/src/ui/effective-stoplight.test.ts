import { describe, it, expect } from "vitest";
import type { Project, Stoplight } from "@proto/proto";
import { effectiveStoplight } from "./effective-stoplight";

function mkProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "P1",
    cwd: "/tmp/p1",
    stoplight: "gray",
    pane_count: 0,
    pane_stoplights: [],
    ...overrides,
  };
}

describe("effectiveStoplight", () => {
  it("returns the project unchanged when the project is in the unseen-green flash state", () => {
    const p = mkProject({
      stoplight: "green",
      pane_stoplights: ["green", "green"],
      pane_count: 2,
    });
    const out = effectiveStoplight(p, true);
    expect(out).toBe(p);
  });

  it("dims the aggregate green to gray when acknowledged", () => {
    const p = mkProject({ stoplight: "green" });
    const out = effectiveStoplight(p, false);
    expect(out.stoplight).toBe("gray");
  });

  it("dims every green pane_stoplights entry to gray when acknowledged", () => {
    const p = mkProject({
      stoplight: "green",
      pane_stoplights: ["gray", "green", "gray"],
      pane_count: 3,
    });
    const out = effectiveStoplight(p, false);
    expect(out.stoplight).toBe("gray");
    expect(out.pane_stoplights).toEqual(["gray", "gray", "gray"]);
  });

  it("leaves non-green stoplights alone when acknowledged", () => {
    const p = mkProject({
      stoplight: "orange",
      pane_stoplights: ["orange", "red", "gray"],
      pane_count: 3,
    });
    const out = effectiveStoplight(p, false);
    expect(out.stoplight).toBe("orange");
    expect(out.pane_stoplights).toEqual(["orange", "red", "gray"]);
  });

  it("dims per-pane greens even when the aggregate is already non-green", () => {
    // One pane working (orange) + one pane idle (green). Aggregate
    // severity picks orange so `unseenGreen[p.id]` never flipped true
    // for this project — the idle pane's green is stale and should
    // not flash on the rail.
    const p = mkProject({
      stoplight: "orange",
      pane_stoplights: ["orange", "green"],
      pane_count: 2,
    });
    const out = effectiveStoplight(p, false);
    expect(out.stoplight).toBe("orange");
    expect(out.pane_stoplights).toEqual(["orange", "gray"]);
  });

  it("returns the same object reference when nothing needs dimming", () => {
    const p = mkProject({
      stoplight: "orange",
      pane_stoplights: ["orange", "gray"],
      pane_count: 2,
    });
    const out = effectiveStoplight(p, false);
    expect(out).toBe(p);
  });

  it("leaves pane_stoplights undefined when the daemon omits the field (Older)", () => {
    // Project type carries `pane_stoplights?: Stoplight[]`; a Older
    // daemon omits it entirely. Make sure the filter doesn't accidentally
    // assert it to an empty array — rail.resolvePaneStoplights falls back
    // to `pane_count` dots colored by the aggregate in that case, and
    // that fallback only kicks in when the field is still undefined.
    const p: Project = {
      id: "p1",
      name: "P1",
      cwd: "/tmp/p1",
      stoplight: "green",
      pane_count: 2,
    };
    const out = effectiveStoplight(p, false);
    expect(out.stoplight).toBe("gray");
    expect(out.pane_stoplights).toBeUndefined();
  });

  it("does not mutate the input project", () => {
    const p = mkProject({
      stoplight: "green",
      pane_stoplights: ["green", "gray"],
      pane_count: 2,
    });
    const frozen = JSON.stringify(p);
    effectiveStoplight(p, false);
    expect(JSON.stringify(p)).toBe(frozen);
  });

  describe("per-pane ack while project is flashing ", () => {
    it("dims acknowledged panes even while the project flash is active", () => {
      // 3 panes all green, project flash on, but the user has focused
      // panes A and B already — only C should still be flashing.
      const p = mkProject({
        stoplight: "green",
        pane_stoplights: ["green", "green", "green"],
        pane_ids: ["A", "B", "C"],
        pane_count: 3,
      });
      const isPaneUnseen = (id: string) => id === "C";
      const out = effectiveStoplight(p, true, isPaneUnseen);
      expect(out.stoplight).toBe("green");
      expect(out.pane_stoplights).toEqual(["gray", "gray", "green"]);
    });

    it("dims every pane dot when the project is flashing but no pane is unseen", () => {
      // Race condition described in an earlier release: project-level flag is on
      // (auto-ack timer hasn't fired yet) but the user has already
      // dismissed every pane via individual focus. All dots dim.
      const p = mkProject({
        stoplight: "green",
        pane_stoplights: ["green", "green", "green"],
        pane_ids: ["A", "B", "C"],
        pane_count: 3,
      });
      const out = effectiveStoplight(p, true, () => false);
      expect(out.stoplight).toBe("green");
      expect(out.pane_stoplights).toEqual(["gray", "gray", "gray"]);
    });

    it("returns the project unchanged when every pane is still unseen", () => {
      // Nothing to dim — fast-path the same-reference return so the
      // rail's render pass can short-circuit on identity.
      const p = mkProject({
        stoplight: "green",
        pane_stoplights: ["green", "green"],
        pane_ids: ["A", "B"],
        pane_count: 2,
      });
      const out = effectiveStoplight(p, true, () => true);
      expect(out).toBe(p);
    });

    it("does not touch non-green panes regardless of their ack state", () => {
      // An orange pane should never go gray, even if the user has
      // acknowledged it — the dim transform applies to greens only.
      const p = mkProject({
        stoplight: "green",
        pane_stoplights: ["green", "orange", "green"],
        pane_ids: ["A", "B", "C"],
        pane_count: 3,
      });
      const isPaneUnseen = (id: string) => id === "A";
      const out = effectiveStoplight(p, true, isPaneUnseen);
      expect(out.stoplight).toBe("green");
      expect(out.pane_stoplights).toEqual(["green", "orange", "gray"]);
    });

    it("falls back to the project-flag-only path when pane_ids is missing (Older daemon)", () => {
      // Older daemons that don't emit pane_ids — we can't map dots to
      // ack state, so keep the Older behaviour and let the project
      // flash carry until project-level ack.
      const p = mkProject({
        stoplight: "green",
        pane_stoplights: ["green", "green"],
        pane_count: 2,
      });
      const out = effectiveStoplight(p, true, () => false);
      expect(out).toBe(p);
    });

    it("falls back when pane_ids length does not match pane_stoplights length", () => {
      // Defensive: misaligned arrays from a buggy daemon should not
      // crash or produce nonsense — fall back to the conservative
      // project-flag-only behaviour.
      const p = mkProject({
        stoplight: "green",
        pane_stoplights: ["green", "green", "green"],
        pane_ids: ["A", "B"],
        pane_count: 3,
      });
      const out = effectiveStoplight(p, true, () => false);
      expect(out).toBe(p);
    });

    it("handles empty pane arrays without crashing or cloning", () => {
      // Zero-pane projects (a freshly-created project before the first
      // pane spawn). Lengths match (0 === 0), nothing to dim — return
      // the same reference.
      const p = mkProject({
        stoplight: "green",
        pane_stoplights: [],
        pane_ids: [],
        pane_count: 0,
      });
      const out = effectiveStoplight(p, true, () => false);
      expect(out).toBe(p);
    });

    it("does not mutate the input pane_stoplights when dimming individual dots", () => {
      // Belt-and-braces: confirm the original array is referentially
      // unchanged when the filter forks a new pane_stoplights.
      const p = mkProject({
        stoplight: "green",
        pane_stoplights: ["green", "green"],
        pane_ids: ["A", "B"],
        pane_count: 2,
      });
      const beforeRef = p.pane_stoplights;
      const beforeJson = JSON.stringify(p.pane_stoplights);
      const out = effectiveStoplight(p, true, (id) => id === "A");
      expect(p.pane_stoplights).toBe(beforeRef);
      expect(JSON.stringify(p.pane_stoplights)).toBe(beforeJson);
      expect(out.pane_stoplights).not.toBe(beforeRef);
      expect(out.pane_stoplights).toEqual(["green", "gray"]);
    });

    it("dims the aggregate but keeps per-pane unseen dots flashing after project ack", () => {
      // boot.ts:247-251 spells out the intent: "other tabs in the
      // project (not the one the user is looking at) keep their green
      // dots until the user actually switches to them". So when the
      // user clicks the project chip (project-level ack) but hasn't
      // yet focused each individual pane, the chip dims while the
      // unfocused panes' dots keep flashing.
      const p = mkProject({
        stoplight: "green",
        pane_stoplights: ["green", "green"],
        pane_ids: ["A", "B"],
        pane_count: 2,
      });
      const out = effectiveStoplight(p, false, () => true);
      expect(out.stoplight).toBe("gray");
      expect(out.pane_stoplights).toEqual(["green", "green"]);
    });

    it("dims per-pane greens that the user has focused, even when aggregate is acked", () => {
      // Same as above but with per-pane state granular: project-level
      // ack fired, pane A focused (and thus its per-pane ack fired),
      // pane B never visited. Aggregate gray, A gray, B still green.
      const p = mkProject({
        stoplight: "green",
        pane_stoplights: ["green", "green"],
        pane_ids: ["A", "B"],
        pane_count: 2,
      });
      const out = effectiveStoplight(p, false, (id) => id === "B");
      expect(out.stoplight).toBe("gray");
      expect(out.pane_stoplights).toEqual(["gray", "green"]);
    });

    it("flashes a freshly-green pane in a mixed-state project even when no aggregate transition occurred", () => {
      // The mixed-state case Codex flagged: project has one orange
      // (working) pane and one green (just completed) pane. The
      // aggregate stays orange (severity max), so unseenGreen[p.id]
      // never flipped — `isUnseenGreen=false`. But pane B's per-pane
      // unseen flag *did* flip via trackPaneStoplightTransitions. The
      // rail must still flash B's dot, otherwise the new background-
      // pane tracking is invisible exactly in the case it was added
      // for.
      const p = mkProject({
        stoplight: "orange",
        pane_stoplights: ["orange", "green"],
        pane_ids: ["A", "B"],
        pane_count: 2,
      });
      const out = effectiveStoplight(p, false, (id) => id === "B");
      expect(out.stoplight).toBe("orange");
      expect(out.pane_stoplights).toEqual(["orange", "green"]);
    });
  });
});
