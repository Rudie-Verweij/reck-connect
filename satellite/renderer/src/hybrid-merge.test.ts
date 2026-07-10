import { describe, it, expect } from "vitest";
import { mergeHybridProjects } from "./hybrid-merge";
import type { Project } from "@proto/proto";

function mk(over: Partial<Project>): Project {
  return {
    id: "x",
    name: "X",
    cwd: "/",
    stoplight: "gray",
    pane_count: 0,
    ...over,
  };
}

describe("mergeHybridProjects", () => {
  it("concats pane_ids / pane_stoplights and sums pane_count when both hosts have panes for the same project", () => {
    const primary = [
      mk({
        id: "a",
        pane_count: 2,
        pane_ids: ["s1", "s2"],
        pane_stoplights: ["green", "orange"],
        stoplight: "orange",
      }),
    ];
    const secondary = [
      mk({
        id: "a",
        pane_count: 1,
        pane_ids: ["l1"],
        pane_stoplights: ["green"],
        stoplight: "green",
      }),
    ];
    const merged = mergeHybridProjects(primary, secondary);
    expect(merged).toHaveLength(1);
    expect(merged[0].pane_count).toBe(3);
    expect(merged[0].pane_ids).toEqual(["s1", "s2", "l1"]);
    expect(merged[0].pane_stoplights).toEqual(["green", "orange", "green"]);
    expect(merged[0].stoplight).toBe("orange");
  });

  it("takes max-severity for the project-level stoplight", () => {
    const primary = [
      mk({ id: "a", stoplight: "green", pane_count: 1, pane_ids: ["s1"], pane_stoplights: ["green"] }),
    ];
    const secondary = [
      mk({ id: "a", stoplight: "red", pane_count: 1, pane_ids: ["l1"], pane_stoplights: ["red"] }),
    ];
    expect(mergeHybridProjects(primary, secondary)[0].stoplight).toBe("red");
  });

  it("returns the primary entry untouched when the secondary host has no matching project ID", () => {
    const primary = [mk({ id: "a", pane_count: 1, pane_ids: ["s1"], pane_stoplights: ["green"] })];
    const merged = mergeHybridProjects(primary, []);
    expect(merged[0]).toBe(primary[0]);
  });

  it("returns the primary entry untouched when the secondary host has zero panes for the project", () => {
    const primary = [mk({ id: "a", pane_count: 1, pane_ids: ["s1"], pane_stoplights: ["green"] })];
    const secondary = [mk({ id: "a", pane_count: 0, pane_ids: [], pane_stoplights: [] })];
    const merged = mergeHybridProjects(primary, secondary);
    expect(merged[0]).toBe(primary[0]);
  });

  it("ignores secondary-only projects — primary catalog is canonical", () => {
    const primary = [mk({ id: "a" })];
    const secondary = [mk({ id: "b", pane_count: 1, pane_ids: ["l1"], pane_stoplights: ["green"] })];
    const merged = mergeHybridProjects(primary, secondary);
    expect(merged.map((p) => p.id)).toEqual(["a"]);
  });

  it("treats undefined pane_ids/pane_stoplights on either side as empty arrays", () => {
    const primary = [mk({ id: "a", pane_count: 1, stoplight: "green" })];
    const secondary = [
      mk({ id: "a", pane_count: 1, pane_ids: ["l1"], pane_stoplights: ["orange"], stoplight: "orange" }),
    ];
    const merged = mergeHybridProjects(primary, secondary);
    expect(merged[0].pane_count).toBe(2);
    expect(merged[0].pane_ids).toEqual(["l1"]);
    expect(merged[0].pane_stoplights).toEqual(["orange"]);
    expect(merged[0].stoplight).toBe("orange");
  });

  it("preserves primary order", () => {
    const primary = [mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" })];
    const secondary = [mk({ id: "b", pane_count: 1, pane_ids: ["l1"], pane_stoplights: ["green"] })];
    const merged = mergeHybridProjects(primary, secondary);
    expect(merged.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(merged[1].pane_count).toBe(1);
  });
});
