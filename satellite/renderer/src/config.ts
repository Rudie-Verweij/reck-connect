import type { TreeNode } from "./layout/split-tree";

declare global {
  interface Window {
    reckAPI: {
      config: {
        get: <T>(key: string) => Promise<T | null>;
        set: (key: string, value: unknown) => Promise<boolean>;
      };
      daemon: {
        status: (host: import("./host").HostRef) => Promise<{ running: boolean; binary: string | null }>;
        start: (
          host: import("./host").HostRef,
        ) => Promise<
          | { ok: true }
          | {
              ok: false;
              reason: string;
              code?: "EADDRINUSE" | "ENOENT" | "EUNKNOWN";
            }
        >;
        stop: (host: import("./host").HostRef) => Promise<{ ok: true } | { ok: false; reason: string }>;
        /**
         * Per-spawn random bearer token for the local daemon. Returns
         * `null` when the local daemon isn't running. Pull after
         * `daemon.start("local")` resolves successfully.
         */
        localToken: () => Promise<string | null>;
      };
      dialog: {
        pickFolder: () => Promise<string | null>;
      };
      shell: {
        openPath(slug: string): Promise<{ ok: boolean; error?: string }>;
      };
      paths: {
        /**
         * Absolute path to the sshfs mount root on this laptop
         * (`$HOME/reck/projects`). Returned by the main process so the
         * home-directory literal never surfaces in the renderer; see
         * `paths:localMountPoint` in `main.ts`.
         */
        localMountPoint(): Promise<string>;
        /**
         * Resolve `rel` against `base` (a file path) using POSIX
         * semantics. Implemented in preload via node:path so the renderer
         * never touches Node modules directly. Used by the file viewer to
         * resolve relative markdown links against the open file's dir.
         */
        resolveAgainst(base: string, rel: string): string;
      };
      /**
       * File-viewer popup feature. All channels validate the path against
       * the project-derived allowed-roots set on the main side (see
       * satellite/main/file-allowlist.ts).
       */
      files: {
        read(filePath: string): Promise<
          | {
              ok: true;
              resolvedPath: string;
              content: string;
              baseline: { mtimeMs: number; sha256: string; size: number };
              writable: boolean;
            }
          | { ok: false; code: string; error: string }
        >;
        stat(filePath: string): Promise<
          | {
              ok: true;
              resolvedPath: string;
              baseline: { mtimeMs: number; sha256: string; size: number };
            }
          | { ok: false; code: string; error: string }
        >;
        /**
         * SSH-backed read for station files outside the sshfs mount. Used
         * by the file viewer popup when its URL carries
         * `?host=station-remote`.
         */
        readStation(stationPath: string): Promise<
          | {
              ok: true;
              content: string;
              baseline: { mtimeMs: number; sha256: string; size: number };
              writable: boolean;
            }
          | { ok: false; code: string; error: string }
        >;
        /**
         * SSH-backed write counterpart of readStation. Same security model:
         * isStationPathSafe + the SSH user's POSIX permissions are the gate.
         * No watcher, so concurrent remote edits surface only on next save.
         */
        writeStation(req: {
          path: string;
          content: string;
          baseline: { mtimeMs: number; sha256: string; size: number };
          force?: boolean;
        }): Promise<
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
        >;
        openInViewer(
          filePath: string,
          opts?:
            | string
            | {
                opener?: string;
                sourceHost?: "station" | "local";
                /**
                 * The raw click text BEFORE resolveActivatePath's
                 * project-root prepending. Lets main detect deterministic
                 * input (absolute / ~/x) and skip the streaming
                 * suffix-search for those.
                 */
                originalText?: string;
                /**
                 * The active project's cwd at the time of the click.
                 * Threaded to the main-side multi-root suffix search so the
                 * walker walks both the resolved path's base AND the
                 * project tree.
                 */
                projectCwd?: string;
              },
        ): Promise<{ ok: true } | { ok: false; code: string; error: string }>;
        /**
         * Batched existence/kind check used by the xterm linkifier. Returns
         * one entry per input path that survives the main-side allowlist,
         * in input order. Out-of-roots paths are silently filtered.
         */
        resolve(paths: string[]): Promise<
          Array<{
            path: string;
            exists: boolean;
            isDirectory: boolean;
            parentExists: boolean;
          }>
        >;
        /**
         * Atomically create an empty file inside an allowed root. Used by
         * the intended-path → "Create" flow. Refuses to overwrite.
         */
        create(filePath: string): Promise<
          | {
              ok: true;
              resolvedPath: string;
              baseline: { mtimeMs: number; sha256: string; size: number };
            }
          | { ok: false; code: string; error: string }
        >;
        /**
         * Create an empty file on the station via SSH (`mkdir -p && touch`).
         * Used by the station-remote create banner when the file lives
         * outside the sshfs mount.
         */
        createStation(stationPath: string): Promise<
          | { ok: true; resolvedPath: string }
          | { ok: false; code: string; error: string }
        >;
        /**
         * Save with optimistic-concurrency check. Returns the new baseline
         * on success or a conflict envelope (with current disk state) so
         * the viewer can route to the 3-way conflict banner.
         */
        write(req: {
          path: string;
          content: string;
          baseline: { mtimeMs: number; sha256: string; size: number };
          force?: boolean;
        }): Promise<
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
        >;
        watchSubscribe(filePath: string): Promise<
          | { ok: true; resolvedPath: string }
          | { ok: false; code: string; error: string }
        >;
        watchUnsubscribe(filePath: string): Promise<{ ok: boolean }>;
        onWatchEvent(
          cb: (ev: { path: string; kind: "change" | "unlink" }) => void,
        ): () => void;
        /**
         * Streaming suffix-search bridge. The popup subscribes to match /
         * progress / done / cancelled events for the search it was spawned
         * for, and can cancel via `cancel(searchId)`. Each subscriber
         * returns an unsub thunk.
         */
        suffixSearch: {
          onMatch(
            cb: (ev: { searchId: string; path: string }) => void,
          ): () => void;
          onProgress(
            cb: (ev: {
              searchId: string;
              scannedDirs: number;
              foundCount: number;
            }) => void,
          ): () => void;
          onDone(
            cb: (ev: {
              searchId: string;
              totalFound: number;
              /** Roots the search walked (drives the no-match banner). */
              searchedRoots?: string[];
            }) => void,
          ): () => void;
          onCancelled(
            cb: (ev: { searchId: string; totalFound: number }) => void,
          ): () => void;
          cancel(searchId: string): Promise<{ ok: boolean }>;
        };
        /**
         * Read the file path this popup was opened for, from the URL
         * query string. Returns `null` in the main window (no `?path=`).
         */
        getViewerPath(): string | null;
      };
      mount: {
        status(): Promise<"green" | "yellow" | "gray">;
        forceRemount(): Promise<{
          ok: boolean;
          state: "green" | "yellow" | "gray";
          error?: string;
        }>;
        onStatus(cb: (s: "green" | "yellow" | "gray") => void): void;
      };
      tailscale: {
        status(stationUrl: string | null): Promise<{
          ok: boolean;
          selfOnline: boolean | null;
          stationOnline: boolean | null;
          stationLastSeen: string | null;
          backendState: string | null;
        }>;
      };
      rsync: {
        // an audit finding — `checkCollision` removed. Slug collision
        // is now reported atomically by `toStation` via `code: "slug-in-use"`.
        toStation(
          localPath: string,
          slug: string,
        ): Promise<{ ok: true } | { ok: false; error: string; code?: string }>;
        cancel(): Promise<{ ok: boolean; error?: string }>;
        rollback(slug: string): Promise<{ ok: true }>;
        onProgress(
          cb: (p: { percent: number; bytes: number; speed: string; eta: string }) => void,
        ): void;
      };
      onMenuAddProject: (cb: () => void) => void;
      onMenuUpdateToken: (cb: () => void) => void;
      onMenuClaudeLaunch: (cb: () => void) => void;
      onMenuPreferences: (cb: () => void) => void;
      // an earlier release: detached pane popouts.
      windows: {
        detachPane(
          paneId: string,
          meta: { projectId: string; host: import("./host").HostRef; title?: string },
          bounds?: { width: number; height: number; x: number; y: number },
        ): Promise<{ ok: true } | { ok: false; reason: string }>;
        reattachPane(
          paneId: string,
        ): Promise<{ ok: true } | { ok: false; reason: string }>;
        onPopoutClosed(cb: (paneId: string) => void): () => void;
        getDetachedPaneInfo(): {
          paneId: string;
          projectId: string;
          host: import("./host").HostRef;
          title: string | null;
        } | null;
      };
    };
  }
}

