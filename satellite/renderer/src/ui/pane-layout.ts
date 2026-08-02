import type { TreeNode, SplitNode, LeafNode, NavDir, Tab } from "../layout/split-tree";
import { allLeaves, findLeaf, focusNav, setRatio } from "../layout/split-tree";
import { TerminalPane } from "@client-core/terminal/terminal-pane";
import type { PasteUploadResult } from "@client-core/terminal/terminal-pane";
import type { PaneWSCloseInfo } from "@client-core/api/ws";
import type { PaneUsage, Stoplight } from "@proto/proto";
import type { HostRef } from "../host";
import { iconClose, iconSplitDown, iconSplitRight, iconDetach, iconHistory, iconMic } from "./icons";
import { ensureHistoryButton } from "./paneControls";
import { ensureDictationFab } from "../transcription/micOverlay";
import { installVoiceErrorHint } from "../transcription/voiceErrorHint";
import { computeReorder } from "./reorder";
import { HoverFocusController } from "./hover-focus-controller";

export interface PaneLayoutCallbacks {
  root: HTMLElement;
  /**
   * Resolve the pane WebSocket URL for `paneId` on `host`. Hybrid mode
   * (rev 3.1, phase 10): each tab's `host` determines which daemon the
   * WS connects to, so boot routes through `apiForHost(host).wsUrl(...)`.
   */
  buildWsUrl: (paneId: string, host: HostRef) => string;
  /**
   * Resolves the Sec-WebSocket-Protocol entries for new pane terminals
   * on `host`. Returns `[]` when auth is disabled (local daemon mode) —
   * a no-op for the WS constructor. Host-aware in phase 10 so station
   * and local clients use their own bearer tokens.
   */
  buildWsSubprotocols: (host: HostRef) => string[];
  onActiveLeafChange: (leafId: string | null) => void;
  /**
   * Fires once per newly-constructed pane terminal, right after its
   * `TerminalPane` is built. Used to install the xterm path linkifier so
   * file paths in scrollback become Cmd+clickable. Optional — consumers
   * that don't need per-pane setup omit it; existing callers are
   * unaffected.
   */
  onPaneCreated?: (paneId: string, pane: TerminalPane) => void;
  onStoplightChange: (paneId: string, s: Stoplight) => void;
  onExit: (paneId: string) => void;
  onTreeChange: (tree: TreeNode | null) => void;
  /**
   * Fires when a pane WebSocket receives a close frame. Lets the
   * renderer distinguish auth failure (1008) from peer shutdown (1001)
   * from generic network drop — callers can route e.g. 1008 into the
   * token-prompt dialog. Optional: omitted by tests that don't care.
   */
  onPaneConnClose?: (paneId: string, info: PaneWSCloseInfo) => void;
  // Resolves current stoplight for a pane so the tab bar can render a
  // per-tab status dot. Return "gray" if unknown.
  getStoplight: (paneId: string) => Stoplight;
  // Resolves the latest usage glance for a pane so the tab bar can render
  // a minimal "ctx 43% · 5h 61%" badge on Claude tabs. Returns undefined
  // when unknown (no sample yet, non-Claude pane, or telemetry disabled).
  // Optional so tests / non-Satellite consumers can omit it.
  getUsage?: (paneId: string) => PaneUsage | undefined;
  // User events
  onSwitchTab: (leafId: string, tabId: string) => void;
  onCloseTab: (leafId: string, tabId: string) => void;
  onNewTab: (leafId: string) => void;
  onSplitRight: (leafId: string) => void;
  onSplitDown: (leafId: string) => void;
  /**
   * Drag-tab-onto-split-button gesture . Fires when the
   * user drops a tab onto the split-right or split-down icon button on
   * any leaf's tab-bar. The renderer is responsible for: (a) creating
   * a new split off `targetLeafId` in `dir`, (b) moving the dragged
   * tab into the new sibling leaf, (c) persisting the layout. No
   * pane-kind picker is shown — the existing tab moves; nothing is
   * spawned. Click (no drag) on the same button still routes through
   * `onSplitRight` / `onSplitDown` and shows the picker as before.
   * Optional so tests / non-Satellite consumers can omit it; when
   * absent, split-button drop is a no-op (the button still accepts
   * clicks).
   */
  onSplitWithTab?: (
    targetLeafId: string,
    draggedLeafId: string,
    draggedTabId: string,
    dir: "vertical" | "horizontal",
  ) => void;
  onCloseLeaf: (leafId: string) => void;
  onRenameTab: (tabId: string, newTitle: string) => void;
  onReorderTab: (leafId: string, tabId: string, newIndex: number) => void;
  /** Move a tab between two different leaves. Inserts at `targetIndex`
   * in the destination leaf. The renderer guarantees `sourceLeafId !==
   * targetLeafId`; same-leaf drags use `onReorderTab`. */
  onMoveTab: (sourceLeafId: string, tabId: string, targetLeafId: string, targetIndex: number) => void;
  /**
   * Optional hover-to-focus controller . When provided, the
   * pane layout attaches `mouseenter` / `mouseleave` on every leaf and
   * routes focus requests through the controller's gate logic.
   * Omitted in tests that don't care, and in a legacy path where the
   * pref is off (construct + attach an always-disabled controller and
   * the request path short-circuits on gate 1 instead — pick whichever
   * the caller prefers).
   */
  hoverFocus?: HoverFocusController;
  /**
   * True iff the renderer is inside `selectProject`'s cold-daemon retry
   * window . When set, every layout-mutating gesture inside this
   * component bails: splitter drag, tab drag/drop reorder, tab drag/drop
   * move between leaves, tab click switch. Pane-creation bails at the
   * boot.ts callback layer, not here. Optional so test callers and
   * non-Satellite consumers can omit it and get the Older always-
   * mutable behaviour.
   */
  isRestoring?: () => boolean;
  /**
   * Upload a pasted image blob to the daemon for `paneId` on `host`
   * .
   *
   * Phase 1: returns `{ kind: "path", path }` — the renderer types the
   * absolute path into the PTY.
   * Phase 2: returns `{ kind: "chip" }` — the daemon already wrote
   * 0x16 (Ctrl+V) into the pane PTY after the sidecar wrote the
   * pasteboard. Renderer types nothing; Claude Code creates the
   * [Image #N] chip from the pasteboard.
   *
   * Optional — when omitted, pasted images silently drop (Older
   * behaviour, same as the legacy PWA consumer). Host-aware so local
   * and station panes route through their own bearer token.
   */
  onPasteUpload?: (
    paneId: string,
    host: HostRef,
    blob: Blob,
    mime: string,
    filename?: string,
  ) => Promise<PasteUploadResult>;
  /** Optional paste-upload error hook; relayed to the TerminalPane. */
  onPasteUploadError?: (paneId: string, err: unknown, mime: string) => void;
  /**
   * Current drop prompt template (thunk so freshly-created panes pick up
   * a Preferences edit without a reload). Relayed to TerminalPane as
   * `dropPromptTemplate`; when undefined a drop types the raw path.
   */
  dropPromptTemplate?: () => string | undefined;
  /**
   * Gate a dropped file against the user's allow-list + size cap. Relayed
   * to TerminalPane as `validateDroppedFile`.
   */
  validateDroppedFile?: (file: {
    name: string;
    size: number;
    type: string;
  }) => { ok: true } | { ok: false; reason: "type" | "size" };
  /** Surface a rejected drop (e.g. a toast). Relayed as `onDropRejected`. */
  onDropRejected?: (info: {
    name: string;
    reason: "type" | "size";
    ext: string;
    sizeBytes: number;
  }) => void;
  /**
   * Detach `paneId` to its own popout window . Called by the
   * per-pane "Detach" button and the ⌘⇧O shortcut. The callback is
   * responsible for opening the actual BrowserWindow (via
   * `reckAPI.windows.detachPane`) and then calling `markDetached(paneId)`
   * on this layout so the slot flips to a placeholder. Optional — tests
   * and non-Satellite consumers omit it; when omitted, the Detach button
   * isn't rendered.
   */
  onDetachPane?: (paneId: string, leafId: string) => void;
  /**
   * Reattach `paneId` from its popout . Called by the
   * placeholder slot's tappable surface. Forwards to
   * `reckAPI.windows.reattachPane`, which closes the popout and triggers
   * the popout-closed handler in boot.ts → `handlePopoutClosed(paneId)`
   * here. Optional for the same reason as `onDetachPane`.
   */
  onReattachPane?: (paneId: string) => void;
  /**
   * Open the transcript "History" overlay for `paneId` (#51). Rendered
   * only for Claude panes — shell/codex panes have no session
   * transcript. Optional for the same reason as `onDetachPane`.
   */
  onHistoryPane?: (paneId: string, leafId: string) => void;
  /**
   * Toggle voice dictation for a Claude pane (issue #67). When present, a
   * mic button is mounted in the pane's control stack. Optional — omitted
   * when the dictation feature isn't wired.
   */
  onDictationToggle?: (paneId: string, leafId: string) => void;
}

