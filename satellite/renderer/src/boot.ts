import { HttpError } from "@client-core/api/client";
import { registerDictationSelfTest } from "./transcription/selfTest";
import { describeError } from "./daemon/connection";
import type { ConnectionInfo } from "./daemon/connection";
import { decidePollFailureAction } from "./daemon/poll-failure-policy";
import {
  connectionForHost,
  enabledHosts,
  initConnectionsForHost,
  isHostReady,
  setHostReady,
  subscribeHostReady,
  setHostCodexAvailable,
  isHostCodexAvailable,
} from "./daemon/connection-for-host";
import {
  makePushState,
  pushStationProjectsToLocal as runProjectPush,
  type PushState,
} from "./project-push";
import { MountHint } from "./daemon/mount-hint";
import { ProjectRefresher } from "./daemon/project-refresh";
import { RemountCoordinator } from "./daemon/remount-coordinator";
import { tokenizeClaudeArgs } from "@client-core/launch-args/tokenize";
import { promptForToken } from "./ui/update-token-dialog";
import {
  apiForHost,
  initApiForHost,
  refreshLocalDaemonToken,
  setApiTokenForHost,
} from "./api-for-host";
import type { HostRef } from "./host";
import { promptForClaudeLaunchArgs } from "./ui/claude-launch-dialog";
import { Rail } from "./ui/rail";
import { effectiveStoplight as filterEffectiveStoplight } from "./ui/effective-stoplight";
import { AppBar, type Theme } from "./ui/app-bar";
import { openUsageOverlay } from "./ui/usage-view";
import { PaneLayout } from "./ui/pane-layout";
import { installPathLinkProvider } from "./viewer/PathLinkProvider";
import { installUrlLinkProvider } from "./viewer/UrlLinkProvider";
import { ensurePaneControls } from "./ui/paneControls";
import { resolveActivatePath } from "./viewer/resolveActivatePath";
import {
  setExtensionlessAllowlist,
  SEEDED_EXTENSIONLESS_FILENAMES,
} from "./viewer/LinkDetector";
import { HoverFocusController } from "./ui/hover-focus-controller";
import { StatusBar } from "./ui/status-bar";
import { deriveConnectionReason, type TailscaleVerdict } from "./ui/connection-reason";
import {
  askPaneKind,
  confirmDialog,
  pickSession,
} from "./ui/new-pane-dialog";
import { codexUnavailableMessage } from "./ui/codex-availability";
import { showToast } from "./viewer/Toast";
import { installShortcuts } from "./ui/shortcuts";
import { renderSettings } from "./ui/settings-view";
import { addProjectFlow } from "./ui/add-project-dialog";
import { confirmDeleteProject } from "./ui/delete-project-dialog";
import { confirmRestoreProject } from "./ui/confirm-restore-dialog";
import { initTts, type TtsHandle } from "./tts/initTts";
import { initTranscription, type TranscriptionHandle } from "./transcription/initTranscription";
import { TerminalPaneAdapter } from "./tts/TerminalPaneAdapter";
import { initSearch } from "./search/initSearch";
import { TerminalSearchAdapter } from "./search/TerminalSearchAdapter";
import { MarkdownSearchAdapter } from "./search/MarkdownSearchAdapter";
import {
  createOverlayScrollbar,
  type OverlayScrollbar,
} from "./search/OverlayScrollbar";
import { terminalScrollSurface } from "./search/scrollSurfaces";
import { createTranscriptController } from "./transcript/TranscriptController";
import type { TerminalPane } from "@client-core/terminal/terminal-pane";
import {
  addTab,
  allLeaves,
  allPaneIds,
  allTabs,
  closeLeaf,
  closeTab,
  isValidTreeNode,
  moveTab,
  findLeaf,
  findTab,
  leafWithTab,
  renameTab,
  reorderTab,
  splitLeaf,
  switchTab,
  tab,
  type TreeNode,
} from "./layout/split-tree";
import {
  countMatchingIdentities,
  countSavedIdentityTabsInReachableHosts,
  reconcile,
} from "./layout/reconcile";
import { SelectSequence, fetchSequenced } from "./select-project";
import {
  applyProjectOrder,
  primaryHost as resolvePrimaryHost,
  loadClaudeLaunchArgs,
  loadClaudeLaunchArgsByProject,
  loadHoverToFocus,
  loadLinkifierAllowlist,
  saveLinkifierAllowlist,
  loadLayouts,
  loadProjectNameOverrides,
  loadProjectOrder,
  loadRailMode,
  loadRailWidth,
  loadRailWiggle,
  loadDropPromptTemplate,
  loadDragDropAllowlist,
  DEFAULT_DRAGDROP_EXTENSIONS,
  DRAGDROP_MAX_BYTES,
  loadSettings,
  loadTheme,
  resolveActiveUrl,
  resolveClaudeLaunchArgs,
  resolveEffectiveReckConnectPrompt,
  saveClaudeLaunchArgs,
  saveClaudeLaunchArgsForProject,
  saveLayout,
  saveProjectNameOverride,
  saveProjectOrder,
  saveRailMode,
  saveRailWidth,
  saveStationToken,
  saveTheme,
  type RailMode,
} from "./config";
import {
  RAIL_COLLAPSE_AT,
  RAIL_MAX,
  RAIL_MINI,
  createWidthAnimator,
  railDragDecision,
  railDragRelease,
} from "./ui/rail-collapse";
import type { Pane, PaneKind, PaneUsage, Project, Stoplight } from "@proto/proto";
import { mergeHybridProjects } from "./hybrid-merge";
import type { StartupSplashController } from "./ui/startup-splash";

const POLL_INTERVAL_MS = 2000;

const RESTORING_OVERLAY_CLASS = "layout-restoring-overlay";

// Renders a splash-styled overlay while selectProject's cold-daemon
// retry loop runs. Mirrors the boot-splash markup so the in-pane wait
// reads as the same visual gesture as cold-start, not a different
// modal. The wrapper element is positioned absolutely inside
// layoutRoot; the inner card reuses the .boot-splash-* classes from
// styles.css so the dot morph, divider grow and shimmer animations
// all run here too.
function mountRestoringOverlay(root: HTMLElement): HTMLElement {
  const existing = root.querySelector<HTMLElement>(`.${RESTORING_OVERLAY_CLASS}`);
  if (existing) return existing;
  const el = document.createElement("div");
  el.className = RESTORING_OVERLAY_CLASS;
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `
    <div class="boot-splash-card">
      <div class="boot-splash-eyebrow">by Reckon Labs</div>
      <h1 class="boot-splash-wordmark">
        <span>Reck</span>
        <span class="boot-splash-dot" aria-hidden="true"></span>
        <span>Connect</span>
      </h1>
      <div class="boot-splash-divider"></div>
      <div class="boot-splash-step">
        <span class="boot-splash-step-label">Restoring layout</span><span class="boot-splash-step-ellipsis" aria-hidden="true"><i></i><i></i><i></i></span>
      </div>
      <div class="boot-splash-progress" role="progressbar" aria-label="Restoring layout">
        <div class="boot-splash-progress-fill"></div>
      </div>
    </div>
  `;
  root.appendChild(el);
  return el;
}

function unmountRestoringOverlay(root: HTMLElement) {
  root.querySelector(`.${RESTORING_OVERLAY_CLASS}`)?.remove();
}