// Hybrid mode (an earlier release, plan rev 3.1) reshaped Settings into two
// independent per-host blocks. Phase 12 retired the legacy `Mode`
// discriminator (the two-button chooser it drove is gone); callers
// that previously needed "which one is this?" now resolve via
// `primaryHost(settings)` below, which returns a `HostRef`.
//
// an earlier release — local is always available (no separate "local-only"
// mode). `LocalSettings.enabled` stays on the type so existing call
// sites compile, but `loadSettings()` always coerces it to true and
// `saveSettings()` always persists it as true. Treat `enabled` as a
// historical artifact: never branch on it.

export interface StationSettings {
  enabled: boolean;
  url: string;
  token?: string;
}

export interface LocalSettings {
  enabled: boolean;
  port: number;
  autoStart: boolean;
}

export interface Settings {
  station?: StationSettings;
  local?: LocalSettings;
}

// Persisted shape of the non-secret half. Identical to `Settings` minus
// `station.token` (held under a separate secret key — see `STATION_TOKEN_KEY`
// in `satellite/main/storage.ts` and the safeStorage refusal path).
type PersistedSettings = {
  station?: Omit<StationSettings, "token">;
  local?: LocalSettings;
};

const SETTINGS_KEY = "settings";
const STATION_TOKEN_KEY = "station.token";

