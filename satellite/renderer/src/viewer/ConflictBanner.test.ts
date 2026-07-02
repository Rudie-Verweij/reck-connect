// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountConflictBanner } from "./ConflictBanner";

describe("mountConflictBanner", () => {
  let parent: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });

  it("inserts the banner as the first child of the parent", () => {
    parent.appendChild(document.createElement("p"));
    mountConflictBanner({
      parent,
      onForceMine: vi.fn(),
      onForceTheirs: vi.fn(),
      onOpenManualMerge: vi.fn(),
    });
    expect(parent.firstElementChild?.className).toBe("file-viewer-conflict-banner");
  });

  it("renders three primary actions (Force mine / Force theirs / Open diff)", () => {
    mountConflictBanner({
      parent,
      onForceMine: vi.fn(),
      onForceTheirs: vi.fn(),
      onOpenManualMerge: vi.fn(),
    });
    const buttons = parent.querySelectorAll(".file-viewer-conflict-action");
    const labels = Array.from(buttons).map((b) => b.textContent ?? "");
    expect(labels).toContain("Force mine");
    expect(labels).toContain("Force theirs");
    expect(labels).toContain("Open diff");
  });

  it("clicking Force mine fires onForceMine", () => {
    const onForceMine = vi.fn();
    mountConflictBanner({
      parent,
      onForceMine,
      onForceTheirs: vi.fn(),
      onOpenManualMerge: vi.fn(),
    });
    (parent.querySelector(".file-viewer-conflict-force-mine") as HTMLButtonElement).click();
    expect(onForceMine).toHaveBeenCalledTimes(1);
  });

  it("clicking Force theirs fires onForceTheirs", () => {
    const onForceTheirs = vi.fn();
    mountConflictBanner({
      parent,
      onForceMine: vi.fn(),
      onForceTheirs,
      onOpenManualMerge: vi.fn(),
    });
    (parent.querySelector(".file-viewer-conflict-force-theirs") as HTMLButtonElement).click();
    expect(onForceTheirs).toHaveBeenCalledTimes(1);
  });

  it("clicking Open diff fires onOpenManualMerge", () => {
    const onOpenManualMerge = vi.fn();
    mountConflictBanner({
      parent,
      onForceMine: vi.fn(),
      onForceTheirs: vi.fn(),
      onOpenManualMerge,
    });
    (parent.querySelector(".file-viewer-conflict-manual-merge") as HTMLButtonElement).click();
    expect(onOpenManualMerge).toHaveBeenCalledTimes(1);
  });

  it("renders a custom message when supplied", () => {
    mountConflictBanner({
      parent,
      message: "Custom conflict message.",
      onForceMine: vi.fn(),
      onForceTheirs: vi.fn(),
      onOpenManualMerge: vi.fn(),
    });
    const msg = parent.querySelector(".file-viewer-conflict-message");
    expect(msg?.textContent).toBe("Custom conflict message.");
  });

  it("dispose() removes the banner from the DOM", () => {
    const handle = mountConflictBanner({
      parent,
      onForceMine: vi.fn(),
      onForceTheirs: vi.fn(),
      onOpenManualMerge: vi.fn(),
    });
    expect(parent.querySelector(".file-viewer-conflict-banner")).not.toBeNull();
    handle.dispose();
    expect(parent.querySelector(".file-viewer-conflict-banner")).toBeNull();
    expect(handle.isMounted()).toBe(false);
  });

  it("includes a Dismiss button only when onDismiss is supplied", () => {
    const onDismiss = vi.fn();
    mountConflictBanner({
      parent,
      onForceMine: vi.fn(),
      onForceTheirs: vi.fn(),
      onOpenManualMerge: vi.fn(),
      onDismiss,
    });
    const dismiss = parent.querySelector(".file-viewer-conflict-dismiss") as HTMLButtonElement | null;
    expect(dismiss).not.toBeNull();
    dismiss!.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
