// Detached pane popout entry .
//
// Boots a single TerminalPane in its own BrowserWindow. The window is
// parent-less so the user can drag it to a second monitor and leave it
// there — the daemon's 64KB ring buffer replays scrollback on (re)
// connect, so the popout's xterm picks up where the main-window pane
// left off without any explicit state transfer.
//
// Lifecycle:
//   - main spawns the BrowserWindow with `?pane=&project=&host=&title=`.
//   - this script reads those, loads settings from IPC (same path the
//     main renderer takes), builds the WS URL, mounts xterm.
//   - on Reattach (button or ⌘W or OS close), main fires `closed` and
//     notifies the main window, which then folds the pane back into
//     its slot.

import "@xterm/xterm/css/xterm.css";
import { TerminalPane } from "@client-core/terminal/terminal-pane";
import { installPathLinkProvider } from "./viewer/PathLinkProvider";
import { installUrlLinkProvider } from "./viewer/UrlLinkProvider";
import { resolveActivatePath } from "./viewer/resolveActivatePath";
import { createWindowHeader } from "./ui/window-header";
import { initContentZoom, zoomedTerminalFontSize } from "./ui/content-zoom";
import type { HostRef } from "./host";
// `loadSettings` reads via the same IPC channels the main renderer uses;
// the popout's preload exposes the same `reckAPI` surface, so this works
// unchanged. Theme is loaded the same way for parity with the main
// window's first paint.
import { loadSettings, loadTheme } from "./config";
import { initTts } from "./tts/initTts";
import { TerminalPaneAdapter } from "./tts/TerminalPaneAdapter";
import { initSearch } from "./search/initSearch";
import { TerminalSearchAdapter } from "./search/TerminalSearchAdapter";
import { MarkdownSearchAdapter } from "./search/MarkdownSearchAdapter";
import { createOverlayScrollbar } from "./search/OverlayScrollbar";
import { terminalScrollSurface } from "./search/scrollSurfaces";
import { ApiClient } from "@client-core/api/client";
import { createTranscriptController } from "./transcript/TranscriptController";
import { resolveTranscriptSession } from "./transcript/resolveSession";
import { ensurePaneControls, ensureHistoryButton } from "./ui/paneControls";
import { iconHistory } from "./ui/icons";

const DEFAULT_LOCAL_PORT = 7315;

/**
 * Build the bearer subprotocol list for the popout's WS connection.
 * Mirrors `ApiClient.wsSubprotocols()` — duplicated here rather than
 * pulling in the full client because the popout doesn't need any of
 * the HTTP plumbing, just the WS URL + bearer.
 */
function wsSubprotocols(token: string | undefined | null): string[] {
  if (!token) return [];
  return [`reck-bearer.${token}`];
}

/**
 * Resolve the daemon base URL + bearer token for a given host. For
 * local, the daemon URL is `127.0.0.1:<port>` and the per-spawn token
 * is fetched from main via the existing `daemon:localToken` channel.
 * For station, the URL + token come from the persisted settings blob.
 */
async function resolveHost(
  host: HostRef,
): Promise<{ baseUrl: string; token: string | null } | { error: string }> {
  const settings = await loadSettings();
  if (!settings) return { error: "settings not configured" };
  if (host === "local") {
    if (!settings.local) return { error: "local host not configured" };
    const port = settings.local.port || DEFAULT_LOCAL_PORT;
    const token = await window.reckAPI.daemon.localToken();
    return { baseUrl: `http://127.0.0.1:${port}`, token };
  }
  if (!settings.station?.enabled) return { error: "station host not enabled" };
  if (!settings.station.url) return { error: "station URL not configured" };
  return {
    baseUrl: settings.station.url.replace(/\/$/, ""),
    token: settings.station.token ?? null,
  };
}

function renderError(root: HTMLElement, message: string): void {
  root.innerHTML = "";
  const err = document.createElement("div");
  err.className = "popout-error";
  err.textContent = `Couldn't open detached pane: ${message}`;
  root.appendChild(err);
}

