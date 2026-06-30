import { app, BrowserWindow, ipcMain, Menu, dialog, shell, clipboard } from "electron";
import path from "node:path";
import { readConfig, writeConfig, hasConfigKey, isAllowedConfigKey } from "./storage";
import {
  startDaemon,
  stopDaemon,
  isDaemonRunning,
  findDaemonBinary,
  daemonStatus,
  isValidHost,
  localDaemonToken,
} from "./daemon-spawn";
import { registerRsyncIpc } from "./rsync-copy";
import { checkExternalUrl, resolveInsideMountPoint } from "./ipc-validation";
import { planMigration } from "./settings-migration";
import { planBootstrapImport } from "./bootstrap-import";
import {
  registerFileViewerIpc,
  closeAllFileViewers,
  type CreateViewerOptions,
} from "./file-viewer";
import { composeFileViewerRoots } from "./file-roots";

// Pin the Electron app name before any path / safeStorage resolution.
//
// In packaged builds Electron reads the name from the asar-bundled
// package.json ("reck-connect-satellite"). Under `pnpm dev` it is launched
// as `electron dist/main/main.js` with no adjacent package.json, so it
// falls back to "Electron". That drift repoints `app.getPath("userData")`
// and the safeStorage keychain entry, so a dev run can't decrypt the
// station token / settings / layouts a packaged run wrote. Calling setName
// here aligns both modes onto the packaged name (a no-op when packaged).
app.setName("reck-connect-satellite");

let mainWindow: BrowserWindow | null = null;

// Detached pane popouts . Per-pane parent-less BrowserWindows
// the user can drag to a second monitor and leave there. Keyed by pane id;
// values evicted on `closed` and `render-process-gone`. The map is the
// source of truth for "is this paneId currently detached?" — both the
// `pane:detach` already-detached short-circuit and `closeAllPopouts()`
// iterate it.
const paneWindows = new Map<string, BrowserWindow>();

// Bug #2 S1 (2026-05-24): the previous "daemon survives Satellite quit"
// design was reversed. Quit now stops the local daemon, but only after a
// confirmation dialog so the user knows their Claude/shell sessions are
// about to die. `quitConfirmed` is the latch that lets the second pass
// through the close/before-quit pipeline (after the user clicked Quit)
// actually exit, instead of looping the dialog forever.
let quitConfirmed = false;

// Concurrent-trigger guard: window-X and Cmd-Q can fire while a dialog is
// already open (the window dialog is sheet-modal but Cmd-Q still fires
// `before-quit` independently). Without this latch the second trigger
// stacks an app-modal duplicate of the same prompt.
let quitDialogOpen = false;

// Returns true if quit may proceed (either no local daemon to worry about,
// or the user explicitly clicked the "Quit" button). Returns false if the
// caller should preventDefault and let the user keep using the app.
//
// On confirm this also awaits `stopDaemon("local", …)` so the Go daemon
// gets a chance to flush + release its port (escalates to SIGKILL after
// 3s, sweeps orphan listeners). The `will-quit` hook in daemon-spawn.ts
// is a SIGTERM fallback for paths that bypass this dialog (e.g. an
// updater calling `app.quit()` directly, or anything that triggers
// `app.exit()` without confirmation).
async function confirmQuitWithLocalDaemon(
  parent: BrowserWindow | null,
): Promise<boolean> {
  if (quitConfirmed) return true;
  if (quitDialogOpen) return false; // another trigger is already prompting
  if (!isDaemonRunning("local")) {
    quitConfirmed = true;
    return true;
  }
  quitDialogOpen = true;
  try {
    const opts = {
      type: "warning" as const,
      buttons: ["Cancel", "Quit Reck Connect"],
      defaultId: 0,
      cancelId: 0,
      message: "Quit Reck Connect?",
      detail:
        "Closing Reck Connect will stop the local daemon and terminate all running Claude and shell sessions on it. The station daemon (if connected) is unaffected.",
    };
    const target = parent && !parent.isDestroyed() ? parent : null;
    const res = await (target
      ? dialog.showMessageBox(target, opts)
      : dialog.showMessageBox(opts));
    if (res.response !== 1) return false;
    quitConfirmed = true;
    try {
      await stopDaemon("local", getLocalPort());
    } catch (err) {
      // Failures here are unusual (stopDaemon always resolves), but if
      // something goes wrong we'd rather log and quit than wedge the UI.
      console.warn(`[satellite] stopDaemon during quit failed: ${String(err)}`);
    }
    return true;
  } finally {
    quitDialogOpen = false;
  }
}

const isDev = !!process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === "development";

// Must mirror the renderer's DEFAULT_LOCAL_PORT (renderer/src/config.ts) and
// the migration default in settings-migration.ts — drift would make the
// renderer probe a different port than what the daemon binds.
const DEFAULT_LOCAL_PORT = 7315;

