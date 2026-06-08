import { contextBridge, ipcRenderer } from "electron";

// Hybrid mode (an earlier release, plan rev 3.1, Phase 5): the daemon IPC takes
// a host arg. Mirrors `HostRef` in the renderer; the main-process
// handler validates the value at the trust boundary.
type HostRef = "station" | "local";

contextBridge.exposeInMainWorld("reckAPI", {
  config: {
    get: (key: string) => ipcRenderer.invoke("config:get", key),
    set: (key: string, value: unknown) => ipcRenderer.invoke("config:set", key, value),
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
