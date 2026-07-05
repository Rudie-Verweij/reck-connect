// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRef } from "../host";
import type { LeafNode } from "../layout/split-tree";

/**
 * Integration test for hover-to-focus wiring in `PaneLayout`
 * . Covers the listener contract from the plan's "Test
 * plan → Integration" section:
 *
 *   - `mouseenter` on a leaf calls `controller.request(leafId, apply)`.
 *   - `mouseleave` calls `controller.cancel()`.
 *
 * The controller itself is a `vi.fn` stub — we're not testing the
 * gates here (those live in `hover-focus-controller.test.ts`), just
 * that `PaneLayout` correctly hooks leaf DOM events to the
 * controller's API and that `focusLeaf` is the `apply` thunk the
 * controller is handed.
 *
 * TerminalPane is mocked so the test doesn't try to spin up xterm/WS
 * against a jsdom DOM.
 */
vi.mock("@client-core/terminal/terminal-pane", () => {
  class MockTerminalPane {
    static instances: MockTerminalPane[] = [];
    container: HTMLElement;
    public atBottom = true;
    public scrollToBottomCalls = 0;
    // an earlier release — surface the partial-scroll offset the syncLeafView
    // capture path now reads. `offsetFromBottom` drives the value
    // returned by `getViewportOffsetFromBottom()`; `restoreCalls`
    // records the args every restore call sees so a test can assert
    // both the call count and the captured offset.
    public offsetFromBottom = 0;
    public restoreCalls: number[] = [];
    constructor() {
      this.container = document.createElement("div");
      this.container.className = "mock-terminal";
      MockTerminalPane.instances.push(this);
    }
    mount() {}
    dispose() {}
    refit() {}
    focus() {}
    setTheme() {}
    isAtBottom() {
      return this.atBottom;
    }
    scrollToBottom() {
      this.scrollToBottomCalls++;
      this.atBottom = true;
    }
    getViewportOffsetFromBottom() {
      return this.offsetFromBottom;
    }
    restoreViewportOffsetFromBottom(offset: number) {
      this.restoreCalls.push(offset);
      // Mirror the production semantics for any test that flips
      // `atBottom` afterwards: a successful restore lands above the
      // tail, so the pane is no longer pinned.
      if (offset > 0) this.atBottom = false;
    }
    /**
     * The real TerminalPane exposes its underlying xterm Terminal so the
     * file-viewer path linkifier (`installPathLinkProvider`) can hook into
     * it when `onPaneCreated` is wired. The mock supplies the minimum
     * shape the linkifier touches.
     */
    getXterm() {
      return {
        registerLinkProvider: () => ({ dispose: () => {} }),
        buffer: { active: { getLine: () => undefined } },
      };
    }
  }
  return { TerminalPane: MockTerminalPane };
});

// Imports must come after vi.mock so the hoisted mock wins.
import { PaneLayout, type PaneLayoutCallbacks } from "./pane-layout";
import { TerminalPane } from "@client-core/terminal/terminal-pane";
import type { SplitNode, TreeNode } from "../layout/split-tree";

const MockTerminalPane = TerminalPane as unknown as {
  instances: Array<{
    atBottom: boolean;
    scrollToBottomCalls: number;
    offsetFromBottom: number;
    restoreCalls: number[];
  }>;
};

function makeLeaf(id: string, tabs: string[] = []): LeafNode {
  return {
    kind: "leaf",
    id,
    activeTabId: tabs[0] ?? "",
    tabs: tabs.map((tabId) => ({
      id: tabId,
      paneId: `pane-${tabId}`,
      kind: "shell",
      title: tabId,
      host: "local" as HostRef,
    })),
  };
}

function makeSplit(id: string, a: TreeNode, b: TreeNode): SplitNode {
  return { kind: "split", id, dir: "vertical", ratio: 0.5, a, b };
}

function makeController() {
  return {
    request: vi.fn(),
    cancel: vi.fn(),
    cancelPending: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
  };
}

function makeCallbacks(
  root: HTMLElement,
  hoverFocus: ReturnType<typeof makeController>,
): PaneLayoutCallbacks {
  return {
    root,
    buildWsUrl: () => "ws://mock",
    buildWsSubprotocols: () => [],
    onActiveLeafChange: () => {},
    onStoplightChange: () => {},
    onExit: () => {},
    onTreeChange: () => {},
    getStoplight: () => "gray",
    onSwitchTab: () => {},
    onCloseTab: () => {},
    onNewTab: () => {},
    onSplitRight: () => {},
    onSplitDown: () => {},
    onCloseLeaf: () => {},
    onRenameTab: () => {},
    onReorderTab: () => {},
    onMoveTab: () => {},
    // Intentional structural type compatibility: the mock controller
    // implements only `request` / `cancel`, which is all PaneLayout
    // reaches for. A full `as unknown as HoverFocusController` cast
    // keeps the test cheap.
    hoverFocus: hoverFocus as unknown as import("./hover-focus-controller").HoverFocusController,
  };
}