// Resolve the local-daemon port from persisted settings. Falls back to the
// default when settings are missing (fresh install) or the port field is
// unexpectedly absent/invalid. Used at every daemon-lifecycle call site so
// the spawned daemon binds the port the renderer is about to probe.
function getLocalPort(): number {
  const settings = readConfig("settings") as
    | { local?: { port?: unknown } }
    | null;
  const raw = settings?.local?.port;
  const port = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : DEFAULT_LOCAL_PORT;
}

function createWindow() {
  // Pick the window's background to match the saved theme so the startup
  // splash doesn't flash cream-on-dark for dark-theme users. Falls back to
  // cream when nothing is stored yet (first launch).
  const savedTheme = readConfig("theme");
  const bgColor = savedTheme === "dark" ? "#141413" : "#f7f4ed";

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Reck Connect Satellite",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: bgColor,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only forward allowlisted schemes (see ipc-validation.ts). A compromised
    // renderer could otherwise call `window.open('mailto:…')` /
    // `x-apple-reminderkit://…` / custom handlers and force the main process
    // to invoke arbitrary OS scheme handlers. Warn loudly on reject so the
    // cause of a silent no-op is visible in the main-process log.
    const check = checkExternalUrl(url);
    if (check.ok) {
      shell.openExternal(check.url);
    } else {
      console.warn(
        `[satellite] rejected window.open: ${check.reason}; url=${JSON.stringify(url)}`,
      );
    }
    return { action: "deny" };
  });

  mainWindow.webContents.once("did-finish-load", () => {
    void tickMount();
  });

  // an earlier release: when the main window closes, tear down every detached
  // pane popout and quit the app — closing a popout's last sibling
  // (i.e. main) is the standard macOS "I'm done" gesture, and leaving
  // the popouts visible after the rest of the app is gone produces
  // orphan windows the user can't reach the menu of. Clearing
  // `mainWindow` first means the activate-handler guard below
  // (`mainWindow === null || mainWindow.isDestroyed()`) correctly
  // recreates the main window if the user re-activates the app from
  // the dock.
  // Bug #2 S1: intercept window-X to prompt before tearing down the local
  // daemon. Without this hook, `closed` fires first (destroying the
  // window), then app.quit() → before-quit dialog would have no parent
  // window to attach to and "Cancel" would leave the user stranded with
  // no UI. Doing the dialog at `close` time keeps the window alive on
  // cancel; on confirm we destroy it and let the existing `closed`
  // handler propagate the quit.
  mainWindow.on("close", (e) => {
    if (quitConfirmed) return;
    e.preventDefault();
    void (async () => {
      if (await confirmQuitWithLocalDaemon(mainWindow)) {
        mainWindow?.destroy();
      }
    })();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    closeAllPopouts();
    closeAllFileViewers();
    // Decision A: main close = app quit on every platform. The legacy
    // `window-all-closed` handler below only quits on non-darwin; this
    // explicit quit avoids the popout-only edge where main is gone but
    // popouts kept the app alive on macOS.
    app.quit();
  });
}

/**
 * Create a parent-less popout window for `paneId`. Parent-less is
 * deliberate: a parented BrowserWindow follows its parent across macOS
 * Spaces, defeating the entire feature. `bounds` is best-effort initial
 * geometry from the renderer's `getBoundingClientRect()` plus the main
 * window's `screenX`/`screenY`; missing fields fall back to a sensible
 * 800x600 default at OS-chosen origin.
 *
 * `projectId`, `host`, and `title` ride along in the URL query so the
 * popout's renderer (which has its own isolated process and no access
 * to the main window's settings/state) can build the WebSocket URL
 * without an extra IPC round-trip. Token is fetched separately from the
 * popout via the existing `daemon:localToken` / config key paths.
 */