/**
 * Per-tab DOM record. A tab is either backed by a live `TerminalPane`
 * (the normal case) or by a placeholder DOM (an earlier release — the pane has
 * been popped out into its own window). The discriminated union keeps
 * the show/hide and dispose paths honest about which branch they're in
 * so the placeholder can't accidentally call `term.refit()`.
 */
type TabRecord =
  | {
      kind: "terminal";
      tab: Tab;
      term: TerminalPane;
      wrapper: HTMLElement;
      // `wasAtBottom` is captured on the transition active→hidden (see
      // syncLeafView) and consumed on the transition hidden→active so we
      // can conditionally `scrollToBottom()` after `refit()`. Default true
      // for freshly-created records — a new tab has nothing to preserve,
      // and "start pinned" matches xterm's own default behaviour.
      wasAtBottom: boolean;
      // Rows the viewport sat above the live tail at hide-time
      // (`baseY - viewportY`). 0 when the pane was pinned. Used on
      // hidden→active to restore a partial-scroll position rather than
      // collapsing every non-tail viewport to the tail (an earlier release —
      // the boolean-only snapshot lost everything between "at tail" and
      // "scrolled up by N rows").
      viewportOffsetFromBottom: number;
      // Sentinel for "xterm-internal viewport state may be stale — a
      // refit is queued but hasn't run yet". Set to the rAF handle on
      // the hidden→active branch and cleared in the rAF callback. The
      // capture-gate in syncLeafView refuses to read xterm while this
      // is non-null: a churn race (show → hide before rAF fires) would
      // otherwise overwrite the previously-correct stored values with
      // numbers read from an un-refit terminal whose buffer has grown
      // during the prior hide window. Codex adversarial-review HIGH
      // (an earlier release round 2).
      pendingFrame: number | null;
    }
  | {
      kind: "placeholder";
      tab: Tab;
      wrapper: HTMLElement;
    };

interface LeafView {
  el: HTMLElement;
  tabBarEl: HTMLElement;
  termsEl: HTMLElement;
  terminals: Map<string, TabRecord>;
}

// formatPaneUsage renders the minimal tab badge string, e.g.
// "ctx 43% · 5h 61%". Returns "" when no usable value is present so the
// caller can skip the DOM node entirely. Exported for unit testing.
// Number.isFinite (not typeof === "number") guards against a NaN slipping
// in from a locally-constructed PaneUsage.
export function formatPaneUsage(u: PaneUsage | undefined): string {
  if (!u) return "";
  const parts: string[] = [];
  if (Number.isFinite(u.context_pct)) parts.push(`ctx ${Math.round(u.context_pct as number)}%`);
  if (Number.isFinite(u.five_hour_pct)) parts.push(`5h ${Math.round(u.five_hour_pct as number)}%`);
  return parts.join(" · ");
}

export class PaneLayout {
  // Shared across tab re-renders: tracks the last title mousedown by tabId
  // so a double-click gesture still fires rename even if setTree recreated the DOM between clicks.
  static lastTitleDownTabId: string | null = null;
  static lastTitleDownTs = 0;
  private static draggedTab: { leafId: string; tabId: string } | null = null;

  private tree: TreeNode | null = null;
  private activeLeafId: string | null = null;
  private views = new Map<string, LeafView>();
  private resizeObserver?: ResizeObserver;
  private currentTheme: "light" | "dark" = "dark";
  // an earlier release: paneIds whose terminal lives in a popout window. The
  // syncLeafView path consults `isDetached` and renders a placeholder
  // wrapper instead of mounting a TerminalPane; drop handlers refuse
  // detached tabs as targets so the user can't drag content into a
  // pane that has no live terminal in this window.
  private detachedPanes = new Set<string>();

