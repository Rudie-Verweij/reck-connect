import { contextBridge, ipcRenderer } from "electron";

/**
 * Pure-JS POSIX `path.resolve(dirname(base), rel)`. Inlined here so the
 * preload doesn't `require("node:path")` — in some packaged-build sandbox
 * configurations that require throws on load, killing the script before
 * `contextBridge.exposeInMainWorld` runs and leaving the renderer with
 * `window.reckAPI === undefined`.
 */
function resolveAgainstPosix(base: string, rel: string): string {
  if (typeof base !== "string" || typeof rel !== "string") return "";
  // Home-anchored rels (`~/x`, `~`) are already anchored — main's
  // `expandTildeForHost` resolves them against the right home
  // (station vs Mac) based on `sourceHost`. Concatenating them onto
  // `base` would leave a literal `~` segment mid-string, which then
  // trips `isStationPathSafe`'s POSIX-safe-char whitelist on the
  // SSH read path. Pass through unchanged, same as absolute rels.
  if (rel === "~" || rel.startsWith("~/")) return rel;
  const dirEnd = base.lastIndexOf("/");
  const dir = dirEnd >= 0 ? base.slice(0, dirEnd) : "";
  // If `rel` is absolute, ignore the base entirely.
  const raw = rel.startsWith("/") ? rel : dir + "/" + rel;
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

// Hybrid mode (an earlier release, plan rev 3.1, Phase 5): the daemon IPC takes
// a host arg. Mirrors `HostRef` in the renderer; the main-process
// handler validates the value at the trust boundary.
type HostRef = "station" | "local";

contextBridge.exposeInMainWorld("reckAPI", {
  config: {
    get: (key: string) => ipcRenderer.invoke("config:get", key),
    set: (key: string, value: unknown) => ipcRenderer.invoke("config:set", key, value),
  },
  clipboard: {
    // OSC 52 copy-on-select writes here so the clipboard write goes through
    // Electron's main-process clipboard (always permitted) instead of the
    // focus-gated renderer navigator.clipboard.
    write: (text: string) => ipcRenderer.invoke("clipboard:write", text),
  },
  daemon: {
    status: (host: HostRef) => ipcRenderer.invoke("daemon:status", host),
    start: (host: HostRef) => ipcRenderer.invoke("daemon:start", host),
    stop: (host: HostRef) => ipcRenderer.invoke("daemon:stop", host),
    /**
     * Per-spawn random bearer token for the local daemon, generated
     * by the main process and held in main-process memory only. Returns
     * `null` when the local daemon isn't running. The renderer pulls
     * this after `daemon.start("local")` resolves successfully and
     * passes it to `setApiTokenForHost("local", token)`.
     */
    localToken: () =>
      ipcRenderer.invoke("daemon:localToken") as Promise<string | null>,
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  },
  shell: {
    openPath: (slug: string) =>
      ipcRenderer.invoke("shell:openPath", slug) as Promise<{ ok: boolean; error?: string }>,
  },
  paths: {
    /**
     * Absolute path to the sshfs mount root on this laptop
     * (typically `$HOME/reck/projects`). Hybrid mode rev 3.1, phase 9:
     * the renderer joins this with a station-owned project ID to build
     * the local-daemon cwd it PUTs in /projects. Returned verbatim from
     * main (no computation in renderer) so the home directory literal
     * never crosses the IPC boundary for anything but the mount root.
     */
    localMountPoint: () =>
      ipcRenderer.invoke("paths:localMountPoint") as Promise<string>,
    /**
     * Resolve `rel` against `base` (a file path) using POSIX semantics.
     * Used by the file viewer to resolve relative markdown links against
     * the currently-open file's directory. Synchronous, pure — runs in
     * preload (which has Node access) and exposes only the resolved string
     * so the renderer never sees the `node:path` module directly.
     */
    resolveAgainst: (base: string, rel: string): string =>
      resolveAgainstPosix(base, rel),
  },
  /**
   * File-viewer popup feature: read files (with mtime+sha256 baseline),
   * stat them, spawn / focus the per-file BrowserWindow. Each channel
   * validates the path against the project-derived allowed-roots set on
   * the main side (see satellite/main/file-allowlist.ts).
   */
  files: {
    read: (filePath: string) =>
      ipcRenderer.invoke("file:read", filePath) as Promise<
        | {
            ok: true;
            resolvedPath: string;
            content: string;
            baseline: { mtimeMs: number; sha256: string; size: number };
            writable: boolean;
          }
        | { ok: false; code: string; error: string }
      >,
    stat: (filePath: string) =>
      ipcRenderer.invoke("file:stat", filePath) as Promise<
        | { ok: true; resolvedPath: string; baseline: { mtimeMs: number; sha256: string; size: number } }
        | { ok: false; code: string; error: string }
      >,
    /**
     * SSH-backed read for station files OUTSIDE the sshfs projects mount
     * (an earlier release). Used by the file viewer popup
     * when the URL carries `?host=station-remote`. Read-only; writes
     * intentionally not supported in v1 (concurrency model needs
     * more thought than reads).
     */
    readStation: (stationPath: string) =>
      ipcRenderer.invoke("file:readStation", stationPath) as Promise<
        | {
            ok: true;
            content: string;
            baseline: { mtimeMs: number; sha256: string; size: number };
            writable: boolean;
          }
        | { ok: false; code: string; error: string }
      >,
    /**
     * an earlier release: SSH-backed write counterpart of readStation.
     * Used by the file viewer popup when the URL carries
     * `?host=station-remote` AND the user is editing (popup is no
     * longer read-only). The main handler validates via
     * isStationPathSafe + a baseline mtime/sha conflict check.
     */
    writeStation: (req: {
      path: string;
      content: string;
      baseline: { mtimeMs: number; sha256: string; size: number };
      force?: boolean;
    }) =>
      ipcRenderer.invoke("file:writeStation", req) as Promise<
        | {
            ok: true;
            baseline: { mtimeMs: number; sha256: string; size: number };
          }
        | {
            ok: false;
            code: string;
            error: string;
            currentBaseline?: { mtimeMs: number; sha256: string; size: number };
            currentContent?: string;
          }
      >,
    openInViewer: (
      filePath: string,
      opts?:
        | string
        | {
            opener?: string;
            sourceHost?: "station" | "local";
            /**
             * an earlier release: the raw click text BEFORE
             * resolveActivatePath's project-root prepending. Used by
             * main to detect deterministic input (absolute / ~/x) and
             * skip the suffix-fallback search.
             */
            originalText?: string;
            /**
             * an earlier release: the active project's cwd at the time
             * of the click. Forwarded to the main-side multi-root
             * suffix search so the walker walks the project tree in
             * addition to the resolved path's own base.
             */
            projectCwd?: string;
          },
    ) => {
      // Back-compat shim: the old signature was `openInViewer(filePath, opener?)`.
      // The new signature is `openInViewer(filePath, { opener?, sourceHost?, originalText?, projectCwd? })`.
      const opener = typeof opts === "string" ? opts : opts?.opener;
      const sourceHost = typeof opts === "object" ? opts?.sourceHost : undefined;
      const originalText =
        typeof opts === "object" ? opts?.originalText : undefined;
      const projectCwd =
        typeof opts === "object" ? opts?.projectCwd : undefined;
      return ipcRenderer.invoke("file:openInViewer", {
        path: filePath,
        opener,
        sourceHost,
        originalText,
        projectCwd,
      }) as Promise<{ ok: true } | { ok: false; code: string; error: string }>;
    },
    /**
     * Batched existence/kind check used by the xterm linkifier. Returns
     * one entry per input path that survives the main-side allowlist,
     * in input order. Out-of-roots paths are silently filtered.
     */
    resolve: (paths: string[]) =>
      ipcRenderer.invoke("file:resolve", paths) as Promise<
        Array<{
          path: string;
          exists: boolean;
          isDirectory: boolean;
          parentExists: boolean;
        }>
      >,
    /**
     * Atomically create an empty file at `filePath`. Creates any missing
     * parent directories inside the allowed root. Refuses to overwrite.
     */
    create: (filePath: string) =>
      ipcRenderer.invoke("file:create", filePath) as Promise<
        | {
            ok: true;
            resolvedPath: string;
            baseline: { mtimeMs: number; sha256: string; size: number };
          }
        | { ok: false; code: string; error: string }
      >,
    /**
     * an earlier release: create an empty file on the station via SSH.
     * Validates against isStationPathSafe before running
     * `mkdir -p <dir> && touch <path>`. Used by the renderStationRemote
     * create banner for paths outside the sshfs mount.
     */
    createStation: (stationPath: string) =>
      ipcRenderer.invoke("file:createStation", stationPath) as Promise<
        | { ok: true; resolvedPath: string }
        | { ok: false; code: string; error: string }
      >,
    /**
     * Save the user's edits to disk, gated by an optimistic-concurrency
     * check against `baseline`. Returns the new baseline on success, or
     * a conflict envelope (with the current disk state) so the viewer
     * can show the 3-way conflict banner.
     */
    write: (req: {
      path: string;
      content: string;
      baseline: { mtimeMs: number; sha256: string; size: number };
      force?: boolean;
    }) =>
      ipcRenderer.invoke("file:write", req) as Promise<
        | {
            ok: true;
            resolvedPath: string;
            baseline: { mtimeMs: number; sha256: string; size: number };
          }
        | {
            ok: false;
            code: string;
            error: string;
            currentBaseline?: { mtimeMs: number; sha256: string; size: number };
            currentContent?: string;
          }
      >,
    /**
     * Subscribe to chokidar-driven `file:watch:event` notifications for
     * a single file. Returns the canonical resolved path on success.
     * Unsubscribe explicitly with `watchUnsubscribe` (or close the window
     * — main tears down watchers on window-closed automatically).
     */
    watchSubscribe: (filePath: string) =>
      ipcRenderer.invoke("file:watch:subscribe", filePath) as Promise<
        | { ok: true; resolvedPath: string }
        | { ok: false; code: string; error: string }
      >,
    watchUnsubscribe: (filePath: string) =>
      ipcRenderer.invoke("file:watch:unsubscribe", filePath) as Promise<
        { ok: boolean }
      >,
    /**
     * Listen for `file:watch:event` notifications. Returns a thunk that
     * unsubscribes the listener without disturbing other consumers.
     */
    onWatchEvent: (
      cb: (ev: { path: string; kind: "change" | "unlink" }) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: { path: string; kind: "change" | "unlink" },
      ) => cb(ev);
      ipcRenderer.on("file:watch:event", listener);
      return () => ipcRenderer.removeListener("file:watch:event", listener);
    },
    /**
     * an earlier release: streaming suffix-search bridge. The renderer
     * subscribes to match / progress / done / cancelled events for an
     * in-flight search and can cancel via `cancel(searchId)`. Each
     * subscriber returns an unsub thunk.
     */
    suffixSearch: {
      onMatch: (
        cb: (ev: { searchId: string; path: string }) => void,
      ) => {
        const listener = (_e: unknown, ev: { searchId: string; path: string }) =>
          cb(ev);
        ipcRenderer.on("file:suffix:match", listener);
        return () =>
          ipcRenderer.removeListener("file:suffix:match", listener);
      },
      onProgress: (
        cb: (ev: {
          searchId: string;
          scannedDirs: number;
          foundCount: number;
        }) => void,
      ) => {
        const listener = (
          _e: unknown,
          ev: { searchId: string; scannedDirs: number; foundCount: number },
        ) => cb(ev);
        ipcRenderer.on("file:suffix:progress", listener);
        return () =>
          ipcRenderer.removeListener("file:suffix:progress", listener);
      },
      onDone: (
        cb: (ev: {
          searchId: string;
          totalFound: number;
          /** roots the search walked (no-match banner). */
          searchedRoots?: string[];
        }) => void,
      ) => {
        const listener = (
          _e: unknown,
          ev: {
            searchId: string;
            totalFound: number;
            searchedRoots?: string[];
          },
        ) => cb(ev);
        ipcRenderer.on("file:suffix:done", listener);
        return () =>
          ipcRenderer.removeListener("file:suffix:done", listener);
      },
      onCancelled: (
        cb: (ev: { searchId: string; totalFound: number }) => void,
      ) => {
        const listener = (
          _e: unknown,
          ev: { searchId: string; totalFound: number },
        ) => cb(ev);
        ipcRenderer.on("file:suffix:cancelled", listener);
        return () =>
          ipcRenderer.removeListener("file:suffix:cancelled", listener);
      },
      cancel: (searchId: string) =>
        ipcRenderer.invoke("file:suffix:cancel", searchId) as Promise<{
          ok: boolean;
        }>,
    },
    /**
     * Read the file path this popup window was opened for, from the URL
     * query string. Returns `null` in the main window (no `?path=`).
     */
    getViewerPath: (): string | null => {
      try {
        return new URL(window.location.href).searchParams.get("path");
      } catch {
        return null;
      }
    },
  },
  mount: {
    status: () => ipcRenderer.invoke("mount:status") as Promise<"green" | "yellow" | "gray">,
    forceRemount: () =>
      ipcRenderer.invoke("mount:forceRemount") as Promise<{
        ok: boolean;
        state: "green" | "yellow" | "gray";
        error?: string;
      }>,
    onStatus: (cb: (s: "green" | "yellow" | "gray") => void) => {
      ipcRenderer.on("mount:status", (_e, s) => cb(s));
    },
  },
  tailscale: {
    // Ask main to run `tailscale status --json` so the connection reason can
    // distinguish "this Mac is off Tailscale" from "the station peer is
    // offline". Pass the station URL so main can match the peer by IP/name.
    status: (stationUrl: string | null) =>
      ipcRenderer.invoke("tailscale:status", stationUrl) as Promise<{
        ok: boolean;
        selfOnline: boolean | null;
        stationOnline: boolean | null;
        stationLastSeen: string | null;
        backendState: string | null;
      }>,
  },
  rsync: {
    // an audit finding — `checkCollision` removed. Slug collision is
    // now detected atomically by `toStation` itself (via `mkdir` on the
    // station); a colliding slug surfaces as `{ ok: false, code: "slug-in-use" }`.
    toStation: (localPath: string, slug: string) =>
      ipcRenderer.invoke("rsync:toStation", localPath, slug) as Promise<
        { ok: true } | { ok: false; error: string; code?: string }
      >,
    cancel: () => ipcRenderer.invoke("rsync:cancel"),
    rollback: (slug: string) => ipcRenderer.invoke("rsync:rollback", slug),
    onProgress: (
      cb: (p: { percent: number; bytes: number; speed: string; eta: string }) => void,
    ) => {
      ipcRenderer.on("rsync:progress", (_e, p) => cb(p));
    },
  },
  onMenuAddProject: (cb: () => void) => ipcRenderer.on("menu:add-project", cb),
  onMenuUpdateToken: (cb: () => void) => ipcRenderer.on("menu:update-token", cb),
  onMenuClaudeLaunch: (cb: () => void) => ipcRenderer.on("menu:claude-launch", cb),
  onMenuPreferences: (cb: () => void) => ipcRenderer.on("menu:preferences", cb),
  // an earlier release: detached pane popouts. The main window calls
  // `detachPane` to spawn a parent-less BrowserWindow for a paneId;
  // either window can call `reattachPane` to fold the pane back into
  // the main split tree (closing the popout fires `pane:popout-closed`
  // back to the main window so it can repopulate the slot from the
  // daemon ring buffer).
  windows: {
    detachPane: (
      paneId: string,
      meta: { projectId: string; host: HostRef; title?: string },
      bounds?: { width: number; height: number; x: number; y: number },
    ) =>
      ipcRenderer.invoke("pane:detach", {
        paneId,
        projectId: meta.projectId,
        host: meta.host,
        title: meta.title,
        bounds,
      }) as Promise<{ ok: true } | { ok: false; reason: string }>,
    reattachPane: (paneId: string) =>
      ipcRenderer.invoke("pane:reattach", { paneId }) as Promise<
        { ok: true } | { ok: false; reason: string }
      >,
    /**
     * Subscribe to popout-closed notifications. Returns an unsubscribe
     * thunk so callers can tear the listener down on dispose without
     * leaking through `ipcRenderer.removeAllListeners` (which would
     * also clobber other consumers of the same channel).
     */
    onPopoutClosed: (cb: (paneId: string) => void) => {
      const listener = (_e: unknown, paneId: string) => cb(paneId);
      ipcRenderer.on("pane:popout-closed", listener);
      return () => ipcRenderer.removeListener("pane:popout-closed", listener);
    },
    /**
     * Read the popout's own paneId, projectId, and host from the URL
     * query string. Used by `popout.ts` to bootstrap the single-pane
     * view. Returns `null` in the main window (no `?pane=...` param),
     * which lets callers tell "popout context" from "main context" with
     * one call.
     */
    getDetachedPaneInfo: (): {
      paneId: string;
      projectId: string;
      host: HostRef;
      title: string | null;
    } | null => {
      try {
        const url = new URL(window.location.href);
        const paneId = url.searchParams.get("pane");
        const projectId = url.searchParams.get("project");
        const hostRaw = url.searchParams.get("host");
        if (!paneId || !projectId) return null;
        const host: HostRef = hostRaw === "local" ? "local" : "station";
        return {
          paneId,
          projectId,
          host,
          title: url.searchParams.get("title"),
        };
      } catch {
        return null;
      }
    },
  },
});