function createPaneWindow(
  paneId: string,
  meta: { projectId: string; host: "station" | "local"; title?: string },
  bounds?: { width?: number; height?: number; x?: number; y?: number },
): BrowserWindow {
  // Match the main window's theme decision so the popout's first paint
  // doesn't flash cream-on-dark for dark-theme users.
  const savedTheme = readConfig("theme");
  const bgColor = savedTheme === "dark" ? "#141413" : "#f7f4ed";

  const win = new BrowserWindow({
    width: bounds?.width ?? 800,
    height: bounds?.height ?? 600,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 320,
    minHeight: 200,
    title: meta.title ? `Reck — ${meta.title}` : "Reck — Detached Pane",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: bgColor,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 },
  });

  // Use a query string (NOT a hash) so the popout boot script can read
  // values via `URL.searchParams.get(...)` without worrying about
  // fragment-only navigation quirks across reloads. All values are
  // encoded; the main window has already validated paneId/projectId
  // against its tree before invoking detach.
  const params = new URLSearchParams({
    pane: paneId,
    project: meta.projectId,
    host: meta.host,
  });
  if (meta.title) params.set("title", meta.title);
  const queryString = params.toString();
  if (isDev) {
    win.loadURL(`http://localhost:5173/popout.html?${queryString}`);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/popout.html"), {
      search: `?${queryString}`,
    });
  }

  // Apply the same window.open allowlist as the main window. A
  // compromised popout renderer could otherwise force the main process
  // to invoke arbitrary OS scheme handlers via window.open.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const check = checkExternalUrl(url);
    if (check.ok) {
      shell.openExternal(check.url);
    } else {
      console.warn(
        `[satellite] popout rejected window.open: ${check.reason}; url=${JSON.stringify(url)}`,
      );
    }
    return { action: "deny" };
  });

  // Cleanup: both `closed` AND `render-process-gone` may fire (the
  // latter when the renderer crashes without producing an OS-level
  // close). Keep both handlers idempotent — a renderer crash typically
  // emits `render-process-gone` first, then `closed` once Electron
  // tears down the wrapper. The `paneWindows.delete` is a no-op on the
  // second call; the `notify` short-circuits if the entry's already
  // gone so we don't double-notify the main window.
  const cleanup = () => {
    if (!paneWindows.has(paneId)) return;
    paneWindows.delete(paneId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pane:popout-closed", paneId);
    }
  };
  win.on("closed", cleanup);
  win.webContents.on("render-process-gone", () => {
    // Force-close the wrapper so the OS window goes away even if the
    // renderer crashed mid-paint. `closed` will fire next and call
    // `cleanup` again — that's fine, it's a no-op the second time.
    if (!win.isDestroyed()) win.close();
    cleanup();
  });

  paneWindows.set(paneId, win);
  return win;
}

/**
 * Close every detached pane popout. Used during main-window close; also
 * available as a defensive sweep if a popout misses its own cleanup
 * handler. Iterates a snapshot so the `closed` handler's
 * `paneWindows.delete` doesn't disturb iteration.
 */