const DEFAULT_LOCAL_PORT = 7315;

/**
 * Reduce the new `Settings` shape to the single `HostRef` the
 * surfaces that still ask "which one is this?" care about —
 * primarily `MountHint` (only station-primary arms the CONN-driven
 * mount yellow), the primary-host status-bar, and the MC
 * supervisor-controls routing.
 *
 * Resolution order:
 *   1. station enabled → "station". Station-aware behaviours apply.
 *   2. otherwise → "local". an earlier release made local always-available, so
 *      this branch is also "no station configured" / "station disabled".
 */
export function primaryHost(s: Settings): import("./host").HostRef {
  if (s.station?.enabled) return "station";
  return "local";
}

/**
 * Resolve the single host the renderer should talk to today. Phase 3+
 * splits this into `apiForHost(host)`; until then, hybrid mode runtime is
 * not wired up so we fall back to a single station-or-local URL pulled
 * from the same Settings blob the migration writes.
 *
 * an earlier release — `loadSettings()` guarantees `s.local` is always populated
 * (with the default port if the persisted blob predates this), so this
 * function returns null only on the truly fresh-install path where
 * `loadSettings()` itself returned null and the caller never reaches
 * here.
 */
export function resolveActiveUrl(s: Settings): string | null {
  if (s.station?.enabled && s.station.url) return s.station.url;
  if (s.local) return `http://127.0.0.1:${s.local.port || DEFAULT_LOCAL_PORT}`;
  return null;
}

export async function loadSettings(): Promise<Settings | null> {
  const persisted = await window.reckAPI.config.get<PersistedSettings>(SETTINGS_KEY);
  if (!persisted) return null;
  // Defensive — same fresh-install branch when the file exists but is
  // empty (no normal save path produces this; partial-write recovery
  // might). Same outcome as no file at all: render Preferences.
  if (!persisted.station && !persisted.local) return null;
  const out: Settings = {};
  if (persisted.station) {
    const token =
      (await window.reckAPI.config.get<string>(STATION_TOKEN_KEY)) ?? undefined;
    out.station = {
      enabled: !!persisted.station.enabled,
      url: typeof persisted.station.url === "string" ? persisted.station.url : "",
      token: token || undefined,
    };
  }
  // an earlier release — local is always populated. Existing configs migrate
  // transparently: a persisted `enabled: false` becomes enabled with
  // autoStart forced on (the only user-facing way `enabled` could land
  // false was the Older checkbox; if they unticked it, they probably
  // didn't set autoStart=true either, and "available but never starts"
  // is worse than just bringing the daemon up). New saves preserve the
  // user's autoStart choice unmodified.
  const wasExplicitlyDisabled = !!persisted.local && !persisted.local.enabled;
  out.local = {
    enabled: true,
    port:
      typeof persisted.local?.port === "number" && Number.isFinite(persisted.local.port)
        ? persisted.local.port
        : DEFAULT_LOCAL_PORT,
    autoStart: persisted.local
      ? wasExplicitlyDisabled
        ? true
        : !!persisted.local.autoStart
      : true,
  };
  return out;
}

export async function saveSettings(s: Settings) {
  const persisted: PersistedSettings = {};
  if (s.station) {
    persisted.station = {
      enabled: s.station.enabled,
      url: s.station.url,
    };
  }
  // an earlier release — local is always persisted as enabled. Defaults applied
  // when the caller passes no `local` block (e.g. the fresh-install
  // Preferences submit, where the section has no enable checkbox).
  persisted.local = {
    enabled: true,
    port: s.local?.port ?? DEFAULT_LOCAL_PORT,
    autoStart: s.local?.autoStart ?? true,
  };
  await window.reckAPI.config.set(SETTINGS_KEY, persisted);
  // Token persisted separately so safeStorage's refusal path (when the
  // OS keychain is unavailable) only blocks the secret half. Empty string
  // means "clear" — writeConfig stores a JSON "" which loadSettings then
  // coerces back to undefined.
  if (s.station?.token !== undefined) {
    await window.reckAPI.config.set(STATION_TOKEN_KEY, s.station.token);
  }
}