describe("PaneLayout hover-focus wiring ", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    MockTerminalPane.instances.length = 0;
  });

  afterEach(() => {
    root.remove();
  });

  it("mouseenter on a leaf calls controller.request with that leafId", () => {
    const hoverFocus = makeController();
    const layout = new PaneLayout(makeCallbacks(root, hoverFocus));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    const leafEl = root.querySelector<HTMLElement>('.pane-leaf[data-leaf-id="leafA"]');
    expect(leafEl).not.toBeNull();
    leafEl!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    expect(hoverFocus.request).toHaveBeenCalledTimes(1);
    const args = hoverFocus.request.mock.calls[0];
    expect(args[0]).toBe("leafA");
    // The `apply` thunk should be a function (focusLeaf closure). We
    // don't invoke it here — focusLeaf calls xterm focus which the
    // mocked TerminalPane tolerates but we avoid side-effectful
    // assertions.
    expect(typeof args[1]).toBe("function");
    layout.dispose();
  });

  it("mouseleave on a leaf calls controller.cancel", () => {
    const hoverFocus = makeController();
    const layout = new PaneLayout(makeCallbacks(root, hoverFocus));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    const leafEl = root.querySelector<HTMLElement>('.pane-leaf[data-leaf-id="leafA"]');
    leafEl!.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    expect(hoverFocus.cancel).toHaveBeenCalledTimes(1);
    layout.dispose();
  });

  it("request's apply thunk routes to focusLeaf", () => {
    const hoverFocus = makeController();
    const callbacks = makeCallbacks(root, hoverFocus);
    const activeChanges: (string | null)[] = [];
    callbacks.onActiveLeafChange = (id) => activeChanges.push(id);
    const layout = new PaneLayout(callbacks);
    layout.setTree(makeLeaf("leafA", ["t1"]));
    const leafEl = root.querySelector<HTMLElement>('.pane-leaf[data-leaf-id="leafA"]');
    leafEl!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    const apply = hoverFocus.request.mock.calls[0][1] as () => void;
    apply();
    // focusLeaf calls onActiveLeafChange("leafA").
    expect(activeChanges).toContain("leafA");
    layout.dispose();
  });

  it("listeners are not installed when hoverFocus is absent", () => {
    const callbacks = makeCallbacks(root, makeController());
    // Strip the hoverFocus binding — simulates test-only callers that
    // don't opt in (or a pref-off path if a caller chose to gate at
    // construction time).
    delete (callbacks as Partial<PaneLayoutCallbacks>).hoverFocus;
    const layout = new PaneLayout(callbacks);
    layout.setTree(makeLeaf("leafA", ["t1"]));
    const leafEl = root.querySelector<HTMLElement>('.pane-leaf[data-leaf-id="leafA"]');
    // Dispatch to make sure no uncaught throw happens — nothing to
    // assert otherwise (the controller we built isn't wired). Mostly
    // a "doesn't crash" check.
    leafEl!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    leafEl!.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    layout.dispose();
  });

  it("setTree calls controller.cancelPending so a pending dwell can't fire on a removed leaf ", () => {
    const hoverFocus = makeController();
    const layout = new PaneLayout(makeCallbacks(root, hoverFocus));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    expect(hoverFocus.cancelPending).toHaveBeenCalledTimes(1);
    layout.setTree(makeLeaf("leafB", ["t2"]));
    expect(hoverFocus.cancelPending).toHaveBeenCalledTimes(2);
    layout.dispose();
  });

  it("focusLeaf is a no-op when the leaf no longer exists ", () => {
    const hoverFocus = makeController();
    const callbacks = makeCallbacks(root, hoverFocus);
    const activeChanges: (string | null)[] = [];
    callbacks.onActiveLeafChange = (id) => activeChanges.push(id);
    const layout = new PaneLayout(callbacks);
    layout.setTree(makeLeaf("leafA", ["t1"]));
    activeChanges.length = 0;
    layout.focusLeaf("leafGhost");
    expect(activeChanges).toEqual([]);
    expect(layout.getActiveLeafId()).not.toBe("leafGhost");
    layout.dispose();
  });

  it("dispose calls controller.detach so global listeners + observers are torn down ", () => {
    const hoverFocus = makeController();
    const layout = new PaneLayout(makeCallbacks(root, hoverFocus));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    expect(hoverFocus.detach).not.toHaveBeenCalled();
    layout.dispose();
    expect(hoverFocus.detach).toHaveBeenCalledTimes(1);
  });
});

describe("PaneLayout syncLeafView scroll restoration ", () => {
  let root: HTMLElement;
  let rafCallbacks: FrameRequestCallback[] = [];
  const origRaf = globalThis.requestAnimationFrame;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    MockTerminalPane.instances.length = 0;
    rafCallbacks = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
  });

  afterEach(() => {
    root.remove();
    globalThis.requestAnimationFrame = origRaf;
  });

  function flushRaf() {
    const pending = rafCallbacks;
    rafCallbacks = [];
    for (const cb of pending) cb(0);
  }

  it("does not re-scroll an already-active tab on plain refresh when user scrolled up", () => {
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    flushRaf();
    expect(MockTerminalPane.instances).toHaveLength(1);
    const term = MockTerminalPane.instances[0];
    expect(term.scrollToBottomCalls).toBe(0);

    term.atBottom = false;

    layout.refresh();
    flushRaf();
    expect(term.scrollToBottomCalls).toBe(0);

    layout.refresh();
    flushRaf();
    expect(term.scrollToBottomCalls).toBe(0);

    layout.dispose();
  });

  it("scrolls to bottom on hidden→active transition when previously pinned", () => {
    const leaf: LeafNode = {
      kind: "leaf",
      id: "leafA",
      activeTabId: "t1",
      tabs: [
        { id: "t1", paneId: "pane-t1", kind: "shell", title: "t1", host: "local" as HostRef },
        { id: "t2", paneId: "pane-t2", kind: "shell", title: "t2", host: "local" as HostRef },
      ],
    };
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(leaf);
    flushRaf();
    expect(MockTerminalPane.instances).toHaveLength(2);
    const t1 = MockTerminalPane.instances[0];
    const t2 = MockTerminalPane.instances[1];
    expect(t1.scrollToBottomCalls).toBe(0);
    expect(t2.scrollToBottomCalls).toBe(0);

    layout.setTree({ ...leaf, activeTabId: "t2" });
    flushRaf();
    expect(t2.scrollToBottomCalls).toBe(1);

    layout.setTree({ ...leaf, activeTabId: "t1" });
    flushRaf();
    expect(t1.scrollToBottomCalls).toBe(1);

    layout.dispose();
  });

  it("does not scroll on hidden→active transition when user had scrolled up before hide", () => {
    const leaf: LeafNode = {
      kind: "leaf",
      id: "leafA",
      activeTabId: "t1",
      tabs: [
        { id: "t1", paneId: "pane-t1", kind: "shell", title: "t1", host: "local" as HostRef },
        { id: "t2", paneId: "pane-t2", kind: "shell", title: "t2", host: "local" as HostRef },
      ],
    };
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(leaf);
    flushRaf();
    const t1 = MockTerminalPane.instances[0];

    t1.atBottom = false;
    layout.setTree({ ...leaf, activeTabId: "t2" });
    flushRaf();

    layout.setTree({ ...leaf, activeTabId: "t1" });
    flushRaf();
    expect(t1.scrollToBottomCalls).toBe(0);

    layout.dispose();
  });
});