function closeAllPopouts(): void {
  const snapshot = [...paneWindows.values()];
  paneWindows.clear();
  for (const win of snapshot) {
    if (!win.isDestroyed()) win.close();
  }
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Reck Satellite",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Add Project…",
          accelerator: "CmdOrCtrl+N",
          click: () => {
            mainWindow?.webContents.send("menu:add-project");
          },
        },
        { type: "separator" },
        {
          label: "Preferences…",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            // Phase 12 (an earlier release, plan rev 3.1): the old "Change
            // Connection Mode…" command cleared state and fell back to
            // the retired two-mode chooser. The hybrid preferences view
            // is non-destructive — each host has its own enable toggle
            // — so the menu item just tells the renderer to switch to
            // the settings-view without touching persisted config.
            mainWindow?.webContents.send("menu:preferences");
          },
        },
        {
          label: "Update Station Token…",
          click: () => {
            if (!mainWindow) return;
            // Phase 2: prefer the new settings blob; fall back to legacy
            // `mode` so a half-migrated config (or pre-migration boot)
            // still routes correctly.
            const settings = readConfig("settings") as
              | { station?: { enabled?: unknown } }
              | null;
            const stationEnabled = !!settings?.station?.enabled;
            const legacyMode = readConfig("mode") as string | null;
            const isStationMode = settings ? stationEnabled : legacyMode === "station";
            if (!isStationMode) {
              dialog.showMessageBox(mainWindow, {
                type: "info",
                message: "Station token only applies in Station mode.",
                detail:
                  "You're currently in Local mode. The local daemon on 127.0.0.1:7315 doesn't require a bearer token.",
              });
              return;
            }
            mainWindow.webContents.send("menu:update-token");
          },
        },
        {
          label: "Claude Code Launch…",
          click: () => {
            mainWindow?.webContents.send("menu:claude-launch");
          },
        },
        { type: "separator" },
        // Phase 5 (an earlier release, plan rev 3.1): "Quit Daemon" splits by host.
        // Only the local daemon is Satellite-spawned; the station daemon
        // is launchd-managed on the remote Mac Studio, so we expose it
        // as a disabled "info-only" entry rather than actively quitting
        // it. Future: a "Restart Station Daemon…" item could shell out to
        // `ssh station launchctl kickstart …` but that's out of scope here.
        {
          label: "Quit Local Daemon…",
          click: async () => {
            if (!isDaemonRunning("local")) {
              if (mainWindow) {
                dialog.showMessageBox(mainWindow, {
                  type: "info",
                  message: "Local daemon is not running.",
                });
              }
              return;
            }
            if (!mainWindow) return;
            const res = await dialog.showMessageBox(mainWindow, {
              type: "warning",
              buttons: ["Cancel", "Quit Daemon"],
              defaultId: 0,
              cancelId: 0,
              message: "Quit the local reck-stationd and kill all running sessions?",
              detail:
                "All open Claude and shell panes on the local daemon will be terminated. You'll need to re-open projects after starting the daemon again.",
            });
            if (res.response === 1) {
              await stopDaemon("local", getLocalPort());
              dialog.showMessageBox(mainWindow, {
                type: "info",
                message: "Local daemon stopped.",
              });
            }
          },
        },
        {
          label: "Station Daemon (remote, launchd-managed)",
          enabled: false,
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Phase 2 (an earlier release, plan rev 3.1): migrate the legacy
  // mode/stationUrl/daemonToken triplet into the new `settings` +
  // `station.token` keys. Idempotent — re-runs short-circuit on the
  // presence of "settings". Legacy keys are NOT deleted; they're held
  // one release for rollback. See ./settings-migration.ts.
  try {
    runSettingsMigration();
  } catch (e) {
    // Migration must never crash the app. The renderer will fall back to
    // the mode-chooser if loadSettings() returns null.
    console.error("[satellite] phase 2 migration: failed", e);
  }

  // First-launch bootstrap import: pick up `bootstrap.json` written by
  // `install-satellite.sh --write-settings` (the Claude-driven install
  // path) and turn it into encrypted settings via the normal storage
  // layer. No-op when the file is absent or settings are already
  // populated. See ./bootstrap-import.ts.
  try {
    runBootstrapImport();
  } catch (e) {
    console.error("[satellite] bootstrap import: failed", e);
  }

  try {
    // Read the migrated settings blob (or, on rollback, the legacy mode
    // key) to decide whether to spawn the local daemon at startup.
    // Reading "settings" first means a freshly-migrated user lands on
    // the same daemon-spawn path the legacy `mode === "local"` branch
    // hit before; reading "mode" as a fallback covers the gap before
    // the migration runs (e.g. a future rollback or test bypass).
    const settings = readConfig("settings") as
      | { local?: { enabled?: unknown; autoStart?: unknown } }
      | null;
    const localShouldAutoStart =
      !!(settings?.local?.enabled && settings.local.autoStart);
    const legacyMode = readConfig("mode");
    const legacyLocal = legacyMode === "local" && !settings;
    if (localShouldAutoStart || legacyLocal) {
      const bin = findDaemonBinary();
      if (!bin) {
        dialog.showMessageBox({
          type: "warning",
          message: "reck-stationd not found",
          detail:
            "Satellite is in Local mode but couldn't find the daemon binary.\n\n" +
            "Fix: run ops/install-local.sh, or build manually:\n" +
            "  cd v2 && go build -o ~/.local/bin/reck-stationd ./daemon/cmd/reck-stationd",
        });
      } else {
        // Phase 5 (an earlier release): explicit host arg. Auto-start only ever
        // applies to the local daemon — the station daemon is launchd-
        // managed remotely. Result is logged but not surfaced to the
        // renderer here; the renderer's first poll will observe the
        // outcome via the connection state.
        const result = await startDaemon("local", getLocalPort());
        if (!result.ok) {
          console.error(
            `[satellite] startup local daemon spawn failed (code=${result.code ?? "?"}): ${result.reason}`,
          );
        }
      }
    }
  } catch (e) {
    console.error("startup daemon check failed", e);
  }

  buildMenu();
  createWindow();

  app.on("activate", () => {
    // an earlier release: explicit `mainWindow` guard. The previous
    // `BrowserWindow.getAllWindows().length === 0` check broke when
    // popouts existed without a main window — dock-clicking the app
    // wouldn't recreate main because the popouts kept the window count
    // above zero. Tracking `mainWindow` directly (cleared in its own
    // `closed` handler) makes the guard match the actual contract:
    // "is the main window still around?"
    if (mainWindow === null || mainWindow.isDestroyed()) createWindow();
  });
});