export async function saveStationToken(token: string) {
  await window.reckAPI.config.set(STATION_TOKEN_KEY, token);
}

/** Per-project layout tree. Keyed under `layouts_v2` to avoid collision with the old single-pane schema. */
export type Layouts = Record<string, TreeNode | null>;

const LAYOUTS_KEY = "layouts_v2";

/**
 * Walk a persisted tree and stamp `host: "station"` on any tab missing
 * the field. Layouts written before the hybrid-mode work (an earlier release)
 * had no `host`; the validator in `split-tree.ts` now requires one, so
 * the load path stamps before validation runs in `boot.ts`.
 *
 * Mutates in place. The blob is the function's own copy from IPC
 * (`window.reckAPI.config.get` returns fresh JSON each call) — no
 * aliasing risk, and the caller hands it straight to the validator.
 *
 * Recursion is gated on the `kind` discriminator. Anything that isn't a
 * recognised leaf/split is left untouched so the validator can drop it
 * downstream; if a third node kind is ever added, this walker and
 * `isValidTreeNode` must be updated together.
 */
export function stampLegacyHost(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const n = node as { kind?: unknown };
  if (n.kind === "leaf") {
    const leaf = node as { tabs?: unknown };
    if (Array.isArray(leaf.tabs)) {
      for (const t of leaf.tabs) {
        if (t && typeof t === "object") {
          const tab = t as { host?: unknown };
          if (tab.host === undefined) tab.host = "station";
        }
      }
    }
  } else if (n.kind === "split") {
    const split = node as { a?: unknown; b?: unknown };
    stampLegacyHost(split.a);
    stampLegacyHost(split.b);
  }
}

export async function loadLayouts(): Promise<Layouts> {
  const raw = (await window.reckAPI.config.get<Layouts>(LAYOUTS_KEY)) ?? {};
  for (const projectId of Object.keys(raw)) {
    stampLegacyHost(raw[projectId]);
  }
  return raw;
}

export async function saveLayout(projectId: string, tree: TreeNode | null) {
  const all = await loadLayouts();
  all[projectId] = tree;
  await window.reckAPI.config.set(LAYOUTS_KEY, all);
}

export async function loadRailWidth(): Promise<number | null> {
  return (await window.reckAPI.config.get<number>("railWidth")) ?? null;
}

export async function saveRailWidth(w: number) {
  await window.reckAPI.config.set("railWidth", w);
}

export type Theme = "light" | "dark";

export async function loadTheme(): Promise<Theme> {
  return (await window.reckAPI.config.get<Theme>("theme")) ?? "dark";
}

export async function saveTheme(t: Theme) {
  await window.reckAPI.config.set("theme", t);
}

// an earlier release — hover-to-focus panes. Default ON  once the
// suppression gates from several earlier releases hardened the feature.
//
// Resolution: missing key → enabled. Explicit `false` survives upgrades
// so users who opted out under the v1 hidden-config era stay opted out;
// any other non-boolean value (legacy malformed write) also resolves to
// the new default rather than silently keeping the feature off.
const HOVER_TO_FOCUS_KEY = "hoverToFocus";

export async function loadHoverToFocus(): Promise<boolean> {
  const raw = await window.reckAPI.config.get<boolean>(HOVER_TO_FOCUS_KEY);
  return raw !== false;
}

export async function saveHoverToFocus(enabled: boolean) {
  await window.reckAPI.config.set(HOVER_TO_FOCUS_KEY, enabled === true);
}

export type ProjectNameOverrides = Record<string, string>;

export async function loadProjectNameOverrides(): Promise<ProjectNameOverrides> {
  return (await window.reckAPI.config.get<ProjectNameOverrides>("projectNames")) ?? {};
}

export async function saveProjectNameOverride(projectId: string, name: string) {
  const all = await loadProjectNameOverrides();
  all[projectId] = name;
  await window.reckAPI.config.set("projectNames", all);
}

// --- Claude Code launch args ---
//
// Per-project overrides beat the machine default; either can be empty.
// Args are stored as a single whitespace-separated string (what the user
// types), split at send-time via shell-compatible tokenization. Relevant to
// Claude panes only — ignored by the daemon for shell panes.

export type ClaudeLaunchArgsByProject = Record<string, string>;

