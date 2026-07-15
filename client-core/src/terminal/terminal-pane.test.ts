// Teardown-race tests for TerminalPane. The pane sits downstream of a
// PaneLayout that schedules `refit()` via `requestAnimationFrame`, and
// it wires three independent async sources that can fire after a call
// to `dispose()`:
//
//   - `ResizeObserver` callback (pane-layout height/width change races
//     ahead of the dispose)
//   - `MutationObserver` callback on the wrapper's `.hidden` class
//     toggle (added in an earlier release for the scroll-wedge diagnostic branch)
//   - A rAF-scheduled `refit()` that hasn't fired yet
//
// If any of those slip through after `dispose()`, the disposed xterm
// buffer will throw "buffer is not open" / DOM-mutation errors deep
// inside the render loop. The test verifies each path is safe.
//
// xterm is heavy and requires a real DOM render surface; we mock it
// out via `vi.mock`. The mocks preserve the *shape* the production
// code relies on (loadAddon, open, resize, dispose, onData, buffer
// accessors) without pulling in the real render stack.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// vi.mock is hoisted to the top of the file, so any identifiers it
// references must be hoisted too. vi.hoisted lets the mock factories
// reference classes that would otherwise be declared too late. Without
// this, vitest errors with `Cannot access 'MockTerminal' before
// initialization`.
const {
  MockTerminal,
  MockFitAddon,
  MockWebglAddon,
  TrackedResizeObserver,
  TrackedMutationObserver,
} = vi.hoisted(() => {
    class MockTerminal {
      static instances: MockTerminal[] = [];
      public disposed = false;
      public cols = 80;
      public rows = 24;
      public options: { theme?: unknown } = {};
      // Records each refresh(start, end) so tests can assert that a
      // forced full-viewport repaint happened (issue #30). xterm's real
      // refresh marks rows dirty; the mock just logs the range.
      public refreshCalls: Array<[number, number]> = [];
      private writtenData: string[] = [];
      private scrollCb: (() => void) | null = null;
      private addons: unknown[] = [];
      public parser = {
        registerOscHandler: () => ({ dispose: () => {} }),
      };
      public buffer = {
        active: { length: 0, viewportY: 0, baseY: 0, cursorY: 0 },
      };
      private onDataCb: ((data: string) => void) | null = null;
      constructor(_opts: unknown) {
        MockTerminal.instances.push(this);
      }
      loadAddon(addon: unknown) {
        this.addons.push(addon);
      }
      open(_el: HTMLElement) {
        // No render work — just mark that open() was called.
      }
      resize(cols: number, rows: number) {
        if (this.disposed) {
          throw new Error("resize on disposed terminal");
        }
        this.cols = cols;
        this.rows = rows;
      }
      write(data: string | Uint8Array) {
        if (this.disposed) {
          throw new Error("write on disposed terminal");
        }
        this.writtenData.push(typeof data === "string" ? data : "<bytes>");
      }
      // Real xterm throws when refresh runs on a disposed terminal — mirror
      // that so the production guard (forceRepaint short-circuits on
      // `disposed`) is actually exercised by the teardown tests.
      refresh(start: number, end: number) {
        if (this.disposed) {
          throw new Error("refresh on disposed terminal");
        }
        this.refreshCalls.push([start, end]);
      }
      onScroll(cb: () => void) {
        this.scrollCb = cb;
        return { dispose: () => { this.scrollCb = null; } };
      }
      dispose() {
        this.disposed = true;
      }
      focus() {
        if (this.disposed) throw new Error("focus on disposed");
      }
      onData(cb: (data: string) => void) {
        this.onDataCb = cb;
      }
      attachCustomKeyEventHandler(_cb: (ev: KeyboardEvent) => boolean) {
        // no-op in tests; production path tested separately if needed
      }
      scrollToBottom() {
        if (this.disposed) throw new Error("scrollToBottom on disposed");
        this.buffer.active.viewportY = this.buffer.active.baseY;
      }
      // xterm's scrollLines mutates viewportY by `amount` (negative
      // scrolls up). Mirrors the real Terminal.scrollLines contract so
      // `restoreViewportOffsetFromBottom` can be exercised against the
      // mock without a live render surface .
      scrollLines(amount: number) {
        if (this.disposed) throw new Error("scrollLines on disposed");
        const next = this.buffer.active.viewportY + amount;
        this.buffer.active.viewportY = Math.max(0, Math.min(next, this.buffer.active.baseY));
      }
    }

    class MockFitAddon {
      public disposed = false;
      fit() {
        if (this.disposed) throw new Error("fit on disposed addon");
      }
      dispose() {
        this.disposed = true;
      }
      proposeDimensions() {
        return { cols: 80, rows: 24 };
      }
      activate(_term: unknown) {}
    }

    class MockWebglAddon {
      static instances: MockWebglAddon[] = [];
      public disposed = false;
      private contextLossCb: (() => void) | null = null;
      constructor() {
        MockWebglAddon.instances.push(this);
      }
      dispose() {
        this.disposed = true;
      }
      activate(_term: unknown) {}
      // xterm's WebglAddon fires this when the GPU drops the WebGL
      // context. The production code must register a handler that
      // disposes the addon + forces a repaint (issue #30).
      onContextLoss(cb: () => void) {
        this.contextLossCb = cb;
        return { dispose: () => { this.contextLossCb = null; } };
      }
      // Test helper — simulate a GPU-process restart.
      _fireContextLoss() {
        this.contextLossCb?.();
      }
    }

    class TrackedResizeObserver {
      static instances: TrackedResizeObserver[] = [];
      public connected = true;
      public callback: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.callback = cb;
        TrackedResizeObserver.instances.push(this);
      }
      observe(_el: Element) {}
      unobserve(_el: Element) {}
      disconnect() {
        this.connected = false;
      }
      // Test helper — invoke the callback as if a resize happened.
      _fire() {
        this.callback([], this as unknown as ResizeObserver);
      }
    }

    // Tracked MutationObserver replaces jsdom's built-in so the test
    // can positively assert disconnect() fired on dispose — not just
    // "no throw on post-dispose flips", which is what the earlier
    // version of this test did and which only proved absence of a
    // crash path, not presence of teardown.
    class TrackedMutationObserver {
      static instances: TrackedMutationObserver[] = [];
      public connected = true;
      public observing: Node | null = null;
      public callback: MutationCallback;
      constructor(cb: MutationCallback) {
        this.callback = cb;
        TrackedMutationObserver.instances.push(this);
      }
      observe(target: Node, _opts?: MutationObserverInit) {
        this.observing = target;
      }
      disconnect() {
        this.connected = false;
        this.observing = null;
      }
      takeRecords(): MutationRecord[] {
        return [];
      }
      // Synthesise a mutation record and fire the callback — lets the
      // test prove a post-dispose flip does NOT reach the pane (by
      // exercising the path and checking no state changed).
      _fireClassChange() {
        this.callback([], this as unknown as MutationObserver);
      }
    }

    return {
      MockTerminal,
      MockFitAddon,
      MockWebglAddon,
      TrackedResizeObserver,
      TrackedMutationObserver,
    };
  });