// Bug #2 S1: intercept Cmd-Q / menu Quit (which bypasses the window's
// `close` event). On confirm we re-call `app.quit()`; the second pass
// short-circuits because `quitConfirmed` is now latched.
app.on("before-quit", (e) => {
  if (quitConfirmed) return;
  e.preventDefault();
  void (async () => {
    if (await confirmQuitWithLocalDaemon(mainWindow)) {
      app.quit();
    }
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// --- IPC: safeStorage-backed config ---
//
// `CONFIG_KEYS` (the runtime allowlist) lives in `storage.ts` so the storage
// layer's secret-key restriction can be tested against it without an Electron
// mock. The IPC boundary refuses anything not in the allowlist, returning
// `null` for `get` / `false` for `set` so a compromised renderer can't stash
// arbitrary JSON in the app's config file.

ipcMain.handle("config:get", (_e, key: unknown) => {
  if (!isAllowedConfigKey(key)) {
    console.warn(
      `[satellite] rejected config:get for unknown key: ${JSON.stringify(key)}`,
    );
    return null;
  }
  return readConfig(key);
});

ipcMain.handle("config:set", (_e, key: unknown, value: unknown) => {
  if (!isAllowedConfigKey(key)) {
    console.warn(
      `[satellite] rejected config:set for unknown key: ${JSON.stringify(key)}`,
    );
    return false;
  }
  // `writeConfig` throws when a secret key is being written but
  // `safeStorage` is unavailable. We let that propagate so the renderer's
  // existing rejection-handling for the secret-storage-unavailable path
  // still fires (changing it to a silent `false` would mask the user-facing
  // "couldn't save token" warning). The allowlist rejection above is the
  // only new failure mode introduced here, and it returns `false` per the
  // IPC contract (renderer treats falsy as "didn't save").
  writeConfig(key, value);
  return true;
});

// --- IPC: clipboard write ---
// OSC 52 copy-on-select routes through here so the write goes via Electron's
// main-process clipboard rather than the renderer's navigator.clipboard,
// which Electron only permits while the window has focus / a recent user
// gesture — making PTY-driven OSC 52 writes flaky.
ipcMain.handle("clipboard:write", (_e, text: unknown) => {
  clipboard.writeText(typeof text === "string" ? text : String(text ?? ""));
});

// --- IPC: daemon control ---
//
// Phase 5 (an earlier release, plan rev 3.1): every daemon channel takes a `host`
// arg. The handler validates it at the trust boundary — the renderer is
// the untrusted side, and a compromised renderer must not be able to
// spawn / inspect / kill arbitrary processes by passing an unrecognised
// host string. `isValidHost` is the closed allowlist; anything else
// returns a typed reject so the caller can surface "invalid host" rather
// than triggering a UI hang.

ipcMain.handle("daemon:status", (_e, host: unknown) => {
  if (!isValidHost(host)) {
    console.warn(
      `[satellite] rejected daemon:status for invalid host: ${JSON.stringify(host)}`,
    );
    return { running: false, binary: null };
  }
  return daemonStatus(host);
});

ipcMain.handle("daemon:start", async (_e, host: unknown) => {
  if (!isValidHost(host)) {
    console.warn(
      `[satellite] rejected daemon:start for invalid host: ${JSON.stringify(host)}`,
    );
    return { ok: false, reason: "invalid host" };
  }
  return await startDaemon(host, getLocalPort());
});

ipcMain.handle("daemon:stop", async (_e, host: unknown) => {
  if (!isValidHost(host)) {
    console.warn(
      `[satellite] rejected daemon:stop for invalid host: ${JSON.stringify(host)}`,
    );
    return { ok: false, reason: "invalid host" };
  }
  await stopDaemon(host, getLocalPort());
  return { ok: true };
});

// Per-spawn local-daemon bearer token. Lives in main-process memory
// only — never persisted, never logged. The renderer fetches via this
// channel after a successful `daemon:start("local")` and applies it to
// the local ApiClient via `setApiTokenForHost("local", token)`.
ipcMain.handle("daemon:localToken", () => localDaemonToken());

// --- IPC: folder picker for Add Project ---

ipcMain.handle("dialog:pickFolder", async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "Select a project folder",
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// --- IPC: Finder / mount ---

import { homedir } from "node:os";
import { statSync, readFileSync, unlinkSync } from "node:fs";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";

const MOUNT_POINT = path.join(homedir(), "reck", "projects");
const SENTINEL = path.join(MOUNT_POINT, ".reck-mount-sentinel");
const MOUNT_CHECK_INTERVAL_MS = 3_000;
// Race each stat() against this deadline so a hung sshfs (tailnet gone,
// remote unreachable) can't freeze the main process. Must stay < the
// tick interval so ticks don't queue up.
const MOUNT_STAT_TIMEOUT_MS = 2_000;
const MOUNT_AGENT_LABEL = "eu.verwey.reck-mount";

type MountState = "green" | "yellow" | "gray";
let lastMountOk = 0;
let mountState: MountState = "gray";
// Guards against piling up stats when the underlying sshfs stat is
// still hanging past the timeout — libuv can't cancel a pending fs op,
// so we simply skip the next tick until this one settles.
let checkInFlight = false;

async function checkMount(): Promise<MountState> {
  // Diagnostic logs : timestamp every stat() attempt, its
  // resolved outcome, and its latency so we can distinguish fast-cache
  // hits from real timeouts when reproducing a Tailscale drop.
  const startMs = Date.now();
  console.log(`[mount] ${startMs} checkMount start sentinel=${SENTINEL}`);
  try {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("stat timeout")),
        MOUNT_STAT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([stat(SENTINEL), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const elapsed = Date.now() - startMs;
    lastMountOk = Date.now();
    console.log(`[mount] ${Date.now()} checkMount ok elapsed=${elapsed}ms -> green`);
    return "green";
  } catch (e) {
    const elapsed = Date.now() - startMs;
    const reason = (e as Error)?.message ?? String(e);
    if (lastMountOk === 0) {
      console.log(
        `[mount] ${Date.now()} checkMount fail elapsed=${elapsed}ms reason=${reason} -> gray (never-seen)`,
      );
      return "gray";
    }
    console.log(
      `[mount] ${Date.now()} checkMount fail elapsed=${elapsed}ms reason=${reason} -> yellow (lastOk=${lastMountOk} ageMs=${Date.now() - lastMountOk})`,
    );
    return "yellow";
  }
}

async function tickMount() {
  if (checkInFlight) {
    console.log(`[mount] ${Date.now()} tickMount skipped (in-flight)`);
    return;
  }
  checkInFlight = true;
  try {
    const next = await checkMount();
    if (next !== mountState) {
      console.log(
        `[mount] ${Date.now()} tickMount transition ${mountState} -> ${next}`,
      );
      mountState = next;
      mainWindow?.webContents.send("mount:status", mountState);
    }
  } finally {
    checkInFlight = false;
  }
}

setInterval(() => void tickMount(), MOUNT_CHECK_INTERVAL_MS);
// Fire immediately on window ready — see hookup below.

ipcMain.handle("mount:status", () => mountState);

// Hybrid mode rev 3.1, phase 9: the renderer needs the absolute local
// mount-point path to translate station-side project cwds
// (/Users/reck-connect/projects/<id>) into their sshfs-mounted copies on
// the laptop ($HOME/reck/projects/<id>) for PUT /projects against the
// local daemon. Keeping the string-building in main means the renderer
// never sees a home directory literal; it also avoids a lazy drift if
// the mount root ever moves — there's only one definition to update.
ipcMain.handle("paths:localMountPoint", () => MOUNT_POINT);

function runLaunchctlKickstart(label: string): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid == null) {
    return Promise.reject(new Error("process.getuid unavailable"));
  }
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/launchctl",
      ["kickstart", "-k", `gui/${uid}/${label}`],
      { timeout: 5000 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
          return;
        }
        resolve();
      },
    );
  });
}