  constructor(private cb: PaneLayoutCallbacks) {
    this.cb.root.classList.add("pane-layout");
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.layout());
      this.resizeObserver.observe(this.cb.root);
    }
  }

  /**
   * Replace the layout tree and repaint.
   *
   * `opts.persist` (default true) controls whether `onTreeChange` fires.
   * User-action paths (split / move / close / rename / reorder) take the
   * default — their setTree reflects a deliberate edit and must go to
   * disk. The reconcile path in `selectProject` passes `persist: false`
   * because the reconciled tree is a presentation projection of saved
   * intent + live daemon panes; letting it auto-save would overwrite
   * the canonical saved layout with whatever Pass 3 of reconcile
   * appended, and the user's splits would degrade irreversibly across
   * every daemon restart / app reload.
   */
  setTree(tree: TreeNode | null, opts: { persist?: boolean } = {}) {
    // Cancel any pending hover-focus dwell: the leaf it was targeting
    // may be removed by this setTree call, and firing focusLeaf on a
    // stale id would stamp activeLeafId onto a now-nonexistent leaf.
    // See an earlier release 3b.
    //
    // Double optional chain: `?.` after `hoverFocus` guards the field
    // being undefined; `?.` after `cancelPending` guards a caller
    // passing a structurally-cast stub that predates the method (tests
    // or legacy callers casting `{ request, cancel, attach, detach }`
    // to `HoverFocusController`). Without the second `?.`, any such
    // stub would throw on the first setTree.
    this.cb.hoverFocus?.cancelPending?.();
    // Dispose views whose leaves are gone
    const keepLeafIds = new Set(allLeaves(tree).map((l) => l.id));
    for (const [leafId, view] of this.views) {
      if (!keepLeafIds.has(leafId)) {
        for (const record of view.terminals.values()) {
          if (record.kind === "terminal") record.term.dispose();
        }
        view.el.remove();
        this.views.delete(leafId);
      }
    }
    this.tree = tree;
    if (this.activeLeafId && !keepLeafIds.has(this.activeLeafId)) {
      this.activeLeafId = keepLeafIds.size > 0 ? [...keepLeafIds][0] : null;
      this.cb.onActiveLeafChange(this.activeLeafId);
    }
    this.render();
    if (opts.persist !== false) this.cb.onTreeChange(tree);
  }

  getTree(): TreeNode | null { return this.tree; }
  getActiveLeafId(): string | null { return this.activeLeafId; }

  getActiveTabForLeaf(leafId: string): Tab | null {
    const l = findLeaf(this.tree, leafId);
    if (!l) return null;
    return l.tabs.find((t) => t.id === l.activeTabId) ?? l.tabs[0] ?? null;
  }

  // Resolve the active leaf's focused terminal record (term + wrapper +
  // tab), or null when the active tab isn't a terminal. The TTS subsystem
  // uses this to wrap the live xterm pane as a speak surface.
  getActiveTerminalRecord(): { term: TerminalPane; wrapper: HTMLElement; tab: Tab } | null {
    if (!this.activeLeafId) return null;
    const view = this.views.get(this.activeLeafId);
    if (!view) return null;
    const tab = this.getActiveTabForLeaf(this.activeLeafId);
    if (!tab) return null;
    const record = view.terminals.get(tab.id);
    if (!record || record.kind !== "terminal") return null;
    return { term: record.term, wrapper: record.wrapper, tab: record.tab };
  }

  // Resolve any pane's terminal record by pane id, active or not. The
  // transcript "History" overlay (#51) mounts into that pane's wrapper
  // regardless of which leaf currently has focus.
  getTerminalRecordByPane(
    paneId: string,
  ): { term: TerminalPane; wrapper: HTMLElement; tab: Tab } | null {
    for (const view of this.views.values()) {
      for (const record of view.terminals.values()) {
        if (record.kind === "terminal" && record.tab.paneId === paneId) {
          return { term: record.term, wrapper: record.wrapper, tab: record.tab };
        }
      }
    }
    return null;
  }

  focusLeaf(leafId: string) {
    // Defensive: hover-focus's dwell path can fire on a leaf that was
    // removed during setTree between request and apply. Early-return
    // avoids stamping activeLeafId onto a nonexistent leaf (which
    // would then fail silently in updateActiveClasses + leak the
    // stale id into the next onActiveLeafChange). Click paths always
    // hold a live leaf, so this adds one cheap lookup on the common
    // case. See an earlier release 3b.
    if (!findLeaf(this.tree, leafId)) return;
    this.activeLeafId = leafId;
    this.cb.onActiveLeafChange(leafId);
    const active = this.getActiveTabForLeaf(leafId);
    const view = this.views.get(leafId);
    if (view && active) {
      const record = view.terminals.get(active.id);
      // Placeholder records (an earlier release, detached pane) have no
      // terminal to focus. Skip silently — the popout window already
      // owns keyboard focus while detached.
      if (record?.kind === "terminal") record.term.focus();
    }
    this.updateActiveClasses();
  }

  navigate(dir: NavDir) {
    if (!this.tree || !this.activeLeafId) return;
    const next = focusNav(this.tree, this.activeLeafId, dir);
    if (next) this.focusLeaf(next);
  }

  resizeSplit(splitId: string, ratio: number) {
    if (!this.tree) return;
    this.setTree(setRatio(this.tree, splitId, ratio));
  }

  /** Re-render after external tree mutation (e.g., tab added / switched). */
  refresh() { this.render(); }

  setTheme(theme: "light" | "dark") {
    this.currentTheme = theme;
    for (const view of this.views.values()) {
      for (const record of view.terminals.values()) {
        if (record.kind === "terminal") record.term.setTheme(theme);
      }
    }
  }

  /**
   * True iff `paneId` has been popped out into its own window
   * . Consulted by syncLeafView (to render placeholder DOM
   * instead of mounting a TerminalPane) and by the tab-bar drop
   * handlers (to refuse drops on detached tabs — moving content into a
   * pane whose terminal lives in another window would silently lose
   * the action).
   */
  isDetached(paneId: string): boolean {
    return this.detachedPanes.has(paneId);
  }

  /**
   * Mark `paneId` as detached: dispose the existing TerminalPane (if
   * any), keep the tab in the split tree, and re-render so its slot
   * flips to the placeholder DOM. Called from boot.ts after a successful
   * `reckAPI.windows.detachPane(paneId)`. Idempotent — calling on an
   * already-detached pane is a no-op (the placeholder is already in
   * place).
   */
  markDetached(paneId: string): void {
    if (this.detachedPanes.has(paneId)) return;
    this.detachedPanes.add(paneId);
    // syncLeafView's create-loop sees the paneId in `detachedPanes`
    // and rebuilds the slot's wrapper as a placeholder. The tear-down
    // of the existing TerminalPane happens inside syncLeafView's
    // detached-ness reconciliation branch.
    this.refresh();
  }

  /**
   * Called by boot.ts when the popout window for `paneId` closed
   * (either via OS close button, ⌘W on the popout, or
   * `reckAPI.windows.reattachPane`). Drops the paneId from the
   * detached set and re-renders so the slot flips back to a live
   * TerminalPane. The new pane connects to the same daemon endpoint
   * and the daemon's 64KB ring buffer replays the recent scrollback,
   * so the user sees state continuous with what the popout showed.
   */
  handlePopoutClosed(paneId: string): void {
    if (!this.detachedPanes.has(paneId)) return;
    this.detachedPanes.delete(paneId);
    this.refresh();
  }

  private render() {
    if (!this.tree) {
      for (const [leafId, v] of this.views) {
        for (const record of v.terminals.values()) {
          if (record.kind === "terminal") record.term.dispose();
        }
        v.el.remove();
        this.views.delete(leafId);
      }
      this.cb.root.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = `<span>No panes in this project.</span><span>Press <kbd>⌘T</kbd> or <kbd>⌘D</kbd> to create one.</span>`;
      this.cb.root.appendChild(empty);
      return;
    }
    // Remove any empty-state marker
    const emptyEl = this.cb.root.querySelector(".empty-state");
    if (emptyEl) emptyEl.remove();
    // Clear split handles (re-added during layout); keep leaf elements.
    for (const h of [...this.cb.root.querySelectorAll(".split-handle")]) h.remove();
    // Build/update leaf views
    for (const leaf of allLeaves(this.tree)) this.syncLeafView(leaf);
    // Position everything
    this.layout();
  }

  private layout() {
    if (!this.tree) return;
    for (const h of [...this.cb.root.querySelectorAll(".split-handle")]) h.remove();
    const rect = this.cb.root.getBoundingClientRect();
    // pane-layout has padding (8px); measure inside it
    const style = getComputedStyle(this.cb.root);
    const pad = parseFloat(style.paddingLeft) || 0;
    const w = rect.width - pad * 2;
    const h = rect.height - pad * 2;
    this.layoutNode(this.tree, pad, pad, w, h);
    this.updateActiveClasses();
  }

  private layoutNode(node: TreeNode, x: number, y: number, w: number, h: number) {
    if (node.kind === "leaf") { this.layoutLeaf(node, x, y, w, h); return; }
    this.layoutSplit(node, x, y, w, h);
  }

  private layoutLeaf(node: LeafNode, x: number, y: number, w: number, h: number) {
    const view = this.views.get(node.id);
    if (!view) return;
    Object.assign(view.el.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
    view.el.setAttribute("data-leaf-id", node.id);
  }

  private layoutSplit(node: SplitNode, x: number, y: number, w: number, h: number) {
    if (node.dir === "vertical") {
      const leftW = Math.floor(w * node.ratio);
      this.layoutNode(node.a, x, y, leftW, h);
      this.layoutNode(node.b, x + leftW, y, w - leftW, h);
      this.addHandle("vertical", node.id, x + leftW, y, h);
    } else {
      const topH = Math.floor(h * node.ratio);
      this.layoutNode(node.a, x, y, w, topH);
      this.layoutNode(node.b, x, y + topH, w, h - topH);
      this.addHandle("horizontal", node.id, x, y + topH, w);
    }
  }

  private addHandle(orient: "vertical" | "horizontal", splitId: string, x: number, y: number, extent: number) {
    const handle = document.createElement("div");
    handle.className = "split-handle " + orient;
    if (orient === "vertical") {
      Object.assign(handle.style, { left: `${x}px`, top: `${y}px`, height: `${extent}px` });
    } else {
      Object.assign(handle.style, { left: `${x}px`, top: `${y}px`, width: `${extent}px` });
    }
    handle.onmousedown = (e) => this.startSplitDrag(e, handle, splitId, orient);
    this.cb.root.appendChild(handle);
  }

  private startSplitDrag(e: MouseEvent, handle: HTMLElement, splitId: string, orient: "vertical" | "horizontal") {
    // An earlier release: drop the drag if we're inside selectProject's retry window.
    // The ratio change would land in setTree → reconcile would silently
    // revert it on the post-retry repaint. CSS also disables pointer
    // events on .restoring-layout .split-handle as a belt-and-braces
    // visual signal; this is the runtime gate.
    if (this.cb.isRestoring?.()) return;
    e.preventDefault();
    handle.classList.add("dragging");
    const rect = this.cb.root.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(this.cb.root).paddingLeft) || 0;
    const onMove = (ev: MouseEvent) => {
      const ratio =
        orient === "vertical"
          ? (ev.clientX - rect.left - pad) / (rect.width - pad * 2)
          : (ev.clientY - rect.top - pad) / (rect.height - pad * 2);
      this.resizeSplit(splitId, ratio);
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      requestAnimationFrame(() => this.refitAllActiveTerminals(false));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  private syncLeafView(leaf: LeafNode) {
    let view = this.views.get(leaf.id);
    if (!view) {
      const el = document.createElement("div");
      el.className = "pane-leaf";
      const tabBar = document.createElement("div");
      tabBar.className = "tab-bar";
      const terms = document.createElement("div");
      terms.className = "pane-terminals";
      el.appendChild(tabBar);
      el.appendChild(terms);
      el.addEventListener("mousedown", () => this.focusLeaf(leaf.id));
      // Hover-to-focus . The controller itself enforces the
      // pref gate, so wiring the listeners unconditionally is fine —
      // they're no-ops when the pref is off. The `apply` thunk is the
      // regular `focusLeaf` path so click-focus and hover-focus end up
      // in the same place. Listeners capture `leaf.id` at leaf-create
      // time; `pane-leaf` elements are recreated if a leaf is removed
      // and re-added, so no re-binding needed across setTree.
      if (this.cb.hoverFocus) {
        const ctrl = this.cb.hoverFocus;
        el.addEventListener("mouseenter", () => {
          ctrl.request(leaf.id, () => this.focusLeaf(leaf.id));
        });
        el.addEventListener("mouseleave", () => ctrl.cancel());
      }
      this.cb.root.appendChild(el);
      view = { el, tabBarEl: tabBar, termsEl: terms, terminals: new Map() };
      this.views.set(leaf.id, view);

      // Tab-bar-level drag handlers catch drops that miss the per-tab
      // listeners — e.g. the empty stretch after the last tab, or the +
      // button. These are attached once per leaf; per-tab drops call
      // stopPropagation() so they don't fire both. The bar still falls
      // back to appending at the end of its leaf.
      tabBar.addEventListener("dragover", (e) => {
        const dragged = PaneLayout.draggedTab;
        if (!dragged) return;
        // Ignore if the current leaf has no tabs (shouldn't happen —
        // empty leaves are collapsed), or if same-leaf and the only tab
        // in the leaf is the dragged one.
        const sameLeaf = dragged.leafId === leaf.id;
        const currentLeaf = findLeaf(this.tree, leaf.id);
        if (sameLeaf && currentLeaf && currentLeaf.tabs.length === 1) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      });
      tabBar.addEventListener("drop", (e) => {
        const dragged = PaneLayout.draggedTab;
        if (!dragged) return;
        e.preventDefault();
        const currentLeaf = findLeaf(this.tree, leaf.id);
        if (!currentLeaf) return;
        // an earlier release: if the dragged tab itself is detached, refuse
        // the drop. Moving a detached tab between leaves would lose
        // track of which window owns its terminal.
        const draggedTab = currentLeaf.tabs.find((x) => x.id === dragged.tabId)
          ?? findLeaf(this.tree, dragged.leafId)?.tabs.find((x) => x.id === dragged.tabId);
        if (draggedTab && this.isDetached(draggedTab.paneId)) return;
        if (dragged.leafId === leaf.id) {
          // Same-leaf fallback drop → move to end of its own list.
          this.cb.onReorderTab(leaf.id, dragged.tabId, currentLeaf.tabs.length - 1);
        } else {
          // Cross-leaf fallback → append to end of target leaf.
          this.cb.onMoveTab(dragged.leafId, dragged.tabId, leaf.id, currentLeaf.tabs.length);
        }
      });
    }

    // Sync terminals: create for new tabs, dispose for removed ones.
    // an earlier release: a record's `kind` distinguishes a live TerminalPane
    // from a placeholder DOM (pane is detached). The dispose branch
    // also reconciles state when a tab's detached-ness changes between
    // syncs — e.g. handlePopoutClosed flips a placeholder back to a
    // live terminal and re-runs syncLeafView.
    const liveTabIds = new Set(leaf.tabs.map((t) => t.id));
    for (const [tabId, record] of view.terminals) {
      if (!liveTabIds.has(tabId)) {
        if (record.kind === "terminal") record.term.dispose();
        record.wrapper.remove();
        view.terminals.delete(tabId);
        continue;
      }
      // Tab still exists — but its detached-ness may have flipped.
      // Drop the stale record so the create loop below rebuilds it
      // in the right kind.
      const isDetached = this.detachedPanes.has(record.tab.paneId);
      const wantPlaceholder = isDetached;
      const havePlaceholder = record.kind === "placeholder";
      if (wantPlaceholder !== havePlaceholder) {
        if (record.kind === "terminal") record.term.dispose();
        record.wrapper.remove();
        view.terminals.delete(tabId);
      }
    }
    for (const t of leaf.tabs) {
      if (view.terminals.has(t.id)) continue;
      const wrapper = document.createElement("div");
      wrapper.className = "pane-terminal";
      if (this.detachedPanes.has(t.paneId)) {
        // an earlier release: render a placeholder DOM in lieu of a TerminalPane.
        // The placeholder is itself tappable — clicking anywhere on it
        // calls `onReattachPane`, which closes the popout window and
        // (via popout-closed → handlePopoutClosed) replaces this record
        // with a fresh TerminalPane that picks up where the popout
        // left off via the daemon's 64KB ring buffer replay.
        wrapper.classList.add("pane-detached-placeholder");
        wrapper.setAttribute("data-pane-id", t.paneId);
        const card = document.createElement("div");
        card.className = "pane-detached-card";
        const title = document.createElement("div");
        title.className = "pane-detached-title";
        title.textContent = "Detached";
        const subtitle = document.createElement("div");
        subtitle.className = "pane-detached-subtitle";
        subtitle.textContent =
          "Close the popout window to recall this pane, or click here.";
        card.appendChild(title);
        card.appendChild(subtitle);
        wrapper.appendChild(card);
        wrapper.addEventListener("click", (e) => {
          e.stopPropagation();
          this.cb.onReattachPane?.(t.paneId);
        });
        view.termsEl.appendChild(wrapper);
        view.terminals.set(t.id, { kind: "placeholder", tab: t, wrapper });
        continue;
      }
      const term = new TerminalPane({
        wsUrl: this.cb.buildWsUrl(t.paneId, t.host),
        // Thunk, not a static array: the bearer token can rotate
        // mid-session (1008 → user pastes a new token in the
        // update-token dialog). Re-resolving on every reconnect
        // means the next attempt automatically picks up the fresh
        // token without rebuilding existing pane terminals.
        // Host-aware so a station→local mixed layout routes each
        // tab's WS through its own daemon's client.
        wsSubprotocols: () => this.cb.buildWsSubprotocols(t.host),
        onStoplight: (s) => this.cb.onStoplightChange(t.paneId, s),
        onExit: (_c) => this.cb.onExit(t.paneId),
        onConnState: (_state, closeInfo) => {
          // Only close-driven transitions carry closeInfo. Forward to
          // the caller so boot.ts can route auth-failure close codes
          // (1008) into the token-prompt dialog, etc.
          if (closeInfo) this.cb.onPaneConnClose?.(t.paneId, closeInfo);
        },
        // Image-paste upload (phase 1). Thread through the
        // pane + host tuple so the callback can pick the right
        // daemon client. When the callback is undefined the
        // TerminalPane installs no paste handler and pasted images
        // drop as before.
        onPasteUpload: this.cb.onPasteUpload
          ? (blob, mime, filename) =>
              this.cb.onPasteUpload!(t.paneId, t.host, blob, mime, filename)
          : undefined,
        onPasteUploadError: this.cb.onPasteUploadError
          ? (err, mime) => this.cb.onPasteUploadError!(t.paneId, err, mime)
          : undefined,
        // Voice-dictation hint (Phase 0): only Claude panes run `/voice`,
        // so watch just those for its station-capture failure and, once,
        // toast the user. `installVoiceErrorHint` mounts into the pane
        // wrapper; the sink no-ops after it has fired.
        onDecodedOutput:
          t.kind === "claude"
            ? installVoiceErrorHint(wrapper).onOutput
            : undefined,
        dropPromptTemplate: this.cb.dropPromptTemplate?.(),
        validateDroppedFile: this.cb.validateDroppedFile,
        onDropRejected: this.cb.onDropRejected,
        theme: this.currentTheme,
      });
      wrapper.appendChild(term.container);
      view.termsEl.appendChild(wrapper);
      term.mount();
      // Install the xterm path linkifier on the freshly-mounted pane so
      // file paths in scrollback become Cmd+clickable (hover-driven — no
      // cost until the user hovers a line). Optional; a no-op when unset.
      this.cb.onPaneCreated?.(t.paneId, term);
      // History (clock) toggle for Claude panes lives in the pane's top-right
      // control stack (alongside search + TTS), not the tab bar. `wrapper` is
      // the same anchor boot.ts mounts search/TTS into, so they share one stack.
      if (this.cb.onHistoryPane && t.kind === "claude") {
        ensureHistoryButton(wrapper, {
          icon: iconHistory,
          onToggle: () => {
            this.focusLeaf(leaf.id);
            this.cb.onHistoryPane?.(t.paneId, leaf.id);
          },
        });
      }
      // Voice-dictation mic (issue #67) — Claude panes only: the floating
      // draggable button anchored to the pane's bottom-left (the chosen
      // design), not the top-right stack. Focuses the pane, then toggles
      // dictation there.
      if (this.cb.onDictationToggle && t.kind === "claude") {
        ensureDictationFab(wrapper, {
          icon: iconMic,
          onToggle: () => {
            this.focusLeaf(leaf.id);
            this.cb.onDictationToggle?.(t.paneId, leaf.id);
          },
        });
      }
      view.terminals.set(t.id, {
        kind: "terminal",
        tab: t,
        term,
        wrapper,
        wasAtBottom: true,
        viewportOffsetFromBottom: 0,
        pendingFrame: null,
      });
    }

    // Show active, hide others. Fix for #93: capture `wasAtBottom`
    // at hide-time so we know, on re-show, whether the pane was
    // live-tailing (snap to bottom after refit) or the user had
    // scrolled up to read history (leave scroll offset alone). The
    // symptom this addresses: PTY output streams into the xterm
    // buffer of a hidden pane, viewport stays pinned to the last
    // visible row, and `refit()` alone doesn't correct it — the
    // user saw "pinned above the tail until first keystroke".
    //
    // Fix for #104: restore-on-show must fire ONLY on the
    // hidden→active edge, not on every refresh pass. Earlier code
    // snapped scroll to bottom every time `syncLeafView` ran with
    // the pane already active — so a user who'd scrolled up to read
    // history got yanked to tail on any `layout.refresh()` trigger
    // (stoplight change, PTY output in a sibling pane, etc.). Gating
    // on `wasHidden` confines the behaviour to the first paint after
    // a hide, matching the original #93 intent.
    //
    // Fix for #187: also capture the partial-scroll offset
    // (`baseY - viewportY`) on the same active→hidden edge. The
    // boolean-only snapshot collapsed every non-tail viewport down to
    // "leave alone", which left users at an arbitrary intermediate
    // position after a tab round-trip — the first keystroke then
    // snapped to baseY via xterm's scroll-on-input behaviour. We
    // restore the offset relative to the *post-refit* baseY so output
    // accumulated while the pane was hidden cannot push the target
    // out of bounds (the restore call clamps internally). Heeds the
    // An earlier release: revert: capture only on the genuine active→hidden edge,
    // never on subsequent refresh ticks while the pane stays hidden —
    // hidden xterm viewports go stale as buffers grow, so re-reading
    // them mid-hide produces nonsense.
    //
    // Codex adversarial-review fix (#187 round 2): the capture path is
    // also unsafe between a hidden→active edge and the rAF that runs
    // refit() for it. xterm-internal `viewportY` / `baseY` haven't yet
    // been brought up to date — but the pane is now visible, so a
    // subsequent active→hidden in the same syncLeafView (or a nearby
    // one before rAF flushes) would happily overwrite the
    // previously-correct stored values with stale reads. Gate the
    // capture on `pendingFrame === null` so the read is only allowed
    // once xterm has had a chance to settle. Cancel-prior + reset the
    // sentinel at the top of the rAF callback to keep the gate honest.
    //
    // Round 3 narrowing: only TRACK pendingFrame for hidden→active
    // restores. Active-stay-active refresh ticks (sibling output,
    // stoplight change, etc.) also rAF a refit, but xterm there is
    // already current — the rAF is just a layout sync. If we set
    // pendingFrame on every refresh, a user who scrolls, then sees a
    // refresh tick, then switches away before the rAF flushes, would
    // have their capture suppressed by the (irrelevant) refresh-tick
    // sentinel and lose their scroll position on the round-trip.
    for (const [tabId, record] of view.terminals) {
      const isActive = tabId === leaf.activeTabId;
      const wasHidden = record.wrapper.classList.contains("hidden");
      // Placeholder records  don't have a TerminalPane to
      // capture/restore scroll state from, so the wasAtBottom dance is
      // confined to the terminal branch.
      if (record.kind === "terminal") {
        if (!isActive && !wasHidden && record.pendingFrame === null) {
          // active → hidden transition with no restore-rAF in flight:
          // xterm is current, so the read is meaningful. Remember
          // current tail state + partial-scroll offset.
          record.wasAtBottom = record.term.isAtBottom();
          record.viewportOffsetFromBottom = record.wasAtBottom
            ? 0
            : record.term.getViewportOffsetFromBottom();
        }
      }
      record.wrapper.classList.toggle("hidden", !isActive);
      if (isActive && record.kind === "terminal") {
        const wasAtBottom = record.wasAtBottom;
        const offset = record.viewportOffsetFromBottom;
        if (wasHidden) {
          // hidden → active edge: refit + restore. Track this rAF with
          // pendingFrame so a hide-before-flush race correctly
          // suppresses re-capture from stale xterm state. Cancel any
          // prior in-flight restore for this record so a fast
          // hidden→active→hidden→active churn doesn't queue obsolete
          // callbacks.
          if (record.pendingFrame !== null) {
            cancelAnimationFrame(record.pendingFrame);
            record.pendingFrame = null;
          }
          record.pendingFrame = requestAnimationFrame(() => {
            // Clear the sentinel FIRST so the gate above resolves
            // correctly even if the body throws — a thrown refit()
            // must not strand the record in a "pending forever" state.
            record.pendingFrame = null;
            // refit() must run BEFORE the restore — a resize can
            // change baseY, and the offset restore needs the
            // post-refit value to remain visually anchored.
            record.term.refit();
            if (wasAtBottom) {
              record.term.scrollToBottom();
            } else if (offset > 0) {
              record.term.restoreViewportOffsetFromBottom(offset);
            }
          });
        } else {
          // active → active refresh tick: just refit. xterm is
          // current; we deliberately do NOT touch pendingFrame so the
          // capture-gate stays open for any active→hidden transition
          // that may follow before this rAF fires.
          requestAnimationFrame(() => {
            record.term.refit();
          });
        }
      }
    }

    // Render tab bar
    this.renderTabBar(leaf, view);
  }

  private renderTabBar(leaf: LeafNode, view: LeafView) {
    view.tabBarEl.innerHTML = "";
    for (const t of leaf.tabs) {
      const tabEl = document.createElement("div");
      tabEl.className = "tab" + (t.id === leaf.activeTabId ? " active" : "");
      tabEl.setAttribute("data-tab-id", t.id);
      const dotEl = document.createElement("span");
      const sl = this.cb.getStoplight(t.paneId);
      dotEl.className = `tab-dot ${sl}`;
      // Hybrid-mode host badge (rev 3.1, phase 10). Only rendered on
      // local tabs \u2014 station is the visual default, absence of badge
      // implicitly marks it. Keeps single-host setups looking the same
      // and makes local panes scannable at a glance in a hybrid layout.
      let hostBadgeEl: HTMLElement | null = null;
      if (t.host === "local") {
        hostBadgeEl = document.createElement("span");
        hostBadgeEl.className = "tab-host-badge local";
        hostBadgeEl.textContent = "L";
        hostBadgeEl.title = "Running on local daemon";
      }
      const titleEl = document.createElement("span");
      titleEl.className = "tab-title";
      titleEl.textContent = t.title;
      if (t.tooltip) titleEl.title = t.tooltip;
      const closeEl = document.createElement("span");
      closeEl.className = "tab-close";
      closeEl.title = "Close tab";
      closeEl.textContent = "\u00d7";
      // Close on pointerdown, NOT click: the first click also flips the
      // pane's stoplight dot (a mouse-tracking TUI like codex/Claude going
      // green\u2192grey), and rendering that change rebuilds the whole tab \u2014 so
      // the mouseup/click lands on a freshly-created \u2715 and no `click` ever
      // fires (the first click gets "eaten"; only the second works). Firing
      // on pointerdown lands the close before that re-render churn \u2014 the same
      // reason the rename gesture is re-render-resilient (see titleEl below).
      closeEl.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.cb.isRestoring?.()) return;
        this.cb.onCloseTab(leaf.id, t.id);
      });
      tabEl.appendChild(dotEl);
      if (hostBadgeEl) tabEl.appendChild(hostBadgeEl);
      tabEl.appendChild(titleEl);
      // (Per-tab usage badge removed — it cluttered every tab and repeated
      // the account-level 5h quota on each one. Usage data still collects
      // in the background; a proper usage view is a separate later pass.)
      tabEl.appendChild(closeEl);

      tabEl.addEventListener("mousedown", (e) => e.stopPropagation());

      tabEl.draggable = true;
      tabEl.addEventListener("dragstart", (e) => {
        // An earlier release: refuse to begin a drag during selectProject's retry
        // window. Without this the visual move/reorder lands and is
        // then silently reverted by the post-retry reconcile. Killing
        // the gesture at dragstart also means the per-tab drop handler
        // below sees `draggedTab === null` and short-circuits, so we
        // don't need a second gate there.
        if (this.cb.isRestoring?.()) {
          e.preventDefault();
          return;
        }
        PaneLayout.draggedTab = { leafId: leaf.id, tabId: t.id };
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", t.id);
        }
        tabEl.classList.add("dragging");
      });
      tabEl.addEventListener("dragover", (e) => {
        const dragged = PaneLayout.draggedTab;
        if (!dragged) return;
        // Dropping a tab onto itself is a no-op; skip the indicator.
        if (dragged.leafId === leaf.id && dragged.tabId === t.id) return;
        // an earlier release: detached tabs are not drop targets. Bail before
        // preventDefault so the drop falls through to the tab-bar
        // fallback (which itself refuses if the *dragged* tab is
        // detached).
        if (this.isDetached(t.paneId)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = tabEl.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        tabEl.classList.toggle("drop-before", before);
        tabEl.classList.toggle("drop-after", !before);
      });
      tabEl.addEventListener("dragleave", () => {
        tabEl.classList.remove("drop-before", "drop-after");
      });
      tabEl.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const dragged = PaneLayout.draggedTab;
        tabEl.classList.remove("drop-before", "drop-after");
        if (!dragged) return;
        if (dragged.leafId === leaf.id && dragged.tabId === t.id) return;
        // an earlier release: refuse drops onto detached tabs (same as the
        // dragover gate above) AND drops where the dragged tab itself
        // is detached. The dragover guard skips preventDefault so the
        // browser usually never delivers a drop here, but native drag
        // semantics aren't guaranteed across platforms — belt-and-
        // braces with an explicit check.
        if (this.isDetached(t.paneId)) return;
        const draggedTab = leaf.tabs.find((x) => x.id === dragged.tabId)
          ?? findLeaf(this.tree, dragged.leafId)?.tabs.find((x) => x.id === dragged.tabId);
        if (draggedTab && this.isDetached(draggedTab.paneId)) return;
        const rect = tabEl.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        if (dragged.leafId === leaf.id) {
          // Same-leaf reorder: reuse the existing computeReorder path so
          // the index math matches what it was before Scope C.
          const currentIds = leaf.tabs.map((x) => x.id);
          const newIds = computeReorder(currentIds, dragged.tabId, t.id, before ? "before" : "after");
          const newIndex = newIds.indexOf(dragged.tabId);
          this.cb.onReorderTab(leaf.id, dragged.tabId, newIndex);
        } else {
          // Cross-leaf move: targetIndex is the position in target leaf's
          // tabs where the moved tab should land (the source tab isn't in
          // that list, so no subtraction needed).
          const targetIdx = leaf.tabs.findIndex((x) => x.id === t.id);
          const insertIdx = before ? targetIdx : targetIdx + 1;
          this.cb.onMoveTab(dragged.leafId, dragged.tabId, leaf.id, insertIdx);
        }
      });
      tabEl.addEventListener("dragend", () => {
        PaneLayout.draggedTab = null;
        tabEl.classList.remove("dragging");
        view.tabBarEl
          .querySelectorAll<HTMLElement>(".tab")
          .forEach((el) => el.classList.remove("drop-before", "drop-after"));
        // an earlier release: a cancelled drag (Esc key, drop outside any
        // target) leaves no `drop` / `dragleave` event behind to clear
        // the split-button highlight. Sweep every split button across
        // the entire layout (a drag may have hovered split buttons
        // belonging to other leaves than the source). Cheap — at most
        // a handful of buttons in any realistic layout.
        this.cb.root
          .querySelectorAll<HTMLElement>(".split-button-drop-target")
          .forEach((el) => el.classList.remove("split-button-drop-target"));
      });

      // Detect double-click on the title via timing on tabId (resilient to DOM re-render).
      titleEl.addEventListener("mousedown", (e) => {
        const now = Date.now();
        if (PaneLayout.lastTitleDownTabId === t.id && now - PaneLayout.lastTitleDownTs < 320) {
          // Treat as rename gesture.
          e.preventDefault();
          e.stopPropagation();
          PaneLayout.lastTitleDownTabId = null;
          PaneLayout.lastTitleDownTs = 0;
          queueMicrotask(() => {
            const liveTitle =
              this.cb.root.querySelector<HTMLElement>(`.tab[data-tab-id="${t.id}"] .tab-title`) ?? titleEl;
            this.startTabRename(t.id, liveTitle);
          });
          return;
        }
        PaneLayout.lastTitleDownTabId = t.id;
        PaneLayout.lastTitleDownTs = now;
      });

      tabEl.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        // An earlier release: every branch below mutates the layout tree (close edits
        // tab list, switch edits activeTabId — both round-trip through
        // setTree → onTreeChange → reconcile-revert during retry).
        // Block at the top so the click is a no-op end-to-end while
        // restoring. The CSS overlay tells the user why.
        if (this.cb.isRestoring?.()) {
          e.stopPropagation();
          return;
        }
        if (target === closeEl) {
          // Close already fired on pointerdown (above), which survives the
          // stoplight-driven tab re-render that a trailing `click` doesn't.
          // Swallow this click so it neither double-closes nor falls through
          // to onSwitchTab.
          e.stopPropagation();
          return;
        }
        if (target.isContentEditable) return;
        this.cb.onSwitchTab(leaf.id, t.id);
      });
      view.tabBarEl.appendChild(tabEl);
    }
    const plus = document.createElement("button");
    plus.className = "tab-new";
    plus.title = "New tab (⌘T)";
    plus.textContent = "+";
    plus.addEventListener("mousedown", (e) => e.stopPropagation());
    plus.addEventListener("click", () => this.cb.onNewTab(leaf.id));
    view.tabBarEl.appendChild(plus);

    // Right-side pane-box actions. an earlier release: the Detach button is
    // rendered only when the host wired `onDetachPane` (Satellite does;
    // legacy / test consumers omit it and don't see the action). It
    // detaches the leaf's currently-active tab — that's the pane the
    // user is looking at, so the gesture matches the per-pane mental
    // model. Disabled when the active tab is itself already detached.
    const actions = document.createElement("div");
    actions.className = "tab-actions";
    const activeTab = leaf.tabs.find((x) => x.id === leaf.activeTabId) ?? leaf.tabs[0] ?? null;
    const activeIsDetached = !!activeTab && this.isDetached(activeTab.paneId);
    let detachButtonHtml = "";
    if (this.cb.onDetachPane && activeTab) {
      const disabledAttr = activeIsDetached ? " disabled" : "";
      const title = activeIsDetached
        ? "Pane is already detached"
        : "Detach pane to its own window (⌘⇧O)";
      detachButtonHtml = `<button class="icon-btn" data-act="detach" title="${title}"${disabledAttr}>${iconDetach}</button>`;
    }
    // "History" (#51) now lives in the pane's top-right control stack (created
    // per Claude pane above), not the tab bar — see ensureHistoryButton.
    actions.innerHTML = `
      ${detachButtonHtml}
      <button class="icon-btn" data-act="split-right" title="Split right (⌘D)">${iconSplitRight}</button>
      <button class="icon-btn" data-act="split-down" title="Split down (⌘⇧D)">${iconSplitDown}</button>
      <button class="icon-btn" data-act="close-leaf" title="Close pane-box">${iconClose}</button>
    `;
    actions.addEventListener("mousedown", (e) => e.stopPropagation());
    actions.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.getAttribute("data-act");
        if (act === "detach") {
          if (activeTab && !activeIsDetached) {
            this.cb.onDetachPane?.(activeTab.paneId, leaf.id);
          }
          return;
        }
        if (act === "split-right") this.cb.onSplitRight(leaf.id);
        else if (act === "split-down") this.cb.onSplitDown(leaf.id);
        else if (act === "close-leaf") this.cb.onCloseLeaf(leaf.id);
      });

      // an earlier release: drag-tab-onto-split-button gesture. Wire only on
      // the two split icon buttons. While a tab drag is in flight,
      // hovering one of these buttons highlights it as a drop target;
      // dropping moves the dragged tab into a new split alongside this
      // leaf without showing the kind picker. dragleave fires on every
      // child-boundary crossing — the split-button SVG icons set
      // `pointer-events: none` in CSS so the leave event is fired only
      // when the pointer truly leaves the button rectangle. The
      // dragend handler on the source tab clears any stuck highlight
      // (cancelled drag, drop outside any target).
      const act = btn.getAttribute("data-act");
      if (act !== "split-right" && act !== "split-down") return;
      const dir: "vertical" | "horizontal" = act === "split-right" ? "vertical" : "horizontal";
      btn.addEventListener("dragover", (e) => {
        const dragged = PaneLayout.draggedTab;
        if (!dragged) return;
        // Edge case: same leaf, dragged tab is the only tab → drop
        // would split-and-move-from-empty-leaf, which collapses on
        // closeTab and yields no split. Refuse so the user gets a
        // clear non-target signal.
        if (dragged.leafId === leaf.id) {
          const draggedLeaf = findLeaf(this.tree, dragged.leafId);
          if (draggedLeaf && draggedLeaf.tabs.length === 1) return;
        }
        // an earlier release / Codex review: refuse drops where the dragged
        // tab itself is detached. The terminal lives in a popout
        // window; moving the tab into a new split would re-home the
        // tab in the layout tree but leave the popup still owning the
        // terminal — state divergence. Mirrors the existing tab and
        // tab-bar drop guards. Bail before preventDefault so the
        // browser draws the standard "no-drop" cursor.
        const draggedTab = findLeaf(this.tree, dragged.leafId)?.tabs.find(
          (x) => x.id === dragged.tabId,
        );
        if (draggedTab && this.isDetached(draggedTab.paneId)) return;
        // Don't allow split-with-tab when no callback was wired — the
        // drop would be a no-op. Letting dragover prevent default
        // would also keep the highlight stuck since drop never fires
        // a meaningful action.
        if (!this.cb.onSplitWithTab) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        btn.classList.add("split-button-drop-target");
      });
      btn.addEventListener("dragleave", () => {
        btn.classList.remove("split-button-drop-target");
      });
      btn.addEventListener("drop", (e) => {
        const dragged = PaneLayout.draggedTab;
        btn.classList.remove("split-button-drop-target");
        if (!dragged) return;
        e.preventDefault();
        e.stopPropagation();
        // Re-check the same edge case as dragover. The dragover guard
        // already short-circuits in this case (no preventDefault), so
        // most browsers won't deliver the drop here, but native drag
        // semantics aren't guaranteed across platforms — belt-and-
        // braces with an explicit check.
        if (dragged.leafId === leaf.id) {
          const draggedLeaf = findLeaf(this.tree, dragged.leafId);
          if (draggedLeaf && draggedLeaf.tabs.length === 1) return;
        }
        // Same belt-and-braces detached-tab rejection as in dragover.
        const draggedTab = findLeaf(this.tree, dragged.leafId)?.tabs.find(
          (x) => x.id === dragged.tabId,
        );
        if (draggedTab && this.isDetached(draggedTab.paneId)) return;
        // Codex review: the boot.ts callback synchronously mutates the
        // layout tree (splitLeaf + closeTab + setTree), which can
        // replace the source tab DOM element BEFORE the browser
        // delivers `dragend` to it. If that happens, the dragend
        // listener never fires and `PaneLayout.draggedTab` stays
        // non-null + any `.split-button-drop-target` highlights on
        // OTHER leaves' split buttons stick. Do full DnD cleanup here
        // BEFORE invoking the callback — fail-closed for the
        // synchronous-mutation case. The dragend sweep stays as
        // belt-and-braces for cancelled drags (Esc, drop outside any
        // target).
        PaneLayout.draggedTab = null;
        this.cb.root
          .querySelectorAll<HTMLElement>(".split-button-drop-target")
          .forEach((el) => el.classList.remove("split-button-drop-target"));
        this.cb.onSplitWithTab?.(leaf.id, dragged.leafId, dragged.tabId, dir);
      });
    });
    view.tabBarEl.appendChild(actions);
  }

  private startTabRename(tabId: string, titleEl: HTMLElement) {
    const original = titleEl.textContent ?? "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tab-title-edit";
    input.value = original;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const finish = (commit: boolean) => {
      input.removeEventListener("keydown", onKey);
      input.removeEventListener("blur", onBlur);
      const next = input.value.trim();
      const newTitle = document.createElement("span");
      newTitle.className = "tab-title";
      newTitle.textContent = commit && next && next !== original ? next : original;
      newTitle.addEventListener("mousedown", (e) => {
        const now = Date.now();
        if (PaneLayout.lastTitleDownTabId === tabId && now - PaneLayout.lastTitleDownTs < 320) {
          e.preventDefault();
          e.stopPropagation();
          PaneLayout.lastTitleDownTabId = null;
          PaneLayout.lastTitleDownTs = 0;
          queueMicrotask(() => {
            const liveTitle =
              this.cb.root.querySelector<HTMLElement>(`.tab[data-tab-id="${tabId}"] .tab-title`) ?? newTitle;
            this.startTabRename(tabId, liveTitle);
          });
          return;
        }
        PaneLayout.lastTitleDownTabId = tabId;
        PaneLayout.lastTitleDownTs = now;
      });
      input.replaceWith(newTitle);
      if (commit && next && next !== original) {
        this.cb.onRenameTab(tabId, next);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      e.stopPropagation();
    };
    const onBlur = () => finish(true);
    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", onBlur);
  }

  private refitAllActiveTerminals(pinToBottom: boolean): boolean {
    if (!this.tree) return true;
    let allLaidOut = true;
    for (const leaf of allLeaves(this.tree)) {
      const view = this.views.get(leaf.id);
      const record = view?.terminals.get(leaf.activeTabId);
      if (!record || record.kind !== "terminal") continue;
      // Fix for #93 (window-focus / visibilitychange branch): sample
      // the tail state BEFORE refit() so a layout-driven dimension
      // change can't smear the baseline. Conditionally scroll after
      // so a user who scrolled up to read history isn't yanked
      // back to the tail on Alt-Tab.
      const wasAtBottom = record.term.isAtBottom();
      if (!record.term.refit()) allLaidOut = false;
      if (pinToBottom) {
        // Project-switch path: a real scroll gesture that lands at the
        // tail, repainting a freshly remounted (possibly blank) viewport.
        record.term.nudgeScrollToBottom();
      } else if (wasAtBottom) {
        record.term.scrollToBottom();
      }
    }
    return allLaidOut;
  }

  /**
   * Re-fit every visible pane and re-send its geometry to the PTY. Used
   * by the boot wiring on window focus: a phone client may have resized
   * the shared PTY while the desktop was in the background, so on refocus
   * the desktop reasserts its own dimensions. Returns false when any
   * pane skipped its fit because the container wasn't laid out yet —
   * the project-switch path uses that to schedule a one-shot retry (and
   * passes pinToBottom so remounted panes end scrolled to the tail).
   */
  refitActive(opts?: { pinToBottom?: boolean }): boolean {
    return this.refitAllActiveTerminals(opts?.pinToBottom === true);
  }

  private updateActiveClasses() {
    for (const [leafId, view] of this.views) {
      view.el.classList.toggle("active", leafId === this.activeLeafId);
    }
  }

  dispose() {
    // Tear down hover-focus globals (mouse/window listeners, body
    // MutationObserver) before the pane tree is gone — otherwise a
    // delayed dwell could fire on a leaf whose view we've already
    // disposed. See an earlier release 3e.
    this.cb.hoverFocus?.detach();
    for (const view of this.views.values()) {
      for (const record of view.terminals.values()) {
        if (record.kind === "terminal") record.term.dispose();
      }
      view.el.remove();
    }
    this.views.clear();
    this.resizeObserver?.disconnect();
  }

  hasLeafs(): boolean { return !!this.tree && allLeaves(this.tree).length > 0; }
  containsLeaf(leafId: string): boolean { return !!findLeaf(this.tree, leafId); }

  /**
   * Look up the active tab's bounding rect inside this layout. Returned
   * coords are window-relative (`getBoundingClientRect`). Used by the
   * Detach gesture to size the popout window to the slot the pane is
   * leaving so it materialises at the same visual area on screen.
   * Returns `null` when there's no active leaf, no active tab, or the
   * leaf's wrapper element isn't laid out yet.
   */
  getActiveLeafRect(): DOMRect | null {
    if (!this.activeLeafId) return null;
    const view = this.views.get(this.activeLeafId);
    if (!view) return null;
    return view.el.getBoundingClientRect();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