describe("PaneLayout syncLeafView partial-scroll restore ", () => {
  let root: HTMLElement;
  // Map<handle, callback>. The production code expects cancelAnimationFrame
  // to drop a queued callback by handle (Codex race fix); a flat array
  // would only let us flush, not cancel. The handle is the Map key
  // (auto-incrementing) so each scheduling call returns a unique value.
  let rafQueue: Map<number, FrameRequestCallback> = new Map();
  let nextRafHandle = 1;
  const origRaf = globalThis.requestAnimationFrame;
  const origCancel = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    MockTerminalPane.instances.length = 0;
    rafQueue = new Map();
    nextRafHandle = 1;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const handle = nextRafHandle++;
      rafQueue.set(handle, cb);
      return handle;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number) => {
      rafQueue.delete(handle);
    }) as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    root.remove();
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancel;
  });

  function flushRaf() {
    const pending = Array.from(rafQueue.values());
    rafQueue.clear();
    for (const cb of pending) cb(0);
  }

  function makeTwoTabLeaf(active: string): LeafNode {
    return {
      kind: "leaf",
      id: "leafA",
      activeTabId: active,
      tabs: [
        { id: "t1", paneId: "pane-t1", kind: "shell", title: "t1", host: "local" as HostRef },
        { id: "t2", paneId: "pane-t2", kind: "shell", title: "t2", host: "local" as HostRef },
      ],
    };
  }

  // Scenario 1 from PLAN — at-bottom round-trip preserves the existing
  // contract. Already covered by an earlier release suite; replicated here so
  // an earlier release cluster reads as a self-contained matrix.
  it("hide-while-at-bottom → show snaps to tail with no offset restore", () => {
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();
    const t1 = MockTerminalPane.instances[0];

    layout.setTree(makeTwoTabLeaf("t2"));
    flushRaf();
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();

    expect(t1.scrollToBottomCalls).toBe(1);
    expect(t1.restoreCalls).toEqual([]);

    layout.dispose();
  });

  // Scenario 2 — the residual #187 branch. Hide while scrolled up,
  // come back, viewport must be restored to the captured offset.
  it("hide-while-scrolled-up → show restores the captured viewport offset", () => {
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();
    const t1 = MockTerminalPane.instances[0];

    // User scrolled up 80 rows; pane is no longer pinned to tail.
    t1.atBottom = false;
    t1.offsetFromBottom = 80;

    // active → hidden: capture happens during this setTree call.
    layout.setTree(makeTwoTabLeaf("t2"));
    flushRaf();

    // hidden → active: restore should fire after refit.
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();

    // The renderer must NOT snap to bottom — the user was scrolled up.
    expect(t1.scrollToBottomCalls).toBe(0);
    // …it must restore the captured 80-row offset exactly once.
    expect(t1.restoreCalls).toEqual([80]);

    layout.dispose();
  });

  // Scenario 3 — an earlier release trap. Output that lands during the hide
  // window grows baseY; the captured offset is the at-hide value, NOT
  // re-read from the (stale) hidden viewport. The clamp in
  // restoreViewportOffsetFromBottom handles the "offset > new
  // baseY" edge case at the TerminalPane level; here we just assert
  // the captured value is forwarded unchanged.
  it("buffer growth during hide does not corrupt the captured offset", () => {
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();
    const t1 = MockTerminalPane.instances[0];

    t1.atBottom = false;
    t1.offsetFromBottom = 50;

    layout.setTree(makeTwoTabLeaf("t2"));
    flushRaf();

    // Simulate output landing while t1 is hidden — the production
    // viewport reading would be stale. The capture only happens on
    // the active→hidden edge above; this mutation is just to confirm
    // the layout doesn't re-read.
    t1.offsetFromBottom = 9999;

    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();

    // Restore call must use the original captured 50, not the
    // post-mutation 9999. If the layout re-read on every refresh
    // pass while hidden it would forward 9999 here — which is the
    // exact failure mode an earlier release revert was about.
    expect(t1.restoreCalls).toEqual([50]);

    layout.dispose();
  });

  // Scenario 4 — refresh ticks while the pane is already hidden must
  // not re-capture. A sibling pane streaming output triggers
  // `layout.refresh()`, which loops every TabRecord. The active →
  // hidden edge is the only valid capture point.
  it("refresh tick while pane is hidden does not re-capture wasAtBottom or offset", () => {
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();
    const t1 = MockTerminalPane.instances[0];

    t1.atBottom = false;
    t1.offsetFromBottom = 30;

    // active → hidden: real capture point.
    layout.setTree(makeTwoTabLeaf("t2"));
    flushRaf();

    // While t1 is hidden, simulate a stale-viewport state: xterm
    // wouldn't have updated viewportY; if syncLeafView re-read on a
    // refresh tick it would record the stale snapshot and overwrite
    // the captured value.
    t1.atBottom = true;
    t1.offsetFromBottom = 0;

    // Trigger refresh (e.g. stoplight tick / sibling PTY output).
    layout.refresh();
    flushRaf();
    layout.refresh();
    flushRaf();

    // Now flip back to t1.
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();

    // If the capture had been clobbered by the refresh ticks above,
    // we'd see scrollToBottom called (atBottom=true at "capture"
    // time) — we must NOT see that. The genuine at-hide capture
    // (atBottom=false, offset=30) should drive the restore.
    expect(t1.scrollToBottomCalls).toBe(0);
    expect(t1.restoreCalls).toEqual([30]);

    layout.dispose();
  });

  // Scenario 5 — Codex adversarial-review HIGH (an earlier release round 2).
  // The bug the gate fixes: a hidden→active edge schedules a rAF for
  // refit + restore but doesn't run it yet. Between scheduling and rAF
  // flush, xterm's internal viewportY/baseY are stale. If the user
  // immediately switches AWAY (active→hidden) before the rAF fires,
  // the naive capture path would read those stale numbers and
  // overwrite the previously-correct stored values. After the next
  // round-trip, the user lands at a wrong offset.
  it("hidden→active→hidden before first rAF flush preserves prior capture (codex race fix)", () => {
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();
    const t1 = MockTerminalPane.instances[0];

    // First active→hidden: captures the GENUINE state — t1 is at the
    // tail (atBottom=true). Stored: wasAtBottom=true, offset=0.
    layout.setTree(makeTwoTabLeaf("t2"));
    flushRaf();

    // Race window opens here. hidden→active for t1 schedules a rAF;
    // we deliberately don't flush it. xterm-internal viewport state
    // is now considered stale by the production code.
    layout.setTree(makeTwoTabLeaf("t1"));
    // No flushRaf — t1.pendingFrame is set.

    // Simulate the stale-xterm condition: PTY output during the
    // prior hide window has grown the buffer; xterm-internal
    // numbers, if re-read now, would give a misleading "scrolled
    // up" picture even though the user hasn't actually scrolled.
    t1.atBottom = false;
    t1.offsetFromBottom = 80;

    // Fast active→hidden BEFORE the rAF fires. Without the
    // pendingFrame gate this would capture (false, 80), poisoning
    // the stored values.
    layout.setTree(makeTwoTabLeaf("t2"));

    // xterm catches up — buffer state returns to "at tail" once the
    // pane is hidden long enough for renders to settle. The user
    // never actually scrolled away from tail.
    t1.atBottom = true;
    t1.offsetFromBottom = 0;
    flushRaf();

    // Final hidden→active. If the gate had failed, the stored
    // capture would be (false, 80) and we'd observe a restore call
    // of 80. With the gate, the original (true, 0) is preserved and
    // we get the correct snap-to-tail behaviour.
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();

    // Hard assertion: the bogus 80-row offset must NEVER have been
    // forwarded to the pane's restore method. This is the bit that
    // would distinguish a working gate from the regression.
    expect(t1.restoreCalls).not.toContain(80);
    expect(t1.restoreCalls).toEqual([]);

    layout.dispose();
  });

  // Companion to scenario 5 — once the rAF flushes (xterm settles),
  // the gate must re-open so a subsequent active→hidden captures
  // again. Otherwise we'd be permanently stuck on the values stored
  // by the first hide.
  it("rAF flush re-opens the capture gate for the next active→hidden edge", () => {
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();
    const t1 = MockTerminalPane.instances[0];

    // First round-trip: at-bottom on hide → snaps to bottom on show.
    layout.setTree(makeTwoTabLeaf("t2"));
    flushRaf();
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();
    expect(t1.scrollToBottomCalls).toBe(1);

    // Now scroll t1 up. Subsequent hide MUST capture the new offset
    // even though we previously captured (true, 0).
    t1.atBottom = false;
    t1.offsetFromBottom = 60;

    layout.setTree(makeTwoTabLeaf("t2"));
    flushRaf();
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();

    // Restore the 60-row offset on the second round-trip.
    expect(t1.restoreCalls).toEqual([60]);

    layout.dispose();
  });

  // Scenario 6 — Codex adversarial-review HIGH (an earlier release round 3).
  // The previous round's gate was too broad: an active-stay-active
  // refresh tick (sibling output, stoplight change, etc.) ALSO
  // schedules a rAF for refit — and the prior code set `pendingFrame`
  // on it. If the user then switched away before that rAF fired, the
  // capture path saw `pendingFrame !== null` and refused to read the
  // (still fresh) xterm state. The user's scroll position got lost on
  // the round-trip — the exact failure class the gate was meant to
  // prevent, just on a different trigger path. Fix: only set
  // pendingFrame on the genuine hidden→active branch.
  it("active-refresh→hide-before-rAF preserves the latest offset (codex narrow-gate fix)", () => {
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();
    const t1 = MockTerminalPane.instances[0];

    // User scrolls t1 up to a partial-scroll position. xterm-internal
    // state is fresh: atBottom=false, offset=50.
    t1.atBottom = false;
    t1.offsetFromBottom = 50;

    // Sibling refresh tick — t1 is still active. syncLeafView runs;
    // the active branch should rAF a refit but must NOT track
    // pendingFrame (xterm is current, no hide ever happened).
    layout.refresh();
    // Deliberately do NOT flush — the refit-only rAF stays queued.

    // User switches t1 → t2 BEFORE the refit-only rAF fires. With
    // the broad gate this would skip the capture (pendingFrame was
    // set by the active-refresh rAF) and the offset=50 would be
    // lost. With the narrow gate, capture proceeds.
    layout.setTree(makeTwoTabLeaf("t2"));
    flushRaf();

    // Switch back. Restore should fire with the correct offset=50.
    layout.setTree(makeTwoTabLeaf("t1"));
    flushRaf();

    // Hard assertion: the captured offset MUST have been forwarded.
    // If the broad gate had blocked the capture, the stored values
    // would still be the defaults (true, 0) and we'd see
    // scrollToBottom instead.
    expect(t1.restoreCalls).toEqual([50]);
    // …and we must NOT have snapped to tail — the user wasn't there.
    expect(t1.scrollToBottomCalls).toBe(0);

    layout.dispose();
  });
});