function waitForSentinel(deadlineMs: number, pollMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + deadlineMs;
    const tick = () => {
      try {
        statSync(SENTINEL);
        resolve(true);
        return;
      } catch {
        // fall through
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/**
 * Force the mount watchdog LaunchAgent to re-run immediately instead of
 * waiting out its 60 s StartInterval. The watchdog unmounts a stale
 * handle if any, then re-runs sshfs — so this is the real "remount"
 * action, distinct from `mount:status` which is just observation.
 */
ipcMain.handle(
  "mount:forceRemount",
  async (): Promise<{ ok: boolean; state: MountState; error?: string }> => {
    try {
      await runLaunchctlKickstart(MOUNT_AGENT_LABEL);
    } catch (e) {
      // Agent not loaded, kickstart failed, etc. Still re-check so the
      // dot reflects reality.
      await tickMount();
      return { ok: false, state: mountState, error: (e as Error).message };
    }
    const ok = await waitForSentinel(3000);
    // Seed lastMountOk so checkMount() returns green next time even if
    // Finder hasn't probed the mount yet.
    if (ok) lastMountOk = Date.now();
    await tickMount();
    return { ok, state: mountState, error: ok ? undefined : "Remount timed out" };
  },
);

ipcMain.handle("shell:openPath", async (_e, projectSlug: string) => {
  // A compromised renderer can pass `../../Applications` (or similar) as the
  // slug; `path.join` happily normalizes traversal segments. Require the
  // resolved target to stay strictly inside MOUNT_POINT; log and refuse
  // anything else so the caller can see *why* an open got no-op'd.
  const target = resolveInsideMountPoint(MOUNT_POINT, projectSlug);
  if (!target) {
    console.warn(
      `[satellite] rejected shell:openPath outside mount: ${JSON.stringify(projectSlug)}`,
    );
    return { ok: false, error: "invalid project slug" };
  }
  const err = await shell.openPath(target);
  return err === "" ? { ok: true } : { ok: false, error: err };
});

// --- IPC: detached pane windows  ---
//
// `pane:detach` opens a parent-less BrowserWindow for `paneId` (or
// focuses the existing one if a popout for that pane is already up).
// `pane:reattach` closes the popout — the `closed` handler then sends
// `pane:popout-closed` to mainWindow, which restores the slot in the
// split tree.
//
// `paneId` is treated as opaque: it's the daemon's pane id (already
// validated by the daemon when the pane was created) and only used as a
// map key + URL query param. Bounds are clamped to sane defaults inside
// `createPaneWindow` so a malicious renderer can't size a popout to
// 0x0 or off-screen.

ipcMain.handle(
  "pane:detach",
  (
    _e,
    args: {
      paneId?: unknown;
      projectId?: unknown;
      host?: unknown;
      title?: unknown;
      bounds?: { width?: unknown; height?: unknown; x?: unknown; y?: unknown };
    },
  ): { ok: true } | { ok: false; reason: string } => {
    const paneId = args?.paneId;
    if (typeof paneId !== "string" || paneId.length === 0) {
      console.warn(
        `[satellite] rejected pane:detach for invalid paneId: ${JSON.stringify(paneId)}`,
      );
      return { ok: false, reason: "invalid paneId" };
    }
    const projectId = args?.projectId;
    if (typeof projectId !== "string" || projectId.length === 0) {
      console.warn(
        `[satellite] rejected pane:detach for invalid projectId: ${JSON.stringify(projectId)}`,
      );
      return { ok: false, reason: "invalid projectId" };
    }
    const host = args?.host;
    if (host !== "station" && host !== "local") {
      console.warn(
        `[satellite] rejected pane:detach for invalid host: ${JSON.stringify(host)}`,
      );
      return { ok: false, reason: "invalid host" };
    }
    const title = typeof args?.title === "string" ? args.title : undefined;
    const existing = paneWindows.get(paneId);
    if (existing && !existing.isDestroyed()) {
      // Already-detached: focus rather than spawn a duplicate. The
      // renderer treats "already-detached" as a no-op on its end (the
      // pane is presumably already in the placeholder state in the main
      // window's split tree); the focus call is a UX nicety so the user
      // sees the popout they were trying to open.
      existing.focus();
      return { ok: false, reason: "already-detached" };
    }
    // Defensive coercion: bounds is optional and best-effort; missing
    // or non-numeric fields fall back to the createPaneWindow defaults.
    const b = args?.bounds;
    const num = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    createPaneWindow(
      paneId,
      { projectId, host, title },
      {
        width: num(b?.width),
        height: num(b?.height),
        x: num(b?.x),
        y: num(b?.y),
      },
    );
    return { ok: true };
  },
);

ipcMain.handle(
  "pane:reattach",
  (_e, args: { paneId?: unknown }): { ok: true } | { ok: false; reason: string } => {
    const paneId = args?.paneId;
    if (typeof paneId !== "string" || paneId.length === 0) {
      console.warn(
        `[satellite] rejected pane:reattach for invalid paneId: ${JSON.stringify(paneId)}`,
      );
      return { ok: false, reason: "invalid paneId" };
    }
    const win = paneWindows.get(paneId);
    if (!win) return { ok: false, reason: "not-detached" };
    if (!win.isDestroyed()) win.close();
    return { ok: true };
  },
);

// --- IPC: rsync copy-to-station for "From existing folder…" flow ---

registerRsyncIpc(() => mainWindow);

// --- IPC: file-viewer popup + Cmd+click path linkifier ---
//
// File-viewer allowed roots. Built-ins are the sshfs station mount, the
// user's $HOME (covers ~/Desktop, ~/dev, etc.), and /tmp (where dev tools
// dump generated paths). User-managed extras come from the
// `fileViewerExtraRoots` config key, editable via the Settings UI. The
// getter passed to registerFileViewerIpc reads them fresh on every IPC, so
// adding/removing a path in Settings takes effect without a restart.
const fileViewerBuiltInRoots = (): string[] => [MOUNT_POINT, homedir(), "/tmp"];
const resolveFileViewerRoots = (): string[] =>
  composeFileViewerRoots(
    fileViewerBuiltInRoots(),
    readConfig("fileViewerExtraRoots"),
  );
console.log(
  `[file-viewer] allowed roots at boot: ${resolveFileViewerRoots().join(", ")}`,
);

// Station root + home come from the env var `RECK_STATION_ROOT` (e.g.
// `/home/pi/projects`); the station home is its parent directory. Used for
// host-aware tilde expansion: `~/foo.md` clicked in a station pane expands
// against the station's home, not the Mac's. Absent on a Mac-local-only
// setup → treated as null.
const stationRootEnv = process.env.RECK_STATION_ROOT;
const stationHomeEnv =
  stationRootEnv && stationRootEnv.length > 0
    ? path.dirname(stationRootEnv)
    : null;

registerFileViewerIpc({
  roots: resolveFileViewerRoots,
  mountPoint: () => MOUNT_POINT,
  localHome: () => homedir(),
  stationHome: () => stationHomeEnv,
  stationRoot: () => stationRootEnv ?? null,
  mountPointPath: () => MOUNT_POINT,
  buildCreateOptions(resolvedPath): Omit<CreateViewerOptions, "title"> {
    const savedTheme = readConfig("theme");
    const bgColor = savedTheme === "dark" ? "#141413" : "#f7f4ed";
    return {
      resolvedPath,
      bgColor,
      rendererHtmlPath: path.join(__dirname, "../renderer/file-viewer.html"),
      devServerUrl: isDev ? "http://localhost:5173" : null,
      preloadPath: path.join(__dirname, "../preload/preload.js"),
    };
  },
});

// --- Phase 2 settings migration (an earlier release, plan rev 3.1) ---
//
// Wiring layer between the storage I/O (sync, Electron-bound) and the
// pure migration planner in `./settings-migration.ts`. The planner
// decides what to write; this function performs the writes (so the
// secret-write path can throw without making the planner partial) and
// logs the outcome via `console.log("[satellite] phase 2 migration: ...")`.
//
// Idempotent: re-runs short-circuit on the presence of the new
// "settings" key (planner-side check). Logged on every entry — fresh
// installs and already-migrated boots both record a one-line trail so
// "did the migration run?" is answerable from a log without diffing
// the config file.
function runSettingsMigration(): void {
  const tomlPath = path.join(homedir(), ".config", "reck", "projects.toml");
  const result = planMigration({
    readKey: (k) => readConfig(k),
    hasKey: (k) => hasConfigKey(k),
    readProjectsToml: () => {
      try {
        return readFileSync(tomlPath, "utf8");
      } catch {
        return null;
      }
    },
    log: (msg) => console.log(`[satellite] ${msg}`),
  });

  if (!result.migrated) {
    console.log(`[satellite] phase 2 migration: skipped (${result.reason})`);
    return;
  }

  // Write the non-secret blob first. If the secret write below throws
  // (safeStorage unavailable), the user lands on the new shape minus
  // the token — the renderer's promptForToken / 1008-close path will
  // ask them to re-enter on first connect. That matches the existing
  // "secret refused" UX rather than failing the whole migration.
  if (result.settings) {
    writeConfig("settings", result.settings);
  }
  if (result.reason === "from-station" && result.stationTokenToWrite !== undefined) {
    if (result.stationTokenToWrite === "") {
      // No legacy token to migrate — leave the new key absent.
      console.log("[satellite] phase 2 migration: no station token to migrate");
    } else {
      try {
        writeConfig("station.token", result.stationTokenToWrite);
        console.log("[satellite] phase 2 migration: station token migrated");
      } catch (e) {
        console.warn(
          "[satellite] phase 2 migration: station token migration failed " +
            "(safeStorage unavailable?); user will be prompted to re-enter",
          e,
        );
      }
    }
  }
  console.log(
    `[satellite] phase 2 migration: done (${result.reason}); ` +
      "legacy keys mode/stationUrl/daemonToken retained for one-release rollback",
  );
}

// First-launch bootstrap import wrapper. Same shape as
// `runSettingsMigration`: thin IO layer around the pure planner in
// `./bootstrap-import.ts`. The bootstrap file is written by
// `install-satellite.sh --write-settings` during the Claude-driven
// install; on every launch we check for it and import-or-discard.
function runBootstrapImport(): void {
  const bootstrapPath = path.join(app.getPath("userData"), "bootstrap.json");
  const result = planBootstrapImport({
    readBootstrap: () => {
      try {
        return readFileSync(bootstrapPath, "utf8");
      } catch {
        return null;
      }
    },
    removeBootstrap: () => {
      try {
        unlinkSync(bootstrapPath);
      } catch (e) {
        // Best-effort. A leftover bootstrap.json on next launch will
        // either re-import (if settings were cleared) or skip (if not).
        console.warn(
          `[satellite] bootstrap import: could not unlink ${bootstrapPath}:`,
          e,
        );
      }
    },
    hasSettings: () => hasConfigKey("settings"),
    hasStationToken: () => hasConfigKey("station.token"),
    writeSettings: (s) => writeConfig("settings", s),
    writeStationToken: (t) => writeConfig("station.token", t),
    log: (msg) => console.log(`[satellite] ${msg}`),
  });

  if (result.imported) {
    console.log("[satellite] bootstrap import: done");
  } else if (result.reason === "malformed") {
    console.warn(
      `[satellite] bootstrap import: rejected (${result.detail}); ` +
        `leaving bootstrap.json in place for inspection`,
    );
  } else {
    console.log(`[satellite] bootstrap import: skipped (${result.reason})`);
  }
}