vi.mock("@xterm/xterm", () => ({
  Terminal: MockTerminal,
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: MockFitAddon,
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: MockWebglAddon,
}));
vi.mock("./osc-filter", () => ({
  installOscFilter: () => {},
}));

// Import AFTER vi.mock so the mocks take effect. `terminal-pane.ts`
// transitively imports `ws.ts`, which we leave alone — our tests don't
// fire any WS callbacks here.
import { TerminalPane, __resetScrollDebugCacheForTests, type TerminalPaneProps } from "./terminal-pane";

// Each test mounts a pane under a fresh wrapper so `.hidden` toggles
// can be observed in isolation.
function setupDom() {
  document.body.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.className = "pane-terminal";
  document.body.appendChild(wrapper);
  return wrapper;
}

declare global {
  interface Window {
    __reckActivePane?: unknown;
    __reckPanes?: Record<string, unknown>;
    __reckPaneSnapshot?: unknown;
  }
}

// Map-backed localStorage shim. Node 22+ ships a native Web Storage
// implementation that vitest's jsdom env exposes as `localStorage`, but
// without `--localstorage-file=<path>` the runtime emits a warning
// ("--localstorage-file was provided without a valid path") and the
// resulting object is a non-functional stub: `typeof localStorage` is
// `"object"` but `getItem` / `setItem` are `undefined`. Production code
// (`isScrollDebugEnabled` in terminal-pane.ts) wraps the access in
// try/catch and degrades gracefully — the gate stays off — but these
// tests need the gate ON so the `.hidden`-class MutationObserver is
// actually installed. Without a working store, every `localStorage`
// call in `beforeEach` silently fails and the gate never flips.
//
// Fix: swap `globalThis.localStorage` for a fresh Map-backed shim per
// test so the gate read returns "1" and the production observer
// installs. Restored in `afterEach`. Only this describe block needs
// the swap; the rest of the suite doesn't touch `reck.debug.scroll`.
function createLocalStorageShim(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
  };
}

