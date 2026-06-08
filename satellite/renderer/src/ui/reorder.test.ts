import { describe, it, expect } from "vitest";
import { computeReorder } from "./reorder";

describe("computeReorder", () => {
  it("moves dragged id before target", () => {
    expect(computeReorder(["a", "b", "c", "d"], "d", "b", "before")).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("moves dragged id after target", () => {
    expect(computeReorder(["a", "b", "c", "d"], "a", "c", "after")).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("is a no-op when dropped on itself", () => {
    expect(computeReorder(["a", "b", "c"], "b", "b", "before")).toEqual(["a", "b", "c"]);
  });

  it("is a no-op when dragged id is unknown", () => {
    expect(computeReorder(["a", "b", "c"], "x", "b", "before")).toEqual(["a", "b", "c"]);
  });

  it("is a no-op when target id is unknown", () => {
    expect(computeReorder(["a", "b", "c"], "a", "x", "after")).toEqual(["a", "b", "c"]);
  });

  it("moves to front when target is first and position=before", () => {
    expect(computeReorder(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
  });

  it("moves to end when target is last and position=after", () => {
    expect(computeReorder(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
  });
});