/**
 * Restoring-window gating . When `selectProject` is inside
 * its cold-daemon retry budget, every layout-mutating gesture inside
 * `PaneLayout` must be a no-op so the post-retry reconcile doesn't
 * silently revert a visible user edit. boot.ts wires `isRestoring` to
 * the same `isRetrying()` predicate it uses for the existing pane-
 * creation gates and the `onTreeChange` persistence suppression.
 */
describe("PaneLayout isRestoring gating ", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    // PaneLayout owns two static fields that leak across tests in the
    // same file: `draggedTab` (HTML5 drag in flight) and the
    // `lastTitleDown*` rename-gesture timing. Reset both so a prior
    // test's dragstart doesn't fool the drop short-circuit here.
    (PaneLayout as unknown as { draggedTab: unknown }).draggedTab = null;
    PaneLayout.lastTitleDownTabId = null;
    PaneLayout.lastTitleDownTs = 0;
  });

  afterEach(() => {
    root.remove();
  });

  function makeGatedCallbacks(restoring: () => boolean) {
    const cb = makeCallbacks(root, makeController());
    const calls = {
      switch: vi.fn(),
      reorder: vi.fn(),
      move: vi.fn(),
      close: vi.fn(),
      treeChange: vi.fn<[TreeNode | null], void>(),
    };
    cb.isRestoring = restoring;
    cb.onSwitchTab = calls.switch;
    cb.onReorderTab = calls.reorder;
    cb.onMoveTab = calls.move;
    cb.onCloseTab = calls.close;
    cb.onTreeChange = calls.treeChange;
    return { cb, calls };
  }

  it("splitter mousedown is a no-op while restoring", () => {
    let restoring = true;
    const { cb, calls } = makeGatedCallbacks(() => restoring);
    const layout = new PaneLayout(cb);
    layout.setTree(makeSplit("s1", makeLeaf("a", ["t1"]), makeLeaf("b", ["t2"])));
    const handle = root.querySelector<HTMLElement>(".split-handle");
    expect(handle).not.toBeNull();
    // Force-clear treeChange spy so we only count post-mousedown
    // emissions (initial setTree triggered one).
    calls.treeChange.mockClear();
    handle!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(handle!.classList.contains("dragging")).toBe(false);
    expect(calls.treeChange).not.toHaveBeenCalled();

    restoring = false;
    handle!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(handle!.classList.contains("dragging")).toBe(true);
    layout.dispose();
  });

  it("tab click does not call onSwitchTab while restoring", () => {
    let restoring = true;
    const { cb, calls } = makeGatedCallbacks(() => restoring);
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    const tabs = root.querySelectorAll<HTMLElement>(".tab");
    expect(tabs.length).toBe(2);
    tabs[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls.switch).not.toHaveBeenCalled();
    expect(calls.close).not.toHaveBeenCalled();

    restoring = false;
    tabs[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls.switch).toHaveBeenCalledWith("leafA", "t2");
    layout.dispose();
  });

  // Closing must fire on pointerdown, not click: the first click also flips
  // the pane's stoplight dot (a mouse-tracking TUI like codex/Claude going
  // green→grey), which re-renders the whole tab — so the mouseup/click can
  // land on a freshly-created ✕ and no `click` ever fires. pointerdown lands
  // before that churn.
  it("closes a tab on pointerdown of the ✕", () => {
    const { cb, calls } = makeGatedCallbacks(() => false);
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    const closeEls = root.querySelectorAll<HTMLElement>(".tab .tab-close");
    expect(closeEls.length).toBe(2);
    closeEls[1].dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(calls.close).toHaveBeenCalledTimes(1);
    expect(calls.close).toHaveBeenCalledWith("leafA", "t2");
    layout.dispose();
  });

  it("a click on the ✕ does not fall through to onSwitchTab", () => {
    const { cb, calls } = makeGatedCallbacks(() => false);
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    const closeEls = root.querySelectorAll<HTMLElement>(".tab .tab-close");
    closeEls[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls.switch).not.toHaveBeenCalled();
    layout.dispose();
  });

  it("pointerdown on the ✕ is a no-op while restoring", () => {
    let restoring = true;
    const { cb, calls } = makeGatedCallbacks(() => restoring);
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    const closeEls = root.querySelectorAll<HTMLElement>(".tab .tab-close");
    closeEls[1].dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(calls.close).not.toHaveBeenCalled();
    layout.dispose();
  });

  it("tab dragstart is suppressed while restoring", () => {
    let restoring = true;
    const { cb } = makeGatedCallbacks(() => restoring);
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    const tabs = root.querySelectorAll<HTMLElement>(".tab");
    // Build a real DragEvent — jsdom supports it well enough that
    // `defaultPrevented` reflects the handler's preventDefault() call.
    const evt = new Event("dragstart", { bubbles: true, cancelable: true });
    tabs[0].dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(tabs[0].classList.contains("dragging")).toBe(false);

    restoring = false;
    const evt2 = new Event("dragstart", { bubbles: true, cancelable: true });
    tabs[0].dispatchEvent(evt2);
    expect(evt2.defaultPrevented).toBe(false);
    expect(tabs[0].classList.contains("dragging")).toBe(true);
    layout.dispose();
  });

  it("tab drop within leaf does not fire reorder when no drag was started (restoring blocked dragstart)", () => {
    let restoring = true;
    const { cb, calls } = makeGatedCallbacks(() => restoring);
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    const tabs = root.querySelectorAll<HTMLElement>(".tab");
    // Source dragstart suppressed by the gate, so PaneLayout.draggedTab
    // stays null and the per-tab drop short-circuits.
    tabs[0].dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    tabs[1].dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(calls.reorder).not.toHaveBeenCalled();
    expect(calls.move).not.toHaveBeenCalled();
    layout.dispose();
  });

  it("absent isRestoring callback behaves as 'not restoring' (back-compat for non-Satellite consumers)", () => {
    const cb = makeCallbacks(root, makeController());
    const switched = vi.fn();
    cb.onSwitchTab = switched;
    // Do NOT set isRestoring — this matches the legacy PaneLayout
    // contract before an earlier release and the test's own makeCallbacks default.
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    const tabs = root.querySelectorAll<HTMLElement>(".tab");
    tabs[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(switched).toHaveBeenCalledWith("leafA", "t2");
    layout.dispose();
  });
});

