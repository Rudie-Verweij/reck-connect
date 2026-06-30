import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installTtsShortcuts } from "./ttsShortcuts";

interface H {
  onSpeak: ReturnType<typeof vi.fn>;
  onStop: ReturnType<typeof vi.fn>;
  onPauseToggle: ReturnType<typeof vi.fn>;
  onRateUp: ReturnType<typeof vi.fn>;
  onRateDown: ReturnType<typeof vi.fn>;
  isActive: () => boolean;
}

function makeHandlers(active = false): H {
  return {
    onSpeak: vi.fn(),
    onStop: vi.fn(),
    onPauseToggle: vi.fn(),
    onRateUp: vi.fn(),
    onRateDown: vi.fn(),
    isActive: () => active,
  };
}

function fireKey(opts: {
  key: string;
  meta?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  target?: EventTarget;
}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key: opts.key,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    ctrlKey: opts.ctrl ?? false,
    altKey: opts.alt ?? false,
    bubbles: true,
    cancelable: true,
  });
  (opts.target ?? window).dispatchEvent(ev);
  return ev;
}

describe("installTtsShortcuts — ⌘⇧S start/restart", () => {
  let h: H;
  let uninstall: () => void;

  beforeEach(() => {
    h = makeHandlers();
    uninstall = installTtsShortcuts(h);
  });
  afterEach(() => uninstall());

  it("calls onSpeak when ⌘⇧S is pressed", () => {
    fireKey({ key: "s", meta: true, shift: true });
    expect(h.onSpeak).toHaveBeenCalledTimes(1);
  });

  it("uppercase S still triggers (Shift typically uppercases)", () => {
    fireKey({ key: "S", meta: true, shift: true });
    expect(h.onSpeak).toHaveBeenCalledTimes(1);
  });

  it("plain ⌘S does NOT trigger (different binding)", () => {
    fireKey({ key: "s", meta: true });
    expect(h.onSpeak).not.toHaveBeenCalled();
  });

  it("plain S (no meta) does NOT trigger", () => {
    fireKey({ key: "s" });
    expect(h.onSpeak).not.toHaveBeenCalled();
  });

  it("preventDefault is called on the matched event", () => {
    const ev = fireKey({ key: "s", meta: true, shift: true });
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("installTtsShortcuts — Escape is NOT bound (heavily used elsewhere)", () => {
  it("does NOT call onStop on plain Esc, even when speaking", () => {
    const h = makeHandlers(true);
    const off = installTtsShortcuts(h);
    fireKey({ key: "Escape" });
    expect(h.onStop).not.toHaveBeenCalled();
    off();
  });

  it("does NOT preventDefault on Esc (lets other UI use it freely)", () => {
    const h = makeHandlers(true);
    const off = installTtsShortcuts(h);
    const ev = fireKey({ key: "Escape" });
    expect(ev.defaultPrevented).toBe(false);
    off();
  });
});

describe("installTtsShortcuts — ⌘⇧X pause/resume toggle", () => {
  it("calls onPauseToggle when ⌘⇧X is pressed", () => {
    const h = makeHandlers(true);
    const off = installTtsShortcuts(h);
    fireKey({ key: "x", meta: true, shift: true });
    expect(h.onPauseToggle).toHaveBeenCalledTimes(1);
    off();
  });

  it("uppercase X (Shift typically uppercases) also triggers", () => {
    const h = makeHandlers(true);
    const off = installTtsShortcuts(h);
    fireKey({ key: "X", meta: true, shift: true });
    expect(h.onPauseToggle).toHaveBeenCalledTimes(1);
    off();
  });

  it("⌘⇧P (the OLD binding) does NOT trigger", () => {
    const h = makeHandlers(true);
    const off = installTtsShortcuts(h);
    fireKey({ key: "p", meta: true, shift: true });
    expect(h.onPauseToggle).not.toHaveBeenCalled();
    off();
  });

  it("does NOT trigger when nothing is speaking", () => {
    const h = makeHandlers(false);
    const off = installTtsShortcuts(h);
    fireKey({ key: "x", meta: true, shift: true });
    expect(h.onPauseToggle).not.toHaveBeenCalled();
    off();
  });
});

describe("installTtsShortcuts — ⌘⇧+ / ⌘⇧- rate adjust", () => {
  let h: H;
  let off: () => void;

  beforeEach(() => {
    h = makeHandlers(true);
    off = installTtsShortcuts(h);
  });
  afterEach(() => off());

  it("⌘⇧+ (key '+') calls onRateUp", () => {
    fireKey({ key: "+", meta: true, shift: true });
    expect(h.onRateUp).toHaveBeenCalledTimes(1);
  });

  it("⌘⇧= (US keyboard physical + key) calls onRateUp", () => {
    // On most US keyboards the "+" character is Shift+= ; modern browsers
    // surface ev.key="+" with shift true, but some keyboard layouts
    // surface "=" with shift instead. Accept both.
    fireKey({ key: "=", meta: true, shift: true });
    expect(h.onRateUp).toHaveBeenCalledTimes(1);
  });

  it("⌘⇧- calls onRateDown", () => {
    fireKey({ key: "-", meta: true, shift: true });
    expect(h.onRateDown).toHaveBeenCalledTimes(1);
  });

  it("does NOT trigger when not active", () => {
    off(); // remove the active handler set
    const inactive = makeHandlers(false);
    const off2 = installTtsShortcuts(inactive);
    fireKey({ key: "+", meta: true, shift: true });
    fireKey({ key: "-", meta: true, shift: true });
    expect(inactive.onRateUp).not.toHaveBeenCalled();
    expect(inactive.onRateDown).not.toHaveBeenCalled();
    off2();
  });
});

describe("installTtsShortcuts — uninstall", () => {
  it("uninstall() detaches the listener", () => {
    const h = makeHandlers();
    const off = installTtsShortcuts(h);
    off();
    fireKey({ key: "s", meta: true, shift: true });
    expect(h.onSpeak).not.toHaveBeenCalled();
  });
});

describe("installTtsShortcuts — irrelevant keys are ignored", () => {
  it("does not fire any handler for unrelated keys", () => {
    const h = makeHandlers(true);
    const off = installTtsShortcuts(h);
    fireKey({ key: "a", meta: true });
    fireKey({ key: "Enter" });
    fireKey({ key: "Tab", shift: true });
    expect(h.onSpeak).not.toHaveBeenCalled();
    expect(h.onStop).not.toHaveBeenCalled();
    expect(h.onPauseToggle).not.toHaveBeenCalled();
    expect(h.onRateUp).not.toHaveBeenCalled();
    expect(h.onRateDown).not.toHaveBeenCalled();
    off();
  });
});
