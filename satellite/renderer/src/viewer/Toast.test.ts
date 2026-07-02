// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { showToast } from "./Toast";

describe("showToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("mounts a toast element into the parent with the message", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    showToast(parent, "Already viewing this file");

    const toast = parent.querySelector(".file-viewer-toast");
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toBe("Already viewing this file");
    expect(toast?.getAttribute("role")).toBe("status");
    expect(toast?.getAttribute("aria-live")).toBe("polite");
  });

  it("adds the fade-out class after durationMs and removes the element after the fade", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    showToast(parent, "x", { durationMs: 1000, fadeMs: 200 });

    const toast = parent.querySelector(".file-viewer-toast");
    expect(toast).not.toBeNull();
    expect(toast?.classList.contains("file-viewer-toast--fade-out")).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(toast?.classList.contains("file-viewer-toast--fade-out")).toBe(true);

    vi.advanceTimersByTime(200);
    expect(parent.querySelector(".file-viewer-toast")).toBeNull();
  });

  it("dispose() removes the toast immediately and cancels pending timers", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const handle = showToast(parent, "x", { durationMs: 1000, fadeMs: 200 });
    handle.dispose();
    expect(parent.querySelector(".file-viewer-toast")).toBeNull();

    // Advancing further must not throw or attempt to re-remove.
    vi.advanceTimersByTime(2000);
    expect(parent.querySelector(".file-viewer-toast")).toBeNull();
  });

  // Round 8.6 follow-up (2026-05-21) — user reported the same-popup
  // toast was hard to see on the cream-on-cream popup body. New `kind`
  // option opts into the high-contrast "info" (Reck-orange) style by
  // default; "error" applies the Wes-rose variant for failures.
  describe("kind variants", () => {
    it("defaults to 'info' kind — the base class IS the info style", () => {
      const parent = document.createElement("div");
      document.body.appendChild(parent);

      showToast(parent, "Already viewing this file");

      const toast = parent.querySelector(".file-viewer-toast");
      expect(toast).not.toBeNull();
      expect(toast?.classList.contains("file-viewer-toast--error")).toBe(false);
    });

    it("applies file-viewer-toast--error when kind=error AND sets role=alert / aria-live=assertive", () => {
      const parent = document.createElement("div");
      document.body.appendChild(parent);

      showToast(parent, "Could not open: out of roots", { kind: "error" });

      const toast = parent.querySelector(".file-viewer-toast");
      expect(toast).not.toBeNull();
      expect(toast?.classList.contains("file-viewer-toast--error")).toBe(true);
      // Errors are assertive so screen readers interrupt; info is polite.
      expect(toast?.getAttribute("role")).toBe("alert");
      expect(toast?.getAttribute("aria-live")).toBe("assertive");
    });

    it("explicit kind=info matches the default (no modifier, polite live region)", () => {
      const parent = document.createElement("div");
      document.body.appendChild(parent);

      showToast(parent, "x", { kind: "info" });

      const toast = parent.querySelector(".file-viewer-toast");
      expect(toast?.classList.contains("file-viewer-toast--error")).toBe(false);
      expect(toast?.getAttribute("role")).toBe("status");
      expect(toast?.getAttribute("aria-live")).toBe("polite");
    });

    it("number arg (legacy duration-only shape) still works without kind", () => {
      const parent = document.createElement("div");
      document.body.appendChild(parent);

      showToast(parent, "legacy caller", 1500);

      const toast = parent.querySelector(".file-viewer-toast");
      expect(toast).not.toBeNull();
      expect(toast?.classList.contains("file-viewer-toast--error")).toBe(false);
    });
  });
});