/**
 * Detached pane wiring . PaneLayout exposes `markDetached`
 * (called by boot.ts after a successful detach IPC) and
 * `handlePopoutClosed` (called by the popout-closed listener). The
 * tests below exercise the contract — what changes in the DOM, which
 * lifecycle methods fire on the MockTerminalPane, and which gestures
 * the placeholder swallows.
 */
describe("PaneLayout detached panes ", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    MockTerminalPane.instances.length = 0;
    (PaneLayout as unknown as { draggedTab: unknown }).draggedTab = null;
  });

  afterEach(() => {
    root.remove();
  });

  function makeDetachCallbacks(detachSpy: ReturnType<typeof vi.fn>, reattachSpy: ReturnType<typeof vi.fn>) {
    const cb = makeCallbacks(root, makeController());
    cb.onDetachPane = detachSpy;
    cb.onReattachPane = reattachSpy;
    return cb;
  }

  it("markDetached disposes the TerminalPane and renders a placeholder slot", () => {
    const detach = vi.fn();
    const reattach = vi.fn();
    const layout = new PaneLayout(makeDetachCallbacks(detach, reattach));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    expect(MockTerminalPane.instances).toHaveLength(1);
    const term = MockTerminalPane.instances[0] as unknown as { disposed?: boolean };
    // MockTerminalPane.dispose is a no-op spy stub but we can detect
    // the swap via the DOM: after markDetached the placeholder class
    // appears and the mock-terminal element is gone.
    layout.markDetached("pane-t1");
    expect(layout.isDetached("pane-t1")).toBe(true);
    expect(root.querySelector(".pane-detached-placeholder")).not.toBeNull();
    expect(root.querySelector(".mock-terminal")).toBeNull();
    void term; // term reference kept to silence unused-var warning
    layout.dispose();
  });

  it("syncLeafView keeps the placeholder across re-renders (no recreate race)", () => {
    const layout = new PaneLayout(makeDetachCallbacks(vi.fn(), vi.fn()));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    layout.markDetached("pane-t1");
    expect(MockTerminalPane.instances).toHaveLength(1);
    // Refresh — historically `syncLeafView` would rebuild a fresh
    // TerminalPane for any tab missing from `view.terminals`. With
    // the detached gate, refresh must be a no-op for the placeholder.
    layout.refresh();
    layout.refresh();
    // No new TerminalPane instances should have been created.
    expect(MockTerminalPane.instances).toHaveLength(1);
    expect(root.querySelector(".pane-detached-placeholder")).not.toBeNull();
    layout.dispose();
  });

  it("handlePopoutClosed clears detached state and recreates the TerminalPane", () => {
    const layout = new PaneLayout(makeDetachCallbacks(vi.fn(), vi.fn()));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    layout.markDetached("pane-t1");
    expect(MockTerminalPane.instances).toHaveLength(1);
    layout.handlePopoutClosed("pane-t1");
    expect(layout.isDetached("pane-t1")).toBe(false);
    expect(root.querySelector(".pane-detached-placeholder")).toBeNull();
    // A fresh TerminalPane was constructed for the recovered tab.
    expect(MockTerminalPane.instances).toHaveLength(2);
    layout.dispose();
  });

  it("placeholder click invokes onReattachPane with the right paneId", () => {
    const detach = vi.fn();
    const reattach = vi.fn();
    const layout = new PaneLayout(makeDetachCallbacks(detach, reattach));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    layout.markDetached("pane-t1");
    const placeholder = root.querySelector<HTMLElement>(".pane-detached-placeholder");
    expect(placeholder).not.toBeNull();
    placeholder!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(reattach).toHaveBeenCalledWith("pane-t1");
    layout.dispose();
  });

  it("Detach button on the active leaf invokes onDetachPane with paneId+leafId", () => {
    const detach = vi.fn();
    const layout = new PaneLayout(makeDetachCallbacks(detach, vi.fn()));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    const detachBtn = root.querySelector<HTMLButtonElement>('.tab-actions button[data-act="detach"]');
    expect(detachBtn).not.toBeNull();
    detachBtn!.click();
    expect(detach).toHaveBeenCalledWith("pane-t1", "leafA");
    layout.dispose();
  });

  it("Detach button is hidden when onDetachPane callback is absent", () => {
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    const detachBtn = root.querySelector('.tab-actions button[data-act="detach"]');
    expect(detachBtn).toBeNull();
    layout.dispose();
  });

  it("Detach button is disabled when active pane is already detached", () => {
    const layout = new PaneLayout(makeDetachCallbacks(vi.fn(), vi.fn()));
    layout.setTree(makeLeaf("leafA", ["t1"]));
    layout.markDetached("pane-t1");
    const detachBtn = root.querySelector<HTMLButtonElement>('.tab-actions button[data-act="detach"]');
    expect(detachBtn?.disabled).toBe(true);
    layout.dispose();
  });

  it("drop on a detached tab is a no-op (no reorder, no move)", () => {
    const detachCb = makeDetachCallbacks(vi.fn(), vi.fn());
    const reorderSpy = vi.fn();
    const moveSpy = vi.fn();
    detachCb.onReorderTab = reorderSpy;
    detachCb.onMoveTab = moveSpy;
    const layout = new PaneLayout(detachCb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    layout.markDetached("pane-t2");
    const tabs = root.querySelectorAll<HTMLElement>(".tab");
    // Simulate user dragstart on t1 then drop onto t2 (which is detached).
    tabs[0].dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    tabs[1].dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(reorderSpy).not.toHaveBeenCalled();
    expect(moveSpy).not.toHaveBeenCalled();
    layout.dispose();
  });

  it("getActiveLeafRect returns null without an active leaf and a DOMRect with one", () => {
    const layout = new PaneLayout(makeDetachCallbacks(vi.fn(), vi.fn()));
    expect(layout.getActiveLeafRect()).toBeNull();
    layout.setTree(makeLeaf("leafA", ["t1"]));
    layout.focusLeaf("leafA");
    const rect = layout.getActiveLeafRect();
    // jsdom returns 0-rect for layout-less DOM, so we just assert a
    // DOMRect comes back (not null).
    expect(rect).not.toBeNull();
    expect(typeof rect?.width).toBe("number");
    layout.dispose();
  });
});