export async function loadClaudeLaunchArgs(): Promise<string> {
  return (await window.reckAPI.config.get<string>("claudeLaunchArgs")) ?? "";
}

export async function saveClaudeLaunchArgs(args: string) {
  await window.reckAPI.config.set("claudeLaunchArgs", args);
}

export async function loadClaudeLaunchArgsByProject(): Promise<ClaudeLaunchArgsByProject> {
  return (
    (await window.reckAPI.config.get<ClaudeLaunchArgsByProject>("claudeLaunchArgsByProject")) ??
    {}
  );
}

export async function saveClaudeLaunchArgsForProject(projectId: string, args: string) {
  const all = await loadClaudeLaunchArgsByProject();
  if (args.trim() === "") {
    delete all[projectId];
  } else {
    all[projectId] = args;
  }
  await window.reckAPI.config.set("claudeLaunchArgsByProject", all);
}

/**
 * Resolve the effective args string for a project: per-project override wins
 * over the machine default. Either may be empty. Returns the raw string —
 * callers should split via `tokenizeClaudeArgs` from
 * `@client-core/launch-args/tokenize` before sending.
 */
export async function resolveClaudeLaunchArgs(projectId: string): Promise<string> {
  const perProject = await loadClaudeLaunchArgsByProject();
  const override = perProject[projectId];
  if (override !== undefined && override !== "") return override;
  return await loadClaudeLaunchArgs();
}

import type { Project } from "@proto/proto";

export async function loadProjectOrder(): Promise<string[]> {
  return (await window.reckAPI.config.get<string[]>("projectOrder")) ?? [];
}

export async function saveProjectOrder(order: string[]) {
  await window.reckAPI.config.set("projectOrder", order);
}

/**
 * Sort `projects` so that ids present in `savedOrder` come first in that
 * exact order, and any projects not in `savedOrder` are appended sorted
 * alphabetically by name. Ids in `savedOrder` that no longer exist in
 * `projects` are silently skipped.
 */
export function applyProjectOrder(projects: Project[], savedOrder: string[]): Project[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const ordered: Project[] = [];
  const seen = new Set<string>();
  for (const id of savedOrder) {
    const p = byId.get(id);
    if (p && !seen.has(id)) {
      ordered.push(p);
      seen.add(id);
    }
  }
  const rest = projects
    .filter((p) => !seen.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...ordered, ...rest];
}

/**
 * Custom file-viewer allowed roots. Combined with the built-ins
 * (MOUNT_POINT, $HOME, /tmp) by main's `composeFileViewerRoots`. Edits
 * take effect on the NEXT IPC the file viewer makes — no app restart.
 */
export async function loadFileViewerExtraRoots(): Promise<string[]> {
  const raw = await window.reckAPI.config.get<string[]>("fileViewerExtraRoots");
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === "string" && p.length > 0);
}

/**
 * Persist the custom-roots list. Normalises on save: rejects non-string /
 * non-absolute / empty / duplicate entries. The main-side
 * `composeFileViewerRoots` would also drop these, but normalising here
 * means the Settings UI never re-displays a malformed entry it just
 * saved.
 */
export async function saveFileViewerExtraRoots(
  roots: readonly string[],
): Promise<void> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of roots) {
    if (typeof p !== "string") continue;
    if (p.length === 0) continue;
    if (!p.startsWith("/")) continue; // absolute-only (POSIX)
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  await window.reckAPI.config.set("fileViewerExtraRoots", out);
}

/**
 * Persisted extensionless-filename allowlist for the linkifier. Driven by
 * `setExtensionlessAllowlist` at boot and after a Preferences save. Stored
 * under `linkifier.extensionlessAllowlist`.
 *
 * Returns the persisted list verbatim (case-sensitive, drop-empty-string
 * only). Returns `null` when the user has never persisted a list — callers
 * seed with `SEEDED_EXTENSIONLESS_FILENAMES` in that case. (We can't return
 * the seeded list directly: that would lose the "user explicitly emptied
 * the list" signal.)
 */
const LINKIFIER_ALLOWLIST_KEY = "linkifier.extensionlessAllowlist";

export async function loadLinkifierAllowlist(): Promise<string[] | null> {
  const raw = await window.reckAPI.config.get<string[]>(LINKIFIER_ALLOWLIST_KEY);
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
}

/**
 * Persist the allowlist. Trims whitespace, drops empty / non-string
 * entries, and dedupes case-sensitively. `README` and `readme` survive
 * as distinct entries on purpose.
 */
export async function saveLinkifierAllowlist(
  names: readonly string[],
): Promise<void> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  await window.reckAPI.config.set(LINKIFIER_ALLOWLIST_KEY, out);
}