async function bootPopout(): Promise<void> {
  const root = document.getElementById("popout");
  if (!root) {
    document.body.textContent = "Error: popout root missing";
    return;
  }

  const info = window.reckAPI.windows.getDetachedPaneInfo();
  if (!info) {
    renderError(root, "missing pane id in URL");
    return;
  }

  // Apply the persisted theme to the popout. The window already opens
  // with the right backgroundColor (main reads `theme` from storage
  // when constructing the BrowserWindow), but the html-level
  // data-theme attribute drives the per-element palette via CSS.
  const theme = await loadTheme();
  document.documentElement.setAttribute("data-theme", theme);

  const resolved = await resolveHost(info.host);
  if ("error" in resolved) {
    renderError(root, resolved.error);
    return;
  }

  // Header chrome: title + reattach button. -webkit-app-region: drag
  // on the header (set in styles.css) lets the user move the window
  // even when the OS title bar is hidden by `titleBarStyle: hiddenInset`.
  // Shared window title bar — owns the traffic-light inset, the drag region
  // and the no-zoom rule. See ui/window-header.ts.
  const header = createWindowHeader("popout-header");
  const titleEl = document.createElement("div");
  titleEl.className = "popout-title";
  titleEl.textContent = info.title || info.paneId;
  const actions = document.createElement("div");
  actions.className = "popout-actions";
  const reattachBtn = document.createElement("button");
  reattachBtn.type = "button";
  reattachBtn.title = "Reattach to main window";
  reattachBtn.textContent = "Reattach";
  reattachBtn.addEventListener("click", () => {
    // Closing this popout via the IPC channel (rather than just
    // window.close()) keeps the OS-close path and the in-app reattach
    // path identical: main's `closed` handler fires for both, sends
    // `pane:popout-closed` to the main window, and the main window
    // restores the slot from the daemon ring buffer.
    void window.reckAPI.windows.reattachPane(info.paneId);
  });
  actions.appendChild(reattachBtn);
  header.appendChild(titleEl);
  header.appendChild(actions);
  root.appendChild(header);

  // Body holds the TerminalPane's container directly. The container
  // already carries class `pane-terminal` (set in TerminalPane's
  // constructor), so nesting another `.pane-terminal` wrapper would
  // double up the absolute-positioned layer and break FitAddon's
  // measurement of the leaf-most container.
  const body = document.createElement("div");
  body.className = "popout-body";
  root.appendChild(body);

  // WS URL mirrors `ApiClient.wsUrl(projectId, paneId)` — duplicated so
  // the popout doesn't need the full HTTP client. The daemon's WS
  // endpoint is the same regardless of which renderer (main or popout)
  // is connecting; the ring buffer replays on connect, so the popout
  // sees recent scrollback automatically.
  const wsBase = resolved.baseUrl.replace(/^http/, "ws");
  const wsUrl = `${wsBase}/ws/${encodeURIComponent(info.projectId)}/${encodeURIComponent(info.paneId)}`;

  // The pane's project cwd — the anchor that turns a bare filename or a
  // root-relative path from terminal scrollback into something openable.
  //
  // Filled in asynchronously below, once the ApiClient exists. Both link
  // handlers read it at CLICK time, which is always long after boot, so the
  // async fill is not a race in practice; a click before it lands simply
  // degrades to the absolute-only behaviour this window had before.
  //
  // A popout is pinned to one pane for its whole lifetime, so its project
  // can't change and one lookup is enough.
  let paneProjectCwd: string | null = null;

  const term = new TerminalPane({
    wsUrl,
    // Capture the token by reference: the local-daemon token can rotate
    // mid-session (rare for a popout's lifetime but cheap to handle).
    // For station the token is stable until the user updates it via
    // Preferences, which restarts the renderer anyway.
    wsSubprotocols: () => wsSubprotocols(resolved.token),
    theme,
  });
  body.appendChild(term.container);
  term.mount();
  // Content zoom. The terminal is a canvas, so it can't inherit a CSS
  // font-size — resize it through xterm instead, which reflows the grid and
  // re-fits the PTY. The subscription fires immediately, so a popout opened
  // while the app is already zoomed starts at the right size.
  const contentZoom = initContentZoom();
  contentZoom.subscribe((factor) => term.setFontSize(zoomedTerminalFontSize(factor)));
  // Install the file-path xterm linkifier on the popout's terminal so
  // detached panes behave like main-window panes — Cmd+click on a path in
  // scrollback opens the file viewer popup.
  //
  // Resolution mirrors the main window's pane handler (boot.ts): anchor the
  // click text against the pane's project cwd here, in the renderer, and
  // thread that cwd through the IPC.
  //
  // This used to pass the raw text with no cwd, on the assumption that main
  // would derive the project anchor itself. It can't: `rootRelativeCandidate`
  // returns null without a cwd, so `docs/x.md` reached `isStationPathSafe`
  // still relative and was rejected ("not an absolute POSIX path"). Detached
  // windows could therefore only open already-absolute paths.
  //
  // `originalText` carries the pre-resolution text so main can tell a
  // deterministic input (absolute, `~/x`) from a guess worth rescuing with the
  // suffix-fallback search — that is what makes a bare filename still open
  // when the anchored guess misses.
  //
  // `info.host` lets main expand `~/` against the right home and route station
  // paths through the local sshfs mount.
  installPathLinkProvider(term.getXterm(), {
    resolveBatch: (paths) => window.reckAPI.files.resolve(paths),
    onActivate: (filePath) => {
      const target = resolveActivatePath(filePath, paneProjectCwd);
      console.log("[click:popout-pane] activate -> openInViewer", {
        paneId: info.paneId,
        sourceHost: info.host,
        projectCwd: paneProjectCwd,
        originalText: filePath,
        target,
      });
      void window.reckAPI.files.openInViewer(target, {
        sourceHost: info.host,
        originalText: filePath,
        projectCwd: paneProjectCwd ?? undefined,
      });
    },
  });
  // Clickable http/https URLs in the popout terminal too. ⌘-click →
  // window.open → main's setWindowOpenHandler → shell.openExternal.
  installUrlLinkProvider(term.getXterm(), {
    onActivateUrl: (url) => {
      window.open(url, "_blank", "noopener");
    },
  });

  // Wire the unified TTS subsystem into the popout. Detached panes share
  // the same controller + control bar + shortcuts as the main window.
  void (async () => {
    try {
      await initTts({
        getActiveSpeakSurface: () => {
          // An open History overlay owns TTS for this pane (#51) — speak the
          // rendered transcript, mirroring the ⌘F switch below.
          const overlay = transcripts.get(panePaneId);
          if (overlay) return overlay.view.getSpeakSurface();
          const xterm = term.getXterm();
          const xtermEl = (xterm.element as HTMLElement | undefined) ?? body;
          const dims = (xterm as unknown as {
            _core?: { _renderService?: { dimensions?: {
              css?: { cell?: { width?: number; height?: number } };
              actualCellWidth?: number;
              actualCellHeight?: number;
            } } };
          })._core?._renderService?.dimensions;
          const cellWidth = dims?.css?.cell?.width ?? dims?.actualCellWidth ?? 8;
          const cellHeight = dims?.css?.cell?.height ?? dims?.actualCellHeight ?? 16;
          return new TerminalPaneAdapter({
            term: xterm as unknown as ConstructorParameters<typeof TerminalPaneAdapter>[0]["term"],
            xtermEl,
            containerEl: ensurePaneControls(body),
            cellWidth,
            cellHeight,
          });
        },
      });
    } catch (e) {
      console.warn("[popout] TTS disabled:", e);
    }
  })();

  // Transcript "History" overlay (#51) — parity with the main window's
  // per-pane toggle, driven by the same TranscriptController (visible
  // loading/error/no-session states + `[transcript]` logging). The
  // popout URL doesn't carry the pane's kind, so gate the button on
  // whether a Claude session actually resolves for this pane
  // (shell/codex popouts simply never get the button).
  const api = new ApiClient({
    baseUrl: resolved.baseUrl,
    token: resolved.token ?? undefined,
  });

  // Resolve the pane's project cwd (declared above) from the daemon catalog —
  // the same source the main window's `currentProjects` comes from.
  //
  // Failure leaves it null on purpose. An ABSENT cwd degrades to absolute-only
  // resolution, which is what this window did before; a WRONG cwd would poison
  // main's rescue pipeline, so a project that isn't in the catalog is treated
  // as "no anchor" rather than guessed at.
  void (async () => {
    try {
      const res = await api.listProjects();
      const match = res.projects.find((p) => p.id === info.projectId);
      paneProjectCwd = match?.cwd ?? null;
      if (!match) {
        console.warn(
          `[popout] project ${info.projectId} not in the daemon catalog — ` +
            "relative path clicks will not resolve",
        );
      }
    } catch (e) {
      console.warn("[popout] project cwd lookup failed:", e);
    }
  })();
  // Narrowed copies for the closures below — TS drops the `!info`
  // guard's narrowing inside nested functions.
  const panePaneId = info.paneId;
  const paneProjectId = info.projectId;
  const paneTitle = info.title;
  const paneHost = info.host;
  const transcripts = createTranscriptController({
    resolvePane: () => ({
      wrapper: body,
      kind: "claude", // gated below: button only exists when a session resolves
      host: paneHost,
      title: paneTitle || "Claude",
    }),
    projectId: () => paneProjectId,
    api: () => api,
    // ⌘+click a path in the transcript → open it in the file viewer. Mirrors
    // this popout's pane linkifier (above): anchor against the pane's project
    // cwd in the renderer, then thread that cwd through the IPC. Main cannot
    // anchor a relative path on its own — see the linkifier comment above.
    linkHandlers: () => ({
      onLinkActivate: (href) => {
        const target = resolveActivatePath(href, paneProjectCwd);
        console.log("[click:popout-transcript] activate -> openInViewer", {
          sourceHost: paneHost,
          projectCwd: paneProjectCwd,
          originalText: href,
          target,
        });
        void window.reckAPI.files.openInViewer(target, {
          sourceHost: paneHost,
          originalText: href,
          projectCwd: paneProjectCwd ?? undefined,
        });
      },
      // ⌘+click an http/https URL in the transcript → OS default browser.
      onExternalActivate: (href) => {
        window.open(href, "_blank", "noopener");
      },
    }),
  });

  void (async () => {
    try {
      const sessionId = await resolveTranscriptSession({
        paneId: panePaneId,
        listSessions: () => api.listSessions(paneProjectId),
      });
      if (!sessionId) return; // not a Claude pane (or no transcript yet)
      // History (clock) lives in the top-right control stack, alongside
      // search + TTS — same component as the main window.
      ensureHistoryButton(body, {
        icon: iconHistory,
        onToggle: () => void transcripts.toggle(panePaneId),
      });
    } catch (e) {
      console.warn("[popout] history disabled:", e);
    }
  })();

  // In-view search (⌘/Ctrl+F) + overlay scrollbar for the detached pane.
  try {
    const scrollbar = createOverlayScrollbar({
      host: body,
      surface: terminalScrollSurface(
        term.getXterm() as unknown as Parameters<typeof terminalScrollSurface>[0],
        (bytes) => term.sendInput(bytes),
      ),
    });
    initSearch({
      getActiveSearchSurface: () => {
        // An open History overlay owns ⌘F (#51) — search the whole
        // transcript rather than the terminal's visible rows. The bar
        // mounts into the popout body's stack (with the history clock +
        // TTS bar), not a nested one inside the overlay — one stack,
        // History always at the bottom.
        const overlay = transcripts.get(panePaneId);
        if (overlay) {
          return new MarkdownSearchAdapter({
            container: ensurePaneControls(body),
            body: overlay.view.body,
          });
        }
        return new TerminalSearchAdapter({
          container: ensurePaneControls(body),
          term: term.getXterm() as unknown as ConstructorParameters<
            typeof TerminalSearchAdapter
          >[0]["term"],
        });
      },
      onMatchesChanged: (fractions) => {
        const overlay = transcripts.get(panePaneId);
        if (overlay) {
          overlay.view.setMatches(fractions);
          return;
        }
        scrollbar.setMatches(fractions);
      },
    });
  } catch (e) {
    console.warn("[popout] search disabled:", e);
  }
  // First-paint guard: even though TerminalPane installs a
  // ResizeObserver, it skips fitting when the container measures 0×0
  // (FitAddon would otherwise clamp to 2×1 and ship that to the PTY).
  // The popout's grid layout occasionally hasn't resolved by the time
  // mount() measures, so explicitly reassert on the next frame once
  // the browser has done a layout pass.
  requestAnimationFrame(() => term.refit());

  // Refit on window resize — the popout owns its own ResizeObserver
  // wiring inside TerminalPane; this is just the explicit reassertion
  // hook we use in the main window for window-focus, kept for parity.
  window.addEventListener("resize", () => term.refit());

  // ⌘W from inside the popout closes the window — Electron's default
  // accelerator hits the focused webContents first; fall back to a
  // window.close() if the OS didn't intercept. Same code path as the
  // OS close button via main's `closed` handler.
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
      e.preventDefault();
      void window.reckAPI.windows.reattachPane(info.paneId);
    }
  });
}

void bootPopout();
