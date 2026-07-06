// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { ensurePaneControls, ensureHistoryButton, setHistoryButtonActive } from "./paneControls";

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

  it("reflects history-open state via aria-pressed and swaps the tooltip", () => {
    const anchor = document.createElement("div");
    const btn = ensureHistoryButton(anchor, { icon: "<svg></svg>", onToggle: vi.fn() });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    const idleTitle = btn.title;

    setHistoryButtonActive(anchor, true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.title).toContain("Back to live terminal");

    setHistoryButtonActive(anchor, false);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.title).toBe(idleTitle);
  });

  it("only touches the anchor's own stack, not a nested overlay's", () => {
    const anchor = document.createElement("div");
    const btn = ensureHistoryButton(anchor, { icon: "<svg></svg>", onToggle: vi.fn() });
    // A transcript overlay mounts its own control stack INSIDE the wrapper —
    // its (button-less) stack must not shadow the wrapper's.
    const overlayRoot = document.createElement("div");
    anchor.appendChild(overlayRoot);
    ensurePaneControls(overlayRoot);

    setHistoryButtonActive(anchor, true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    // No button under the overlay anchor — a silent no-op, never a throw.
    expect(() => setHistoryButtonActive(overlayRoot, false)).not.toThrow();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });
});
