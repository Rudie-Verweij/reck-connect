// Round 8.6 Phase 9 — shared click-log + openInViewer-handle helper.
//
// User reported (2026-05-21) that the source-view click handlers had
// inconsistent logging vs the markdown handler AND fired-and-forgot
// the openInViewer call — so neither the "Already viewing this file"
// toast nor the error toast surfaced. This helper centralises:
//   - Click-activate logging with a uniform shape per surface
//   - Result-handling: rejection toast, same-popup toast, throw-warn

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  logClickActivate,
  logClickRejected,
  logClickThrew,
  logClickSamePopup,
  openInViewerWithToast,
  type ClickContext,
} from "./click-log";

describe("click-log helpers", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  const baseCtx = (): ClickContext => ({
    surface: "popup-source",
    href: "~/.claude/plans/x.md",
    opener: "/home/pi/.claude/plans/x.md",
    target: "~/.claude/plans/x.md",
    sourceHost: "station",
  });

  it("logClickActivate logs with [click:<surface>] prefix and full context", () => {
    logClickActivate(baseCtx());
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = logSpy.mock.calls[0];
    expect(tag).toBe("[click:popup-source] activate");
    expect(payload).toMatchObject({
      surface: "popup-source",
      href: "~/.claude/plans/x.md",
      opener: "/home/pi/.claude/plans/x.md",
      target: "~/.claude/plans/x.md",
      sourceHost: "station",
    });
  });

  it("logClickRejected logs as warn with the IPC result attached", () => {
    logClickRejected(baseCtx(), {
      ok: false,
      code: "unreachable",
      error: "Outside mount",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = warnSpy.mock.calls[0];
    expect(tag).toBe("[click:popup-source] openInViewer rejected");
    expect(payload).toMatchObject({
      result: { ok: false, code: "unreachable", error: "Outside mount" },
    });
  });

  it("logClickThrew logs as warn with the error attached", () => {
    logClickThrew(baseCtx(), new Error("boom"));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = warnSpy.mock.calls[0];
    expect(tag).toBe("[click:popup-source] openInViewer threw");
    expect(payload).toMatchObject({ error: expect.any(Error) });
  });

  it("logClickSamePopup logs as info (debug-level signal)", () => {
    logClickSamePopup(baseCtx());
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [tag] = logSpy.mock.calls[0];
    expect(tag).toBe("[click:popup-source] already-open (toast)");
  });
});

describe("openInViewerWithToast", () => {
  interface ToastRecord {
    msg: string;
    ttl?: number;
    kind?: "info" | "error";
  }
  let toasts: ToastRecord[];
  let showToast: (msg: string, opts?: { ttl?: number; kind?: "info" | "error" }) => void;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    toasts = [];
    showToast = (msg, opts) => {
      toasts.push({ msg, ttl: opts?.ttl, kind: opts?.kind });
    };
  });

  const baseCtx = (): ClickContext => ({
    surface: "popup-markdown",
    href: "./other.md",
    opener: "/home/pi/.claude/plans/x.md",
    target: "/home/pi/.claude/plans/other.md",
    sourceHost: "station",
  });

  it("HIT (ok=true, no code) — no toast", async () => {
    const openInViewer = vi.fn().mockResolvedValue({ ok: true });
    await openInViewerWithToast({
      ctx: baseCtx(),
      openInViewer,
      showToast,
    });
    expect(openInViewer).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });

  it("SAME-POPUP — fires 'Already viewing this file' toast", async () => {
    const openInViewer = vi
      .fn()
      .mockResolvedValue({ ok: true, code: "same-popup" });
    await openInViewerWithToast({
      ctx: baseCtx(),
      openInViewer,
      showToast,
    });
    // No ttl/kind passed for info default → matches the brand-orange style.
    expect(toasts).toEqual([
      { msg: "Already viewing this file.", ttl: undefined, kind: undefined },
    ]);
  });

  it("FOCUSED-EXISTING — no toast (different popup got focused)", async () => {
    const openInViewer = vi
      .fn()
      .mockResolvedValue({ ok: true, code: "focused-existing" });
    await openInViewerWithToast({
      ctx: baseCtx(),
      openInViewer,
      showToast,
    });
    expect(toasts).toEqual([]);
  });

  it("REJECTED — fires error toast using result.error when available", async () => {
    const openInViewer = vi
      .fn()
      .mockResolvedValue({ ok: false, code: "out-of-roots", error: "Outside" });
    await openInViewerWithToast({
      ctx: baseCtx(),
      openInViewer,
      showToast,
    });
    // Rejection MUST tag kind:error so it gets the rose styling +
    // assertive aria-live (interrupts screen readers).
    expect(toasts).toEqual([
      { msg: "Could not open: Outside", ttl: 3500, kind: "error" },
    ]);
  });

  it("REJECTED with no error — falls back to generic message", async () => {
    const openInViewer = vi.fn().mockResolvedValue({ ok: false });
    await openInViewerWithToast({
      ctx: baseCtx(),
      openInViewer,
      showToast,
    });
    expect(toasts).toEqual([
      { msg: "Could not open file.", ttl: 3500, kind: "error" },
    ]);
  });

  it("THREW — logs warn, does NOT toast (avoids spam on transient failures)", async () => {
    const openInViewer = vi.fn().mockRejectedValue(new Error("network gone"));
    await openInViewerWithToast({
      ctx: baseCtx(),
      openInViewer,
      showToast,
    });
    expect(toasts).toEqual([]);
  });
});