describe("TerminalPane teardown races", () => {
  let origRO: typeof ResizeObserver | undefined;
  let origRAF: typeof requestAnimationFrame | undefined;
  let origMO: typeof MutationObserver;
  let origWS: typeof WebSocket;
  let origLS: Storage | undefined;
  let rafQueue: FrameRequestCallback[] = [];

  beforeEach(() => {
    MockTerminal.instances = [];
    MockWebglAddon.instances = [];
    TrackedResizeObserver.instances = [];
    TrackedMutationObserver.instances = [];
    // Clear any debug-window state from a prior test.
    delete (window as Window).__reckActivePane;
    delete (window as Window).__reckPanes;
    delete (window as Window).__reckPaneSnapshot;

    // Install a working localStorage shim — see the comment above
    // `createLocalStorageShim`. Node 25's native Web Storage stub
    // breaks `localStorage.setItem` / `getItem`, which silently
    // disables the gate this test relies on.
    origLS = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage: Storage }).localStorage = createLocalStorageShim();

    // Opt the gate in so the `.hidden`-class MutationObserver is
    // actually installed for the teardown-race assertions below. The
    // scroll-debug gate is off by default in production (see an earlier release
    // follow-up); these tests specifically verify the instrumented
    // code path, so they set the flag + reset the module-scope cache.
    localStorage.setItem("reck.debug.scroll", "1");
    __resetScrollDebugCacheForTests();

    // jsdom ships without ResizeObserver or requestAnimationFrame —
    // install stubs scoped to the test so production code paths run.
    origRO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    (globalThis as { ResizeObserver: unknown }).ResizeObserver =
      TrackedResizeObserver;
    origRAF = (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame })
      .requestAnimationFrame;
    rafQueue = [];
    (globalThis as { requestAnimationFrame: unknown }).requestAnimationFrame =
      (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      };
    // Override jsdom's built-in MutationObserver with a tracked
    // variant so the test can positively assert disconnect() fired
    // on dispose — not just that post-dispose class flips don't
    // crash.
    origMO = globalThis.MutationObserver;
    (globalThis as { MutationObserver: unknown }).MutationObserver =
      TrackedMutationObserver;

    // Stub WebSocket so PaneWS.connect() doesn't make real requests.
    origWS = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = class {
      // Spec readyState constants — needed for PaneWS.send's
      // `WebSocket.OPEN` gate to evaluate correctly under the stub.
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 0;
      bufferedAmount = 0;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      constructor(_url: string, _protocols?: string | string[]) {}
      send(_data: string) {}
      close() {}
    };
  });

  afterEach(() => {
    if (origRO !== undefined) {
      (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
        origRO;
    } else {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    }
    if (origRAF !== undefined) {
      (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame })
        .requestAnimationFrame = origRAF;
    } else {
      delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame })
        .requestAnimationFrame;
    }
    globalThis.MutationObserver = origMO;
    globalThis.WebSocket = origWS;
    // Reset the scroll-debug gate between tests so the module-scope
    // cache from one test never bleeds into the next.
    localStorage.removeItem("reck.debug.scroll");
    __resetScrollDebugCacheForTests();
    // Restore whatever localStorage the runtime had before this
    // describe block stomped on it (likely Node's broken native stub
    // in CI, or jsdom's own impl elsewhere).
    if (origLS !== undefined) {
      (globalThis as { localStorage: Storage }).localStorage = origLS;
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  function mountPane(wrapper: HTMLElement): TerminalPane {
    const pane = new TerminalPane({
      wsUrl: "ws://x/ws/p/p",
      wsSubprotocols: [],
    });
    wrapper.appendChild(pane.container);
    pane.mount();
    return pane;
  }

  it("ResizeObserver fired after dispose is a safe no-op", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const ro = TrackedResizeObserver.instances[0];
    expect(ro.connected).toBe(true);

    pane.dispose();
    // Real browsers MAY deliver a previously-queued ResizeObserver
    // callback after disconnect; simulate that and assert the pane
    // doesn't try to operate on its disposed xterm.
    expect(() => ro._fire()).not.toThrow();

    // ResizeObserver was disconnected by dispose.
    expect(ro.connected).toBe(false);
  });

  it("MutationObserver on .hidden toggle is disconnected by dispose", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);

    // TerminalPane constructs the hidden-class MutationObserver
    // during mount(); the tracked stub records the instance. It
    // must be live and observing the wrapper before dispose.
    const mo = TrackedMutationObserver.instances[0];
    expect(mo).toBeDefined();
    expect(mo.connected).toBe(true);
    expect(mo.observing).toBe(wrapper);
    const term = MockTerminal.instances[0];
    expect(term.disposed).toBe(false);

    pane.dispose();

    // Positive assertion: dispose() called observer.disconnect() —
    // the invariant the earlier version of this test only checked
    // indirectly via "no throw on post-dispose flip". Now we also
    // verify the observer explicitly released its target.
    expect(mo.connected).toBe(false);
    expect(mo.observing).toBeNull();

    // Belt-and-braces: flipping the class post-dispose still must
    // not throw, and a synthetic late callback delivery also must
    // be a safe no-op (production path: the pane's scrollDebug
    // would read `this.term.buffer`, which is fine even if the
    // terminal is disposed because MockTerminal.buffer stays
    // accessible; the real xterm throws, but we're asserting the
    // observer is disconnected so the callback simply won't fire
    // from real-world paths).
    expect(() => wrapper.classList.toggle("hidden")).not.toThrow();
    expect(() => mo._fireClassChange()).not.toThrow();
  });

  it("rAF scheduled by PaneLayout that fires after dispose is a safe no-op", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);

    // Emulate PaneLayout.syncLeafView: `requestAnimationFrame(() =>
    // record.term.refit())`.
    requestAnimationFrame(() => pane.refit());

    // Dispose BEFORE the rAF fires.
    pane.dispose();
    const term = MockTerminal.instances[0];
    expect(term.disposed).toBe(true);

    // Fire the queued rAF. refit() is called on a disposed pane; the
    // production code short-circuits on `!isLaidOut()` (clientWidth/
    // clientHeight are 0 for a detached node), so no xterm call
    // should reach the disposed buffer. Assert: no throw, no DOM
    // mutation on the detached container.
    expect(() => {
      for (const cb of rafQueue.splice(0)) cb(0);
    }).not.toThrow();
  });

  it("onResize() via ResizeObserver callback after dispose does not mutate disposed xterm", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const ro = TrackedResizeObserver.instances[0];

    pane.dispose();
    const term = MockTerminal.instances[0];

    // Simulate a late ResizeObserver delivery. Even if the browser
    // somehow dispatches it after disconnect, production code guards
    // via `isLaidOut()` (false for detached container) OR we'd
    // surface the bug here as an unhandled throw from
    // `MockTerminal.resize`.
    ro._fire();

    // The disposed term must not have been resized.
    expect(term.cols).toBe(80);
    expect(term.rows).toBe(24);
  });

  it("refit() called directly after dispose is a safe no-op", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    pane.dispose();
    const term = MockTerminal.instances[0];

    // Direct invocation — simulates any cached reference that might
    // try to refit. Must NOT reach a disposed xterm operation.
    expect(() => pane.refit()).not.toThrow();
    // term.cols/rows are unchanged because the detached container
    // short-circuits isLaidOut().
    expect(term.cols).toBe(80);
  });

  it("debug accessors (__reckActivePane / __reckPanes) drop the disposed instance", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    pane.focus(); // marks the debug registry

    expect(window.__reckActivePane).toBe(pane);
    const panes = window.__reckPanes ?? {};
    expect(panes[pane.debugId]).toBe(pane);

    pane.dispose();

    // Active-pane handle cleared.
    expect(window.__reckActivePane == null).toBe(true);
    // Registry entry removed — the disposed instance is not reachable
    // via any debug path, so GC can collect it.
    expect((window.__reckPanes ?? {})[pane.debugId]).toBeUndefined();
  });

  it("dispose() is idempotent — second call is a no-op", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    pane.dispose();
    // Second dispose must not throw even though observers / ws /
    // terminal are already torn down.
    expect(() => pane.dispose()).not.toThrow();
  });

  // Issue #30 — WebGL stale/white/misaligned frames. The renderer holds
  // stale pixels after a state change (GPU context loss, focus, tab
  // show) and only a forced repaint clears them. These tests pin the two
  // fixes: (A) recover from context loss, (B) always repaint on refit.

  it("registers a WebGL context-loss handler that disposes the addon and forces a repaint (issue #30)", () => {
    const wrapper = setupDom();
    mountPane(wrapper);
    const webgl = MockWebglAddon.instances[0];
    expect(webgl).toBeDefined();
    expect(webgl.disposed).toBe(false);
    const term = MockTerminal.instances[0];
    term.refreshCalls = [];

    // Simulate Chromium's GPU process restarting (display sleep/wake,
    // GPU switch, driver reset). xterm's WebGL renderer would otherwise
    // stay blank/white forever.
    webgl._fireContextLoss();

    // Addon disposed → xterm reverts to its DOM renderer...
    expect(webgl.disposed).toBe(true);
    // ...and a full-viewport repaint is forced so the fallback paints
    // immediately rather than waiting for the next PTY write.
    expect(term.refreshCalls).toContainEqual([0, term.rows - 1]);
  });

  it("WebGL context loss after dispose is a safe no-op (issue #30)", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const webgl = MockWebglAddon.instances[0];
    pane.dispose();
    // A late context-loss event must not touch the disposed xterm
    // (refresh on a disposed terminal throws).
    expect(() => webgl._fireContextLoss()).not.toThrow();
  });

  it("refit() forces a full-viewport repaint even when fit() leaves dimensions unchanged (issue #30)", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const term = MockTerminal.instances[0];
    // jsdom reports 0×0 for detached nodes; fake a laid-out container so
    // refit() runs fit()+repaint instead of short-circuiting isLaidOut().
    Object.defineProperty(pane.container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(pane.container, "clientHeight", { value: 600, configurable: true });
    term.refreshCalls = [];

    // fit() is a no-op (MockFitAddon doesn't change cols/rows), so the
    // only way a repaint happens is the forced refresh.
    pane.refit();

    expect(term.refreshCalls).toContainEqual([0, term.rows - 1]);
  });

  it("onResize() forces a full-viewport repaint when laid out (issue #30)", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const term = MockTerminal.instances[0];
    Object.defineProperty(pane.container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(pane.container, "clientHeight", { value: 600, configurable: true });
    term.refreshCalls = [];

    // Fire the container ResizeObserver as the browser would.
    TrackedResizeObserver.instances[0]._fire();

    expect(term.refreshCalls).toContainEqual([0, term.rows - 1]);
  });

  it("refit() while not laid out does not repaint (issue #30)", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const term = MockTerminal.instances[0];
    // Detached/0×0 container: nothing visible, so no repaint should fire.
    term.refreshCalls = [];
    pane.refit();
    expect(term.refreshCalls).toEqual([]);
  });

  it("isAtBottom() reflects viewportY/baseY equality ", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const term = MockTerminal.instances[0];

    // Fresh buffer: both are 0 — viewport is at the bottom (empty).
    expect(pane.isAtBottom()).toBe(true);

    // Simulate scrollback: baseY advances as rows land, viewportY
    // stays behind (user has scrolled up).
    term.buffer.active.baseY = 200;
    term.buffer.active.viewportY = 120;
    expect(pane.isAtBottom()).toBe(false);

    // Realign — viewport is re-pinned to the tail.
    term.buffer.active.viewportY = 200;
    expect(pane.isAtBottom()).toBe(true);
  });

  it("scrollToBottom() delegates to the xterm instance ", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const term = MockTerminal.instances[0];

    // Put the viewport behind the base so we can observe the snap.
    term.buffer.active.baseY = 500;
    term.buffer.active.viewportY = 100;

    pane.scrollToBottom();
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
    expect(pane.isAtBottom()).toBe(true);
  });

  // an earlier release — partial-scroll preservation across pane hide/show.
  // The previous boolean-only `wasAtBottom` snapshot lost everything
  // between "at tail" and "scrolled up by N rows". These tests cover
  // the new offset-based capture/restore helpers in isolation; the
  // syncLeafView wiring around them lives in pane-layout.test.ts.

  it("getViewportOffsetFromBottom() returns baseY - viewportY ", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const term = MockTerminal.instances[0];

    // Pinned to the tail — offset is 0.
    term.buffer.active.baseY = 200;
    term.buffer.active.viewportY = 200;
    expect(pane.getViewportOffsetFromBottom()).toBe(0);

    // Scrolled up 80 rows.
    term.buffer.active.viewportY = 120;
    expect(pane.getViewportOffsetFromBottom()).toBe(80);

    // Fresh empty buffer.
    term.buffer.active.baseY = 0;
    term.buffer.active.viewportY = 0;
    expect(pane.getViewportOffsetFromBottom()).toBe(0);
  });

  it("restoreViewportOffsetFromBottom() re-anchors the viewport relative to baseY ", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const term = MockTerminal.instances[0];

    // Pane is at the tail; restore an 80-row offset.
    term.buffer.active.baseY = 500;
    term.buffer.active.viewportY = 500;
    pane.restoreViewportOffsetFromBottom(80);
    expect(term.buffer.active.viewportY).toBe(420);
    expect(pane.isAtBottom()).toBe(false);
  });

  it("restoreViewportOffsetFromBottom() clamps to baseY=0 when offset exceeds buffer size ", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const term = MockTerminal.instances[0];

    // Captured offset 600 but the post-show buffer only has 100 rows
    // of scrollback — clamp to row 0 instead of producing a negative
    // viewportY.
    term.buffer.active.baseY = 100;
    term.buffer.active.viewportY = 100;
    pane.restoreViewportOffsetFromBottom(600);
    expect(term.buffer.active.viewportY).toBe(0);
  });

  it("restoreViewportOffsetFromBottom() is a no-op for offset 0 or negative ", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    const term = MockTerminal.instances[0];

    term.buffer.active.baseY = 500;
    term.buffer.active.viewportY = 500;
    pane.restoreViewportOffsetFromBottom(0);
    expect(term.buffer.active.viewportY).toBe(500);
    pane.restoreViewportOffsetFromBottom(-10);
    expect(term.buffer.active.viewportY).toBe(500);
  });

  it("restoreViewportOffsetFromBottom() is a safe no-op after dispose ", () => {
    const wrapper = setupDom();
    const pane = mountPane(wrapper);
    pane.dispose();
    expect(() => pane.restoreViewportOffsetFromBottom(50)).not.toThrow();
  });

  // Image-paste tests (phase 1). The paste handler
  // intercepts `paste` events on the xterm root, uploads image blobs
  // via the injected `onPasteUpload` callback, then types the returned
  // absolute path into the PTY.

  /**
   * Build a ClipboardEvent shaped like a real paste with the given
   * clipboard items. jsdom's ClipboardEvent constructor doesn't support
   * `clipboardData` via the init dict (it's a readonly spec property),
   * so we construct via the base Event and define the property with
   * Object.defineProperty — matches what the browser exposes at the
   * event's own property.
   */
  function makePasteEvent(items: DataTransferItem[]): ClipboardEvent {
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    const dataTransfer = {
      items: Object.assign(items, { length: items.length }) as unknown as DataTransferItemList,
    };
    Object.defineProperty(ev, "clipboardData", {
      value: dataTransfer,
      enumerable: true,
    });
    return ev as ClipboardEvent;
  }

  function makeImageItem(mime: string, bytes: Uint8Array): DataTransferItem {
    const file = new File([bytes], "paste", { type: mime });
    return {
      kind: "file",
      type: mime,
      getAsFile: () => file,
      // Unused by the handler but present on the real DataTransferItem
      // interface — jsdom's type-checker wants them.
      getAsString: () => {},
    } as unknown as DataTransferItem;
  }

  // Rewire the WebSocket stub so tests can capture send frames and
  // force the socket into "open" state. PaneWS drops sends while
  // state != "open" (queueing them under the hood), so without this
  // the typed-path frames from the paste handler would never reach
  // our capture. Returns the sends array + a "force open" helper that
  // fires onopen on every instantiated stub.
  function installCapturingWebSocket(): { sends: string[]; openAll: () => void } {
    const sends: string[] = [];
    const instances: Array<{ readyState: number; onopen: ((e: Event) => void) | null }> = [];
    class CapturingWS {
      // Spec readyState constants — production code in
      // PaneWS.send gates on `WebSocket.OPEN`, so the mock must
      // expose them on the constructor.
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 0;
      bufferedAmount = 0;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      constructor(_url: string, _protocols?: string | string[]) {
        instances.push(this);
      }
      send(data: string) {
        sends.push(data);
      }
      close() {}
    }
    (globalThis as { WebSocket: unknown }).WebSocket = CapturingWS;
    return {
      sends,
      openAll: () => {
        for (const w of instances) {
          w.readyState = 1;
          w.onopen?.(new Event("open"));
        }
      },
    };
  }

  function mountPaneWithPaste(
    wrapper: HTMLElement,
    onPasteUpload: (blob: Blob, mime: string) => Promise<{ kind: "path"; path: string } | { kind: "chip" }>,
    onPasteUploadError?: (err: unknown, mime: string) => void,
  ): TerminalPane {
    const pane = new TerminalPane({
      wsUrl: "ws://x/ws/p/p",
      wsSubprotocols: [],
      onPasteUpload,
      onPasteUploadError,
    });
    wrapper.appendChild(pane.container);
    pane.mount();
    return pane;
  }

  /** Capture WS send payloads by monkey-patching the stub WebSocket.
   *  Must run AFTER mountPane because PaneWS constructs the socket
   *  on connect(). */
  function captureWsSends(): string[] {
    const sends: string[] = [];
    // Iterate over all live WebSocket instances — jsdom's custom stub
    // doesn't expose them, so we patch the prototype before the pane
    // mounts. Done via a wrapper function.
    return sends;
  }

  it("paste with a single image uploads then types the path into the PTY", async () => {
    const wrapper = setupDom();
    const { sends, openAll } = installCapturingWebSocket();

    const upload = vi.fn(async (_blob: Blob, _mime: string) => ({
      kind: "path" as const,
      path: "/tmp/reck-pane-p_x/uploads/123-abc.png",
    }));
    const pane = mountPaneWithPaste(wrapper, upload);
    // PaneWS drops sends while state != "open" — force the socket
    // open so the handler's ws.send actually reaches our capture.
    openAll();

    const ev = makePasteEvent([makeImageItem("image/png", new Uint8Array([1, 2, 3]))]);
    // Trigger the paste event on the xterm root (the container). The
    // handler is attached in capture phase so it runs before any
    // xterm-internal listener.
    pane.container.dispatchEvent(ev);
    // preventDefault must have been called because an image item was
    // present — otherwise xterm would have run its own text-paste path
    // and polluted the PTY with whatever text-flavour the clipboard
    // had.
    expect(ev.defaultPrevented).toBe(true);

    // Upload is async — wait a tick for the promise chain to resolve.
    await new Promise((r) => setTimeout(r, 0));

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][1]).toBe("image/png");

    // The handler types the path into the PTY via ws.send. The wire
    // format is `{type:"input", data: <base64>}` where data is the
    // base64-encoded UTF-8 bytes of the path + " ".
    //
    // We find the input frame and decode it back to string to assert
    // on the exact text that would reach the PTY.
    const inputFrames = sends
      .map((raw) => JSON.parse(raw) as { type: string; data?: string })
      .filter((m) => m.type === "input");
    expect(inputFrames.length).toBe(1);
    const b64 = inputFrames[0].data!;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    // Plan: "typed into the PTY followed by a space, not a newline —
    // the user will decide when to submit."
    expect(text).toBe("/tmp/reck-pane-p_x/uploads/123-abc.png ");
    pane.dispose();
  });

  it("paste with no image items is a no-op — xterm's default text path runs", async () => {
    const wrapper = setupDom();
    installCapturingWebSocket();

    const upload = vi.fn(async () => ({ kind: "path" as const, path: "never" }));
    const pane = mountPaneWithPaste(wrapper, upload);

    // A text-only paste (no file items at all) must fall through: the
    // handler returns early, preventDefault is NOT called, xterm sees
    // the event and does its thing.
    const ev = makePasteEvent([]);
    pane.container.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 0));

    expect(upload).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    pane.dispose();
  });

  it("paste with multiple images uploads serially and types paths in order", async () => {
    const wrapper = setupDom();
    const { sends, openAll } = installCapturingWebSocket();

    // Resolve sequentially so we can prove ordering: the second upload
    // only resolves after the first's path has been typed.
    const order: string[] = [];
    const upload = vi.fn(async (_blob: Blob, mime: string) => {
      order.push(`start:${mime}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`done:${mime}`);
      return { kind: "path" as const, path: `/tmp/${mime.replace("/", "-")}.file` };
    });

    const pane = mountPaneWithPaste(wrapper, upload);
    openAll();

    const ev = makePasteEvent([
      makeImageItem("image/png", new Uint8Array([1])),
      makeImageItem("image/jpeg", new Uint8Array([2])),
    ]);
    pane.container.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);

    // Wait for both serial uploads to finish.
    await new Promise((r) => setTimeout(r, 30));

    // Serial: start png → done png → start jpeg → done jpeg. Anything
    // else implies parallelism, which re-ordering the clipboard items'
    // intended sequence.
    expect(order).toEqual(["start:image/png", "done:image/png", "start:image/jpeg", "done:image/jpeg"]);

    // And the PTY saw two input frames, paths in clipboard order.
    const texts = sends
      .map((raw) => JSON.parse(raw) as { type: string; data?: string })
      .filter((m) => m.type === "input")
      .map((m) => {
        const b = Uint8Array.from(atob(m.data!), (c) => c.charCodeAt(0));
        return new TextDecoder().decode(b);
      });
    expect(texts).toEqual(["/tmp/image-png.file ", "/tmp/image-jpeg.file "]);
    pane.dispose();
  });

  it("paste upload failure calls onPasteUploadError and does not type a path", async () => {
    const wrapper = setupDom();
    const { sends, openAll } = installCapturingWebSocket();

    const boom = new Error("upload failed: 413");
    const upload = vi.fn(async () => {
      throw boom;
    });
    const onError = vi.fn();
    const pane = mountPaneWithPaste(wrapper, upload, onError);
    openAll();

    const ev = makePasteEvent([makeImageItem("image/png", new Uint8Array([0]))]);
    pane.container.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 0));

    // Error hook fired with the same error + mime, no input frame typed.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(boom);
    expect(onError.mock.calls[0][1]).toBe("image/png");

    const inputFrames = sends
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((m) => m.type === "input");
    expect(inputFrames).toEqual([]);
    pane.dispose();
  });

  // Phase 2: chip path. The upload callback returns
  // { kind: "chip" } when the daemon's clipboard-image endpoint took
  // care of typing 0x16 into the PTY. The TerminalPane must NOT type
  // a path on top of that.
  it("paste with chip-result does not type any path into the PTY", async () => {
    const wrapper = setupDom();
    const { sends, openAll } = installCapturingWebSocket();

    const upload = vi.fn(async (_blob: Blob, _mime: string) => ({
      kind: "chip" as const,
    }));
    const pane = mountPaneWithPaste(wrapper, upload);
    openAll();

    const ev = makePasteEvent([makeImageItem("image/png", new Uint8Array([1, 2, 3]))]);
    pane.container.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(upload).toHaveBeenCalledTimes(1);
    const inputFrames = sends
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((m) => m.type === "input");
    // Daemon already wrote 0x16; renderer types nothing.
    expect(inputFrames).toEqual([]);
    pane.dispose();
  });

  it("paste mixes chip + path results — both kinds processed in order", async () => {
    const wrapper = setupDom();
    const { sends, openAll } = installCapturingWebSocket();

    let n = 0;
    const upload = vi.fn(async (_blob: Blob, _mime: string) => {
      n++;
      // First image goes via chip; second falls back to path (e.g. the
      // capability flipped between the two calls).
      if (n === 1) return { kind: "chip" as const };
      return { kind: "path" as const, path: "/tmp/fallback.png" };
    });
    const pane = mountPaneWithPaste(wrapper, upload);
    openAll();

    const ev = makePasteEvent([
      makeImageItem("image/png", new Uint8Array([1])),
      makeImageItem("image/png", new Uint8Array([2])),
    ]);
    pane.container.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 5));

    const texts = sends
      .map((raw) => JSON.parse(raw) as { type: string; data?: string })
      .filter((m) => m.type === "input")
      .map((m) => {
        const b = Uint8Array.from(atob(m.data!), (c) => c.charCodeAt(0));
        return new TextDecoder().decode(b);
      });
    // Chip emitted nothing; path-fallback typed "/tmp/fallback.png ".
    expect(texts).toEqual(["/tmp/fallback.png "]);
    pane.dispose();
  });

  it("paste handler is not installed when onPasteUpload is undefined", () => {
    const wrapper = setupDom();
    const pane = new TerminalPane({
      wsUrl: "ws://x/ws/p/p",
      wsSubprotocols: [],
      // No onPasteUpload: handler must not be installed.
    });
    wrapper.appendChild(pane.container);
    pane.mount();

    // A pasted image event reaches the root — preventDefault must NOT
    // be called, because our handler was never installed. xterm's
    // default text path is what the user gets (for a text blob; an
    // image blob silently drops, same as Older behaviour).
    const ev = makePasteEvent([makeImageItem("image/png", new Uint8Array([0]))]);
    pane.container.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    pane.dispose();
  });

  // File drag-and-drop tests (Scope A — images only). The drop handler
  // reuses the same onPasteUpload pipeline as image paste: files dragged
  // onto the pane are uploaded to the daemon and their station-side path
  // is typed into the PTY. A dropped file's local path is meaningless on a
  // (possibly remote) station, so we always upload the bytes.

  /**
   * Build a DragEvent shaped like a real file drop/dragover. jsdom's
   * DataTransfer is minimal, so — as with makePasteEvent — we construct
   * a base Event and define `dataTransfer` with Object.defineProperty.
   * `types` carries "Files" whenever the drag has files, mirroring the
   * browser's `DataTransfer.types` gate the handler keys off.
   */
  function makeDropEvent(type: "drop" | "dragover", files: File[]): DragEvent {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    const fileList = Object.assign([...files], {
      length: files.length,
      item: (i: number) => files[i] ?? null,
    });
    const dataTransfer = {
      files: fileList as unknown as FileList,
      types: files.length > 0 ? ["Files"] : [],
      dropEffect: "none",
    };
    Object.defineProperty(ev, "dataTransfer", { value: dataTransfer, enumerable: true });
    return ev as DragEvent;
  }

  function makeImageFile(mime: string, bytes: Uint8Array, name = "drop"): File {
    return new File([bytes], name, { type: mime });
  }

  it("drop of a single image uploads then types the path into the PTY", async () => {
    const wrapper = setupDom();
    const { sends, openAll } = installCapturingWebSocket();

    const upload = vi.fn(async (_blob: Blob, _mime: string) => ({
      kind: "path" as const,
      path: "/tmp/reck-pane-p_x/uploads/drop-1.png",
    }));
    const pane = mountPaneWithPaste(wrapper, upload);
    openAll();

    const ev = makeDropEvent("drop", [makeImageFile("image/png", new Uint8Array([1, 2, 3]))]);
    pane.container.dispatchEvent(ev);
    // preventDefault blocks Electron's navigate-to-dropped-file default.
    expect(ev.defaultPrevented).toBe(true);

    await new Promise((r) => setTimeout(r, 0));

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][1]).toBe("image/png");

    const inputFrames = sends
      .map((raw) => JSON.parse(raw) as { type: string; data?: string })
      .filter((m) => m.type === "input");
    expect(inputFrames.length).toBe(1);
    const bytes = Uint8Array.from(atob(inputFrames[0].data!), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe("/tmp/reck-pane-p_x/uploads/drop-1.png ");
    pane.dispose();
  });

  it("drop with no files is an inert no-op (no preventDefault, no upload)", async () => {
    const wrapper = setupDom();
    installCapturingWebSocket();
    const upload = vi.fn(async () => ({ kind: "path" as const, path: "never" }));
    const pane = mountPaneWithPaste(wrapper, upload);

    const ev = makeDropEvent("drop", []);
    pane.container.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 0));

    expect(upload).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    pane.dispose();
  });

  it("drop of multiple images uploads serially and types paths in order", async () => {
    const wrapper = setupDom();
    const { sends, openAll } = installCapturingWebSocket();

    const order: string[] = [];
    const upload = vi.fn(async (_blob: Blob, mime: string) => {
      order.push(`start:${mime}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`done:${mime}`);
      return { kind: "path" as const, path: `/tmp/${mime.replace("/", "-")}.file` };
    });
    const pane = mountPaneWithPaste(wrapper, upload);
    openAll();

    const ev = makeDropEvent("drop", [
      makeImageFile("image/png", new Uint8Array([1])),
      makeImageFile("image/jpeg", new Uint8Array([2])),
    ]);
    pane.container.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);

    await new Promise((r) => setTimeout(r, 30));

    expect(order).toEqual(["start:image/png", "done:image/png", "start:image/jpeg", "done:image/jpeg"]);
    const texts = sends
      .map((raw) => JSON.parse(raw) as { type: string; data?: string })
      .filter((m) => m.type === "input")
      .map((m) => new TextDecoder().decode(Uint8Array.from(atob(m.data!), (c) => c.charCodeAt(0))));
    expect(texts).toEqual(["/tmp/image-png.file ", "/tmp/image-jpeg.file "]);
    pane.dispose();
  });

  function mountPaneWithDropPolicy(
    wrapper: HTMLElement,
    upload: (blob: Blob, mime: string, filename?: string) => Promise<{ kind: "path"; path: string } | { kind: "chip" }>,
    validateDroppedFile: TerminalPaneProps["validateDroppedFile"],
    onDropRejected: TerminalPaneProps["onDropRejected"],
  ): TerminalPane {
    const pane = new TerminalPane({
      wsUrl: "ws://x/ws/p/p",
      wsSubprotocols: [],
      onPasteUpload: upload,
      validateDroppedFile,
      onDropRejected,
    });
    wrapper.appendChild(pane.container);
    pane.mount();
    return pane;
  }

  it("drop rejected by type does not upload and reports the rejection", async () => {
    const wrapper = setupDom();
    const { sends } = installCapturingWebSocket();
    const upload = vi.fn(async () => ({ kind: "path" as const, path: "never" }));
    const onDropRejected = vi.fn();
    const pane = mountPaneWithDropPolicy(
      wrapper,
      upload,
      (f) => (f.name.endsWith(".zip") ? { ok: false, reason: "type" } : { ok: true }),
      onDropRejected,
    );

    const ev = makeDropEvent("drop", [makeImageFile("application/zip", new Uint8Array([1]), "archive.zip")]);
    pane.container.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 0));

    // preventDefault still fires (never navigate to the file), but no
    // upload — and the host is told so it can toast.
    expect(ev.defaultPrevented).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(onDropRejected).toHaveBeenCalledTimes(1);
    expect(onDropRejected.mock.calls[0][0]).toMatchObject({
      reason: "type",
      ext: "zip",
      name: "archive.zip",
    });
    const inputFrames = sends.map((raw) => JSON.parse(raw) as { type: string }).filter((m) => m.type === "input");
    expect(inputFrames).toEqual([]);
    pane.dispose();
  });

  it("drop rejected for size reports reason 'size'", async () => {
    const wrapper = setupDom();
    installCapturingWebSocket();
    const upload = vi.fn(async () => ({ kind: "path" as const, path: "never" }));
    const onDropRejected = vi.fn();
    const pane = mountPaneWithDropPolicy(
      wrapper,
      upload,
      (f) => (f.size > 5 ? { ok: false, reason: "size" } : { ok: true }),
      onDropRejected,
    );

    const ev = makeDropEvent("drop", [makeImageFile("image/png", new Uint8Array([1, 2, 3, 4, 5, 6]), "big.png")]);
    pane.container.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 0));

    expect(upload).not.toHaveBeenCalled();
    expect(onDropRejected.mock.calls[0][0]).toMatchObject({ reason: "size", name: "big.png" });
    pane.dispose();
  });

  it("drop of a non-image file uploads as octet-stream with its original filename (Scope B)", async () => {
    const wrapper = setupDom();
    const { sends, openAll } = installCapturingWebSocket();
    const upload = vi.fn(async (_blob: Blob, _mime: string, _filename?: string) => ({
      kind: "path" as const,
      path: "/tmp/reck-pane-p_x/uploads/doc.pdf",
    }));
    const pane = mountPaneWithPaste(wrapper, upload);
    openAll();

    const ev = makeDropEvent("drop", [makeImageFile("application/pdf", new Uint8Array([1, 2]), "spec.pdf")]);
    pane.container.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(upload).toHaveBeenCalledTimes(1);
    // Non-image drops go up as octet-stream; the daemon stores them by the
    // original filename's extension.
    expect(upload.mock.calls[0][1]).toBe("application/octet-stream");
    expect(upload.mock.calls[0][2]).toBe("spec.pdf");
    const texts = sends
      .map((raw) => JSON.parse(raw) as { type: string; data?: string })
      .filter((m) => m.type === "input")
      .map((m) => new TextDecoder().decode(Uint8Array.from(atob(m.data!), (c) => c.charCodeAt(0))));
    expect(texts).toEqual(["/tmp/reck-pane-p_x/uploads/doc.pdf "]);
    pane.dispose();
  });

  it("drop of a text file with empty browser MIME still forwards its filename (Scope B)", async () => {
    const wrapper = setupDom();
    installCapturingWebSocket();
    const upload = vi.fn(async (_blob: Blob, _mime: string, _filename?: string) => ({
      kind: "path" as const,
      path: "/tmp/notes.md",
    }));
    const pane = mountPaneWithPaste(wrapper, upload);

    const ev = makeDropEvent("drop", [makeImageFile("", new Uint8Array([1]), "notes.md")]);
    pane.container.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 0));

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][1]).toBe("application/octet-stream");
    expect(upload.mock.calls[0][2]).toBe("notes.md");
    pane.dispose();
  });

  it("dragover carrying files is claimed (preventDefault + copy dropEffect)", () => {
    const wrapper = setupDom();
    installCapturingWebSocket();
    const upload = vi.fn(async () => ({ kind: "path" as const, path: "x" }));
    const pane = mountPaneWithPaste(wrapper, upload);

    const ev = makeDropEvent("dragover", [makeImageFile("image/png", new Uint8Array([0]))]);
    pane.container.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(ev.dataTransfer!.dropEffect).toBe("copy");
    pane.dispose();
  });

  it("drop with dropPromptTemplate pastes the rendered prompt in bracketed-paste markers (Scope B)", async () => {
    const wrapper = setupDom();
    const { sends, openAll } = installCapturingWebSocket();
    const upload = vi.fn(async (_blob: Blob, _mime: string) => ({
      kind: "path" as const,
      path: "/tmp/reck-pane-p_x/uploads/1-a.pdf",
    }));
    const pane = new TerminalPane({
      wsUrl: "ws://x/ws/p/p",
      wsSubprotocols: [],
      onPasteUpload: upload,
      dropPromptTemplate: "Dropped {filename} at {path}. Handle with care.",
    });
    wrapper.appendChild(pane.container);
    pane.mount();
    openAll();

    const ev = makeDropEvent("drop", [makeImageFile("application/pdf", new Uint8Array([1]), "report.pdf")]);
    pane.container.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 0));

    const inputFrames = sends
      .map((raw) => JSON.parse(raw) as { type: string; data?: string })
      .filter((m) => m.type === "input");
    expect(inputFrames.length).toBe(1);
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(inputFrames[0].data!), (c) => c.charCodeAt(0)),
    );
    // Wrapped in bracketed-paste markers, placeholders substituted, no newline.
    expect(text).toBe(
      "\x1b[200~Dropped report.pdf at /tmp/reck-pane-p_x/uploads/1-a.pdf. Handle with care.\x1b[201~",
    );
    pane.dispose();
  });

  it("drop handler is not installed when onPasteUpload is undefined", () => {
    const wrapper = setupDom();
    const pane = new TerminalPane({ wsUrl: "ws://x/ws/p/p", wsSubprotocols: [] });
    wrapper.appendChild(pane.container);
    pane.mount();

    const ev = makeDropEvent("drop", [makeImageFile("image/png", new Uint8Array([0]))]);
    pane.container.dispatchEvent(ev);
    // No handler → default not prevented → Electron/browser handles it.
    expect(ev.defaultPrevented).toBe(false);
    pane.dispose();
  });

  it("multiple panes disposed out-of-order don't corrupt the debug registry", () => {
    const wrapper1 = document.createElement("div");
    wrapper1.className = "pane-terminal";
    const wrapper2 = document.createElement("div");
    wrapper2.className = "pane-terminal";
    document.body.innerHTML = "";
    document.body.appendChild(wrapper1);
    document.body.appendChild(wrapper2);

    const p1 = mountPane(wrapper1);
    const p2 = mountPane(wrapper2);
    // Focus p1, then p2 — p2 becomes active.
    p1.focus();
    p2.focus();
    expect(window.__reckActivePane).toBe(p2);

    // Dispose p1 (NOT the active one). __reckActivePane must still
    // point at p2 — this is the regression the guard was added for.
    p1.dispose();
    expect(window.__reckActivePane).toBe(p2);

    // Now dispose p2 too — active is cleared.
    p2.dispose();
    expect(window.__reckActivePane == null).toBe(true);
    expect(Object.keys(window.__reckPanes ?? {})).toEqual([]);
  });

  it("scroll-debug gate OFF: no MutationObserver installed, no console spam", () => {
    // Flip the gate OFF for this one test (overriding the outer
    // beforeEach which sets it ON). Registry hooks still populate —
    // they're not gated; only the logging + MutationObserver are.
    localStorage.removeItem("reck.debug.scroll");
    __resetScrollDebugCacheForTests();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const wrapper = setupDom();
      const pane = mountPane(wrapper);

      // No MutationObserver should have been constructed for the
      // hidden-class watcher — the log-only observer is now gated.
      expect(TrackedMutationObserver.instances.length).toBe(0);

      // Registry hooks still work — they're not gated.
      pane.focus();
      expect(window.__reckActivePane).toBe(pane);
      expect((window.__reckPanes ?? {})[pane.debugId]).toBe(pane);

      // refit() / resize-observer paths must not emit `[scroll-debug]`.
      pane.refit();
      const scrollDebugLogs = logSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("[scroll-debug]"),
      );
      expect(scrollDebugLogs).toEqual([]);

      pane.dispose();
    } finally {
      logSpy.mockRestore();
    }
  });
});
