// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { ensurePaneControls, ensureHistoryButton } from "./paneControls";

describe("paneControls", () => {
  it("creates one .pane-controls child, idempotently", () => {
    const anchor = document.createElement("div");
    const a = ensurePaneControls(anchor);
    expect(a.classList.contains("pane-controls")).toBe(true);
    expect(anchor.children).toHaveLength(1);
    // Second call returns the SAME element (shared by all mounters).
    const b = ensurePaneControls(anchor);
    expect(b).toBe(a);
    expect(anchor.querySelectorAll(".pane-controls")).toHaveLength(1);
  });

  it("adds a single history button in the stack, idempotently, firing onToggle", () => {
    const anchor = document.createElement("div");
    const onToggle = vi.fn();
    const btn = ensureHistoryButton(anchor, { icon: "<svg></svg>", onToggle });
    expect(btn.classList.contains("pane-controls-history")).toBe(true);
    // Lives inside the stack.
    expect(ensurePaneControls(anchor).contains(btn)).toBe(true);
    // Idempotent — no duplicate.
    expect(ensureHistoryButton(anchor, { icon: "<svg></svg>", onToggle })).toBe(btn);
    expect(anchor.querySelectorAll(".pane-controls-history")).toHaveLength(1);
    btn.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