export async function boot(splash?: StartupSplashController) {
  const app = document.getElementById("app")!;

  // Dictation diagnostics — harmless global hook used by the e2e-electron
  // dictation spec and by humans in DevTools (`reckDictationSelfTest.run()`).
  registerDictationSelfTest();

  // Theme: apply as early as possible to avoid flash. The <html>
  // data-theme attribute also lets the boot splash pick the right
  // background (the inline block in index.html keys off it).
  let theme: Theme = await loadTheme();
  document.documentElement.setAttribute("data-theme", theme);

  // Hydrate the linkifier's extensionless-filename allowlist from persisted
  // config. First run (no list yet) seeds the documented defaults and
  // persists them immediately so the Preferences UI can show them as chips.
  // Later runs honour the persisted list — even when empty, which signals
  // the user emptied it on purpose.
  {
    const persisted = await loadLinkifierAllowlist();
    if (persisted === null) {
      await saveLinkifierAllowlist(SEEDED_EXTENSIONLESS_FILENAMES);
      setExtensionlessAllowlist(SEEDED_EXTENSIONLESS_FILENAMES);
    } else {
      setExtensionlessAllowlist(persisted);
    }
  }

  const settings = await loadSettings();
  // No settings file → render Preferences. an earlier release made local always
  // available, so a non-null `settings` always resolves a usable URL
  // (resolveActiveUrl returns the local URL when station is disabled);
  // the old `!maybeUrl` guard is collapsed.
  if (!settings) {
    splash?.markFirstLaunch();
    await splash?.dismiss();
    await renderSettings(app, () => window.location.reload());
    return;
  }

  // Primary host resolved; surface "Connecting to station" (or "local")
  // copy while the API clients init and the first probe runs.
  splash?.step(resolvePrimaryHost(settings) === "station" ? "station" : "local");
  // Phase 5 (an earlier release, plan rev 3.1): autoStart-gated early local
  // daemon spawn. The main process's `whenReady` startup also tries
  // this on boot — issuing it here too is idempotent (the spawn map
  // short-circuits when the child is already alive) and covers the
  // "user changed port via Preferences, reloaded" path without an
  // Electron restart. an earlier release: local is always enabled now, so the
  // gate is just `autoStart` (not `enabled && autoStart`).
  //
  // Failure is captured into `localStartError` and surfaced via the
  // status bar later; we do NOT throw, because a station-primary setup
  // can still come up cleanly even when the local spawn fails.
  let localStartError: { reason: string; code?: string } | null = null;
  if (settings.local?.autoStart) {
    const result = await window.reckAPI.daemon.start("local");
    if (!result.ok) {
      localStartError = { reason: result.reason, code: result.code };
      console.error(
        `[boot] local daemon start failed (code=${result.code ?? "?"}): ${result.reason}`,
      );
    }
  }
  // Note: localStartError is captured for future status-bar surfacing
  // (Phase 11 widens the status bar to display per-host state). For
  // now the connection-poll's CONN dot signals unreachability; this
  // typed reason is here so a future surface can show "port-bind
  // failure: another process is using 7315" rather than just "down".
  void localStartError;
  // Narrow to non-null for closures (e.g. requestTokenUpdate, renderStatus
  // below); a `let` in the outer scope wouldn't survive the function
  // boundary's control-flow narrowing. Falls back to "" only on the
  // theoretical post-rollout path where station has no URL and local
  // somehow has no port — both are guaranteed by loadSettings, so the
  // fallback is just type insurance.
  const activeUrl: string = resolveActiveUrl(settings) ?? "";
  const primaryHost = resolvePrimaryHost(settings);

  // Hybrid mode (an earlier release, plan rev 3.1, Phase 3): the per-host
  // ApiClient registry replaces the single inline construction. Boot
  // initialises the registry once with the loaded settings; later
  // call sites either go through `apiForHost(tab.host)` (for paths
  // that know the host) or through `client` (the active-host alias
  // we keep below for the ~30 call sites still pinned to "the active
  // daemon" — Phase 4+ will split them piecewise).
  initApiForHost(settings);
  // Phase 5: pull the local daemon's per-spawn random token from the
  // Electron main process and apply it to the local ApiClient. The
  // IPC returns null when the daemon isn't running yet (e.g.
  // autoStart=false, or spawn failed) and `refreshLocalDaemonToken`
  // clears the token so the first request fails cleanly rather than
  // racing a stale value. an earlier release: local is always enabled, so the
  // refresh runs unconditionally — a successfully-running daemon
  // gives us a token, an absent one wipes the cached value either way.
  // This needs to run *before* any local connection probe / pane WS
  // open, otherwise the daemon would 401 on a no-bearer request and
  // the renderer would log a spurious recovery loop.
  try {
    await refreshLocalDaemonToken();
  } catch (e) {
    console.warn("[boot] failed to fetch local daemon token", e);
  }
  const client = apiForHost(primaryHost);

  app.innerHTML = `
    <div class="app-shell">
      <div id="nav-root"></div>
      <div class="app-main" id="app-main">
        <div class="rail" id="rail"></div>
        <div class="rail-resize" id="rail-resize"></div>
        <div class="right-pane" id="right-pane">
          <div class="pane-layout" id="pane-layout"></div>
        </div>
      </div>
      <div class="status-bar" id="status-bar"></div>
    </div>
  `;

  const navRoot = document.getElementById("nav-root")!;
  const appMain = document.getElementById("app-main") as HTMLElement;
  const railResizeEl = document.getElementById("rail-resize") as HTMLElement;
  const layoutRoot = document.getElementById("pane-layout")!;
  const statusRoot = document.getElementById("status-bar")!;
  const rightPane = document.getElementById("right-pane")!;

  // A pointerdown anywhere inside the project's content area counts as
  // "I saw it" — acknowledges the unseen-green flag on both the project
  // rail and the currently-active tab. Other tabs in the project (not
  // the one the user is looking at) keep their green dots until the
  // user actually switches to them.
  rightPane.addEventListener("pointerdown", () => {
    if (!currentProjectId) return;
    const activeLeaf = layout.getActiveLeafId();
    const activeTab = activeLeaf ? layout.getActiveTabForLeaf(activeLeaf) : null;
    acknowledgeSeen(currentProjectId, activeTab?.paneId);
  });

  rightPane.addEventListener("keydown", () => {
    if (!currentProjectId) return;
    const activeLeaf = layout.getActiveLeafId();
    const activeTab = activeLeaf ? layout.getActiveTabForLeaf(activeLeaf) : null;
    acknowledgeSeen(currentProjectId, activeTab?.paneId);
  });

  // --- Rail collapse (expanded ⟷ mini) --------------------------------
  // The 48px mini rail is the ONLY collapsed state — the rail is never
  // fully hidden. RAIL_MAX (240) is both the default and the maximum
  // width. Mode + expanded width persist independently so the rail
  // restores exactly as the user left it.
  const savedRailWidth = await loadRailWidth();
  const savedRailMode = await loadRailMode();
  const railWiggle = await loadRailWiggle();
  // Drop prompt template (mutable — a Preferences save updates this in
  // place so newly-created panes pick it up without a reload).
  let dropPromptTemplate = await loadDropPromptTemplate();
  // Droppable-extensions allow-list (lowercase, no dot). Seeded on first
  // run. A Preferences save reloads the renderer, so a fresh Set is read
  // then; live panes use the snapshot captured here.
  const dragDropAllowlist = new Set(
    (await loadDragDropAllowlist()) ?? DEFAULT_DRAGDROP_EXTENSIONS,
  );
  const railEl = document.getElementById("rail")!;
  // Old configs could persist up to the removed 420px upper clamp; a
  // corrupted value must not feed NaN into the grid template.
  const savedWidthSafe = typeof savedRailWidth === "number" && Number.isFinite(savedRailWidth) ? savedRailWidth : RAIL_MAX;
  let railExpandedWidth = Math.max(RAIL_MINI, Math.min(RAIL_MAX, savedWidthSafe));
  let railMode: RailMode = savedRailMode;
  let railWidth = railMode === "mini" ? RAIL_MINI : railExpandedWidth;
  let railDragActive = false;
  applyGrid();

  function applyGrid() {
    appMain.style.gridTemplateColumns = `${railWidth}px 6px 1fr`;
  }

  // Shared rAF width animator: drives collapse/expand and the wiggle.
  // Every frame writes through the same path as a mouse drag (update
  // railWidth → applyGrid) so pane ResizeObservers see real grid
  // deltas rather than a CSS transition they'd sample late.
  const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const railAnimator = createWidthAnimator({
    getWidth: () => railWidth,
    onFrame: (w) => {
      railWidth = w;
      applyGrid();
    },
    reducedMotion: () => reducedMotionQuery?.matches === true,
  });

  const RAIL_SNAP_MS = 200;

  // Late-bound: `layout` is constructed further down, but the nav
  // rail-toggle is clickable as soon as the app bar mounts — during
  // boot's awaits a collapse could finish before `layout` exists (TDZ
  // on the const). Rebound to the real refit once PaneLayout is up.
  let refitActiveTerminals: () => void = () => {};

  function setRailMode(mode: RailMode) {
    if (railMode === mode) return;
    // The pointer owns the width while a divider drag is live — a
    // keyboard toggle mid-drag would race the mousemove writes.
    if (railDragActive) return;
    // A newer mode change is authoritative — a wiggle's delayed restore
    // must never stomp the width we're about to animate to.
    cancelWiggle(false);
    railMode = mode;
    void saveRailMode(mode);
    appBar.setRailExpanded(mode === "expanded");
    // The crossfade between rows and avatars is pure CSS, keyed off
    // .rail-mini (per-element opacity/visibility transitions in
    // styles.css) — outgoing content fades fast so the stoplight dots
    // never linger mid-flight at a wrong offset from the rail edge.
    rail.setMode(mode);
    // Spring both directions — collapse and expand share the same
    // bouncy pop, whichever trigger (button, chevron, keys, click).
    railAnimator.animateTo(mode === "mini" ? RAIL_MINI : railExpandedWidth, {
      durationMs: RAIL_SNAP_MS,
      easing: "spring",
      onDone: () => {
        refitActiveTerminals();
      },
    });
  }

  railResizeEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    // The drag owns the width now: settle any in-flight wiggle back to
    // its base and stop mode animations before sampling the start width.
    cancelWiggle(true);
    railAnimator.cancel();
    railDragActive = true;
    railResizeEl.classList.add("dragging");
    const startX = e.clientX;
    const startW = railWidth;
    const endDrag = () => {
      railDragActive = false;
      railResizeEl.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onMove = (ev: MouseEvent) => {
      const decision = railDragDecision(startW + (ev.clientX - startX), railMode === "mini");
      switch (decision.kind) {
        case "collapse":
          // The pointer travelled past the sticky zone — collapse
          // straight into mini mid-drag with a spring, ending the drag.
          endDrag();
          setRailMode("mini");
          break;
        case "stretch":
          // Elastic accidental-collapse guard: the rail trails the
          // pointer with damped rubber-band resistance, signalling
          // "keep pulling to collapse" instead of freezing solid.
          railExpandedWidth = RAIL_COLLAPSE_AT;
          railWidth = decision.width;
          applyGrid();
          break;
        case "expand":
          // Dragging the handle back out of mini re-expands at the
          // pointer position (no animation — the pointer is authoritative).
          railMode = "expanded";
          rail.setMode("expanded");
          appBar.setRailExpanded(true);
          void saveRailMode("expanded");
          railExpandedWidth = decision.width;
          railWidth = decision.width;
          applyGrid();
          break;
        case "resize":
          railExpandedWidth = decision.width;
          railWidth = decision.width;
          applyGrid();
          break;
        case "track":
          // Mini rail follows the pointer live; the release decides
          // whether the pull committed to an expand.
          railWidth = decision.width;
          applyGrid();
          break;
      }
    };
    const onUp = () => {
      endDrag();
      const release = railDragRelease(railWidth, railMode === "mini");
      switch (release.kind) {
        case "spring-expand":
          // A small outward pull means "expand": spring open from the
          // tracked width to the full expanded width.
          setRailMode("expanded");
          break;
        case "settle-mini":
          railAnimator.animateTo(RAIL_MINI, { durationMs: RAIL_SNAP_MS, easing: "spring" });
          break;
        case "bounce-back":
          // Released mid-stretch without committing the collapse — the
          // elastic snaps the rail back to the row minimum.
          railAnimator.animateTo(RAIL_COLLAPSE_AT, { durationMs: RAIL_SNAP_MS, easing: "spring" });
          void saveRailWidth(railExpandedWidth);
          break;
        case "stay":
          void saveRailWidth(railExpandedWidth);
          break;
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  railResizeEl.addEventListener("dblclick", () => {
    setRailMode(railMode === "mini" ? "expanded" : "mini");
  });

  function toggleRail() {
    setRailMode(railMode === "mini" ? "expanded" : "mini");
  }

  // --- Separator wiggle ------------------------------------------------
  // After a project switch the divider auto-nudges out and back through
  // the shared animator (railWidth → applyGrid each frame), then forces
  // a terminal refit — replacing the manual divider jiggle previously
  // needed to unstick a stale grid after a switch.
  let wiggleActive = false;
  let wiggleBase = 0;
  let wiggleRetryTimer: number | null = null;

  function cancelWiggle(restoreBase: boolean) {
    if (wiggleRetryTimer !== null) {
      window.clearTimeout(wiggleRetryTimer);
      wiggleRetryTimer = null;
    }
    if (!wiggleActive) return;
    wiggleActive = false;
    railAnimator.cancel();
    railResizeEl.classList.remove("dragging");
    if (restoreBase) {
      railWidth = wiggleBase;
      applyGrid();
    }
  }

  function wiggleSeparator(attempt = 0) {
    if (!railWiggle.enabled || wiggleActive || railDragActive) return;
    if (railAnimator.isAnimating()) {
      // A collapse/expand is mid-flight (e.g. a mini-avatar click just
      // expanded the rail) — retry once after it settles. Tracked so a
      // later drag or mode change can cancel the stale retry.
      if (attempt === 0 && wiggleRetryTimer === null) {
        wiggleRetryTimer = window.setTimeout(() => {
          wiggleRetryTimer = null;
          wiggleSeparator(1);
        }, RAIL_SNAP_MS + 40);
      }
      return;
    }
    wiggleActive = true;
    wiggleBase = railWidth;
    railResizeEl.classList.add("dragging");
    railAnimator.animateTo(wiggleBase + railWiggle.pixels, {
      durationMs: railWiggle.legMs,
      onDone: () => {
        if (!wiggleActive) return;
        railAnimator.animateTo(wiggleBase, {
          durationMs: railWiggle.legMs,
          onDone: () => {
            if (!wiggleActive) return;
            wiggleActive = false;
            railResizeEl.classList.remove("dragging");
            refitActiveTerminals();
          },
        });
      },
    });
  }

  function toggleTheme() {
    theme = theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    appBar.setTheme(theme);
    layout.setTheme(theme);
    void saveTheme(theme);
  }

  const appBar = new AppBar({
    root: navRoot,
    onToggleRail: () => toggleRail(),
    onToggleTheme: () => toggleTheme(),
    // Usage data lives in the primary host's daemon (the station's
    // SQLite store); the overlay fetches everything it needs itself.
    onOpenUsage: () => openUsageOverlay({ api: apiForHost(primaryHost) }),
  });
  appBar.setRailExpanded(railMode === "expanded");
  appBar.setTheme(theme);
  // propagate initial theme to the pane layout (for newly mounted terminals)
  // done after layout is constructed below

  const statusBar = new StatusBar({
    root: statusRoot,
    onRefresh: () => forceRefresh(),
  });
  statusBar.setMessage("Connecting…");

  let mountState: "green" | "yellow" | "gray" = "gray";
  // an earlier release: CONN-driven soft signal. In station mode a tailnet-level
  // CONN failure downgrades a stale-green mount to yellow immediately;
  // a successful CONN poll disarms it. See ./daemon/mount-hint.ts.
  const mountHint = new MountHint(primaryHost);

  let currentProjectId: string | null = null;
  // Sequencer for selectProject(): aborts the prior in-flight fetch on
  // any newer selection, and carries a monotonic token so stale
  // responses that complete before the abort lands are dropped. See
  // an earlier release Section 3 — without sequencing, rapid A-then-B switches
  // could leave A's tree visible under B's key and persist it under B.
  const selectSeq = new SelectSequence();
  // Set to the `mySeq` token of the active selectProject while it is
  // inside its retry budget. Consumed by `onTreeChange` to suppress
  // persistence during that window: the partial tree painted at
  // line 1135 is an incomplete projection (panes not yet restored
  // by the daemon), and letting user edits reach saveLayout() would
  // permanently drop the late-restored panes from disk. Seq-keyed
  // (not projectId-keyed) so a rapid A→B switch where A's finally
  // still runs after B's retry has started can't clobber B's guard.
  let activeRetrySeq: number | null = null;
  // True iff the current selection is inside its retry budget. Used
  // to gate pane-creation entry points (new-tab, split) — the
  // alternative (allow creation, then drop placement on reconcile)
  // produced a data-corruption path where the user's new pane got
  // re-appended to the first leaf when retry resolved . Close
  // / rename remain enabled; they're symmetrically reconciled (Pass 1
  // drops the identity) so there's no placement loss.
  function isRetrying(): boolean {
    return activeRetrySeq !== null && activeRetrySeq === selectSeq.current();
  }
  const savedLayouts = await loadLayouts();
  // Defensive sanitisation: a malformed `savedLayouts[projectId]`
  // (hand-edited config, schema drift, partial-write corruption) used to
  // crash reconcile() deep inside Pass 1 with an unhelpful error. Validate
  // every entry up front; drop any that fails the structural shape check
  // (logged, not silently). A dropped entry behaves like "no saved
  // layout" — Pass 3 of reconcile() appends the live panes fresh.
  for (const projectId of Object.keys(savedLayouts)) {
    const tree = savedLayouts[projectId];
    if (tree === null) continue; // explicit "no layout" entry, fine
    if (!isValidTreeNode(tree)) {
      console.warn(
        "[boot] dropping invalid saved layout for project",
        projectId,
      );
      delete savedLayouts[projectId];
    }
  }
  const projectNameOverrides = await loadProjectNameOverrides();
  let projectOrder = await loadProjectOrder();
  let currentProjects: Project[] = [];

  // Per-project "unseen green" tracking. A project's rail dot shows green
  // only when its most recent non-green→green transition hasn't been
  // acknowledged by a pointerdown inside the project's content area.
  const lastStoplight = new Map<string, Stoplight>();
  const unseenGreen = new Map<string, boolean>();
  // an earlier release: green decays to gray automatically after this window even
  // without an explicit user ack. Without it, AgentStateIdle (which the
  // daemon maps to green forever per the "task done, notice me" design)
  // leaves the rail dot stuck green for the entire session. Per-id timer
  // handles fan to either project or pane scope.
  const UNSEEN_GREEN_AUTO_ACK_MS = 60_000;
  const unseenGreenTimers = new Map<string, number>();
  const paneUnseenGreenTimers = new Map<string, number>();

  // Per-pane stoplight, driven by TerminalPane hello/status messages
  // for the active project's panes. Used by the tab bar (via
  // `getStoplight`) and by `onStoplightChange` as the WS-driven
  // baseline for detecting non-green→green transitions on the
  // active project (subsecond latency).
  //
  // Background projects' panes are also tracked, via the poll-driven
  // `lastPanePollStoplight` map below. `onStoplightChange` mirrors
  // every WS update into that map too, so the two paths share a
  // single per-pane baseline and `trackPaneStoplightTransitions`
  // doesn't replay state changes the WS path already handled.
  const paneStoplight = new Map<string, Stoplight>();
  // Per-pane mirror of the project-level "unseen green" logic: a pane's
  // tab dot stays visibly green only until the user has focused it (tab
  // switch) or clicked inside its content area. Same acknowledgement
  // semantics as the project rail, applied one pane at a time.
  const paneUnseenGreen = new Map<string, boolean>();
  // Per-pane analogue of `lastStoplight` — the shared baseline used
  // by both the poll path (`trackPaneStoplightTransitions`, fires on
  // every listProjects refresh) and the WS path
  // (`onStoplightChange`, mirrors live updates here so the two
  // paths agree on the most recent state). Without this map, the
  // poll path can't tell whether a green pane in the latest
  // snapshot is the same green WS already announced or a fresh
  // non-green→green transition that needs a flash.
  const lastPanePollStoplight = new Map<string, Stoplight>();
  // Monotonic counter used to arbitrate poll vs WS pane updates.
  // Both paths bump it before mutating per-pane state — WS on each
  // event, poll on each `refreshProjects` start. The poll path
  // captures the bumped value at request time and skips per-pane
  // application when WS has observed a strictly newer event, so an
  // older poll snapshot landing after a fresher WS event can't
  // regress `lastPanePollStoplight` or replay/clear `paneUnseenGreen`.
  // `paneStoplightEpoch` records the latest WS observation per pane;
  // panes never observed via WS have no entry, which falls through
  // to "poll is authoritative" — the desired behaviour for
  // background panes whose TerminalPanes aren't mounted.
  let updateEpoch = 0;
  const paneStoplightEpoch = new Map<string, number>();
  // phase 2: per-pane clipboard-image capability flag, fed
  // by selectProject() from the daemon's per-pane Pane.capabilities
  // object. The paste handler reads this to decide whether to try the
  // sidecar route (POST /clipboard-image) before the /uploads
  // fallback. Missing entry → treat as false (older daemon, or pane
  // not yet refreshed).
  const paneClipboardImage = new Map<string, boolean>();

  // Update the per-pane clipboard-image cap map from a daemon-provided
  // pane list. phase 2. Pre-phase-2 daemons omit
  // `capabilities` entirely; treat that as `false` so the renderer
  // falls back to the /uploads path. Doesn't clear stale entries —
  // pane teardown handles that elsewhere if needed.
  function recordPaneCapabilitiesFromHost(panes: { id: string; capabilities?: { clipboard_image?: boolean } }[]) {
    for (const p of panes) {
      const flag = p.capabilities?.clipboard_image === true;
      paneClipboardImage.set(p.id, flag);
    }
  }

  // Latest per-pane usage glance (context / quota %) from a daemon pane
  // list, feeding the minimal tab badge. Populated on the same
  // fetchHostPanes path as capabilities above; a pane without a sample
  // clears its entry.
  const paneUsage = new Map<string, PaneUsage>();
  function recordPaneUsageFromHost(panes: Pane[]) {
    for (const p of panes) {
      if (p.usage) paneUsage.set(p.id, p.usage);
      else paneUsage.delete(p.id);
    }
  }

  function clearUnseenGreenTimer(projectId: string) {
    const t = unseenGreenTimers.get(projectId);
    if (t !== undefined) {
      window.clearTimeout(t);
      unseenGreenTimers.delete(projectId);
    }
  }

  function clearPaneUnseenGreenTimer(paneId: string) {
    const t = paneUnseenGreenTimers.get(paneId);
    if (t !== undefined) {
      window.clearTimeout(t);
      paneUnseenGreenTimers.delete(paneId);
    }
  }

  // an earlier release: schedule an auto-ack so a project rail dot doesn't stay
  // green indefinitely when the user never clicks the project. The
  // daemon's AgentStateIdle stays green forever by design ("task done,
  // notice me"); without this timer, the only escape is an explicit
  // user click.
  function armUnseenGreenAutoAck(projectId: string) {
    clearUnseenGreenTimer(projectId);
    const handle = window.setTimeout(() => {
      unseenGreenTimers.delete(projectId);
      if (!unseenGreen.get(projectId)) return;
      unseenGreen.set(projectId, false);
      renderRail();
    }, UNSEEN_GREEN_AUTO_ACK_MS);
    unseenGreenTimers.set(projectId, handle);
  }

  function armPaneUnseenGreenAutoAck(paneId: string) {
    clearPaneUnseenGreenTimer(paneId);
    const handle = window.setTimeout(() => {
      paneUnseenGreenTimers.delete(paneId);
      if (!paneUnseenGreen.get(paneId)) return;
      paneUnseenGreen.set(paneId, false);
      // Two surfaces depend on this flag now: the active layout's tab
      // dots (via getStoplight) and every project's rail indicator dots
      // . Refresh both so the auto-ack
      // doesn't leave the rail showing a stale green dot until the next
      // poll cycle.
      renderRail();
      layout.refresh();
    }, UNSEEN_GREEN_AUTO_ACK_MS);
    paneUnseenGreenTimers.set(paneId, handle);
  }

  function acknowledgeSeen(projectId: string, paneId: string | undefined) {
    let changed = false;
    if (lastStoplight.get(projectId) === "green" && unseenGreen.get(projectId)) {
      unseenGreen.set(projectId, false);
      clearUnseenGreenTimer(projectId);
      changed = true;
    }
    if (paneId && paneUnseenGreen.get(paneId)) {
      paneUnseenGreen.set(paneId, false);
      clearPaneUnseenGreenTimer(paneId);
      changed = true;
    }
    if (!changed) return;
    renderRail();
    layout.refresh();
  }

  function trackStoplightTransitions(projects: Project[]) {
    for (const p of projects) {
      const prev = lastStoplight.get(p.id);
      // Only surface transitions for projects we already knew about — the
      // first time we see a project (fresh boot, or just added), we take
      // whatever state it's in as the baseline and don't flash it.
      if (prev !== undefined && p.stoplight === "green" && prev !== "green") {
        unseenGreen.set(p.id, true);
        armUnseenGreenAutoAck(p.id);
      } else if (prev === "green" && p.stoplight !== "green") {
        // Daemon moved off green on its own (orange/red/gray). Drop the
        // unseen flag + cancel any pending auto-ack — the next non-green→
        // green transition will arm a fresh window. Keeps the asymmetry
        // called out in an earlier release hypothesis B from leaving stale state.
        if (unseenGreen.get(p.id)) {
          unseenGreen.set(p.id, false);
        }
        clearUnseenGreenTimer(p.id);
      }
      lastStoplight.set(p.id, p.stoplight);
    }
  }

  // Per-pane analogue of `trackStoplightTransitions`: walks every
  // project's `pane_ids`/`pane_stoplights` from the listProjects
  // poll and arms `paneUnseenGreen` on non-green→green transitions.
  // Runs for *all* projects, not just background ones — Older
  // we only fed `paneUnseenGreen` from the WS path
  // (`onStoplightChange`), which only sees the active project's
  // panes; the rail therefore couldn't flash background projects'
  // dots on completion.
  //
  // Two paths now write to `paneUnseenGreen`:
  //   - WS (`onStoplightChange`): subsecond latency on the active
  //     project. Also mirrors its observation into
  //     `lastPanePollStoplight` so this poll path sees prev=cur
  //     and doesn't replay the transition.
  //   - Poll (here): up-to-`POLL_INTERVAL_MS` latency, covers every
  //     project including background ones whose TerminalPanes
  //     aren't mounted.
  //
  // The arm branch is idempotent: if `paneUnseenGreen[paneId]` is
  // already true, we don't re-call `armPaneUnseenGreenAutoAck`
  // (which would clear+reset the 60 s window). The clear branch is
  // unconditional: dropping the flag and cancelling a stale timer
  // is always safe.
  //
  // Active↔background hand-off: relies on the WS-side mirror above
  // and on `selectProject` not running for the same project twice;
  // when a project becomes active the WS path takes over without
  // the poll path losing or replaying state, and vice versa.
  function trackPaneStoplightTransitions(
    projects: Project[],
    pollEpoch: number,
  ) {
    for (const p of projects) {
      if (!p.pane_ids || !p.pane_stoplights) continue;
      if (p.pane_ids.length !== p.pane_stoplights.length) continue;
      for (let i = 0; i < p.pane_ids.length; i++) {
        const paneId = p.pane_ids[i];
        const cur = p.pane_stoplights[i];
        // Epoch arbitration. If WS has recorded an event for this
        // pane after the poll request was issued, the snapshot we're
        // applying is older than the live WS view — skip to avoid
        // regressing the shared baseline. Equality (`wsEpoch ===
        // pollEpoch`) can't happen: both paths increment from the
        // same counter, so any observed WS epoch is either strictly
        // less (older WS event) or strictly greater (newer WS event)
        // than this poll's epoch. Background panes have no WS
        // observations, so their `wsEpoch` is `undefined` and we
        // fall through to the transition logic — the desired path.
        const wsEpoch = paneStoplightEpoch.get(paneId);
        if (wsEpoch !== undefined && wsEpoch > pollEpoch) continue;
        const prev = lastPanePollStoplight.get(paneId);
        if (prev !== undefined && prev !== "green" && cur === "green") {
          if (!paneUnseenGreen.get(paneId)) {
            paneUnseenGreen.set(paneId, true);
            armPaneUnseenGreenAutoAck(paneId);
          }
        } else if (prev === "green" && cur !== "green") {
          if (paneUnseenGreen.get(paneId)) {
            paneUnseenGreen.set(paneId, false);
          }
          clearPaneUnseenGreenTimer(paneId);
        }
        lastPanePollStoplight.set(paneId, cur);
      }
    }
  }

  function effectiveStoplight(p: Project): Project {
    return filterEffectiveStoplight(
      p,
      unseenGreen.get(p.id) === true,
      (paneId) => paneUnseenGreen.get(paneId) === true,
    );
  }

  // Single render path for the rail — applies the optimistic rename
  // overrides (`projectNameOverrides`) and then the per-project
  // unseen-green filter. Live pane stoplights for the active project
  // are mirrored into `currentProjects` directly by `onStoplightChange`,
  // so reading `currentProjects` gives a fresh view without an extra
  // overlay step. Background projects' rail dots come from whatever
  // the last poll returned — the per-pane dimming layer  only
  // covers the active project, where `paneUnseenGreen` is populated.
  function renderRail(): void {
    const named = applyProjectOverrides(currentProjects);
    rail.setProjects(named.map(effectiveStoplight));
  }

  const rail = new Rail({
    root: railEl,
    onSelect: (projectId) => {
      // Clicking an archived project restores it (behind a confirm) rather
      // than selecting an empty, panes-killed view.
      const proj = currentProjects.find((p) => p.id === projectId);
      if (proj?.archived) {
        void requestUnarchive(projectId);
        return;
      }
      // A mini-rail avatar click selects the project AND expands the rail.
      if (railMode === "mini") setRailMode("expanded");
      void selectProject(projectId);
    },
    onExpand: () => setRailMode("expanded"),
    onAddProject: () => void handleAddProject(),
    onRename: (projectId, newName) => {
      // Optimistic: paint the new name right away, then persist on the
      // daemon so every connected client sees it. The optimistic override
      // is shadowed by the daemon's display_name on the next refreshProjects
      // tick (applyProjectOverrides prefers daemon state).
      projectNameOverrides[projectId] = newName;
      rail.setProjects(applyProjectOverrides(currentProjects));
      void (async () => {
        try {
          await client.renameProject(projectId, newName);
        } catch (e) {
          console.error("renameProject failed", e);
          // Roll back the optimistic paint — daemon is unreachable or
          // rejected the rename, so leave the canonical name alone.
          delete projectNameOverrides[projectId];
          rail.setProjects(applyProjectOverrides(currentProjects));
        }
      })();
    },
    onReorder: (newIds) => {
      projectOrder = newIds;
      void saveProjectOrder(newIds);
      const byId = new Map(currentProjects.map((p) => [p.id, p]));
      const reordered: Project[] = [];
      for (const id of newIds) {
        const p = byId.get(id);
        if (p) reordered.push(p);
      }
      for (const p of currentProjects) {
        if (!newIds.includes(p.id)) reordered.push(p);
      }
      currentProjects = reordered;
      renderRail();
    },
    onRequestDelete: async (projectId, projectName) => {
      const ok = await confirmDeleteProject(projectName, projectId);
      if (!ok) return;
      try {
        await client.deleteProject(projectId);
      } catch (e) {
        console.error("deleteProject failed", e);
      }
      // Next refreshProjects tick will reflect the deletion.
    },
    onOpenInFinder: async (projectId) => {
      const res = await window.reckAPI.shell.openPath(projectId);
      if (!res.ok) {
        console.error("openPath failed:", res.error);
      }
    },
    onToggleArchive: async (projectId, archived) => {
      if (!archived) {
        // Unarchive (menu "Unarchive" or drag-out) goes through the same
        // confirm-then-restore path as clicking an archived project.
        await requestUnarchive(projectId);
        return;
      }
      // Archive: kill the daemon's panes to free RAM, then — if this was
      // the active project — tear down its renderer terminals and switch
      // away. Its saved layout stays frozen for restore.
      try {
        await client.archiveProject(projectId);
      } catch (e) {
        console.error("archiveProject failed", e);
        return;
      }
      switchAwayFromArchived(projectId);
    },
    // an earlier release — flatten the project's saved layout left-to-right so
    // the rail can reorder dots out of daemon creation order. Active
    // project: hand back the live tree (`layout.getTree()`) so an
    // in-flight split / move repaints with the right dot order on the
    // next setProjects pass; non-active projects fall back to the
    // boot-loaded `savedLayouts[id]`. The active-tree branch is also a
    // freshness guarantee: `onTreeChange` mutates `savedLayouts`
    // in-place, but only against the previously-persisted snapshot —
    // the live tree object on `layout` is the source of truth between
    // ticks.
    getLayoutPaneOrder: (projectId) => {
      const tree =
        projectId === currentProjectId
          ? layout.getTree()
          : (savedLayouts[projectId] ?? null);
      if (!tree) return null;
      return allTabs(tree).map((t) => t.paneId);
    },
  });
  rail.setMode(railMode);

  window.reckAPI.onMenuAddProject(() => void handleAddProject());
  // Phase 12: the "Preferences…" menu item hands control to the
  // settings view without clearing state. After save the view calls
  // `window.location.reload()` which re-runs boot() with the new
  // settings; that's cheaper than threading a live settings swap
  // through the full renderer graph, and matches the fresh-install
  // first-boot path.
  window.reckAPI.onMenuPreferences(() => {
    void renderSettings(app, () => window.location.reload());
  });

  // Token update from menu ("Update Station Token…") or from 1008
  // close / 401 auto-detect. A single global gate prevents the
  // dialog from stacking — `promptForToken` overlays the whole
  // window, registers global Enter/Escape handlers, and a second
  // overlay would silently double-fire those listeners. The gate
  // is intentionally global, not per-host: in Phase 4+ the two
  // daemons can both reject within ms of each other, and surfacing
  // two overlapping modals is worse than dropping the second
  // attempt (the user can re-trigger via the menu after dealing
  // with the first).
  let tokenPromptInFlight = false;
  async function requestTokenUpdate(host: HostRef, reason?: string) {
    if (tokenPromptInFlight) return;
    tokenPromptInFlight = true;
    try {
      const current =
        host === "station" ? (settings!.station?.token ?? "") : "";
      const next = await promptForToken(host, current, reason);
      if (next === null) return;
      // Apply the token to the in-memory client *first*. If the
      // persistence call below rejects (keychain unavailable, IPC
      // hiccup), we still want this session to use the freshly
      // entered bearer — auth recovery has to keep working even
      // when persistence is broken. The error is surfaced via
      // console + the next time the renderer starts; user-visible
      // remediation can come later.
      setApiTokenForHost(host, next);
      if (host === "station") {
        if (!settings!.station) {
          settings!.station = { enabled: true, url: activeUrl, token: next };
        } else {
          settings!.station.token = next;
        }
        try {
          await saveStationToken(next);
        } catch (e) {
          console.error(
            "[token] failed to persist station token (in-memory rotation still applied)",
            e,
          );
        }
      } else {
        // Phase 5: nothing to persist for local — the source of
        // truth is the Electron main process's in-memory per-spawn
        // token (`localDaemonToken()`), and the only legitimate
        // way to "rotate" the local token is to restart the
        // daemon (which mints a fresh one). The user-typed value
        // above is honoured for this session so a power user can
        // paste a token they already inspected, but any next
        // `refreshLocalDaemonToken()` call will overwrite it from
        // main. That's the correct precedence — main owns the
        // truth, the dialog is an emergency escape hatch only.
        console.info(
          "[token] local token applied in memory; main process is authoritative " +
            "(refreshLocalDaemonToken on next start will overwrite)",
        );
      }
    } finally {
      tokenPromptInFlight = false;
    }
  }
  window.reckAPI.onMenuUpdateToken(() => void requestTokenUpdate("station"));

  // Claude Code launch-args dialog ("File → Claude Code Launch…").
  // The user can set a machine default or a per-project override. Args are
  // saved via config; they apply to *new* Claude panes only — existing
  // panes keep their current argv.
  async function handleClaudeLaunchMenu() {
    const machineDefault = await loadClaudeLaunchArgs();
    const perProject = await loadClaudeLaunchArgsByProject();
    const projectId = currentProjectId;
    const projectName =
      projectId
        ? currentProjects.find((p) => p.id === projectId)?.name ??
          projectNameOverrides[projectId] ??
          projectId
        : null;
    const res = await promptForClaudeLaunchArgs({
      machineDefault,
      projectOverride: projectId ? (perProject[projectId] ?? "") : "",
      projectName,
    });
    if (!res) return;
    if (res.scope === "machine") {
      await saveClaudeLaunchArgs(res.args);
    } else if (projectId) {
      await saveClaudeLaunchArgsForProject(projectId, res.args);
    }
  }
  window.reckAPI.onMenuClaudeLaunch(() => void handleClaudeLaunchMenu());

  /**
   * Resolve the effective Claude launch args for a pane-create call. Returns
   * { raw, tokens } where `raw` is suitable for a user-facing tooltip and
   * `tokens` is the pre-split argv to send to the daemon. Empty string and
   * empty-token-list when nothing is configured.
   */
  async function resolveClaudeExtras(
    projectId: string,
  ): Promise<{ raw: string; tokens: string[] }> {
    const raw = await resolveClaudeLaunchArgs(projectId);
    if (!raw.trim()) return { raw: "", tokens: [] };
    try {
      return { raw, tokens: tokenizeClaudeArgs(raw) };
    } catch (e) {
      console.warn("Claude launch args failed to tokenize, spawning without them:", e);
      return { raw: "", tokens: [] };
    }
  }

  /**
   * Resolve which host a pane lives on by walking the active layout
   * tree for its tab. Returns null if no tab in the current project's
   * tree owns this paneId — typically a transient state where the
   * close fires after the tab was already removed. Phase 3+ uses this
   * to route the 1008-close prompt to the right host's token store.
   */
  function paneHost(paneId: string): HostRef | null {
    const tree = layout.getTree();
    if (!tree) return null;
    for (const t of allTabs(tree)) {
      if (t.paneId === paneId) return t.host;
    }
    return null;
  }

  // Hover-to-focus . Pref is loaded once at boot into a mutable
  // cell; flipping it at runtime via Preferences  reloads boot
  // entirely, so the cell is effectively immutable for a given run.
  // The controller reads the cell on every `request`.
  let hoverToFocusEnabled = await loadHoverToFocus();
  const hoverFocus = new HoverFocusController({
    isEnabled: () => hoverToFocusEnabled,
    // `layout` is hoisted by the time the first `mouseenter` fires
    // (listeners are attached inside syncLeafView, which runs only
    // after the first setTree call). Referencing it in the closure is
    // safe even though it's declared below.
    isAlreadyActive: (leafId) => layout.getActiveLeafId() === leafId,
  });
  hoverFocus.attach();
  // Boot-time indicator. Logs both states (default ON since an earlier release) so
  // an operator scanning DevTools can confirm the resolved pref
  // without having to inspect storage.
  console.info(`[reck] hover-to-focus panes: ${hoverToFocusEnabled ? "enabled" : "disabled"}`);
  // HMR / page-reload safeguard: tear down global listeners + the
  // body MutationObserver before the renderer frame unloads. Without
  // this, a dev reload would stack observers across sessions and leak
  // window-blur/focus handlers. Production-build unloads still get
  // the cleanup as a free side-effect. See an earlier release 3e.
  window.addEventListener("beforeunload", () => hoverFocus.detach(), { once: true });

  // Per-pane overlay scrollbars, keyed by the TerminalPane so each entry is
  // GC'd with its pane (the pane drops its scroll listener on dispose).
  const terminalScrollbars = new WeakMap<TerminalPane, OverlayScrollbar>();

  // --- Claude transcript "History" overlays (#51) ---------------------
  // Owned by the TranscriptController: one overlay per pane, mounted in
  // the pane's wrapper (the xterm keeps running underneath), tailing the
  // session transcript from the pane's host daemon. The controller
  // always shows a visible status (loading/error/no-session) instead of
  // failing silently, and traces every decision with `[transcript]`
  // console logs — set localStorage["reck-transcript-debug"]="1" for
  // per-poll/per-render verbosity.
  const transcripts = createTranscriptController({
    resolvePane: (paneId) => {
      const rec = layout.getTerminalRecordByPane(paneId);
      if (!rec) return null;
      return {
        wrapper: rec.wrapper,
        kind: rec.tab.kind,
        host: rec.tab.host,
        title: rec.tab.title ?? "",
        sessionId: rec.tab.sessionId,
      };
    },
    projectId: () => currentProjectId,
    api: (host) => apiForHost(host),
    // ⌘+click a path in the transcript → open it in the file viewer, reusing
    // the exact resolve/open pipeline the pane linkifier uses (below). `host`
    // is the pane's host, so `~/` and station-cwd translation route correctly.
    // History only opens on a pane in the current layout/project, so the
    // active project's cwd is the right anchor for relative paths.
    linkHandlers: (host) => ({
      onLinkActivate: (href) => {
        const projectCwd =
          currentProjects.find((p) => p.id === currentProjectId)?.cwd ?? null;
        const target = resolveActivatePath(href, projectCwd);
        console.log("[click:transcript] activate -> openInViewer", {
          host,
          projectCwd,
          originalText: href,
          target,
        });
        void window.reckAPI.files
          .openInViewer(target, {
            sourceHost: host,
            originalText: href,
            projectCwd: projectCwd ?? undefined,
          })
          .then((r) => {
            if (!r || (r as { ok?: boolean }).ok !== true) {
              console.warn("[click:transcript] openInViewer rejected", { href, target, r });
            }
          })
          .catch((e) => console.warn("[click:transcript] openInViewer error", e));
      },
      // ⌘+click an http/https URL in the transcript → OS default browser.
      onExternalActivate: (href) => {
        window.open(href, "_blank", "noopener");
      },
    }),
  });

  // Voice dictation handle (#67), assigned by the async initTranscription
  // below. The layout's mic-button callback and the ⌘⇧V hotkey route here.
  let dictationHandle: TranscriptionHandle | null = null;
  let ttsHandle: TtsHandle | null = null;

  const layout: PaneLayout = new PaneLayout({
    root: layoutRoot,
    // Phase 10: route each tab's WS through its own host's ApiClient.
    // A hybrid layout can mix station + local panes in the same leaf,
    // so the URL/subprotocols must be resolved per-tab rather than
    // per-layout.
    buildWsUrl: (paneId, host) => apiForHost(host).wsUrl(currentProjectId!, paneId),
    // Subprotocol-based bearer auth (see ApiClient.wsSubprotocols); the
    // token never appears in the URL.
    buildWsSubprotocols: (host) => apiForHost(host).wsSubprotocols(),
    hoverFocus,
    // An earlier release: hand the retry-window predicate to PaneLayout so the
    // splitter, tab-click, and tab-drag handlers can bail at gesture
    // start. boot.ts callbacks below check the same predicate; the
    // double-gate is defence in depth (PaneLayout-side prevents the
    // visual flicker, boot.ts-side covers code paths that bypass the
    // component, e.g. keyboard shortcuts).
    isRestoring: () => isRetrying(),
    // seed theme so new terminals use the right colors from first mount
    onActiveLeafChange: () => {},
    // Install the xterm path linkifier on every new pane so file paths in
    // scrollback (from `ls`, `grep`, Claude Code edit messages, …) become
    // Cmd+clickable. The provider is hover-driven — no cost until the user
    // hovers a line. The resolve batch and openInViewer route through
    // main's allowlist.
    onPaneCreated: (paneId, pane) => {
      // Per-pane auto-hiding overlay scrollbar (xterm's native scrollbar is
      // hidden via CSS). Fire-and-forget like the linkifier below: tied to
      // the pane's lifetime and GC'd with it via the WeakMap.
      try {
        const host = pane.container.parentElement ?? pane.container;
        const sb = createOverlayScrollbar({
          host,
          surface: terminalScrollSurface(
            pane.getXterm() as unknown as Parameters<typeof terminalScrollSurface>[0],
            (bytes) => pane.sendInput(bytes),
          ),
        });
        terminalScrollbars.set(pane, sb);
      } catch (e) {
        console.warn("[scrollbar] disabled for pane:", e);
      }

      installPathLinkProvider(pane.getXterm(), {
        resolveBatch: (paths) => window.reckAPI.files.resolve(paths),
        onActivate: (filePath) => {
          // Route the click through the pane's host so main can expand
          // `~/` against the right home (station vs Mac) and apply the
          // station-cwd translation. Lookup is by paneId because the
          // pane's host is tracked at the tab level (see paneHost()).
          const directHost = paneHost(paneId);
          // paneHost can return null transiently while the layout tree
          // rebuilds (e.g. during selectProject) or before the daemon's
          // first pane-state push lands. Defaulting to "local" silently
          // misrouted station-pane clicks to the Mac filesystem (a
          // "file doesn't exist" error against a /Users/... path). Fall
          // back to primaryHost instead — for users running with station
          // enabled that's "station", the right guess for the vast
          // majority of clicks. A console.warn flags the fallback.
          const host: HostRef = directHost ?? primaryHost;
          if (directHost === null) {
            console.warn(
              `[linkifier] paneHost(${paneId}) returned null — falling back to primaryHost=${primaryHost}`,
            );
          }
          // Resolve bare filenames AND `./X` / `../X` against the active
          // project's cwd; absolute (`/abs`) and home-anchored (`~/x`)
          // paths pass through unchanged.
          //
          // The cwd lookup keys off the UI-SELECTED project, but the
          // clicked pane is only provably that project's when it sits in
          // the current layout tree (directHost !== null). Outside it
          // (selectProject race), a WRONG cwd poisons resolveActivatePath
          // and main's rescue pipeline, while an ABSENT cwd is safe — main
          // derives the project anchor from the resolved path. So drop the
          // cwd when the pane isn't provably the current project's.
          const projectCwd =
            directHost !== null
              ? currentProjects.find((p) => p.id === currentProjectId)?.cwd ??
                null
              : null;
          const target = resolveActivatePath(filePath, projectCwd);
          console.log("[click:pane] activate -> openInViewer", {
            paneId,
            paneHost: directHost,
            resolvedHost: host,
            sourceHost: host,
            projectCwd,
            originalText: filePath,
            rawPath: filePath,
            target,
          });
          window.reckAPI.files
            .openInViewer(target, {
              sourceHost: host,
              originalText: filePath,
              projectCwd: projectCwd ?? undefined,
            })
            .then((r) => {
              if (!r || (r as { ok?: boolean }).ok !== true) {
                console.warn("[click:pane] openInViewer rejected", {
                  target,
                  sourceHost: host,
                  result: r,
                });
              }
            })
            .catch((err: unknown) => {
              console.warn("[click:pane] openInViewer threw", {
                target,
                sourceHost: host,
                error: err,
              });
            });
        },
      });
      // Clickable http/https URLs alongside the path linkifier. ⌘-click
      // opens the OS default browser: window.open is intercepted by main's
      // setWindowOpenHandler and forwarded to shell.openExternal.
      installUrlLinkProvider(pane.getXterm(), {
        onActivateUrl: (url) => {
          window.open(url, "_blank", "noopener");
        },
      });
    },
    onStoplightChange: (paneId, s) => {
      // Bump the shared epoch first thing so any in-flight poll
      // response landing after this event sees `wsEpoch > pollEpoch`
      // and skips applying its (now stale) snapshot. Done before the
      // de-dup early-return so duplicate WS events still advance the
      // epoch — the next poll then has a strictly newer fingerprint
      // to compare against, which keeps the arbitration monotonic.
      paneStoplightEpoch.set(paneId, ++updateEpoch);
      // `paneStoplight` is the WS-side de-dup source: it tracks the
      // last value this pane's TerminalPane WS connection actually
      // emitted, so duplicate hello/status events return early
      // without firing renderRail/layout.refresh. Don't fold it into
      // the shared baseline — the de-dup needs WS-only state.
      const prevWs = paneStoplight.get(paneId);
      if (prevWs === s) return;
      // Transition detection consults the *shared* baseline,
      // populated by both this WS path and the poll-driven
      // `trackPaneStoplightTransitions`. Without this, a pane that
      // transitions while its project is backgrounded (poll-tracked
      // and acked) would be re-armed by the first WS event after
      // re-activation, because `paneStoplight` for that pane could
      // be stuck at a non-green value from the last time the
      // project was active. Using `lastPanePollStoplight` keeps both
      // hand-off directions symmetric.
      const prev = lastPanePollStoplight.get(paneId);
      // Only flag a pane as "unseen" on a real transition into green —
      // a pane observed green on first connect (prev === undefined) is
      // baseline, not a completion worth announcing.
      if (prev !== undefined && prev !== "green" && s === "green") {
        // Idempotent arm: if the poll path already armed for this
        // transition (e.g. user re-selected the project just after
        // poll-track flagged it), don't reset the auto-ack window.
        if (!paneUnseenGreen.get(paneId)) {
          paneUnseenGreen.set(paneId, true);
          // an earlier release: same auto-ack as the project rail. Without this,
          // a pane that completes once stays bright on its tab dot until
          // the user opens that exact tab.
          armPaneUnseenGreenAutoAck(paneId);
        }
      } else if (prev === "green" && s !== "green") {
        // Pane moved off green on its own — drop the flag + cancel any
        // pending auto-ack so a future non-green→green starts fresh.
        if (paneUnseenGreen.get(paneId)) {
          paneUnseenGreen.set(paneId, false);
        }
        clearPaneUnseenGreenTimer(paneId);
      }
      paneStoplight.set(paneId, s);
      // Keep the poll-driven baseline (`lastPanePollStoplight`) in
      // sync with the WS path so `trackPaneStoplightTransitions` on
      // the next poll sees prev=cur and doesn't replay the
      // transition we already handled here. This is what makes
      // active↔background hand-off correct: at the moment the
      // project flips to background, the most recent WS state has
      // already been mirrored into the poll map, so the first
      // background-poll has a fresh baseline rather than one up to
      // 2 s stale.
      lastPanePollStoplight.set(paneId, s);
      // Mirror the live update into currentProjects so the rail
      // (which renders from `currentProjects.pane_stoplights[]`) shows
      // the new state immediately, not after the next poll. Aggregate
      // `p.stoplight` is daemon-derived (severity max across panes) —
      // we leave it stale until the next listProjects round-trip
      // recomputes it; the project chip already had this lag Older.
      // The mutation is overwritten cleanly on the next poll cycle.
      for (const p of currentProjects) {
        if (p.id !== currentProjectId) continue;
        if (!p.pane_ids || !p.pane_stoplights) break;
        if (p.pane_ids.length !== p.pane_stoplights.length) break;
        const idx = p.pane_ids.indexOf(paneId);
        if (idx === -1) break;
        if (p.pane_stoplights[idx] === s) break;
        p.pane_stoplights = [...p.pane_stoplights];
        p.pane_stoplights[idx] = s;
        break;
      }
      renderRail();
      layout.refresh();
    },
    getStoplight: (paneId) => {
      const raw = paneStoplight.get(paneId) ?? "gray";
      if (raw === "green" && !paneUnseenGreen.get(paneId)) return "gray";
      return raw;
    },
    getUsage: (paneId) => paneUsage.get(paneId),
    onExit: () => {},
    onPaneConnClose: (paneId, info) => {
      // Standard WebSocket close codes — see RFC 6455 §7.4.
      // 1008 (policy violation) is what the daemon uses to reject an
      // invalid bearer token; surface straight to the token-prompt
      // dialog so the user doesn't have to manually "Update token".
      // 1001 (going away) is the daemon's shutdown close; panes will
      // reconnect automatically once the daemon is back. Noise-log it
      // at info level so operators tailing the console can correlate.
      // Everything else (1006, 1011, transient network) falls through
      // to the existing reconnect-with-backoff path — no extra UI.
      //
      // Hybrid mode (Phase 3): resolve which host the rejected pane
      // lives on from `Tab.host` so the prompt only mutates that
      // host's token. **Fail closed** if the tab can't be located
      // (close raced a teardown or the tree was already torn down):
      // we'd rather drop one prompt than risk routing a local 1008
      // through `mode` and persisting a token onto the wrong host.
      // Phase 9's two-host runtime makes the cross-routing a real
      // trust-boundary risk; Phase 3 is the right time to set the
      // habit.
      if (info.code === 1008) {
        const tabHost = paneHost(paneId);
        if (tabHost === null) {
          console.warn(
            "[pane] 1008 received but pane not present in current tree; skipping token prompt to avoid cross-host routing",
            { paneId },
          );
          return;
        }
        // Phase 5 (an earlier release, plan rev 3.1): a 1008 on a local pane
        // means the renderer's cached bearer is stale relative to
        // what the local daemon currently expects. The Electron
        // main process owns the per-spawn token (random 32 bytes,
        // rotates on every `daemon.start("local")`); fetching via
        // IPC and re-applying covers the common cases — a daemon
        // restart raced the first probe, or the renderer's local
        // ApiClient was constructed before main had stashed the
        // token. We never prompt the user for a local-daemon token
        // (the user has no way to know it; main generates it), so
        // dropping the prompt path here is intentional. If the
        // refresh comes back null (daemon down) the next pane
        // reconnect attempt fails noisily; the connection-poll's
        // CONN dot is the user's surface for that case.
        if (tabHost === "local") {
          console.info(
            "[pane] local 1008: refreshing per-spawn token from main process",
          );
          void refreshLocalDaemonToken().catch((e) => {
            console.warn("[pane] local token refresh failed after 1008", e);
          });
          return;
        }
        const reason =
          "Station rejected the current token. Paste a fresh one to reconnect.";
        void requestTokenUpdate(tabHost, reason);
      } else if (info.code === 1001) {
        console.info(
          "[pane] daemon going away — panes will reconnect automatically",
          { reason: info.reason },
        );
      }
    },
    onTreeChange: (tree) => {
      if (!currentProjectId) return;
      // Suppress persistence while the current selection is inside its
      // retry budget . The tree painted during retry is an
      // incomplete projection — daemon-side pane restore is still in
      // flight — so a split/close/move here is operating on partial
      // state. Persisting it would drop the not-yet-restored panes
      // from the saved layout. The post-retry `setTree(reconciled)`
      // re-paints against the stabilised reconcile; any visual edits
      // made during the retry window are discarded at that point,
      // matching an earlier release behaviour (no persistence while
      // restoring) without the "project looks dead" symptom.
      if (activeRetrySeq !== null && activeRetrySeq === selectSeq.current()) {
        return;
      }
      // Keep the in-memory snapshot in sync with disk. saveLayout() in
      // config.ts reads fresh, mutates a local copy, and persists — it
      // never touches this outer object — so without this line
      // `savedLayouts[projectId]` would stay frozen at its boot-time
      // value and miss every user edit until next restart.
      savedLayouts[currentProjectId] = tree;
      void saveLayout(currentProjectId, tree);
    },
    onSwitchTab: (leafId, tabId) => {
      if (isRetrying()) return;
      const tree = layout.getTree();
      if (!tree) return;
      layout.setTree(switchTab(tree, leafId, tabId));
      layout.focusLeaf(leafId);
      const t = findTab(layout.getTree(), tabId);
      if (t && currentProjectId) acknowledgeSeen(currentProjectId, t.tab.paneId);
    },
    onCloseTab: (leafId, tabId) => {
      if (isRetrying()) return;
      void closeTabAt(leafId, tabId);
    },
    onNewTab: (leafId) => {
      if (isRetrying()) return;
      void newTabInLeaf(leafId);
    },
    onSplitRight: (leafId) => {
      if (isRetrying()) return;
      void splitLeafAt(leafId, "vertical");
    },
    onSplitDown: (leafId) => {
      if (isRetrying()) return;
      void splitLeafAt(leafId, "horizontal");
    },
    onCloseLeaf: (leafId) => {
      if (isRetrying()) return;
      void closeLeafAt(leafId);
    },
    onRenameTab: (tabId, newTitle) => {
      if (isRetrying()) return;
      const tree = layout.getTree();
      if (!tree) return;
      const found = findTab(tree, tabId);
      if (!found || !currentProjectId) return;
      const paneId = found.tab.paneId;
      const prevTitle = found.tab.title;
      // Optimistic local repaint, then persist to the daemon. A daemon
      // rejection (e.g. shell panes have no session_id to key off of)
      // rolls the title back so the UI doesn't lie.
      layout.setTree(renameTab(tree, tabId, newTitle));
      // Hybrid mode (rev 3.1, phase 10): route rename to the host the
      // pane actually lives on. The singleton `client` is the primary
      // host's client; a local pane whose rename is sent there would
      // 404 (local daemon has no such pane_id in station-primary mode).
      const targetHost = found.tab.host;
      void (async () => {
        try {
          await apiForHost(targetHost).renamePane(currentProjectId!, paneId, newTitle);
        } catch (e) {
          console.error("renamePane failed", e);
          const current = layout.getTree();
          if (current) layout.setTree(renameTab(current, tabId, prevTitle));
        }
      })();
    },
    onReorderTab: (leafId, tabId, newIndex) => {
      if (isRetrying()) return;
      const tree = layout.getTree();
      if (!tree) return;
      layout.setTree(reorderTab(tree, leafId, tabId, newIndex));
    },
    onMoveTab: (sourceLeafId, tabId, targetLeafId, targetIndex) => {
      if (isRetrying()) return;
      const tree = layout.getTree();
      if (!tree) return;
      const next = moveTab(tree, tabId, targetLeafId, targetIndex);
      if (!next) return;
      layout.setTree(next);
      // Keep focus on the target leaf so the moved tab's terminal is
      // what the user sees. setTree's onTreeChange handler persists the
      // new layout — same pattern as reorder/close.
      layout.focusLeaf(targetLeafId);
      // `sourceLeafId` is currently unused in the body but kept on the
      // callback signature because the renderer already knows which
      // leaf the drag started in; exposing it saves a tree walk if we
      // ever need source-side side effects (e.g. analytics, undo).
      void sourceLeafId;
    },
    // an earlier release: drag-tab-onto-split-button. The user dragged a tab
    // onto the split-right / split-down icon button on some leaf; we
    // create a new split off `targetLeafId` and move the dragged tab
    // into the new sibling leaf — no kind picker, no spawn. Strategy:
    //   1. Wrap the target leaf in a new split via `splitLeaf`,
    //      planting the dragged tab object as the new sibling. After
    //      this step the dragged tab exists in TWO leaves (its
    //      original source leaf, plus the new sibling leaf).
    //   2. Strip the duplicate from the source leaf via `closeTab`.
    //      `closeTab` collapses the source leaf if its last tab was
    //      the dragged one, bubbling the sibling up — same machinery
    //      that's been correct for tab-close since an earlier release.
    // Using `closeTab(...)` second (not first) means we never have to
    // construct the new tab object — the original `Tab` (with its
    // existing paneId, host, kind, title) is reused directly.
    onSplitWithTab: (targetLeafId, draggedLeafId, draggedTabId, dir) => {
      if (isRetrying()) return;
      const tree = layout.getTree();
      if (!tree) return;
      const found = findTab(tree, draggedTabId);
      if (!found) return;
      // Edge case: dragging a single-tab leaf onto its own split
      // button. The split would close back to a single leaf the
      // moment closeTab collapses the source side. Treat as a no-op
      // so we don't disturb the layout.
      if (found.leaf.id === draggedLeafId && found.leaf.id === targetLeafId && found.leaf.tabs.length === 1) {
        return;
      }
      // 1. Insert the dragged tab as a new sibling leaf alongside the
      //    target. `splitLeaf` minted a fresh leaf id for the sibling
      //    (`r.newLeafId`); the original target leaf keeps its id.
      const r = splitLeaf(tree, targetLeafId, dir, found.tab);
      // 2. Remove the dragged tab from its source leaf (the original
      //    location). `closeTab` matches on (sourceLeafId, draggedTabId)
      //    and ignores the new sibling leaf, so the freshly-planted
      //    copy survives.
      const cleaned = closeTab(r.tree, found.leaf.id, draggedTabId);
      if (!cleaned) return;
      layout.setTree(cleaned);
      // Land focus on the new sibling so the moved tab's terminal is
      // visually under the cursor — matches the focus follow-through
      // of `onMoveTab` above.
      layout.focusLeaf(r.newLeafId);
      void draggedLeafId; // surface in callback signature; unused here
    },
    // Image-paste upload.
    //
    // Phase 2 (preferred): if the daemon has reported
    // capabilities.clipboard_image=true for this pane (Claude pane on a
    // daemon running in Aqua scope), POST raw bytes to
    // /clipboard-image. The daemon writes NSPasteboard in-process via
    // cgo + AppKit (see daemon/internal/macclipboard/pasteboard.go and
    // pasteboard_darwin.m), then writes 0x16 to the PTY so Claude Code
    // creates an [Image #N] chip — no path leaks into the prompt text.
    // On 5xx (e.g. daemon NSPasteboard write failed) we fall back to
    // /uploads silently with a console.info breadcrumb.
    //
    // Phase 1 (fallback / shell panes / non-Aqua daemons): POST
    // multipart to /uploads, receive an absolute path, type it into
    // the PTY. Visible breadcrumb classifies *why* we landed on the
    // path branch (see PasteUploadResult below).
    //
    // History: phase 2 used to dispatch via a separate `reck-clipboard`
    // sidecar (issue #96 / #131) because the daemon then ran as a
    // LaunchDaemon and NSPasteboard writes from system scope are
    // unreliable. Issue #215 moved the daemon itself into Aqua and
    // folded the sidecar's NSPasteboard write into the daemon process,
    // so there is no sidecar anymore — `clipboard_image=true` now just
    // means "daemon is in Aqua and AppKit is loaded".
    //
    // Errors bubble up to TerminalPane's onPasteUploadError hook; the
    // renderer doesn't toast by default — a console warning is enough.
    onPasteUpload: async (paneId, host, blob, mime, filename) => {
      const api = apiForHost(host);
      // Classify *why* we may end up on the path-typing branch so the
      // TerminalPane can emit a visible breadcrumb. Without this, the
      // path appears in the prompt with no UI signal — indistinguishable
      // from a bug from the user's seat. See PasteUploadResult.
      let fallbackReason: "no-capability" | "daemon-error" | "upload-only" | undefined;
      let fallbackDetail: string | undefined;
      // The clipboard-image sidecar only handles image pasteboard writes;
      // non-image drops (PDF, text, Scope B) go straight to /uploads. Flag
      // it as the expected upload-only route rather than a failure.
      const isImage = mime.toLowerCase().startsWith("image/");
      if (!isImage) {
        fallbackReason = "upload-only";
      } else if (paneClipboardImage.get(paneId) === true) {
        try {
          const ok = await api.pasteImage(paneId, blob, mime);
          if (ok) return { kind: "chip" };
          // 5xx from /clipboard-image — fall through to /uploads. The
          // ApiClient.pasteImage already logged status + body.
          fallbackReason = "daemon-error";
          fallbackDetail = "clipboard-image returned 5xx";
        } catch (err) {
          // Non-5xx 4xx (HttpError) or transport error — also fall
          // through to /uploads. The chip path is opportunistic; treat
          // any hard failure as "try the universal route" rather than
          // escalating to the user.
          fallbackReason = "daemon-error";
          // HttpError carries a numeric `status`; pull it out for the
          // breadcrumb if present, otherwise fall back to err.message.
          const status =
            typeof err === "object" && err !== null && "status" in err
              ? (err as { status?: unknown }).status
              : undefined;
          const message = err instanceof Error ? err.message : String(err);
          fallbackDetail =
            typeof status === "number" ? `HTTP ${status}: ${message}` : message;
          console.info("[paste-clipboard] error, falling back to /uploads", {
            paneId,
            status,
            err,
          });
        }
      } else {
        // Pane has no clipboard-image capability (shell/codex pane on
        // any OS, Claude pane off macOS, or capability event never
        // arrived). Phase-1 path is the *expected* route here — flag
        // it so the user knows it's by design, not a bug.
        fallbackReason = "no-capability";
      }
      const resp = await api.uploadFile(paneId, blob, mime, filename);
      return { kind: "path", path: resp.path, fallbackReason, fallbackDetail };
    },
    onPasteUploadError: (paneId, err, mime) => {
      console.warn("[paste-upload] failed", { paneId, mime, err });
    },
    // Current drop prompt template, read fresh per pane creation so a
    // Preferences edit takes effect on the next-created pane.
    dropPromptTemplate: () => dropPromptTemplate,
    // Gate a dropped file against the user's allow-list + 10 MB cap.
    validateDroppedFile: (file) => {
      if (file.size > DRAGDROP_MAX_BYTES) return { ok: false, reason: "size" };
      const dot = file.name.lastIndexOf(".");
      const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
      if (!ext || !dragDropAllowlist.has(ext)) return { ok: false, reason: "type" };
      return { ok: true };
    },
    onDropRejected: (info) => {
      const mb = (info.sizeBytes / (1000 * 1000)).toFixed(1);
      const msg =
        info.reason === "size"
          ? `“${info.name}” is ${mb} MB — drag-drop is capped at 10 MB.`
          : info.ext
            ? `“.${info.ext}” files aren’t allowed. Add the type in Settings → Drag & drop files.`
            : `“${info.name}” has no extension. Add allowed types in Settings → Drag & drop files.`;
      showToast(document.body, msg, { kind: "error" });
    },
    // an earlier release: detach the pane to its own popout window. The flow:
    //   1. ask main for the leaf's screen rect (via getActiveLeafRect)
    //      and translate to absolute screen coords (window.screenX/Y).
    //   2. invoke `pane:detach` over IPC; main spawns a parent-less
    //      BrowserWindow and returns ok.
    //   3. on ok, mark the pane detached locally so syncLeafView flips
    //      the slot to a placeholder DOM (existing TerminalPane is
    //      disposed inside the reconciliation branch).
    // already-detached → focus already happened main-side, no UI work.
    onDetachPane: (paneId, _leafId) => {
      // Detach call needs the project + host context so the popout can
      // build its own WebSocket URL without an extra IPC round-trip.
      // Resolve from the current tree by paneId — same lookup the 1008
      // handler uses for host routing, just keeping the title too.
      if (!currentProjectId) return;
      const tree = layout.getTree();
      if (!tree) return;
      const tab = allTabs(tree).find((t) => t.paneId === paneId);
      if (!tab) return;
      void (async () => {
        const rect = layout.getActiveLeafRect();
        const bounds = rect
          ? {
              width: Math.max(320, Math.round(rect.width)),
              height: Math.max(200, Math.round(rect.height)),
              x: Math.round(window.screenX + rect.left),
              y: Math.round(window.screenY + rect.top),
            }
          : undefined;
        const res = await window.reckAPI.windows.detachPane(
          paneId,
          { projectId: currentProjectId!, host: tab.host, title: tab.title },
          bounds,
        );
        if (res.ok) layout.markDetached(paneId);
      })();
    },
    onReattachPane: (paneId) => {
      // Closing the popout fires its `closed` handler in main, which
      // sends `pane:popout-closed` back to this window — and the
      // listener installed below routes that into
      // `layout.handlePopoutClosed(paneId)`. Driving the flow through
      // the popout's close path means the OS-close-button case and the
      // in-app reattach button take the exact same code path.
      void window.reckAPI.windows.reattachPane(paneId);
    },
    // "History" (#51): toggle the transcript overlay for a Claude pane.
    onHistoryPane: (paneId) => {
      void transcripts.toggle(paneId);
    },
    // Voice dictation (#67): the mic button focuses the pane (in the layout)
    // then routes here; the active-pane target is resolved when it starts.
    onDictationToggle: () => {
      dictationHandle?.toggle();
    },
  });
  layout.setTheme(theme);
  // Bind the rail-collapse/wiggle refit hook now that the layout exists.
  refitActiveTerminals = () => void layout.refitActive();

  // an earlier release: subscribe to popout-closed notifications. The
  // unsubscribe thunk is captured here so the next reload doesn't stack
  // listeners across HMR sessions; production unloads get the cleanup
  // as a free side-effect via `beforeunload`.
  const unsubPopoutClosed = window.reckAPI.windows.onPopoutClosed((paneId) => {
    layout.handlePopoutClosed(paneId);
  });
  window.addEventListener("beforeunload", () => unsubPopoutClosed(), { once: true });

  /**
   * Two-step pane picker: the user first chooses host + Claude / Shell /
   * Resume; when they pick Resume we fetch the project's session
   * index *from the chosen host's daemon* and show a second dialog.
   * Returns the pane kind, the host it will run on, and an optional
   * resume UUID for CreatePane.
   *
   * Hybrid mode (rev 3.1, phase 10): the host selector is rendered
   * only when both hosts are enabled, and gated on `isHostReady(host)`
   * so a user can't create a local pane before Phase 9's PUT /projects
   * push-ack has arrived. The dialog subscribes to ready-flag flips so
   * the gate can arm live while the picker is open.
   */
  async function pickNewPane(): Promise<{
    kind: PaneKind;
    host: HostRef;
    resumeSessionId?: string;
  } | null> {
    const choice = await askPaneKind(document.body, {
      // `settings` is narrowed non-null by the early-return guard at
      // the top of `boot()`, but the narrowing doesn't survive this
      // async closure — match the `!` pattern used by the Phase 9 push
      // orchestrator a few hundred lines below. an earlier release: local is
      // always available; only station varies.
      enabledHosts: {
        station: !!settings!.station?.enabled,
        local: true,
      },
      isHostReady: (h) => isHostReady(h),
      subscribeReady: (cb) => subscribeHostReady(cb),
    });
    if (!choice) return null;
    // Codex is a first-class kind but needs a `codex` binary on the chosen
    // host's daemon PATH. If /health reported none, don't silently fail the
    // create — tell the user exactly what's missing and how to fix it.
    if (choice.kind === "codex" && !isHostCodexAvailable(choice.host)) {
      showToast(document.body, codexUnavailableMessage(choice.host), {
        kind: "info",
        durationMs: 9000,
      });
      return null;
    }
    if (
      choice.kind === "claude" ||
      choice.kind === "shell" ||
      choice.kind === "codex"
    ) {
      // Codex, like shell, is a direct create (no preamble, no resume) —
      // the three newTab callers below already gate extras/globalPreamble
      // on kind==="claude", so codex correctly sends neither.
      return { kind: choice.kind, host: choice.host };
    }
    // "resume": surface the session list. The picker is Claude-only —
    // Scope B widened /sessions to emit shell rows too, so we filter
    // to Claude here (pre-Scope-B daemons omit kind entirely, treated
    // as claude for back-compat). Shell restore is a separate flow
    // that's only offered by the post-reconnect restore prompt.
    //
    // Sessions are host-scoped: a local daemon never sees station's
    // session files and vice versa. Fetch from the picked host's client
    // so the resume list reflects what that daemon can actually spawn.
    if (!currentProjectId) return null;
    try {
      const { sessions } = await apiForHost(choice.host).listSessions(currentProjectId);
      const claudeOnly = sessions.filter(
        (s) => (s.kind ?? "claude") === "claude" && !!s.session_id,
      );
      const picked = await pickSession(document.body, claudeOnly);
      if (!picked || !picked.session_id) return null;
      return { kind: "claude", host: choice.host, resumeSessionId: picked.session_id };
    } catch (e) {
      console.error("listSessions failed", e);
      return null;
    }
  }

  /**
   * Spawn a pane on `host` and return its id, or `null` after surfacing an
   * error toast when the daemon rejects it. Pane-create failures used to be
   * swallowed to the console (see the comment above); routing them through
   * a toast means the user actually learns why nothing appeared — e.g. a
   * codex create that slips past the availability gate returns the daemon's
   * `ErrCodexNotAvailable` here.
   */
  async function createPaneOrToast(
    host: HostRef,
    projectId: string,
    kind: PaneKind,
    opts: {
      resumeSessionId?: string;
      extraArgs?: string[];
      globalPreamble?: string;
    },
  ): Promise<string | null> {
    try {
      const { pane_id } = await apiForHost(host).createPane(
        projectId,
        kind,
        opts,
      );
      return pane_id;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const label =
        kind === "claude" ? "Claude" : kind === "codex" ? "Codex" : "Shell";
      showToast(document.body, `Couldn't start the ${label} pane: ${detail}`, {
        kind: "error",
        durationMs: 8000,
      });
      console.error("createPane failed", { host, projectId, kind, error: e });
      return null;
    }
  }

  async function newTabInLeaf(leafId: string) {
    if (!currentProjectId) return;
    const choice = await pickNewPane();
    if (!choice) return;
    const extras =
      choice.kind === "claude" && !choice.resumeSessionId
        ? await resolveClaudeExtras(currentProjectId)
        : null;
    // Reck Connect prompt — sent for every Claude pane (including resumes)
    // AND for codex panes (the codex adapter injects it via
    // `-c developer_instructions=`); undefined for shell panes.
    const globalPreamble =
      choice.kind === "claude" || choice.kind === "codex"
        ? await resolveEffectiveReckConnectPrompt()
        : undefined;
    // Hybrid mode (rev 3.1, phase 10): route pane-create to the host
    // the user picked. The local daemon resolves `projectId → cwd`
    // from its in-memory map populated by Phase 9's PUT /projects, so
    // no cwd override is needed here — the daemon handles the sshfs
    // mount-path translation transparently.
    const pane_id = await createPaneOrToast(
      choice.host,
      currentProjectId,
      choice.kind,
      {
        resumeSessionId: choice.resumeSessionId,
        extraArgs: extras?.tokens,
        globalPreamble,
      },
    );
    if (!pane_id) return;
    const tooltip = extras?.raw ? `claude ${extras.raw}` : undefined;
    const tree = layout.getTree();
    if (!tree) {
      const newLeaf = leafWithTab(
        tab(pane_id, choice.kind, choice.host, undefined, undefined, tooltip),
      );
      layout.setTree(newLeaf);
      layout.focusLeaf(newLeaf.id);
      return;
    }
    layout.setTree(
      addTab(tree, leafId, tab(pane_id, choice.kind, choice.host, undefined, undefined, tooltip)),
    );
    layout.focusLeaf(leafId);
  }

  async function newTabInActiveLeaf() {
    const leafId = layout.getActiveLeafId();
    const tree = layout.getTree();
    if (!leafId || !tree) return createFirstPane();
    return newTabInLeaf(leafId);
  }

  async function splitLeafAt(leafId: string, dir: "vertical" | "horizontal") {
    if (!currentProjectId) return;
    const tree = layout.getTree();
    if (!tree) return createFirstPane();
    const choice = await pickNewPane();
    if (!choice) return;
    const extras =
      choice.kind === "claude" && !choice.resumeSessionId
        ? await resolveClaudeExtras(currentProjectId)
        : null;
    // Reck Connect prompt — sent for every Claude pane (including resumes)
    // AND for codex panes (the codex adapter injects it via
    // `-c developer_instructions=`); undefined for shell panes.
    const globalPreamble =
      choice.kind === "claude" || choice.kind === "codex"
        ? await resolveEffectiveReckConnectPrompt()
        : undefined;
    const pane_id = await createPaneOrToast(
      choice.host,
      currentProjectId,
      choice.kind,
      {
        resumeSessionId: choice.resumeSessionId,
        extraArgs: extras?.tokens,
        globalPreamble,
      },
    );
    if (!pane_id) return;
    const tooltip = extras?.raw ? `claude ${extras.raw}` : undefined;
    const r = splitLeaf(
      tree,
      leafId,
      dir,
      tab(pane_id, choice.kind, choice.host, undefined, undefined, tooltip),
    );
    layout.setTree(r.tree);
    layout.focusLeaf(r.newLeafId);
  }

  async function splitActive(dir: "vertical" | "horizontal") {
    const leafId = layout.getActiveLeafId();
    if (!leafId) return createFirstPane();
    return splitLeafAt(leafId, dir);
  }

  async function createFirstPane() {
    if (!currentProjectId) return;
    const choice = await pickNewPane();
    if (!choice) return;
    const extras =
      choice.kind === "claude" && !choice.resumeSessionId
        ? await resolveClaudeExtras(currentProjectId)
        : null;
    // Reck Connect prompt — sent for every Claude pane (including resumes)
    // AND for codex panes (the codex adapter injects it via
    // `-c developer_instructions=`); undefined for shell panes.
    const globalPreamble =
      choice.kind === "claude" || choice.kind === "codex"
        ? await resolveEffectiveReckConnectPrompt()
        : undefined;
    const pane_id = await createPaneOrToast(
      choice.host,
      currentProjectId,
      choice.kind,
      {
        resumeSessionId: choice.resumeSessionId,
        extraArgs: extras?.tokens,
        globalPreamble,
      },
    );
    if (!pane_id) return;
    const tooltip = extras?.raw ? `claude ${extras.raw}` : undefined;
    const newLeaf = leafWithTab(
      tab(pane_id, choice.kind, choice.host, undefined, undefined, tooltip),
    );
    layout.setTree(newLeaf);
    layout.focusLeaf(newLeaf.id);
  }

  async function closeTabAt(leafId: string, tabId: string) {
    if (!currentProjectId) return;
    const tree = layout.getTree();
    if (!tree) return;
    const found = findTab(tree, tabId);
    if (!found) return;
    const ok = await confirmDialog(document.body, {
      title: `Close ${found.tab.title}?`,
      body: `This will end the ${found.tab.kind === "claude" ? "Claude" : found.tab.kind === "codex" ? "Codex" : "shell"} process running in this tab. Unsaved terminal state will be lost.`,
      confirmLabel: "Close tab",
      cancelLabel: "Keep",
    });
    if (!ok) return;
    try {
      // Phase 10: delete on the host the tab actually runs on.
      await apiForHost(found.tab.host).deletePane(currentProjectId, found.tab.paneId);
    } catch (e) {
      console.error("deletePane failed", e);
    }
    layout.setTree(closeTab(tree, leafId, tabId));
  }

  async function closeLeafAt(leafId: string) {
    if (!currentProjectId) return;
    const tree = layout.getTree();
    if (!tree) return;
    const l = findLeaf(tree, leafId);
    if (!l) return;
    const paneCount = l.tabs.length;
    const ok = await confirmDialog(document.body, {
      title: paneCount === 1 ? `Close ${l.tabs[0].title}?` : `Close pane-box?`,
      body:
        paneCount === 1
          ? `This will end the ${l.tabs[0].kind === "claude" ? "Claude" : l.tabs[0].kind === "codex" ? "Codex" : "shell"} process.`
          : `This will close all ${paneCount} tabs and end their processes.`,
      confirmLabel: paneCount === 1 ? "Close tab" : `Close ${paneCount} tabs`,
      cancelLabel: "Keep",
    });
    if (!ok) return;
    for (const t of l.tabs) {
      // Phase 10: each tab may live on a different host in hybrid mode.
      try { await apiForHost(t.host).deletePane(currentProjectId, t.paneId); } catch (e) { console.error(e); }
    }
    layout.setTree(closeLeaf(tree, leafId));
  }

  async function closeActive() {
    const leafId = layout.getActiveLeafId();
    const tree = layout.getTree();
    if (!leafId || !tree) return;
    const l = findLeaf(tree, leafId);
    if (!l) return;
    await closeTabAt(leafId, l.activeTabId);
  }

  function nextPrevTab(dir: "next" | "prev") {
    const leafId = layout.getActiveLeafId();
    const tree = layout.getTree();
    if (!leafId || !tree) return;
    const l = findLeaf(tree, leafId);
    if (!l || l.tabs.length < 2) return;
    const idx = l.tabs.findIndex((t) => t.id === l.activeTabId);
    const nextIdx =
      dir === "next" ? (idx + 1) % l.tabs.length : (idx - 1 + l.tabs.length) % l.tabs.length;
    layout.setTree(switchTab(tree, leafId, l.tabs[nextIdx].id));
    layout.focusLeaf(leafId);
  }

  function clearActiveTerminal() {
    const leafId = layout.getActiveLeafId();
    if (!leafId) return;
    layout.focusLeaf(leafId);
    const evt = new KeyboardEvent("keydown", { key: "l", ctrlKey: true });
    document.activeElement?.dispatchEvent(evt);
  }

  installShortcuts({
    onNewTab: () => {
      if (isRetrying()) return;
      void newTabInActiveLeaf();
    },
    onSplitVertical: () => {
      if (isRetrying()) return;
      void splitActive("vertical");
    },
    onSplitHorizontal: () => {
      if (isRetrying()) return;
      void splitActive("horizontal");
    },
    onCloseActive: () => {
      if (isRetrying()) return;
      void closeActive();
    },
    onNextTab: () => {
      if (isRetrying()) return;
      nextPrevTab("next");
    },
    onPrevTab: () => {
      if (isRetrying()) return;
      nextPrevTab("prev");
    },
    onFocusLeft: () => layout.navigate("left"),
    onFocusRight: () => layout.navigate("right"),
    onFocusUp: () => layout.navigate("up"),
    onFocusDown: () => layout.navigate("down"),
    onToggleRail: () => toggleRail(),
    onCollapseRail: () => setRailMode("mini"),
    onExpandRail: () => setRailMode("expanded"),
    onClearTerminal: () => clearActiveTerminal(),
    // an earlier release: detach the focused pane via the same callback path
    // the per-pane button uses. We resolve "focused pane" from the
    // active leaf's active tab — same pane the Detach button targets,
    // so the shortcut is observably the button's keyboard alias.
    onDetachActive: () => {
      if (isRetrying()) return;
      if (!currentProjectId) return;
      const leafId = layout.getActiveLeafId();
      if (!leafId) return;
      const tab = layout.getActiveTabForLeaf(leafId);
      if (!tab) return;
      // Skip if the active pane is already detached — the user pressed
      // the shortcut but there's nothing left to do here. Main-side
      // already focuses the popout in that case via the
      // already-detached short-circuit.
      if (layout.isDetached(tab.paneId)) return;
      void (async () => {
        const rect = layout.getActiveLeafRect();
        const bounds = rect
          ? {
              width: Math.max(320, Math.round(rect.width)),
              height: Math.max(200, Math.round(rect.height)),
              x: Math.round(window.screenX + rect.left),
              y: Math.round(window.screenY + rect.top),
            }
          : undefined;
        const res = await window.reckAPI.windows.detachPane(
          tab.paneId,
          { projectId: currentProjectId!, host: tab.host, title: tab.title },
          bounds,
        );
        if (res.ok) layout.markDetached(tab.paneId);
      })();
    },
    onJumpProject: (idx) => {
      const p = currentProjects[idx - 1];
      if (p) void selectProject(p.id);
    },
  });

  // Text-to-speech subsystem. Resolves the active TerminalPane via the
  // layout, listens for the speak shortcuts, and renders the floating
  // control bar anchored to the active pane wrapper. Failures here are
  // non-fatal — the rest of the app should still boot if the browser
  // doesn't expose speechSynthesis (e.g. headless test harness).
  void (async () => {
    try {
      ttsHandle = await initTts({
        getActiveSpeakSurface: () => {
          const rec = layout.getActiveTerminalRecord();
          if (!rec) return null;
          // An open History overlay owns TTS for its pane (#51): speak the
          // rendered transcript, not the terminal's visible rows — same
          // switch as ⌘F below. Reuses the file-viewer's MarkdownSurfaceAdapter.
          const overlay = transcripts.get(rec.tab.paneId);
          if (overlay) return overlay.view.getSpeakSurface();
          // Wrap the active xterm pane in a TerminalPaneAdapter so the
          // TtsController treats it as a generic SpeakSurfaceAdapter,
          // identical to how the file-viewer popup wraps its markdown /
          // CodeMirror surfaces. Cell metrics are read off xterm's
          // render service when available, with a defaulted fallback.
          const term = rec.term.getXterm();
          const xtermEl = (term.element as HTMLElement | undefined) ?? rec.wrapper;
          const dims = (term as unknown as {
            _core?: { _renderService?: { dimensions?: {
              css?: { cell?: { width?: number; height?: number } };
              actualCellWidth?: number;
              actualCellHeight?: number;
            } } };
          })._core?._renderService?.dimensions;
          const cellWidth = dims?.css?.cell?.width ?? dims?.actualCellWidth ?? 8;
          const cellHeight = dims?.css?.cell?.height ?? dims?.actualCellHeight ?? 16;
          return new TerminalPaneAdapter({
            term: term as unknown as ConstructorParameters<typeof TerminalPaneAdapter>[0]["term"],
            xtermEl,
            containerEl: ensurePaneControls(rec.wrapper),
            cellWidth,
            cellHeight,
          });
        },
      });
    } catch (e) {
      console.warn("[tts] disabled:", e);
    }
  })();

  // Voice dictation (#67): capture the mic on this Mac, transcribe (local
  // Whisper or Deepgram), and type the text into the active pane's PTY.
  // Non-fatal like TTS above.
  void (async () => {
    try {
      dictationHandle = await initTranscription({
        resolveSession: () => {
          const rec = layout.getActiveTerminalRecord();
          if (!rec) return null;
          const encoder = new TextEncoder();
          return {
            target: {
              insert: (text) => rec.term.sendInput(encoder.encode(text)),
              submit: () => rec.term.sendInput(encoder.encode("\r")),
            },
            surface: rec.wrapper,
          };
        },
        onError: (msg) => showToast(document.body, msg, { kind: "error", durationMs: 6000 }),
      });
    } catch (e) {
      console.warn("[dictation] disabled:", e);
    }
  })();

  // In-view search (⌘/Ctrl+F). Resolves the active terminal pane as a
  // TerminalSearchAdapter (same pattern as the TTS surface above) and
  // routes match-position ticks to that pane's overlay scrollbar.
  try {
    initSearch({
      getActiveSearchSurface: () => {
        const rec = layout.getActiveTerminalRecord();
        if (!rec) return null;
        // An open History overlay owns ⌘F for its pane (#51): search
        // the whole transcript, not the terminal's visible rows. The bar
        // mounts into the PANE wrapper's stack (with the history clock +
        // TTS bar), not a nested one inside the overlay — one stack,
        // History always at the bottom.
        const overlay = transcripts.get(rec.tab.paneId);
        if (overlay) {
          return new MarkdownSearchAdapter({
            container: ensurePaneControls(rec.wrapper),
            body: overlay.view.body,
          });
        }
        const term = rec.term.getXterm();
        return new TerminalSearchAdapter({
          container: ensurePaneControls(rec.wrapper),
          term: term as unknown as ConstructorParameters<
            typeof TerminalSearchAdapter
          >[0]["term"],
        });
      },
      onMatchesChanged: (fractions) => {
        const rec = layout.getActiveTerminalRecord();
        if (!rec) return;
        const overlay = transcripts.get(rec.tab.paneId);
        if (overlay) {
          overlay.view.setMatches(fractions);
          return;
        }
        terminalScrollbars.get(rec.term)?.setMatches(fractions);
      },
    });
  } catch (e) {
    console.warn("[search] disabled:", e);
  }

  // Shared unarchive path for every entry point (rail click, drag-out,
  // context-menu "Unarchive"). Confirm first — restoring can spin several
  // heavy agent panes back up — then unarchive on the daemon and select the
  // project so the frozen layout reconciles onto the respawned panes.
  async function requestUnarchive(projectId: string): Promise<void> {
    const proj = currentProjects.find((p) => p.id === projectId);
    const name = proj?.name ?? projectId;
    const savedTree = savedLayouts[projectId] ?? null;
    const paneCount = savedTree ? allTabs(savedTree).length : 0;
    const ok = await confirmRestoreProject(name, paneCount);
    if (!ok) return;
    try {
      await client.unarchiveProject(projectId);
    } catch (e) {
      console.error("unarchiveProject failed", e);
      return;
    }
    // UnarchiveProject respawns the panes synchronously before responding,
    // so selecting now reconciles the frozen layout onto live panes.
    await selectProject(projectId);
  }

  // The active project was just archived (its panes are being killed). Move
  // focus off it: selecting another project disposes the archived project's
  // TerminalPanes via setTree (freeing renderer RAM), and its saved layout
  // stays frozen because onTreeChange only persists the current selection —
  // which we're changing here.
  function switchAwayFromArchived(projectId: string): void {
    if (currentProjectId !== projectId) return;
    const nextActive = currentProjects.find(
      (p) => p.id !== projectId && !p.archived,
    );
    if (nextActive) {
      void selectProject(nextActive.id);
      return;
    }
    // Nothing else to show — clear the pane area (disposing the archived
    // project's terminals) and deselect. Null currentProjectId first so
    // onTreeChange doesn't persist the empty tree under the archived id.
    currentProjectId = null;
    rail.select(null);
    layout.setTree(null, { persist: false });
    renderStatus();
  }

  // Root-cause fix for the stale grid after a cross-project switch:
  // setTree freshly remounts panes, and a pane whose container isn't
  // laid out yet makes TerminalPane.refit() early-return without
  // re-arming — a same-geometry switch then produces no ResizeObserver
  // delta, so nothing ever re-fits. Double-rAF lets the new tree paint
  // first; if any pane still reports not-laid-out, retry once shortly
  // after.
  function scheduleProjectSwitchRefit() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // pinToBottom: end the switch with a real scroll that lands at
        // the tail — a remounted pane can present blank until scrolled.
        const allLaidOut = layout.refitActive({ pinToBottom: true });
        if (!allLaidOut) {
          window.setTimeout(() => layout.refitActive({ pinToBottom: true }), 100);
        }
      });
    });
  }

  async function selectProject(projectId: string) {
    if (currentProjectId === projectId) return;

    // Stop any in-flight read-aloud: the pane being spoken is about to
    // unmount, and cancel/speak churn against a dying surface is one of
    // the sequences that wedges macOS's speech service process-wide.
    ttsHandle?.stop();

    // Cancel any in-flight fetch from the prior selection; reserve a
    // fresh sequence number. A newer switch is authoritative — the
    // old response is no longer useful even if it completes, because
    // otherwise a slow A fetch resolving after a B selection would
    // paint A's tree into B's slot and the next onTreeChange would
    // persist A's layout under B's key.
    const mySeq = selectSeq.next();

    // `paneStoplight` tracks the WS connection's last observed value
    // for active-project panes. When the project deactivates those
    // TerminalPanes unmount and stop emitting events, but the map
    // entries persist — which would let a stale `prevWs === s`
    // early-return in `onStoplightChange` swallow a real transition
    // on re-activation. Walk the live layout tree (not
    // `currentProjects[outgoingId].pane_ids`, which is poll-derived
    // and missing any panes created since the last refresh) so
    // every pane currently mounted in the outgoing project gets
    // cleaned up. `lastPanePollStoplight` is the durable
    // cross-project baseline.
    //
    // Critically, `paneStoplightEpoch` is NOT cleared here. The
    // epoch is the freshness watermark that lets
    // `trackPaneStoplightTransitions` reject stale poll snapshots
    // already in flight when the user switched projects: an older
    // `/listProjects` response landing after this cleanup must
    // still see the higher WS epoch and skip its outdated values,
    // otherwise it would regress `lastPanePollStoplight` /
    // `paneUnseenGreen` for the backgrounded project. The epoch
    // entry stays valid forever — it's only ever compared against
    // poll epochs and never read for de-dup, so there's no
    // re-entry hazard to clear it for.
    if (currentProjectId !== null) {
      const outgoingTree = layout.getTree();
      if (outgoingTree) {
        for (const t of allTabs(outgoingTree)) {
          paneStoplight.delete(t.paneId);
        }
      }
    }

    currentProjectId = projectId;
    rail.select(projectId);

    // Phase 10 fixup (post-codex review): fetch pane state from every
    // enabled host in parallel, not just the primary. The saved tree
    // may contain tabs on either host, and reconcile needs each host's
    // pane list to bind them correctly. Station is still the
    // sequenced-fetch surface so a rapid project-switch aborts the
    // prior in-flight call deterministically; local is best-effort
    // (TypeError / 401 treated as "no live panes from that host",
    // matching pre-hybrid single-host behaviour).
    const hosts = enabledHosts();
    // autoSpawn=false on the primary fetch too. The daemon's
    // GET /projects/:id auto-spawns a default pane when the project
    // has zero live panes, but it spawns with empty CreatePaneOptions
    // — no ExtraArgs — so the per-project / machine claude launch
    // args (stored in satellite config, not projects.toml) never make
    // it onto the starter pane's argv. Opting out lets the client
    // drive the starter spawn through `spawnStarterPane` below, which
    // resolves and applies the configured launch args.
    const res = await fetchSequenced(selectSeq, mySeq, (signal) =>
      client.getProject(projectId, { signal, autoSpawn: false }),
    );
    if (!res.ok) {
      if (!res.aborted) console.error("selectProject failed", res.error);
      return;
    }
    // Capture the sequence's AbortSignal for the retry-loop fetches
    // below. Defer `selectSeq.settle()` until after the retry loop so
    // `this.ctrl` stays live throughout retry — a newer
    // selectProject → selectSeq.next() will `ctrl.abort()` our signal
    // and flip `retrySignal.aborted`, instead of being a no-op on a
    // prematurely-nulled ctrl. See settle() call near end of function.
    const retrySignal = selectSeq.signal();
    const primaryPanes = res.detail.panes;

    async function fetchHostPanes(
      primary: typeof primaryPanes,
    ): Promise<Record<string, typeof primaryPanes>> {
      const out: Record<string, typeof primaryPanes> = {
        [primaryHost]: primary,
      };
      const secondaries = hosts.filter((h) => h !== primaryHost);
      await Promise.all(
        secondaries.map(async (h) => {
          try {
            // an earlier release: read-only secondary fetch. The daemon's
            // `GET /projects/:id` auto-spawns a default pane when the
            // project has zero live panes — useful as new-project UX on
            // the primary host, but a phantom-spawn vector here. A
            // station-resident project always reads as "empty" on local
            // (panes live elsewhere), so without `autoSpawn: false`
            // every secondary-host roundtrip leaks a fresh local
            // Claude pane. Reconcile Pass 3 then surfaces it as a tab.
            const detail = await apiForHost(h).getProject(projectId, {
              autoSpawn: false,
            });
            out[h] = detail.panes;
          } catch (err) {
            // A secondary host being unreachable is expected when the
            // user just booted Satellite mid-outage. Reconcile treats
            // a missing host's tabs as stale, which is the correct
            // UX: dropped-not-shown beats a broken WS trying to reach
            // a dead daemon.
            console.warn(`selectProject: ${h} pane fetch failed`, err);
          }
        }),
      );
      return out;
    }
    async function fetchHostPanesRetry(
      signal: AbortSignal | null,
    ): Promise<Record<string, typeof primaryPanes>> {
      // Retry path uses the primary's unsequenced refresh (the
      // in-flight sequence has settled; guard is against a newer
      // selectProject, not this function's own reentry). The signal
      // is the *pre-settle* AbortSignal so a subsequent
      // selectProject → selectSeq.next() cancels this in-flight
      // fetch instead of letting it run out the 12 s retry budget.
      //
      // an earlier release (review M1): the retry loop only runs when a saved
      // layout is being restored (`if (saved && matchedSaved <
      // savedIdTabs)` gate above). If the daemon's pane-restore walk
      // hasn't yet rebound any saved panes when this fires, primary
      // would read as empty and the default-spawn would land a phantom
      // starter pane on top of the saved panes once they come back.
      // Retry is by definition a project-with-saved-layout — never a
      // new project — so opting out of auto-spawn here has zero UX
      // cost.
      const init: RequestInit & { autoSpawn: boolean } = signal
        ? { signal, autoSpawn: false }
        : { autoSpawn: false };
      const primary = await client.getProject(projectId, init);
      return fetchHostPanes(primary.panes);
    }
    let livePanesByHost = await fetchHostPanes(primaryPanes);
    for (const panes of Object.values(livePanesByHost)) {
      recordPaneCapabilitiesFromHost(panes);
      recordPaneUsageFromHost(panes);
    }

    const saved = savedLayouts[projectId] ?? null;
    let reconciled = reconcile(saved, livePanesByHost);

    // an earlier release: paint immediately *before* the retry loop so the
    // pane area switches the instant the user clicks, even on a
    // cold daemon where the retry budget can run up to ~12 s. The
    // `{ persist: false }` flag preserves the b0c90a0 contract —
    // reconciled tree is a presentation projection, not a canonical
    // user edit, so it must not auto-persist and collapse saved
    // splits on restart.
    layout.setTree(reconciled, { persist: false });
    {
      const firstLeaf = reconciled ? allLeaves(reconciled)[0] : null;
      if (firstLeaf) layout.focusLeaf(firstLeaf.id);
    }
    renderStatus();
    scheduleProjectSwitchRefit();
    wiggleSeparator();

    // Daemon-restart race: the daemon's restore walk takes several
    // seconds on wake-up, so `getProject` may return a subset of the
    // panes that will eventually exist. If Pass 1 of reconcile can't
    // rebind every saved tab yet, the UI would paint an incomplete
    // tree — functionally okay now that the reconcile paint doesn't
    // persist (see the `{ persist: false }` setTree call above), but
    // still confusing for the user. Retry the fetch+reconcile against
    // the ORIGINAL saved tree on a ~12 s budget before the final
    // repaint, so the full layout lands as soon as the daemon comes
    // back. Observed warm restore: ~8 s across 4–5 panes.
    //
    // Why countMatchingIdentities and not allTabs(reconciled).length:
    // reconcile's Pass 3 appends uncovered live panes to the first
    // leaf, so the total tab count can equal savedTabs even when
    // half the saved tabs silently dropped and got replaced. The
    // right signal is "how many saved stable identities are present
    // in the live pane list" — that's the would-rebind count.
    // These two helpers live in reconcile.ts so they're trivially
    // unit-testable (see reconcile.test.ts). The logic — host-keyed
    // identity matching + host-reachability filter on savedIdTabs —
    // was called out twice in codex adversarial reviews, so extracting
    // makes the regression surface explicit.
    const savedIdTabs = countSavedIdentityTabsInReachableHosts(saved, livePanesByHost);
    let matchedSaved = countMatchingIdentities(saved, livePanesByHost);
    let didRetry = false;
    if (saved && matchedSaved < savedIdTabs) {
      // Gate persistence AND every layout-mutating gesture for the
      // duration of the retry budget (an earlier release). The tree painted
      // above is a partial projection while the daemon finishes
      // restoring panes; the post-retry repaint will reset to
      // `saved`, so any in-window edit (splitter drag, tab reorder,
      // tab move, active-tab switch, close, rename, new-tab, split)
      // would appear to land then silently revert. The finally clears
      // the gate on any exit — normal completion, early return on a
      // newer selection, or thrown error.
      //
      // Why the full block is acceptable: the retry budget caps at
      // 12 s, typical warm restore is well under one second, the CSS
      // overlay on `.restoring-layout` tells the user the panes are
      // still coming back, and silently reverting a user edit is a
      // worse failure mode than a brief no-op. Callback-level
      // `isRetrying()` gates in onSwitchTab / onCloseTab / onNewTab /
      // onSplit* / onCloseLeaf / onRenameTab / onReorderTab /
      // onMoveTab and the keyboard close/next/prev shortcuts are the
      // source of truth; the `isRestoring` predicate handed to
      // PaneLayout suppresses the gesture at the dragstart / click /
      // mousedown source so the user doesn't even see a partial drag.
      activeRetrySeq = mySeq;
      // Visual: `.restoring-layout` drives the pointer-events gate on
      // splitter / tab-creation controls; the splash-style overlay
      // element (mounted alongside) gives the user the affordance.
      // Runtime gates above are the source of truth.
      layoutRoot.classList.add("restoring-layout");
      mountRestoringOverlay(layoutRoot);
      try {
        for (let i = 0; i < 24; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (mySeq !== selectSeq.current()) return;
          if (currentProjectId !== projectId) return;
          try {
            const retried = await fetchHostPanesRetry(retrySignal);
            if (mySeq !== selectSeq.current()) return;
            if (currentProjectId !== projectId) return;
            livePanesByHost = retried;
            for (const panes of Object.values(livePanesByHost)) {
              recordPaneCapabilitiesFromHost(panes);
              recordPaneUsageFromHost(panes);
            }
            reconciled = reconcile(saved, livePanesByHost);
            didRetry = true;
            matchedSaved = countMatchingIdentities(saved, livePanesByHost);
            if (matchedSaved >= savedIdTabs) break;
          } catch (err) {
            // AbortError from the pre-settle signal means a newer
            // selectProject superseded us — bail quietly; the next
            // seq/currentProjectId guard above would catch it anyway,
            // but skipping the console.warn keeps the log clean.
            if (retrySignal?.aborted) return;
            console.warn("selectProject retry fetch failed", err);
          }
        }
      } finally {
        if (activeRetrySeq === mySeq) {
          activeRetrySeq = null;
          layoutRoot.classList.remove("restoring-layout");
          unmountRestoringOverlay(layoutRoot);
        }
      }
    }

    // Repaint with the stabilised reconcile if the retry loop produced
    // a new one. Same `{ persist: false }` rule as the immediate paint
    // above — reconciled is a presentation projection, not a canonical
    // user edit, and must not reach saveLayout.
    //
    // Equality gate skips the setTree when the live tree already
    // matches — avoids a spurious focus-flash on happy-path retries
    // where the incremental paint inside the loop (via setTree
    // persist:false? no — via the early paint at line 1153 only) hasn't
    // shifted. Because persistence is suppressed during retry ,
    // `saved` is still the source-of-truth for the reconcile; no need
    // to re-read savedLayouts here.
    if (didRetry) {
      const current = layout.getTree();
      if (JSON.stringify(current) !== JSON.stringify(reconciled)) {
        layout.setTree(reconciled, { persist: false });
        const firstLeaf = reconciled ? allLeaves(reconciled)[0] : null;
        if (firstLeaf) layout.focusLeaf(firstLeaf.id);
        renderStatus();
        // The repaint remounted panes again — same not-laid-out hazard
        // as the fast-path paint above.
        scheduleProjectSwitchRefit();
      }
    }
    // Housekeeping: clear the in-flight AbortController now that the
    // last fetch using `retrySignal` has returned. Deferred from the
    // usual post-fetch position (line 1100) so that `retrySignal`
    // stayed abortable by a newer selectProject throughout retry.
    selectSeq.settle();

    // Starter pane: replace the daemon-side EnsureDefaultPane that
    // we opted out of with `autoSpawn=false` above. Only fire when
    // there's no saved layout AND the primary host genuinely has
    // zero panes — otherwise the user is restoring a session and
    // the reconcile path owns the tree. Goes through createPane on
    // the primary host so the configured Claude launch args
    // (`claudeLaunchArgs` / `claudeLaunchArgsByProject`) end up on
    // the spawned pane's argv.
    if (
      !saved &&
      currentProjectId === projectId &&
      (livePanesByHost[primaryHost] ?? []).length === 0
    ) {
      void spawnStarterPane(projectId);
    }
  }

  /**
   * Spawn the first pane for a project that has no saved layout and
   * no live panes. Mirrors the daemon-side EnsureDefaultPane spawn
   * (which Satellite opts out of via `autoSpawn=false` so it can
   * route the spawn through `createPane` and apply launch args).
   */
  async function spawnStarterPane(projectId: string) {
    // Default kind matches the daemon's: an empty `default_pane` in
    // projects.toml falls through to "claude". Project.default_pane
    // isn't on the wire today, so we mirror the daemon default here.
    // Shell-default projects (rare) lose their auto-shell starter;
    // users open one manually via the new-pane dialog.
    const kind: PaneKind = "claude";
    const extras = await resolveClaudeExtras(projectId);
    // Starter panes are always Claude, so they carry the Reck Connect
    // prompt too — auto-started sessions get the same global hints.
    const globalPreamble = await resolveEffectiveReckConnectPrompt();
    if (currentProjectId !== projectId) return;
    let paneId: string | null = null;
    try {
      const created = await apiForHost(primaryHost).createPane(
        projectId,
        kind,
        { extraArgs: extras.tokens, globalPreamble },
      );
      paneId = created.pane_id;
      // Project switched while createPane was in flight. The pane
      // exists on the daemon but we never painted it into a tab;
      // clean it up so a rapid switch doesn't leak phantom Claude
      // panes (the same failure mode `autoSpawn=false` exists to
      // prevent on secondary-host fetches). Best-effort delete —
      // logged on failure but not surfaced; a leaked pane shows up
      // on the project's next selectProject and the user can close
      // it manually.
      if (currentProjectId !== projectId) {
        void apiForHost(primaryHost)
          .deletePane(projectId, paneId)
          .catch((err) =>
            console.warn("starter pane cleanup after project switch failed", err),
          );
        return;
      }
      const tooltip = extras.raw ? `claude ${extras.raw}` : undefined;
      const newLeaf = leafWithTab(
        tab(paneId, kind, primaryHost, undefined, undefined, tooltip),
      );
      layout.setTree(newLeaf);
      layout.focusLeaf(newLeaf.id);
    } catch (err) {
      console.error("starter pane spawn failed", err);
    }
  }

  function applyProjectOverrides(projects: Project[]): Project[] {
    // Daemon-served display_name is authoritative and shared across
    // clients. The in-memory override map (projectNameOverrides) is only
    // consulted as a fallback — it's optimistic UI from an in-flight
    // rename, or a legacy Electron-config override from before the
    // rename endpoint existed, and gets overwritten as soon as the
    // daemon confirms.
    return projects.map((p) => {
      const daemon = p.display_name?.trim();
      if (daemon) return { ...p, name: daemon };
      const local = projectNameOverrides[p.id];
      if (local) return { ...p, name: local };
      return p;
    });
  }

  let connInfo: ConnectionInfo = { state: "connecting", lastError: null, uptimeSec: null };
  // Tailscale verdict for the inline connection reason. Probed lazily when
  // the station goes unreachable (not on a token error), cleared on
  // recovery. Single-flight so a flapping link can't stack `tailscale`
  // CLI calls.
  let tailscaleVerdict: TailscaleVerdict | null = null;
  let tailscaleProbeInFlight = false;
  async function refreshTailscaleVerdict(): Promise<void> {
    if (tailscaleProbeInFlight) return;
    tailscaleProbeInFlight = true;
    try {
      const v = await window.reckAPI.tailscale.status(activeUrl);
      tailscaleVerdict = v.ok ? v : null;
      renderStatus();
    } catch {
      tailscaleVerdict = null;
    } finally {
      tailscaleProbeInFlight = false;
    }
  }

  // --- Phase 9 push state (declared before renderStatus so the status
  // bar can read localPushError on its very first paint) --------------
  //
  // `localMountPoint` is resolved once at boot from the Electron main
  // process; `pushState` holds the orchestrator's single-flight gate
  // and last-pushed fingerprint across triggers. `localPushError` is
  // derived from `pushState.lastError` so renderStatus only reads one
  // binding (avoids a getter on an object property surviving the
  // closure's narrowing).
  let localMountPoint: string | null = null;
  const pushState: PushState = makePushState();
  let localPushError: string | null = null;
  // When CONN is `connected` but the `/projects` fetch fails, the project
  // refresher records the reason here instead of throwing back into the
  // poll loop and demoting CONN. Dedup-guarded so a repeating failure
  // doesn't re-render the status row every poll.
  let projectsError: string | null = null;

  // Re-evaluate an earlier release soft hint from the current (CONN, mount) tuple
  // and return the decorated mount state. Call this whenever CONN or
  // mount changes. Helper avoids drift between the two update paths.
  function refreshMountHint(): "green" | "yellow" | "gray" {
    mountHint.onConn(connInfo.state, connInfo.lastError, mountState);
    return mountHint.apply(mountState);
  }

  function renderStatus() {
    const displayedMount = refreshMountHint();
    statusBar.setInfo({
      projectName:
        currentProjects.find((p) => p.id === currentProjectId)?.name ?? "",
      paneCount: (() => {
        const tree = layout.getTree();
        return tree ? allPaneIds(tree).length : 0;
      })(),
      projectCount: currentProjects.length,
      host: new URL(activeUrl).host,
      conn: connInfo.state,
      connError: connInfo.lastError,
      connDetail: deriveConnectionReason(connInfo.lastError, tailscaleVerdict),
      mount: displayedMount,
      localPushError,
    });
  }

  void window.reckAPI.mount.status().then((s) => {
    mountState = s;
    renderStatus();
  });
  window.reckAPI.mount.onStatus((s) => {
    mountState = s;
    renderStatus();
  });

  async function refreshProjects(): Promise<Project[]> {
    // Capture the epoch BEFORE the await so any WS events that fire
    // while the listProjects round trip is in flight bump
    // `paneStoplightEpoch` past this poll's epoch — the trackPane
    // call below then arbitrates per pane and skips ones the WS
    // path has more recently observed.
    const pollEpoch = ++updateEpoch;
    const { projects } = await client.listProjects();
    // Hybrid rail merge . The primary `client` is the station daemon
    // when station is enabled; its `pane_ids` / `pane_stoplights` only
    // describe station-spawned panes. Local-host panes (`[L]` badge tabs)
    // are invisible to the rail unless we also pull `listProjects` from
    // the local daemon and merge per project ID. Errors from the local
    // fetch are swallowed — the station catalog is the canonical view, and
    // a transient local outage shouldn't blank the rail.
    let merged = projects;
    if (primaryHost === "station") {
      try {
        const localList = await apiForHost("local").listProjects();
        merged = mergeHybridProjects(projects, localList.projects);
      } catch (e) {
        console.warn("[boot] hybrid rail: local listProjects failed", e);
      }
    }
    const ordered = applyProjectOrder(merged, projectOrder);
    const withOverrides = applyProjectOverrides(ordered);
    currentProjects = withOverrides;
    // If the active project got archived (by this client or another), tear
    // down its terminals and move focus off it. Idempotent — no-op once we
    // are no longer on that project.
    if (currentProjectId) {
      const active = withOverrides.find((p) => p.id === currentProjectId);
      if (active?.archived) switchAwayFromArchived(currentProjectId);
    }
    trackStoplightTransitions(withOverrides);
    trackPaneStoplightTransitions(withOverrides, pollEpoch);
    renderRail();
    // Hybrid mode rev 3.1, phase 9: after every station-project
    // refresh, push the translated project catalog to the local daemon
    // (if local is enabled). The push is skipped when the fingerprint
    // matches the last-acked payload, so a typical 2 s poll cycle with
    // unchanged projects doesn't burn a PUT. Kicked off without await
    // so a slow local PUT doesn't block the rail repaint — errors are
    // surfaced via the status bar instead of thrown up the poll loop.
    void pushStationProjectsToLocal();
    return withOverrides;
  }

  // --- Phase 9: station → local project-list push -------------------------
  //
  // The state (localMountPoint, lastPushedFingerprint, pushInFlight,
  // pushQueued, localPushError) is declared earlier in the function
  // so renderStatus can read localPushError. This block resolves the
  // mount path and defines the orchestrator.

  // Absolute local mount path, resolved once at boot from the Electron
  // main process (`$HOME/reck/projects`). Joined with each station
  // project's ID in `buildPutProjectsPayload` to form the cwd the local
  // daemon's PUT /projects handler validates against its permitted
  // prefix. Resolved unconditionally (an earlier release: local is always
  // available); the push orchestrator's eligibility gate skips when no
  // station is configured or when the resolution failed.
  try {
    localMountPoint = await window.reckAPI.paths.localMountPoint();
  } catch (e) {
    console.warn("[boot] failed to resolve local mount point", e);
  }

  async function pushStationProjectsToLocal(): Promise<void> {
    // Eligibility — push is only meaningful in true hybrid mode (station
    // configured AND local mount resolved). When the user hasn't enabled
    // station, the local daemon's project map stays driven by its own
    // projects.toml; when station is enabled, the local daemon mirrors
    // the station catalog so panes can route either way.
    if (!settings!.station?.enabled) return;
    if (localMountPoint === null) return;
    await runProjectPush(
      {
        state: pushState,
        client: apiForHost("local"),
        projects: currentProjects,
        localMount: localMountPoint,
        onReadyChange: (ready) => setHostReady("local", ready),
        onStatusChange: (err) => {
          if (localPushError === err) return;
          localPushError = err;
          renderStatus();
        },
      },
      () => pushStationProjectsToLocal(),
    );
  }

  async function handleAddProject() {
    const newProj = await addProjectFlow(client);
    if (!newProj) return;
    await refreshProjects();
    await selectProject(newProj.id);
  }

  // Daemon-restart detection: /health uptime_sec is monotonically
  // increasing in a running process. Any observed decrease means the
  // daemon restarted, which invalidates every pane ID we hold. Hard
  // reload the renderer so xterm widgets, WebSockets, and pane state
  // all get rebuilt against the fresh pane ids.
  let lastUptimeSec = -1;

  // Hybrid mode (an earlier release, plan rev 3.1, Phase 4): two
  // DaemonConnection instances, one per enabled host, with
  // independent poll loops and error state. The registry mirrors
  // `apiForHost` — initialised once with settings + boot callbacks,
  // accessed by host. Phase 4 keeps the single-display status bar:
  // we wire `connInfo` from the *primary* host's events
  // (`derivedMode`-resolved, currently station-if-enabled-else-local)
  // until a later phase extends the status bar to surface both
  // hosts. Local's events still run through the registry so Phase 9
  // (project-list push) and later UI aggregation plug in without a
  // second rewrite.
  // Drives the startup splash off the real boot pipeline. Dismissed
  // once the first project is rendered — or shortly after, if there
  // are none / the daemon is unreachable. We don't want to trap the
  // user behind the splash on a bad network. A single-shot guard so
  // the safety timer and the happy-path poll callback don't race.
  let splashDismissed = false;
  function markBootReady() {
    if (splashDismissed) return;
    splashDismissed = true;
    splash?.step("ready");
    void splash?.dismiss();
  }
  // Safety net: never leave the splash up for more than ~5s. The
  // status bar's CONN indicator takes over the "is it up?" job from
  // here.
  const splashSafetyTimer = window.setTimeout(markBootReady, 5000);

  // Decouples rail population from the health-probe gate: `refreshProjects`
  // runs fire-and-forget so a slow/failing `/projects` can never throw out
  // of `onPollSuccess` and bounce CONN back to `reconnecting`. Auto-select,
  // splash advancement, and boot-ready all run in the success continuation.
  const projectRefresher = new ProjectRefresher<Project>({
    refresh: refreshProjects,
    onError: (msg) => {
      if (projectsError === msg) return;
      projectsError = msg;
      renderStatus();
    },
    onResult: async (projects, { firstSuccess, firstNonEmpty }) => {
      if (!currentProjectId && projects.length > 0) {
        if (firstNonEmpty) splash?.step("layout");
        await selectProject(projects[0].id);
      }
      if (firstSuccess) {
        window.clearTimeout(splashSafetyTimer);
        markBootReady();
      }
    },
  });

  // Kicks an immediate remount on the genuine reconnecting→connected
  // recovery edge so the sshfs mount catches up with HTTP instead of
  // lagging the 60 s fuse-t watchdog. Station-only; debounced.
  const remountCoordinator = new RemountCoordinator({
    primaryHost,
    forceRemount: async () => {
      const res = await window.reckAPI.mount.forceRemount();
      mountState = res.state;
      renderStatus();
    },
  });

  initConnectionsForHost(settings, {
    pollIntervalMs: POLL_INTERVAL_MS,
    pollTimeoutMs: 5000,
    refreshTimeoutMs: 3000,
    onPollSuccess: async (host, health) => {
      // Project refresh, restore-prompt, and uptime-regression
      // detection all run against the *primary* client
      // (`client = apiForHost(primaryHost)` above). In a true hybrid
      // setup (station enabled) the project rail is station-owned per
      // rev 3.1's model ("only station projects exist"). When station
      // isn't enabled, `primaryHost` resolves to "local" and this
      // callback must drive `refreshProjects()` so the rail populates
      // and restore can offer to resurrect sessions — gate on
      // `host !== primaryHost` rather than hard-coding "station".
      //
      // Phase 9: local's success callback is no longer a pure no-op.
      // When local is the *secondary* host in a true-hybrid setup, we
      // still need to know when it first becomes healthy so we can
      // push the station project list down. That's why the local-
      // specific branch runs BEFORE the `host !== primaryHost`
      // early-return.
      if (host === "local" && settings.station?.enabled) {
        // True hybrid (station enabled): station is primary, local is
        // secondary. Every successful local probe is a chance to push —
        // the orchestrator itself short-circuits when the payload
        // fingerprint hasn't changed, so calling on every poll is
        // cheap and captures the "local daemon just came back from a
        // restart" case. Local-without-station setups skip this branch
        // because there's no station catalog to mirror.
        void pushStationProjectsToLocal();
      }
      // Record codex availability for EVERY host (before the primary-host
      // early-return) so the New-pane dialog can show the Codex button on
      // whichever host the user targets. `codex_available` is absent on
      // older daemons → coerced to false (button stays hidden).
      setHostCodexAvailable(host, health.codex_available === true);
      if (host !== primaryHost) return;
      if (lastUptimeSec >= 0 && health.uptime_sec < lastUptimeSec) {
        window.location.reload();
        return;
      }
      const firstSuccess = lastUptimeSec < 0;
      lastUptimeSec = health.uptime_sec;
      if (firstSuccess) splash?.step("projects");
      // Fire-and-forget: must NOT be awaited here. Awaiting the heavy
      // `/projects` fetch inside this gated handler is what made a
      // half-open Tailscale recovery bounce CONN back to "reconnecting".
      // The refresher is single-flight and never throws; rail repaint,
      // auto-select, splash dismissal, and the station→local push all
      // happen in its success continuation / inside refreshProjects.
      void projectRefresher.run();
    },
    onPollFailure: (host, _reason, e) => {
      // Route the failure through a pure, tested policy. The subtle rule:
      // a LOCAL 401 must self-heal even when it's the background host.
      // The local daemon's per-spawn bearer rotates on every (re)start,
      // so when the station is primary the local connection is polling in
      // the background with a stale token — if we gated the refresh
      // behind `host === primaryHost` (as an earlier draft did), local
      // would 401-loop and grey out until the whole app was restarted.
      // A STATION 401 stays host-aware: only prompt when it's the host
      // we're actively driving. Forwarding a background station 401 to
      // requestTokenUpdate would pop a blocking modal for a token the
      // user has no UI affordance to fix (flagged in the Phase 4 review);
      // the 1008-on-pane path keeps that host-aware separately.
      const action = decidePollFailureAction(host, primaryHost, e);
      if (action === "refresh-local-token") {
        // The user has no token to paste — main owns the per-spawn
        // bearer. Refresh from main and let the next poll retry; if the
        // daemon is really gone the request fails again and the
        // failure-log entry tells the operator what's up.
        console.info(
          "[poll] local 401: refreshing per-spawn token from main process",
        );
        void refreshLocalDaemonToken().catch((err) => {
          console.warn("[poll] local token refresh failed after 401", err);
        });
      } else if (action === "prompt-station-token") {
        const reason =
          "Station rejected the current token. Paste a fresh one to reconnect.";
        void requestTokenUpdate(host, reason);
      }
    },
    onConnectionInfo: (host, info) => {
      // Phase 9: ready-flag transitions are the policy the registry
      // deliberately stays out of. Station ready ≡ connected (no
      // prerequisites). Local disconnects invalidate the last pushed
      // fingerprint so the next reconnect forces a fresh PUT, and
      // clear the push-error surface so a returning daemon visibly
      // re-arms the rail. These run for BOTH hosts — not gated on
      // `mode` — because the ready flag is consumed by Phase 10's
      // host picker regardless of which host is primary.
      if (host === "station") {
        setHostReady("station", info.state === "connected");
        // Auto-remount on the recovery edge.
        remountCoordinator.onConn(info.state);
      } else if (host === "local") {
        if (info.state !== "connected") {
          setHostReady("local", false);
          // Force the next reconnect to re-push even if the catalog
          // hasn't changed — the local daemon lost its in-memory map.
          pushState.lastPushedFingerprint = null;
        }
      }
      // Phase 4: status bar is still single-display. Forward only
      // the primary host's info (matches the existing CONN dot
      // semantics). A later phase may extend the status bar to
      // surface both hosts; until then local's info is consumed by
      // the registry but not surfaced.
      if (host !== primaryHost) return;
      connInfo = info;
      // When the station goes unreachable (not a token problem), probe
      // Tailscale so the inline reason can say whether to fix this Mac or
      // the station; clear the verdict once we recover.
      if (primaryHost === "station") {
        if (info.state === "connected") {
          tailscaleVerdict = null;
        } else if (info.lastError !== "Unauthorized") {
          void refreshTailscaleVerdict();
        }
      }
      renderStatus();
    },
  });

  // Start each enabled host's poll loop. Independent setIntervals —
  // a station outage doesn't pause local, and vice versa.
  for (const host of enabledHosts()) {
    connectionForHost(host).start();
  }

  // The "primary" connection drives the status bar refresh button
  // and is what `forceRefresh()` fans out to. Phase 11 will widen
  // this to refresh every connection in parallel; Phase 4 keeps the
  // single-host UI semantics.
  const primaryConnection = connectionForHost(primaryHost);

  // Invoked by the status-bar refresh button. Fans out to the
  // primary daemon connection (which cancels its in-flight/pending
  // probe and attempts immediately with a 3 s timeout) and to the
  // mount kickstart IPC in parallel. Errors from either are
  // collected and surfaced as a single thrown message so the button
  // can show its error state with a specific reason.
  async function forceRefresh(): Promise<void> {
    const results = await Promise.allSettled([
      primaryConnection.refresh(),
      window.reckAPI.mount.forceRemount(),
    ]);
    // Share the cooldown so the auto-remount coordinator doesn't fire a
    // second kickstart right after this manual one.
    remountCoordinator.noteRemount();
    const mountResult = results[1];
    if (mountResult.status === "fulfilled") {
      mountState = mountResult.value.state;
      renderStatus();
    }
    const failures: string[] = [];
    if (results[0].status === "rejected") {
      failures.push(`daemon: ${describeError(results[0].reason)}`);
    }
    if (mountResult.status === "rejected") {
      failures.push(
        `mount: ${(mountResult.reason as Error)?.message ?? "unknown error"}`,
      );
    } else if (!mountResult.value.ok) {
      failures.push(`mount: ${mountResult.value.error ?? "remount failed"}`);
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
  }
  // When the desktop regains focus, reassert our terminal dimensions
  // against the shared PTY — another client may have resized it while
  // we were in the background.
  window.addEventListener("focus", () => layout.refitActive());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) layout.refitActive();
  });
}
