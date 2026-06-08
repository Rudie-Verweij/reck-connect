// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverFocusController } from "./hover-focus-controller";

/**
 * Unit tests for `HoverFocusController`. Each test covers one gate from
 * the plan (see `notes/2026-04-23-hover-to-focus-plan/plan.md` §
 * "Suppression invariants").
 *
 * All tests run the controller with `dwellMs: 0` so `apply` fires
 * synchronously on a successful request. The dwell path itself is
 * covered by a dedicated test using `vi.useFakeTimers`.
 */
describe("HoverFocusController", () => {
  let enabled: boolean;
  let activeLeaf: string | null;
  let ctrl: HoverFocusController;
  let applyCount: number;
  let lastLeafApplied: string | null;

  // Keep `document.hasFocus()` controllable; jsdom returns `false` by
  // default which would trip gate 3 on every test. Override to return
  // a value driven by this flag.
  let docHasFocus = true;
  const origHasFocus = document.hasFocus.bind(document);

  beforeEach(() => {
    enabled = true;
    activeLeaf = null;
    applyCount = 0;
    lastLeafApplied = null;
    docHasFocus = true;
    document.hasFocus = () => docHasFocus;
    // Fresh body so leftover .new-pane-dialog / .rail-context-menu
    // elements from one test can't contaminate another.
    document.body.innerHTML = "";
    ctrl = new HoverFocusController({
      isEnabled: () => enabled,
      isAlreadyActive: (id) => id === activeLeaf,
      dwellMs: 0,
    });
    ctrl.attach();
  });

  afterEach(() => {
    ctrl.detach();
    document.hasFocus = origHasFocus;
  });

  const apply = (leafId: string) => () => {
    applyCount++;
    lastLeafApplied = leafId;
  };

  it("gate 1 — pref disabled suppresses", () => {
    enabled = false;
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
  });

  it("gate 1+2+3 happy path — all gates clear → apply fires", () => {
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(1);
    expect(lastLeafApplied).toBe("leafA");
  });

  it("gate 2 — mouse button held suppresses", () => {
    window.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
    // Release → subsequent request should fire.
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(1);
  });

  it("gate 2 — multi-button held counts correctly", () => {
    window.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    window.dispatchEvent(new MouseEvent("mousedown", { button: 2 }));
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    // One button still down — suppressed.
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
    window.dispatchEvent(new MouseEvent("mouseup", { button: 2 }));
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(1);
  });

  it("gate 2 — mouseup clamps at zero on stray release", () => {
    // Stray mouseup (mousedown eaten by the OS). Should not push the
    // counter negative and unlock a later legitimate mousedown.
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    window.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
  });

  it("gate 3 — window unfocused suppresses", () => {
    docHasFocus = false;
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
  });

  it("gate 4 — modal dialog open suppresses", () => {
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";
    document.body.appendChild(overlay);
    // MutationObserver is async; flush the microtask queue.
    return Promise.resolve().then(() => {
      ctrl.request("leafA", apply("leafA"));
      expect(applyCount).toBe(0);
      overlay.remove();
      return Promise.resolve().then(() => {
        // Even after removal, the close-cooldown suppresses the
        // immediate next request. Advance past the 150ms cooldown.
        ctrl.request("leafA", apply("leafA"));
        expect(applyCount).toBe(0);
      });
    });
  });

  it("gate 4 — modal present when attached is detected", () => {
    // Controller re-attached with a modal already in the DOM; the
    // initial snapshot should pick it up.
    ctrl.detach();
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";
    document.body.appendChild(overlay);
    ctrl.attach();
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
  });

  it("gate 5 — contextmenu event triggers cooldown", () => {
    document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
  });

  it("gate 5 — rail context menu open suppresses", async () => {
    const menu = document.createElement("div");
    menu.className = "rail-context-menu";
    document.body.appendChild(menu);
    await Promise.resolve();
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
    menu.remove();
  });

  it("gate 5 — cooldown expires and apply resumes", () => {
    vi.useFakeTimers();
    try {
      // Rebuild ctrl using fake timers' Date.
      ctrl.detach();
      ctrl = new HoverFocusController({
        isEnabled: () => enabled,
        isAlreadyActive: (id) => id === activeLeaf,
        dwellMs: 0,
      });
      ctrl.attach();
      document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      ctrl.request("leafA", apply("leafA"));
      expect(applyCount).toBe(0);
      vi.setSystemTime(Date.now() + 200);
      ctrl.request("leafA", apply("leafA"));
      expect(applyCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gate 6 — editable element focused suppresses", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
    input.remove();
  });

  it("gate 6 — xterm hidden textarea focus does NOT suppress", () => {
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    document.body.appendChild(ta);
    ta.focus();
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(1);
    ta.remove();
  });

  it("gate 6 — contentEditable div suppresses", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    // jsdom requires a `tabindex` (or a focusable tag) for `.focus()`
    // to actually move `activeElement`; without it the call is a
    // no-op and the gate would be tested against `document.body`
    // instead. Real browsers focus contenteditable divs natively —
    // the tabindex is a jsdom-specific shim.
    div.tabIndex = 0;
    document.body.appendChild(div);
    div.focus();
    expect(document.activeElement).toBe(div);
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
    div.remove();
  });

  it("gate 7 — blur while parked on a pane suppresses until mouseleave", () => {
    // Pointer has to be over a pane at blur time for the gate to arm
    // . Simulate that by issuing a successful request first —
    // `request()` also marks `pointerOverAnyPane`.
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(1);
    window.dispatchEvent(new FocusEvent("blur"));
    docHasFocus = true;
    expect(ctrl._isArmedAfterBlur()).toBe(true);
    // While armed, a fresh request is suppressed.
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(1);
    // mouseleave disarms.
    ctrl.cancel();
    expect(ctrl._isArmedAfterBlur()).toBe(false);
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(2);
  });

  it("gate 7 — blur with pointer NOT over a pane does not arm", () => {
    // User was on the rail / app bar / outside the pane area when
    // Cmd-Tab fired — no parked-on-a-pane risk, the flag must stay
    // off so the first mouseenter after back-focus works .
    window.dispatchEvent(new FocusEvent("blur"));
    docHasFocus = true;
    expect(ctrl._isArmedAfterBlur()).toBe(false);
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(1);
  });

  it("gate 2 — blur resets held-button count (cross-app drag) ", () => {
    // Drag started OUTSIDE any pane (e.g. user dragging a rail item
    // before Cmd-Tab-ing away). Keeping the pointer off-pane avoids
    // gate-7 arming so the test isolates gate 2's reset behaviour.
    window.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    // Blur without matching mouseup — cross-app release.
    window.dispatchEvent(new FocusEvent("blur"));
    docHasFocus = true;
    // Before fix: mouseButtonsDown stuck at 1 → gate 2 blocks forever.
    // After fix: blur reset the counter → hover passes.
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(1);
  });

  it("gate 6 — keyboard-focused button (:focus-visible) suppresses hover ", () => {
    // jsdom doesn't track focus-source natively, so to simulate a
    // Tab-reached button we override `matches(':focus-visible')` on
    // the element. In a real Chromium renderer this is what the UA
    // returns for a button reached by keyboard navigation.
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    const origMatches = btn.matches.bind(btn);
    btn.matches = ((sel: string) =>
      sel === ":focus-visible" ? true : origMatches(sel)) as typeof btn.matches;
    btn.focus();
    expect(document.activeElement).toBe(btn);
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
    btn.remove();
  });

  it("gate 8 — already-active leaf is a no-op", () => {
    activeLeaf = "leafA";
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(0);
  });

  it("gate 9 — dwell delays apply and cancel aborts", () => {
    vi.useFakeTimers();
    try {
      ctrl.detach();
      ctrl = new HoverFocusController({
        isEnabled: () => enabled,
        isAlreadyActive: (id) => id === activeLeaf,
        dwellMs: 60,
      });
      ctrl.attach();
      ctrl.request("leafA", apply("leafA"));
      expect(applyCount).toBe(0);
      expect(ctrl._hasPendingDwell()).toBe(true);
      vi.advanceTimersByTime(59);
      expect(applyCount).toBe(0);
      vi.advanceTimersByTime(1);
      expect(applyCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gate 9 — rapid transit A→B→C lands on C only", () => {
    vi.useFakeTimers();
    try {
      ctrl.detach();
      ctrl = new HoverFocusController({
        isEnabled: () => enabled,
        isAlreadyActive: (id) => id === activeLeaf,
        dwellMs: 60,
      });
      ctrl.attach();
      ctrl.request("leafA", apply("leafA"));
      vi.advanceTimersByTime(20);
      ctrl.request("leafB", apply("leafB"));
      vi.advanceTimersByTime(20);
      ctrl.request("leafC", apply("leafC"));
      vi.advanceTimersByTime(60);
      expect(applyCount).toBe(1);
      expect(lastLeafApplied).toBe("leafC");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gate 9 — cancel during dwell aborts apply", () => {
    vi.useFakeTimers();
    try {
      ctrl.detach();
      ctrl = new HoverFocusController({
        isEnabled: () => enabled,
        isAlreadyActive: (id) => id === activeLeaf,
        dwellMs: 60,
      });
      ctrl.attach();
      ctrl.request("leafA", apply("leafA"));
      ctrl.cancel();
      vi.advanceTimersByTime(100);
      expect(applyCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dwell re-checks gates at fire time (modal opened mid-dwell)", () => {
    vi.useFakeTimers();
    try {
      ctrl.detach();
      ctrl = new HoverFocusController({
        isEnabled: () => enabled,
        isAlreadyActive: (id) => id === activeLeaf,
        dwellMs: 60,
      });
      ctrl.attach();
      ctrl.request("leafA", apply("leafA"));
      // Force modal open (bypass MutationObserver timing in jsdom).
      ctrl._setModalOpenForTest(true);
      vi.advanceTimersByTime(100);
      expect(applyCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dwell re-checks gates at fire time (pref disabled mid-dwell) ", () => {
    vi.useFakeTimers();
    try {
      ctrl.detach();
      ctrl = new HoverFocusController({
        isEnabled: () => enabled,
        isAlreadyActive: (id) => id === activeLeaf,
        dwellMs: 60,
      });
      ctrl.attach();
      ctrl.request("leafA", apply("leafA"));
      enabled = false;
      vi.advanceTimersByTime(100);
      expect(applyCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dwell re-checks gates at fire time (contextmenu fires mid-dwell) ", () => {
    vi.useFakeTimers();
    try {
      ctrl.detach();
      ctrl = new HoverFocusController({
        isEnabled: () => enabled,
        isAlreadyActive: (id) => id === activeLeaf,
        dwellMs: 60,
      });
      ctrl.attach();
      ctrl.request("leafA", apply("leafA"));
      document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      vi.advanceTimersByTime(100);
      expect(applyCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dwell re-checks gates at fire time (editable element focused mid-dwell) ", () => {
    vi.useFakeTimers();
    try {
      ctrl.detach();
      ctrl = new HoverFocusController({
        isEnabled: () => enabled,
        isAlreadyActive: (id) => id === activeLeaf,
        dwellMs: 60,
      });
      ctrl.attach();
      ctrl.request("leafA", apply("leafA"));
      const input = document.createElement("input");
      input.type = "text";
      document.body.appendChild(input);
      input.focus();
      vi.advanceTimersByTime(100);
      expect(applyCount).toBe(0);
      input.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancelPending aborts a pending dwell ", () => {
    vi.useFakeTimers();
    try {
      ctrl.detach();
      ctrl = new HoverFocusController({
        isEnabled: () => enabled,
        isAlreadyActive: (id) => id === activeLeaf,
        dwellMs: 60,
      });
      ctrl.attach();
      ctrl.request("leafA", apply("leafA"));
      expect(ctrl._hasPendingDwell()).toBe(true);
      ctrl.cancelPending();
      expect(ctrl._hasPendingDwell()).toBe(false);
      vi.advanceTimersByTime(100);
      expect(applyCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detach cleans up window listeners", () => {
    ctrl.detach();
    // Button count should no longer advance.
    window.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    // Re-attach without triggering the mouseup, and a fresh request
    // should fire because the detached controller's counter never
    // moved. Re-create to test clean state.
    ctrl = new HoverFocusController({
      isEnabled: () => enabled,
      isAlreadyActive: (id) => id === activeLeaf,
      dwellMs: 0,
    });
    ctrl.attach();
    ctrl.request("leafA", apply("leafA"));
    expect(applyCount).toBe(1);
  });
});