/**
 * Overlay rendering . selectProject in boot.ts toggles
 * `.restoring-layout` on layoutRoot for the pointer-events gates and
 * mounts a `.layout-restoring-overlay` child element with the
 * splash-styled card. The class+overlay pair is the contract; we
 * assert the CSS rule exists rather than computing pseudo styles
 * (jsdom doesn't surface them reliably).
 */
describe("Restoring overlay styles ", () => {
  it("CSS rule for .layout-restoring-overlay is present in the renderer stylesheet", async () => {
    // Read the source of styles.css directly — jsdom does not parse
    // arbitrary external stylesheets, so we assert on the raw CSS.
    // This catches deletion/regression of the overlay rule.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const css = await fs.readFile(path.join(here, "..", "styles.css"), "utf8");
    expect(css).toMatch(/\.layout-restoring-overlay\s*\{/);
    expect(css).toMatch(/\.layout-restoring-overlay \.boot-splash-progress-fill/);
  });
});

/**
 * Drag-tab-onto-split-button gesture . The user drags a
 * tab onto a leaf's split-right / split-down icon button and drops;
 * the dragged tab moves into a new split alongside the target leaf
 * with no kind picker shown. Click (no drag) on the same button still
 * routes through the regular `onSplitRight` / `onSplitDown` callbacks.
 *
 * The test scaffolding mirrors the existing tab-DnD tests: plain
 * `Event` instances (jsdom's DragEvent constructor doesn't expose a
 * working `dataTransfer`, and the production handlers gate on
 * `if (e.dataTransfer)` so the absent property is harmless), and
 * `PaneLayout.draggedTab` reset in beforeEach so a prior test's
 * dragstart can't leak.
 */
describe("PaneLayout drag-to-split ", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    (PaneLayout as unknown as { draggedTab: unknown }).draggedTab = null;
    PaneLayout.lastTitleDownTabId = null;
    PaneLayout.lastTitleDownTs = 0;
  });

  afterEach(() => {
    root.remove();
  });

  function makeSplitDragCallbacks(): {
    cb: PaneLayoutCallbacks;
    splitWithTab: ReturnType<typeof vi.fn>;
    splitRight: ReturnType<typeof vi.fn>;
    splitDown: ReturnType<typeof vi.fn>;
    moveTab: ReturnType<typeof vi.fn>;
    reorderTab: ReturnType<typeof vi.fn>;
  } {
    const cb = makeCallbacks(root, makeController());
    const splitWithTab = vi.fn();
    const splitRight = vi.fn();
    const splitDown = vi.fn();
    const moveTab = vi.fn();
    const reorderTab = vi.fn();
    cb.onSplitWithTab = splitWithTab;
    cb.onSplitRight = splitRight;
    cb.onSplitDown = splitDown;
    cb.onMoveTab = moveTab;
    cb.onReorderTab = reorderTab;
    return { cb, splitWithTab, splitRight, splitDown, moveTab, reorderTab };
  }

  it("drag-to-split-right moves tab into new vertical split without picker", () => {
    const { cb, splitWithTab, splitRight } = makeSplitDragCallbacks();
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    const tabs = root.querySelectorAll<HTMLElement>(".tab");
    const splitRightBtn = root.querySelector<HTMLButtonElement>(
      '.tab-actions button[data-act="split-right"]',
    );
    expect(splitRightBtn).not.toBeNull();
    // Source dragstart populates PaneLayout.draggedTab.
    tabs[0].dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    // Hover over the split-right button (highlight goes on).
    splitRightBtn!.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    expect(splitRightBtn!.classList.contains("split-button-drop-target")).toBe(true);
    // Drop fires the new split-with-tab callback; click-only fallbacks
    // (onSplitRight) must NOT have been invoked.
    splitRightBtn!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(splitWithTab).toHaveBeenCalledWith("leafA", "leafA", "t1", "vertical");
    expect(splitRight).not.toHaveBeenCalled();
    // Highlight cleared after drop so a subsequent drag wouldn't see
    // a stuck "this is a drop target" class.
    expect(splitRightBtn!.classList.contains("split-button-drop-target")).toBe(false);
    layout.dispose();
  });

  it("drag-to-split-down moves tab into new horizontal split without picker", () => {
    const { cb, splitWithTab, splitDown } = makeSplitDragCallbacks();
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    const tabs = root.querySelectorAll<HTMLElement>(".tab");
    const splitDownBtn = root.querySelector<HTMLButtonElement>(
      '.tab-actions button[data-act="split-down"]',
    );
    expect(splitDownBtn).not.toBeNull();
    tabs[0].dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    splitDownBtn!.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    expect(splitDownBtn!.classList.contains("split-button-drop-target")).toBe(true);
    splitDownBtn!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(splitWithTab).toHaveBeenCalledWith("leafA", "leafA", "t1", "horizontal");
    expect(splitDown).not.toHaveBeenCalled();
    expect(splitDownBtn!.classList.contains("split-button-drop-target")).toBe(false);
    layout.dispose();
  });

  it("dragover does not highlight or accept when no tab drag is in flight", () => {
    const { cb } = makeSplitDragCallbacks();
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1"]));
    const splitRightBtn = root.querySelector<HTMLButtonElement>(
      '.tab-actions button[data-act="split-right"]',
    );
    const evt = new Event("dragover", { bubbles: true, cancelable: true });
    splitRightBtn!.dispatchEvent(evt);
    // Without an active drag, dragover must NOT preventDefault — that's
    // how the browser knows the target rejects the drop.
    expect(evt.defaultPrevented).toBe(false);
    expect(splitRightBtn!.classList.contains("split-button-drop-target")).toBe(false);
    layout.dispose();
  });

  it("dragend without drop clears the split-button highlight (cancelled drag)", () => {
    const { cb, splitWithTab } = makeSplitDragCallbacks();
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    const tabs = root.querySelectorAll<HTMLElement>(".tab");
    const splitRightBtn = root.querySelector<HTMLButtonElement>(
      '.tab-actions button[data-act="split-right"]',
    );
    tabs[0].dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    splitRightBtn!.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    expect(splitRightBtn!.classList.contains("split-button-drop-target")).toBe(true);
    // User aborts (Esc, drop outside any target). dragend fires on the
    // source tab, NO drop on any split button.
    tabs[0].dispatchEvent(new Event("dragend", { bubbles: true, cancelable: true }));
    expect(splitRightBtn!.classList.contains("split-button-drop-target")).toBe(false);
    // No split happened.
    expect(splitWithTab).not.toHaveBeenCalled();
    // PaneLayout.draggedTab cleared so the next drag starts fresh.
    expect((PaneLayout as unknown as { draggedTab: unknown }).draggedTab).toBeNull();
    layout.dispose();
  });

  it("dragend sweeps highlights from split buttons across multiple leaves", () => {
    // Two leaves in a split → two split-right buttons. A drag that
    // hovered both must clear both on dragend even though the drop
    // never happened.
    const { cb } = makeSplitDragCallbacks();
    const layout = new PaneLayout(cb);
    layout.setTree(
      makeSplit("s1", makeLeaf("leafA", ["t1", "t2"]), makeLeaf("leafB", ["t3"])),
    );
    // Source dragstart on leafA's first tab.
    const aTabs = root.querySelectorAll<HTMLElement>('[data-leaf-id="leafA"] .tab');
    aTabs[0].dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    const splitButtons = root.querySelectorAll<HTMLButtonElement>(
      '.tab-actions button[data-act="split-right"]',
    );
    expect(splitButtons.length).toBe(2);
    // Pretend the user dragged across both leaves' split-right buttons
    // without dropping (some browsers don't always fire dragleave
    // before the next dragover).
    splitButtons[0].dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    splitButtons[1].dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    expect(splitButtons[0].classList.contains("split-button-drop-target")).toBe(true);
    expect(splitButtons[1].classList.contains("split-button-drop-target")).toBe(true);
    // dragend on the source must clear BOTH.
    aTabs[0].dispatchEvent(new Event("dragend", { bubbles: true, cancelable: true }));
    expect(splitButtons[0].classList.contains("split-button-drop-target")).toBe(false);
    expect(splitButtons[1].classList.contains("split-button-drop-target")).toBe(false);
    layout.dispose();
  });

  it("drag from single-tab leaf onto own split button is a no-op", () => {
    // The dragged tab is the only tab in its source leaf. After the
    // hypothetical split + closeTab, the source leaf would collapse
    // and the new split would degenerate back to a single leaf — no
    // visible change. We refuse the drop at the dragover stage so the
    // user gets a clear non-target signal.
    const { cb, splitWithTab } = makeSplitDragCallbacks();
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1"]));
    const tab = root.querySelector<HTMLElement>(".tab")!;
    const splitRightBtn = root.querySelector<HTMLButtonElement>(
      '.tab-actions button[data-act="split-right"]',
    );
    tab.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    const overEvt = new Event("dragover", { bubbles: true, cancelable: true });
    splitRightBtn!.dispatchEvent(overEvt);
    expect(overEvt.defaultPrevented).toBe(false);
    expect(splitRightBtn!.classList.contains("split-button-drop-target")).toBe(false);
    splitRightBtn!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(splitWithTab).not.toHaveBeenCalled();
    layout.dispose();
  });

  it("clicking a split button (no drag) still opens the kind picker via onSplitRight", () => {
    // Regression: the existing click path must keep working unchanged
    // when no drag is in flight. PaneLayout.draggedTab is null, so the
    // click handler routes to onSplitRight (boot.ts shows the kind
    // picker), not onSplitWithTab.
    const { cb, splitWithTab, splitRight } = makeSplitDragCallbacks();
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1"]));
    const splitRightBtn = root.querySelector<HTMLButtonElement>(
      '.tab-actions button[data-act="split-right"]',
    );
    expect(splitRightBtn).not.toBeNull();
    splitRightBtn!.click();
    expect(splitRight).toHaveBeenCalledWith("leafA");
    expect(splitWithTab).not.toHaveBeenCalled();
    layout.dispose();
  });

  it("clicking a split-down button (no drag) still opens the kind picker via onSplitDown", () => {
    const { cb, splitWithTab, splitDown } = makeSplitDragCallbacks();
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1"]));
    const splitDownBtn = root.querySelector<HTMLButtonElement>(
      '.tab-actions button[data-act="split-down"]',
    );
    expect(splitDownBtn).not.toBeNull();
    splitDownBtn!.click();
    expect(splitDown).toHaveBeenCalledWith("leafA");
    expect(splitWithTab).not.toHaveBeenCalled();
    layout.dispose();
  });

  it("split button does not highlight or fire move when onSplitWithTab callback is absent", () => {
    // Back-compat: if a non-Satellite consumer omits onSplitWithTab,
    // the split button must not highlight (no false affordance) and
    // its drop must not silently fall through to a tab-bar move (the
    // user pointed at a *split* control, not the tab strip — turning
    // that into an in-bar move would be surprising).
    const cb = makeCallbacks(root, makeController());
    const moveSpy = vi.fn();
    const reorderSpy = vi.fn();
    cb.onMoveTab = moveSpy;
    cb.onReorderTab = reorderSpy;
    // Deliberately do NOT set cb.onSplitWithTab.
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    const tabs = root.querySelectorAll<HTMLElement>(".tab");
    const splitRightBtn = root.querySelector<HTMLButtonElement>(
      '.tab-actions button[data-act="split-right"]',
    );
    tabs[0].dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    splitRightBtn!.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    // No highlight when the callback is absent — a stuck class would
    // imply a drop here would do something.
    expect(splitRightBtn!.classList.contains("split-button-drop-target")).toBe(false);
    splitRightBtn!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    // Drop on the split button stops propagation so the tab-bar
    // fallback drop never sees it.
    expect(moveSpy).not.toHaveBeenCalled();
    expect(reorderSpy).not.toHaveBeenCalled();
    layout.dispose();
  });

  it("rejects a detached tab dropped on split button (Codex HIGH)", () => {
    // an earlier release / Codex review: detached panes have their terminal
    // owned by a popout window. Moving a detached tab into a new
    // split via this gesture would re-home the tab in the layout
    // tree but leave the popup still owning the terminal — state
    // divergence. Mirror the existing tab/tab-bar drop-path guard.
    //
    // Assertion strategy: the split button's own dragover/drop must
    // refuse — no `.split-button-drop-target` highlight, no
    // `onSplitWithTab` callback. We don't assert on
    // `defaultPrevented` because the surrounding tab-bar dragover
    // listener bubbles up and preventDefaults independently (its
    // detached-tab guard fires only at drop-time, by design — same
    // as the per-tab dragover gate at line ~856).
    const { cb, splitWithTab } = makeSplitDragCallbacks();
    cb.onDetachPane = vi.fn();
    cb.onReattachPane = vi.fn();
    const layout = new PaneLayout(cb);
    // Two tabs so the same-leaf-single-tab guard doesn't fire first.
    layout.setTree(makeLeaf("leafA", ["t1", "t2"]));
    // Mark t1 (the one we'll drag) as detached.
    layout.markDetached("pane-t1");
    const tabs = root.querySelectorAll<HTMLElement>(".tab");
    const splitRightBtn = root.querySelector<HTMLButtonElement>(
      '.tab-actions button[data-act="split-right"]',
    );
    expect(splitRightBtn).not.toBeNull();
    tabs[0].dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    splitRightBtn!.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    // dragover refused → no highlight class.
    expect(splitRightBtn!.classList.contains("split-button-drop-target")).toBe(false);
    // Even if the platform delivers drop anyway (belt-and-braces),
    // the drop handler also refuses: callback never fires.
    splitRightBtn!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(splitWithTab).not.toHaveBeenCalled();
    layout.dispose();
  });

  it("split-button drop clears DnD state before tree mutation (Codex MEDIUM)", () => {
    // Codex review: the boot.ts callback synchronously mutates the
    // tree (splitLeaf + closeTab + setTree), which can replace the
    // source tab DOM element BEFORE the browser delivers `dragend`.
    // If that happens, dragend never fires and `PaneLayout.draggedTab`
    // stays non-null + any `.split-button-drop-target` highlights on
    // OTHER leaves' split buttons stick. The drop handler must do
    // full DnD cleanup BEFORE calling onSplitWithTab. Use the
    // callback as the assertion point: when it fires, draggedTab
    // should be null and zero buttons should still carry the class.
    const { cb } = makeSplitDragCallbacks();
    let observedDraggedTab: unknown = "uninitialised";
    let observedHighlightCount = -1;
    cb.onSplitWithTab = () => {
      observedDraggedTab = (PaneLayout as unknown as { draggedTab: unknown }).draggedTab;
      observedHighlightCount = root.querySelectorAll(".split-button-drop-target").length;
    };
    const layout = new PaneLayout(cb);
    layout.setTree(
      makeSplit("s1", makeLeaf("leafA", ["t1", "t2"]), makeLeaf("leafB", ["t3"])),
    );
    // dragstart on leafA's first tab.
    const aTabs = root.querySelectorAll<HTMLElement>('[data-leaf-id="leafA"] .tab');
    aTabs[0].dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    // Hover both leaves' split-right buttons so both carry the class.
    const splitButtons = root.querySelectorAll<HTMLButtonElement>(
      '.tab-actions button[data-act="split-right"]',
    );
    expect(splitButtons.length).toBe(2);
    splitButtons[0].dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    splitButtons[1].dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    expect(splitButtons[0].classList.contains("split-button-drop-target")).toBe(true);
    expect(splitButtons[1].classList.contains("split-button-drop-target")).toBe(true);
    // Drop on the second leaf's split button. The callback should
    // observe a clean DnD state.
    splitButtons[1].dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(observedDraggedTab).toBeNull();
    expect(observedHighlightCount).toBe(0);
    layout.dispose();
  });
});

describe("Drag-to-split styles ", () => {
  it("CSS rules for .split-button-drop-target and SVG pointer-events guard are present in the renderer stylesheet", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const css = await fs.readFile(path.join(here, "..", "styles.css"), "utf8");
    // Visual highlight class itself.
    expect(css).toMatch(/\.split-button-drop-target/);
    // Pointer-events guard so dragleave doesn't flicker on each
    // sub-element boundary inside the icon button.
    expect(css).toMatch(/data-act="split-right"\] svg/);
    expect(css).toMatch(/data-act="split-down"\] svg/);
    expect(css).toMatch(/pointer-events:\s*none/);
  });
});

/**
 * "History" button (#51) — opens the Claude-pane transcript overlay.
 * Rendered only when the host wires `onHistoryPane` AND the active tab
 * is a Claude pane (shell/codex panes have no session transcript).
 */
describe("PaneLayout history button", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    MockTerminalPane.instances.length = 0;
    (PaneLayout as unknown as { draggedTab: unknown }).draggedTab = null;
  });

  afterEach(() => {
    root.remove();
  });

  function makeClaudeLeaf(id: string, tabs: string[]): LeafNode {
    return {
      kind: "leaf",
      id,
      activeTabId: tabs[0] ?? "",
      tabs: tabs.map((tabId) => ({
        id: tabId,
        paneId: `pane-${tabId}`,
        kind: "claude" as const,
        title: tabId,
        host: "local" as HostRef,
      })),
    };
  }

  it("appears on a claude tab and invokes onHistoryPane with paneId+leafId", () => {
    const history = vi.fn();
    const cb = makeCallbacks(root, makeController());
    cb.onHistoryPane = history;
    const layout = new PaneLayout(cb);
    layout.setTree(makeClaudeLeaf("leafA", ["t1"]));
    const btn = root.querySelector<HTMLButtonElement>(".pane-controls-history");
    expect(btn).not.toBeNull();
    btn!.click();
    expect(history).toHaveBeenCalledWith("pane-t1", "leafA");
    layout.dispose();
  });

  it("is hidden for shell tabs", () => {
    const cb = makeCallbacks(root, makeController());
    cb.onHistoryPane = vi.fn();
    const layout = new PaneLayout(cb);
    layout.setTree(makeLeaf("leafA", ["t1"])); // makeLeaf builds shell tabs
    expect(root.querySelector(".pane-controls-history")).toBeNull();
    layout.dispose();
  });

  it("is hidden when the onHistoryPane callback is absent", () => {
    const layout = new PaneLayout(makeCallbacks(root, makeController()));
    layout.setTree(makeClaudeLeaf("leafA", ["t1"]));
    expect(root.querySelector(".pane-controls-history")).toBeNull();
    layout.dispose();
  });
});

/**
 * Clicking History must focus its leaf first (#51 follow-up): the
 * toolbar swallows mousedown (stopPropagation), so without an explicit
 * focus the ⌘F search subsystem resolves the previously-active pane and
 * searches the terminal's ~40 painted rows instead of the transcript.
 */
describe("PaneLayout history button focuses its leaf", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    MockTerminalPane.instances.length = 0;
    (PaneLayout as unknown as { draggedTab: unknown }).draggedTab = null;
  });

  afterEach(() => {
    root.remove();
  });

  it("calls focusLeaf with the button's leaf before the callback", () => {
    const order: string[] = [];
    const cb = makeCallbacks(root, makeController());
    cb.onHistoryPane = () => order.push("history");
    const layout = new PaneLayout(cb);
    const focusSpy = vi
      .spyOn(layout, "focusLeaf")
      .mockImplementation(() => order.push("focus"));
    layout.setTree({
      kind: "leaf",
      id: "leafA",
      activeTabId: "t1",
      tabs: [
        {
          id: "t1",
          paneId: "pane-t1",
          kind: "claude" as const,
          title: "t1",
          host: "local" as HostRef,
        },
      ],
    });
    focusSpy.mockClear();
    order.length = 0;
    const btn = root.querySelector<HTMLButtonElement>(".pane-controls-history");
    btn!.click();
    expect(focusSpy).toHaveBeenCalledWith("leafA");
    expect(order).toEqual(["focus", "history"]);
    layout.dispose();
  });
});
