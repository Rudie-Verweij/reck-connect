// Main-process surface for the file-viewer popup feature.
//
// Owns:
//   - the `file:*` IPC handlers (read, stat, openInViewer)
//   - the `fileViewerWindows` registry (one BrowserWindow per realpath;
//     second open of the same file focuses the existing window)
//   - the popup geometry calculator (named-constant defaults so they can
//     be tuned without touching call sites)
//
// Logic is split from Electron wiring so the handlers can be unit-tested
// without an Electron mock: `handleFileRead` etc. are pure async functions
// that take a `FileViewerDeps` for live state. `registerFileViewerIpc()`
// is the thin shim that connects those handlers to `ipcMain.handle`.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { BrowserWindow, dialog, ipcMain, screen, shell } from "electron";

import { resolveInsideAllowedRoots } from "./file-allowlist";
import { checkExternalUrl } from "./ipc-validation";
import { deriveProjectAnchor } from "./project-anchor";
import { normalizeProjectCwd } from "./project-cwd";
import { rootRelativeCandidate } from "./root-relative";
import {
  readStationFile,
  writeStationFile,
  createStationFile,
  translateMountToStationPath,
} from "./station-ssh";
import type {
  StationWriteRequest,
  StationWriteResult,
  StationCreateResult,
} from "./station-ssh";
import { isDeterministicInput } from "./search-walk";
import {
  createSuffixSearchOrchestrator,
  type SuffixSearchHandle,
  type StreamingWorkerLike,
} from "./suffix-search-orchestrator";
import {
  createBackendDetection,
  defaultLocalExecutableProbe,
  defaultSshRgProbe,
} from "./backend-detection";
import { createRgLocalWorker } from "./search-worker-rg-local";
import { createRgSshWorker } from "./search-worker-rg-ssh";
import type { SshSpawnFn } from "./search-worker-rg-ssh";
import {
  SSH_KEY,
  SSH_HOST,
  SSH_CONNECT_TIMEOUT_SEC,
} from "./station-ssh";

/**
 * Expand a leading `~` or `~/` against the current user's home dir. Shells
 * normally do this, but path strings extracted from terminal scrollback
 * (the linkifier) and from markdown links never went through a shell. The
 * file-viewer treats `~/foo` as equivalent to `$HOME/foo` so users can
 * Cmd+click on `~/.claude/plans/x.md` and have it Just Work.
 *
 * Non-tilde paths are returned unchanged.
 */
function expandTilde(p: string): string {
  if (typeof p !== "string" || p.length === 0) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Phase 3 of the linkifier-followups plan: host-aware tilde expansion.
 * A path emitted by a station-backed pane (e.g. a Claude pane talking to
 * the Pi daemon) is in the Pi's filesystem. `~/` there means the Pi's
 * home, not the Mac's; absolute paths like `/home/pi/projects/...`
 * have to be translated through the local sshfs mount to be readable
 * from the satellite.
 *
 * Returns a tagged result:
 *   - `local`       → an absolute path resolveInsideAllowedRoots can use
 *   - `unreachable` → the station path lives outside the projects mount;
 *                     the satellite can't reach it via sshfs. The caller
 *                     should surface a clear "Station file outside mount"
 *                     banner (no Create option — we can't write either).
 *
 * Local-host (default) paths flow through the regular `expandTilde`.
 */
export interface ExpandTildeForHostOpts {
  sourceHost?: "station" | "local";
  /** Mac home (`os.homedir()`). Required for local + station fallback. */
  localHome: string;
  /** Pi home (`dirname(RECK_STATION_ROOT)`), e.g. `/home/pi`.
   *  Required when sourceHost === "station". */
  stationHome?: string;
  /** Pi projects root (`RECK_STATION_ROOT`), e.g. `/home/pi/projects`.
   *  Required when sourceHost === "station". */
  stationRoot?: string;
  /** Local sshfs mount root. */
  mountPoint: string;
  /**
   * Round 8.6 — absolute station-side cwd of the pane the click originated
   * from (e.g. `/home/pi/projects/MyProject`). Used to anchor
   * project-relative paths from station-pane clicks; ignored for
   * absolute / tilde inputs and for local sourceHost.
   */
  projectCwd?: string;
}

export type ExpandedPath =
  | { kind: "local"; path: string }
  /**
   * The path resolves to a station file OUTSIDE the sshfs projects
   * mount (e.g. `~/.claude/...`, `~/.ssh/...`). It IS reachable via
   * SSH using the same credentials the sshfs mount uses; the file
   * viewer routes these through `readStationFile` (read-only in v1).
   *
   * `path` is the absolute STATION-side path (e.g.
   * `/home/pi/.claude/plans/foo.md`).
   */
  | { kind: "station-remote"; path: string }
  | { kind: "unreachable"; reason: string };

export function expandTildeForHost(
  raw: string,
  opts: ExpandTildeForHostOpts,
): ExpandedPath {
  if (typeof raw !== "string" || raw.length === 0) {
    return { kind: "local", path: raw };
  }
  const host = opts.sourceHost ?? "local";
  if (host === "local") {
    // Same semantics as `expandTilde` — Mac home, leave non-tilde paths alone.
    if (raw === "~") return { kind: "local", path: opts.localHome };
    if (raw.startsWith("~/")) {
      return { kind: "local", path: path.join(opts.localHome, raw.slice(2)) };
    }
    return { kind: "local", path: raw };
  }
  // station host — expand against the Pi's home, then translate through
  // the local sshfs mount. Anything outside the projects subtree is
  // unreachable from the Mac.
  const stationHome = opts.stationHome;
  const stationRoot = opts.stationRoot;
  if (!stationHome || !stationRoot) {
    return {
      kind: "unreachable",
      reason:
        "Station host paths cannot be resolved (station home/root not configured)",
    };
  }
  let stationPath: string;
  if (raw === "~") stationPath = stationHome;
  else if (raw.startsWith("~/")) {
    stationPath = path.posix.join(stationHome, raw.slice(2));
  } else if (!path.posix.isAbsolute(raw) && opts.projectCwd) {
    // Round 8.6 — project-root-relative path from a station-pane click.
    // Anchor against the pane's cwd so it becomes an absolute Pi path;
    // downstream prefix check + mount translation handle the rest.
    // Without this, the bare relative path failed the stationRoot prefix
    // check and was misrouted to station-remote, surfacing "no matches"
    // for files that exist on the local mount.
    stationPath = path.posix.join(opts.projectCwd, raw);
  } else {
    stationPath = raw;
  }
  // Strict-segment prefix check matching translateStationCwd's contract.
  const rootStripped = stationRoot.replace(/\/+$/, "");
  if (
    stationPath !== rootStripped &&
    !stationPath.startsWith(rootStripped + "/")
  ) {
    // Outside the projects mount but still on the Pi → reachable via
    // SSH (same key sshfs uses). The caller routes these through
    // `file:readStation` and opens a read-only popup.
    return { kind: "station-remote", path: stationPath };
  }
  const mountStripped = opts.mountPoint.replace(/\/+$/, "");
  const suffix = stationPath.slice(rootStripped.length);
  return { kind: "local", path: mountStripped + suffix };
}

// --- Round 5 Phase U — find-by-suffix path resolution ----------------------
//
// Round 6 Phase CC1 — the core walk moved to ./search-walk.ts so it can be
// shared by this in-process API and the worker_threads streaming search.
// This wrapper preserves the legacy `searchProjectTreeBySuffix` contract
// (await → string[]) so existing callers and tests don't change.

import {
  searchTreeBySuffix,
  type SearchWalkOptions,
} from "./search-walk";

export type SuffixSearchOptions = Pick<
  SearchWalkOptions,
  "maxMatches" | "maxDepth" | "timeoutMs"
>;

export async function searchProjectTreeBySuffix(
  roots: readonly string[],
  suffix: string,
  opts: SuffixSearchOptions = {},
): Promise<string[]> {
  const result = await searchTreeBySuffix(roots, suffix, opts);
  return result.matches;
}

// --- geometry constants (tweak in one place) ---------------------------------

/**
 * Default fraction of the primary display's work area to use for popup
 * width / height. Override per-call via `createFileViewerWindow({width, ...})`.
 */
export const FILE_VIEWER_WIDTH_FRACTION = 0.5;
export const FILE_VIEWER_HEIGHT_FRACTION = 0.8;
export const FILE_VIEWER_MIN_WIDTH = 480;
export const FILE_VIEWER_MIN_HEIGHT = 360;

export interface DisplayInfo {
  workAreaSize: { width: number; height: number };
}

export interface ViewerGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface ViewerGeometryOverride {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

/**
 * Compute the BrowserWindow bounds for a file-viewer popup. Defaults to
 * `FILE_VIEWER_*_FRACTION` of the display work area, clamped to the
 * `FILE_VIEWER_MIN_*` constants. Any field in `override` wins. The popup
 * is centered on the primary display unless `x`/`y` are overridden.
 */
export function computeViewerGeometry(
  display: DisplayInfo,
  override: ViewerGeometryOverride = {},
): ViewerGeometry {
  const work = display.workAreaSize;
  const rawWidth =
    override.width ?? Math.round(work.width * FILE_VIEWER_WIDTH_FRACTION);
  const rawHeight =
    override.height ?? Math.round(work.height * FILE_VIEWER_HEIGHT_FRACTION);
  const width = Math.max(FILE_VIEWER_MIN_WIDTH, rawWidth);
  const height = Math.max(FILE_VIEWER_MIN_HEIGHT, rawHeight);
  const x = override.x ?? Math.round((work.width - width) / 2);
  const y = override.y ?? Math.round((work.height - height) / 2);
  return { width, height, x, y };
}

// --- baselines ---------------------------------------------------------------

export interface FileBaseline {
  mtimeMs: number;
  sha256: string;
  size: number;
}

/**
 * Compute the freshness baseline for a file: mtime, sha256 of contents, size.
 * Used by `file:read` on open, by `file:write` to check that disk hasn't
 * shifted since the read, and by the auto-reload path to update state.
 *
 * Throws if the file doesn't exist or is unreadable. Callers should catch.
 */
export function computeBaseline(absolutePath: string): FileBaseline {
  const stat = fs.statSync(absolutePath);
  const content = fs.readFileSync(absolutePath);
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  return { mtimeMs: stat.mtimeMs, sha256, size: stat.size };
}

// --- handlers (pure async, no Electron) --------------------------------------

export interface FileViewerDeps {
  /**
   * Returns the current allowed-roots list. Wrapped in a getter so the
   * handler always sees the latest set (projects can be added/removed
   * while the app is running).
   */
  roots: () => readonly string[];
  /** Mac home for tilde expansion. Defaults to os.homedir() when omitted. */
  localHome?: () => string;
  /** Pi home (`dirname(RECK_STATION_ROOT)`). Required for station tilde
   *  expansion; if absent, station-host requests fall back to "unreachable". */
  stationHome?: () => string | null;
  /** Pi projects root (`RECK_STATION_ROOT`). Required for station path
   *  translation through the local sshfs mount. */
  stationRoot?: () => string | null;
  /** Local sshfs mount root, e.g. `$HOME/reck/projects`. */
  mountPointPath?: () => string;
}

/**
 * Maximum file size we'll load into the viewer. Larger files are
 * rejected with `too-large`; the user can open them in the OS default
 * app instead (deferred — for v1 we just refuse).
 */
export const FILE_VIEWER_MAX_BYTES = 2 * 1024 * 1024;
/** How many bytes from the start of the file to scan for a NUL byte. */
const BINARY_PROBE_BYTES = 8 * 1024;

export type FileReadErrorCode =
  | "invalid-input"
  | "out-of-roots"
  | "not-found"
  | "is-directory"
  | "too-large"
  | "binary"
  | "io-error";

export type FileReadResult =
  | {
      ok: true;
      resolvedPath: string;
      content: string;
      baseline: FileBaseline;
      /** Round 5 Phase V — false when the current process can't write
       *  the file (POSIX W_OK probe failed). Used by the renderer to
       *  show a "READ-ONLY" banner and suppress the lock toggle. */
      writable: boolean;
    }
  | { ok: false; code: FileReadErrorCode; error: string };

export async function handleFileRead(
  deps: FileViewerDeps,
  rawPath: unknown,
): Promise<FileReadResult> {
  if (typeof rawPath !== "string") {
    return { ok: false, code: "invalid-input", error: "path must be a string" };
  }
  const resolved = resolveInsideAllowedRoots(deps.roots(), expandTilde(rawPath));
  if (!resolved) {
    return {
      ok: false,
      code: "out-of-roots",
      error: "path is not inside any accessible project",
    };
  }
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(resolved);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, code: "not-found", error: "file not found" };
    }
    return { ok: false, code: "io-error", error: errorMessage(e) };
  }
  if (stat.isDirectory()) {
    return {
      ok: false,
      code: "is-directory",
      error: "target is a directory",
    };
  }
  if (stat.size > FILE_VIEWER_MAX_BYTES) {
    return {
      ok: false,
      code: "too-large",
      error: `file is larger than ${FILE_VIEWER_MAX_BYTES} bytes`,
    };
  }
  // Binary detection: peek the first BINARY_PROBE_BYTES looking for a
  // NUL byte. ASCII / UTF-8 text never contains NUL; if we see one in
  // the prefix, the file is almost certainly binary and rendering it
  // as text would produce garbage at best, hang the editor at worst.
  let probe: Buffer;
  try {
    const handle = await fsp.open(resolved, "r");
    try {
      const buffer = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, stat.size));
      await handle.read(buffer, 0, buffer.length, 0);
      probe = buffer;
    } finally {
      await handle.close();
    }
  } catch (e) {
    return { ok: false, code: "io-error", error: errorMessage(e) };
  }
  if (probe.includes(0)) {
    return {
      ok: false,
      code: "binary",
      error: "binary content detected — refusing to load as text",
    };
  }
  let content: string;
  try {
    content = await fsp.readFile(resolved, "utf8");
  } catch (e) {
    return { ok: false, code: "io-error", error: errorMessage(e) };
  }
  const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  // Round 5 Phase V — POSIX write-permission probe. fs.access(W_OK)
  // is the standard way to ask "would write(2) succeed without
  // requiring elevated privileges?". A single sub-millisecond stat
  // per open; surface as `writable: boolean` so the renderer can
  // decide whether to show the lock toggle vs the READ-ONLY banner.
  let writable = false;
  try {
    await fsp.access(resolved, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  return {
    ok: true,
    resolvedPath: resolved,
    content,
    baseline: { mtimeMs: stat.mtimeMs, sha256, size: stat.size },
    writable,
  };
}

export type FileStatErrorCode =
  | "invalid-input"
  | "out-of-roots"
  | "not-found"
  | "io-error";

export type FileStatResult =
  | { ok: true; resolvedPath: string; baseline: FileBaseline }
  | { ok: false; code: FileStatErrorCode; error: string };

export async function handleFileStat(
  deps: FileViewerDeps,
  rawPath: unknown,
): Promise<FileStatResult> {
  if (typeof rawPath !== "string") {
    return { ok: false, code: "invalid-input", error: "path must be a string" };
  }
  const resolved = resolveInsideAllowedRoots(deps.roots(), expandTilde(rawPath));
  if (!resolved) {
    return {
      ok: false,
      code: "out-of-roots",
      error: "path is not inside any accessible project",
    };
  }
  try {
    const baseline = computeBaseline(resolved);
    return { ok: true, resolvedPath: resolved, baseline };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, code: "not-found", error: "file not found" };
    }
    return { ok: false, code: "io-error", error: errorMessage(e) };
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// --- atomic write ------------------------------------------------------------

/**
 * Atomically replace the contents of `targetPath` with `content`. The
 * file is first written to a sibling `<targetPath>.reck-tmp-<random>`,
 * fsynced, then `rename`d over the target. `rename` is atomic at the
 * POSIX level (and at the FUSE level on sshfs), so a reader at any
 * instant sees either the old file or the new file, never a partial
 * write.
 *
 * Caveat (documented in docs/LEARNINGS.md): on sshfs, `fsync` returns
 * before the remote actually flushes unless the mount has `-o
 * sync_writes`. We promise atomicity (no half-written file) but NOT
 * durability across station crashes.
 *
 * Caller is responsible for validating `targetPath` against the
 * allowlist before invoking.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(
    dir,
    `.reck-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}`,
  );
  // Open with O_EXCL so a colliding stale tmp causes failure instead of
  // silently overwriting another in-flight save.
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(tmp, "wx");
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  try {
    await fsp.rename(tmp, targetPath);
  } catch (e) {
    // Rename failed — clean up the orphan tmp so we don't accumulate them.
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

// --- conflict-aware write ----------------------------------------------------

export type FileWriteErrorCode =
  | "invalid-input"
  | "out-of-roots"
  | "is-directory"
  | "conflict"
  | "io-error";

export interface FileWriteRequest {
  path: string;
  content: string;
  baseline: FileBaseline;
  /**
   * When true, skip the baseline-vs-disk comparison. Used by the
   * "Force mine" branch of the conflict banner — the viewer explicitly
   * chooses to overwrite the disk version.
   */
  force?: boolean;
}

export type FileWriteResult =
  | { ok: true; resolvedPath: string; baseline: FileBaseline }
  | {
      ok: false;
      code: FileWriteErrorCode;
      error: string;
      /** Present on `code: "conflict"` only. Lets the viewer hydrate the
       *  conflict banner with the disk state without an extra round-trip. */
      currentBaseline?: FileBaseline;
      currentContent?: string;
    };

/**
 * Save the user's edits to disk, gated by an optimistic-concurrency
 * check against the baseline the viewer captured at open / last save.
 *
 * Algorithm:
 *   1. Validate input + path against allowlist.
 *   2. If the target exists, compute its current baseline. If mtime
 *      AND sha256 match the supplied baseline, the user's view of the
 *      file is fresh — proceed. If only mtime differs but sha matches,
 *      proceed too (some editors rewrite-in-place without changing
 *      content; the meaningful state is unchanged).
 *   3. If sha differs and `force !== true` → CONFLICT. Return the
 *      current state so the viewer can show the conflict banner.
 *   4. Atomic write. Return the new baseline.
 */
export async function handleFileWrite(
  deps: FileViewerDeps,
  req: unknown,
): Promise<FileWriteResult> {
  if (!isWriteRequest(req)) {
    return { ok: false, code: "invalid-input", error: "malformed write request" };
  }
  const resolved = resolveInsideAllowedRoots(deps.roots(), expandTilde(req.path));
  if (!resolved) {
    return {
      ok: false,
      code: "out-of-roots",
      error: "path is not inside any accessible project",
    };
  }
  // Check what's currently on disk.
  let currentStat: fs.Stats | null = null;
  try {
    currentStat = await fsp.stat(resolved);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return { ok: false, code: "io-error", error: errorMessage(e) };
    }
    // ENOENT: target was created since the viewer opened — treat as no
    // baseline conflict, just write.
  }
  if (currentStat?.isDirectory()) {
    return { ok: false, code: "is-directory", error: "target is a directory" };
  }
  if (currentStat && !req.force) {
    const sameMtime = currentStat.mtimeMs === req.baseline.mtimeMs;
    if (!sameMtime) {
      // Mtime drifted — hash to confirm whether content actually changed.
      const currentContent = await fsp.readFile(resolved, "utf8");
      const currentSha = crypto
        .createHash("sha256")
        .update(currentContent, "utf8")
        .digest("hex");
      if (currentSha !== req.baseline.sha256) {
        return {
          ok: false,
          code: "conflict",
          error: "file has changed on disk since last read",
          currentBaseline: {
            mtimeMs: currentStat.mtimeMs,
            sha256: currentSha,
            size: currentStat.size,
          },
          currentContent,
        };
      }
      // Sha matches → harmless rewrite-in-place by another tool. Proceed.
    }
  }
  try {
    await atomicWriteFile(resolved, req.content);
  } catch (e) {
    return { ok: false, code: "io-error", error: errorMessage(e) };
  }
  // Round 3 D1 — stamp this realpath as a self-write BEFORE returning.
  // The fs.watch fire that follows the rename will be filtered by the
  // watch IPC handler so it never reaches the renderer (and therefore
  // never re-enters the auto-save loop). Stamped at success only —
  // failed writes shouldn't shadow legitimate external edits.
  recordSelfWrite(resolved);
  const baseline = computeBaseline(resolved);
  console.log(
    `[file-viewer] write path=${path.basename(resolved)} ` +
      `mtime=${baseline.mtimeMs} sha=${baseline.sha256.slice(0, 8)} ` +
      `bytes=${baseline.size}`,
  );
  return {
    ok: true,
    resolvedPath: resolved,
    baseline,
  };
}

// --- self-write suppression (Round 3 D1) ------------------------------------
//
// After we (the main process) atomically write a file, the OS will fire
// an fs.watch event for that same path 10-200ms later. Without filtering,
// the renderer interprets that as an external change and re-reads the
// file → editor.setContent → onChange → autoSave → write → watch → … a
// self-sustaining ~1–2 Hz loop. The user observed this as ~50ms flicker
// because the spinner toggles three times per cycle and the markdown
// rendered-mode tears down the body with `innerHTML = ""` and rebuilds.
//
// The fix is a small registry of self-write timestamps. After every
// successful `handleFileWrite`, the realpath is stamped with `now`. The
// IPC watcher dispatch checks this map BEFORE forwarding to the renderer
// and drops events whose timestamp is within the suppression window.
// 500ms is generously above the 100ms fs.watch debounce and the 1.5s
// sshfs poll interval (we don't suppress sshfs events anyway because
// those are driven by remote changes that aren't our own writes).
//
// Exposed for direct unit testing — production code reaches the helpers
// through the watch IPC handler below.

export const WATCHER_SUPPRESS_AFTER_WRITE_MS = 500;

/** realpath → ms timestamp of the last self-write. */
const recentSelfWrites = new Map<string, number>();

/**
 * Record that the main process just wrote `realpath`. Subsequent watch
 * events for the same path within `WATCHER_SUPPRESS_AFTER_WRITE_MS` are
 * suppressed by `shouldSuppressWatchEvent`. Accepts an explicit `now`
 * for deterministic testing; production callers pass `Date.now()` (or
 * omit it).
 */
export function recordSelfWrite(realpath: string, now: number = Date.now()): void {
  recentSelfWrites.set(realpath, now);
}

/**
 * Should the next watch event for `realpath` be suppressed? True iff a
 * recent `recordSelfWrite` for the same path falls inside the
 * suppression window measured against `now`. Entries past the window
 * are cleaned up lazily on call.
 *
 * Note: this does NOT delete fresh entries on hit. A single write can
 * legitimately produce multiple fs.watch fires (write-then-truncate,
 * editors that rename-over, etc.). Leaving the entry until expiration
 * means all rapid-fire events in the window are suppressed together,
 * which is the user-visible behaviour we want.
 */
export function shouldSuppressWatchEvent(
  realpath: string,
  now: number = Date.now(),
): boolean {
  const ts = recentSelfWrites.get(realpath);
  if (ts === undefined) return false;
  if (now - ts > WATCHER_SUPPRESS_AFTER_WRITE_MS) {
    recentSelfWrites.delete(realpath);
    return false;
  }
  return true;
}

// --- file watcher ------------------------------------------------------------
//
// Originally implemented via `chokidar`, but chokidar's transitive deps
// (readdirp, anymatch, …) don't survive pnpm's symlinked node_modules
// → electron-builder asar packaging round-trip without `node-linker=
// hoisted`. We avoid that whole class of bug by using `node:fs.watch`
// for local paths (where fsevents propagates) and a stat-poller for
// paths under the sshfs mount (where inotify/fsevents do NOT propagate
// remote changes). Zero external deps; behaviour matches what we'd want
// from chokidar's `{usePolling}` mode anyway.

export interface WatcherStrategy {
  /** `"poll"` for sshfs paths (no inotify propagation), `"native"` otherwise. */
  kind: "poll" | "native";
  intervalMs?: number;
}

/**
 * Choose a watcher strategy for `realpath`. sshfs (under MOUNT_POINT)
 * does not propagate inotify, so a native `fs.watch` would silently
 * miss remote changes. Use polling for that branch; native fsevents
 * elsewhere. Polling interval is conservative (1.5s) to keep CPU low.
 */
export function chokidarOptionsForPath(
  realpath: string,
  mountPoint: string,
): { usePolling: boolean; interval?: number; binaryInterval?: number } {
  const mountWithSep = mountPoint.endsWith("/") ? mountPoint : mountPoint + "/";
  if (realpath === mountPoint || realpath.startsWith(mountWithSep)) {
    return { usePolling: true, interval: 1500, binaryInterval: 3000 };
  }
  return { usePolling: false };
}

interface FileWatcher {
  close(): void;
}

type WatchEvent = "change" | "unlink";

/**
 * Watch a single file. Returns a closable handle. `onEvent` fires when
 * the file changes content (`change`) or is removed (`unlink`).
 *
 * Strategy: paths under the sshfs mount use a stat-poller (sshfs
 * doesn't propagate inotify); everything else uses native `fs.watch`.
 */
function watchSingleFile(
  realpath: string,
  mountPoint: string,
  onEvent: (kind: WatchEvent) => void,
): FileWatcher {
  const opts = chokidarOptionsForPath(realpath, mountPoint);
  if (opts.usePolling) {
    let prevMtime = -1;
    let prevSize = -1;
    const tick = async () => {
      try {
        const stat = await fsp.stat(realpath);
        if (prevMtime === -1) {
          prevMtime = stat.mtimeMs;
          prevSize = stat.size;
          return;
        }
        if (stat.mtimeMs !== prevMtime || stat.size !== prevSize) {
          prevMtime = stat.mtimeMs;
          prevSize = stat.size;
          onEvent("change");
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          onEvent("unlink");
        }
      }
    };
    void tick(); // prime baseline asynchronously
    const timer = setInterval(() => void tick(), opts.interval ?? 1500);
    return { close: () => clearInterval(timer) };
  }
  // Native `fs.watch`. macOS uses fsevents under the hood. The handler
  // debounces internally because fs.watch can emit multiple events per
  // change (e.g., editors that write-then-truncate-then-rename).
  let pending = false;
  let pendingKind: WatchEvent = "change";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    pending = false;
    onEvent(pendingKind);
  };
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(realpath, (eventType) => {
      pending = true;
      pendingKind = eventType === "rename" ? "unlink" : "change";
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 100);
    });
  } catch (e) {
    console.warn(`[file-viewer] fs.watch failed for ${realpath}:`, e);
    return { close: () => {} };
  }
  return {
    close: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

/**
 * Per-window watch registry. Keyed by `{webContentsId, realpath}` so a
 * window can subscribe to multiple files (recursive viewer popups) and
 * we can tear them down independently when the window closes.
 */
interface WatchRecord {
  watcher: FileWatcher;
  realpath: string;
  windowId: number;
}
const watchRegistry = new Map<string, WatchRecord>();

function watchKey(windowId: number, realpath: string): string {
  return `${windowId}:${realpath}`;
}

/**
 * Pure cleanup helper used by `createFileViewerWindow`. Extracted so the
 * regression test for the "Object has been destroyed" crash on close can
 * drive it without instantiating Electron. The key correctness property:
 * `windowId` is a captured integer — the helper never touches a possibly-
 * destroyed `BrowserWindow.webContents` property.
 */
export interface CleanupWindowResourcesArgs {
  resolvedPath: string;
  windowId: number;
  /** The exact BrowserWindow instance — compared by identity against the
   *  registry entry to avoid clobbering a later open of the same path. */
  win: unknown;
  windowsRegistry: Map<string, unknown>;
  watchersRegistry: Map<string, { watcher: { close(): void }; windowId: number }>;
}

export function cleanupWindowResources(args: CleanupWindowResourcesArgs): void {
  if (args.windowsRegistry.get(args.resolvedPath) !== args.win) return;
  args.windowsRegistry.delete(args.resolvedPath);
  for (const [key, rec] of args.watchersRegistry.entries()) {
    if (rec.windowId === args.windowId) {
      try {
        rec.watcher.close();
      } catch {
        // A watcher may already be closed (e.g. via render-process-gone
        // racing with closed); swallow rather than crash main.
      }
      args.watchersRegistry.delete(key);
    }
  }
}

function isReqOfShape<K extends string>(
  v: unknown,
  ...keys: K[]
): v is Record<K, unknown> {
  if (!v || typeof v !== "object") return false;
  return keys.every((k) => k in (v as Record<string, unknown>));
}

function isWriteRequest(v: unknown): v is FileWriteRequest {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.path !== "string") return false;
  if (typeof r.content !== "string") return false;
  if (!r.baseline || typeof r.baseline !== "object") return false;
  const b = r.baseline as Record<string, unknown>;
  if (typeof b.mtimeMs !== "number") return false;
  if (typeof b.sha256 !== "string") return false;
  if (typeof b.size !== "number") return false;
  return true;
}

// Round 4 Phase S — runtime validator for the SSH-backed write request.
// Shape matches `StationWriteRequest` from station-ssh.ts.
function isStationWriteRequest(v: unknown): v is StationWriteRequest {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.path !== "string") return false;
  if (typeof r.content !== "string") return false;
  if (!r.baseline || typeof r.baseline !== "object") return false;
  const b = r.baseline as Record<string, unknown>;
  if (typeof b.mtimeMs !== "number") return false;
  if (typeof b.sha256 !== "string") return false;
  if (typeof b.size !== "number") return false;
  if (r.force !== undefined && typeof r.force !== "boolean") return false;
  return true;
}

// --- batched resolve (for the xterm linkifier) -------------------------------

export interface FileResolveEntry {
  /** The validated absolute path (canonicalised via the allowlist). */
  path: string;
  /** True if `path` exists on disk. */
  exists: boolean;
  /** True if `path` exists and is a directory. */
  isDirectory: boolean;
  /** True if the parent directory of `path` exists. */
  parentExists: boolean;
}

/**
 * Batched existence + kind check. Out-of-roots paths are silently filtered
 * out (the renderer can't infer the existence of files outside accessible
 * projects). Returns one entry per input path that survives the allowlist,
 * in input order.
 *
 * Used by the xterm linkifier: a hovered scrollback line collects all
 * path-like candidates and asks main "which of these are real, which are
 * intended-but-missing, which are directories?" in a single round-trip.
 */
export async function handleFileResolve(
  deps: FileViewerDeps,
  rawPaths: unknown,
): Promise<FileResolveEntry[]> {
  if (!Array.isArray(rawPaths)) return [];
  const out: FileResolveEntry[] = [];
  const roots = deps.roots();
  for (const candidate of rawPaths) {
    if (typeof candidate !== "string") continue;
    const resolved = resolveInsideAllowedRoots(roots, expandTilde(candidate));
    if (!resolved) continue;
    let exists = false;
    let isDirectory = false;
    try {
      const stat = await fsp.stat(resolved);
      exists = true;
      isDirectory = stat.isDirectory();
    } catch {
      // ENOENT or permission denied — treat as "doesn't exist".
    }
    let parentExists = false;
    try {
      const parentStat = await fsp.stat(path.dirname(resolved));
      parentExists = parentStat.isDirectory();
    } catch {
      // parent missing too — leave as false.
    }
    out.push({ path: resolved, exists, isDirectory, parentExists });
  }
  return out;
}

// --- atomic create (for intended-path → "Create" flow) -----------------------

export type FileCreateErrorCode =
  | "invalid-input"
  | "out-of-roots"
  | "exists"
  | "io-error";

export type FileCreateResult =
  | { ok: true; resolvedPath: string; baseline: FileBaseline }
  | { ok: false; code: FileCreateErrorCode; error: string };

/**
 * Atomically create an empty file at `rawPath`. Used by the intended-path
 * create flow (Cmd+click on a dashed-underline path → popup → Create
 * button). Creates any missing parent directories inside the allowed
 * root. Refuses to overwrite an existing file (the popup's UX distinguishes
 * "create empty" from "edit existing"; overwriting via this path would be
 * data loss).
 */
export async function handleFileCreate(
  deps: FileViewerDeps,
  rawPath: unknown,
): Promise<FileCreateResult> {
  if (typeof rawPath !== "string") {
    return { ok: false, code: "invalid-input", error: "path must be a string" };
  }
  const resolved = resolveInsideAllowedRoots(deps.roots(), expandTilde(rawPath));
  if (!resolved) {
    return {
      ok: false,
      code: "out-of-roots",
      error: "path is not inside any accessible project",
    };
  }
  // Refuse to overwrite. fs.access throws if the file is missing.
  try {
    await fsp.access(resolved);
    return { ok: false, code: "exists", error: "file already exists" };
  } catch {
    // Falls through to create — expected branch when target is missing.
  }
  try {
    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    await fsp.writeFile(resolved, "", "utf8");
  } catch (e) {
    return { ok: false, code: "io-error", error: errorMessage(e) };
  }
  return {
    ok: true,
    resolvedPath: resolved,
    baseline: computeBaseline(resolved),
  };
}

// --- BrowserWindow factory + registry ---------------------------------------

/**
 * One popup per file. Keyed by canonical realpath so two requests for the
 * same file from different cwds collapse to a single window. Mirrors the
 * `paneWindows` map at main.ts:26.
 */
const fileViewerWindows = new Map<string, BrowserWindow>();

/**
 * Round 6 Phase CC — registry of in-flight streaming suffix searches.
 * Keyed by an opaque searchId carried in the popup URL. The renderer
 * sends `file:suffix:cancel(searchId)` when the user clicks the Stop
 * button; the worker is also terminated on window close so a stale
 * search can't keep walking forever.
 */
const activeSuffixSearches = new Map<string, SuffixSearchHandle>();

/**
 * Round 8.1 Phase SS — reverse-lookup from a streaming popup window to
 * its searchId. Used on re-click: if the user clicks the same path
 * again while the previous popup's worker is still walking (commonly
 * because the sshfs mount is stalled), the focus-existing branch would
 * just refocus the hung popup. Instead, we look up its searchId here,
 * check whether the handle is still active, and close the popup so a
 * fresh search runs.
 */
const streamingPopupSearchIds = new Map<BrowserWindow, string>();

/**
 * Round 8.7 follow-up — pure helper used by both the openInViewer
 * handler's local-exists branch AND createFileViewerWindow's
 * defence-in-depth dedupe. Returns true when the existing window in
 * the registry can be reused (focus + return) instead of spawning a
 * fresh one. Streaming-search popups are excluded — they share the
 * same registry key as the file viewers they would resolve to on a
 * match, so reusing one closes the streaming popup itself (its
 * renderer's window.close() runs after the cascade IPC resolves).
 *
 * Pure (no Electron deps) so unit tests can drive every branch.
 */
export function shouldFocusExistingViewer(
  existing: { isDestroyed(): boolean } | undefined,
  streamingMap: Map<{ isDestroyed(): boolean }, unknown>,
): boolean {
  if (!existing) return false;
  if (existing.isDestroyed()) return false;
  if (streamingMap.has(existing)) return false;
  return true;
}

/**
 * Default factory: spawn a real worker_threads child loading the
 * compiled search-worker.js sitting next to this file. In tests the
 * orchestrator's `workerFactory` is replaced with a fake.
 */
function defaultWorkerFactory(): StreamingWorkerLike {
  const workerPath = path.join(__dirname, "search-worker.js");
  const w = new Worker(workerPath);
  // node:worker_threads Worker matches StreamingWorkerLike's shape
  // structurally; the cast collapses Node's overload-richer types into
  // our narrow interface.
  return w as unknown as StreamingWorkerLike;
}

const suffixSearchOrchestrator = createSuffixSearchOrchestrator({
  workerFactory: defaultWorkerFactory,
});

// Round 8.6 Phase 3 — backend selection. Probes `which rg` locally and
// `command -v rg` over SSH; both are cached for the process lifetime.
// When ripgrep is present we use it instead of the readdir walker; for
// station-pane clicks we ALSO line up an SSH-rg fallback worker so the
// orchestrator can catch files that exist on the Pi but not yet in the
// local sshfs mirror.
const searchBackends = createBackendDetection({
  executableProbe: defaultLocalExecutableProbe,
  sshProbe: () =>
    defaultSshRgProbe({
      sshKey: SSH_KEY,
      sshHost: SSH_HOST,
      connectTimeoutSec: SSH_CONNECT_TIMEOUT_SEC,
    }),
});

/**
 * test seam for the search-backend probes. The pipeline
 * regression tests (open-in-viewer-pipeline.test.ts) drive the REAL
 * `file:openInViewer` handler end-to-end; without this seam those tests
 * would probe for rg over real SSH and spawn real ssh children. Absent
 * (production), behavior is identical to before: the module-level
 * `searchBackends` probes run.
 */
export interface SearchBackendOverrides {
  /** Replaces `searchBackends.hasLocalRg()` (resolves rg path or null). */
  hasLocalRg?: () => Promise<string | null>;
  /** Replaces `searchBackends.hasSshRg()` (station-side rg probe). */
  hasSshRg?: () => Promise<boolean>;
  /** Injected into the ssh fallback worker instead of real `spawn("ssh")`. */
  sshSpawnFn?: SshSpawnFn;
}

interface BackendChoice {
  workerFactory: () => StreamingWorkerLike;
  /** Whether the primary worker emits per-readdir progress events.
   * The legacy readdir walker does; the rg backends don't (commit
   * a3b843f), so with rg `scannedDirs` stays 0 for the whole search.
   * The renderer needs this to know whether `scannedDirs === 0` at
   * done-time means "couldn't read any root" (walker) or nothing at
   * all (rg) —'s misleading sshfs-stall banner. */
  progressCapable: boolean;
  fallback?: {
    factory: () => StreamingWorkerLike;
    when: () => boolean;
    onStart?: () => void;
  };
}

/**
 * Round 8.6 Phase 3e — log the backend selection ONCE per probe outcome
 * so the user can tell from `pnpm dev` output (or the packaged log)
 * whether searches are running on the fast rg path or the slow walker
 * fallback. Two flags so each "missing" message fires exactly once even
 * across many clicks.
 */
let loggedLocalRgChoice = false;
let loggedSshRgChoice = false;

async function pickSearchBackend(
  sourceHost: "station" | "local",
  onFallbackStart?: () => void,
  overrides?: SearchBackendOverrides,
): Promise<BackendChoice> {
  const localRgPath = overrides?.hasLocalRg
    ? await overrides.hasLocalRg()
    : await searchBackends.hasLocalRg();
  const hasSshRg =
    sourceHost === "station"
      ? overrides?.hasSshRg
        ? await overrides.hasSshRg()
        : await searchBackends.hasSshRg()
      : false;

  if (!loggedLocalRgChoice) {
    loggedLocalRgChoice = true;
    if (localRgPath) {
      console.log(
        `[search-backend] local rg detected at ${localRgPath} — using fast ripgrep backend`,
      );
    } else {
      console.warn(
        "[search-backend] local rg NOT detected — falling back to the legacy readdir walker (slow, 3–20s on sshfs). " +
          "Install with `brew install ripgrep` and restart the satellite for ~10x faster search.",
      );
    }
  }
  if (sourceHost === "station" && !loggedSshRgChoice) {
    loggedSshRgChoice = true;
    if (hasSshRg) {
      console.log(
        "[search-backend] ssh rg available on station — SSH-fallback armed for station-only files",
      );
    } else {
      console.warn(
        "[search-backend] ssh rg NOT detected on station — no SSH-fallback. " +
          "Files visible on the Pi but missing from the local sshfs mirror will NOT be found. " +
          "Install ripgrep on the Pi (`sudo apt install -y ripgrep`) to enable the fallback.",
      );
    }
  }

  const workerFactory: () => StreamingWorkerLike = localRgPath
    ? () => createRgLocalWorker({ rgPath: localRgPath })
    : defaultWorkerFactory;
  const progressCapable = !localRgPath;
  if (!hasSshRg) {
    return { workerFactory, progressCapable };
  }
  return {
    workerFactory,
    progressCapable,
    fallback: {
      factory: () =>
        createRgSshWorker({
          sshConfig: {
            sshKey: SSH_KEY,
            sshHost: SSH_HOST,
            connectTimeoutSec: SSH_CONNECT_TIMEOUT_SEC,
          },
          sshSpawnFn: overrides?.sshSpawnFn,
        }),
      when: () => sourceHost === "station",
      onStart: onFallbackStart,
    },
  };
}

let nextSearchId = 1;
function newSearchId(): string {
  const id = `search-${Date.now()}-${nextSearchId}`;
  nextSearchId += 1;
  return id;
}

export interface CreateViewerOptions extends ViewerGeometryOverride {
  resolvedPath: string;
  /** Theme background color, matched to the saved theme (cream / dark). */
  bgColor: string;
  /** Path to the popup HTML in production (next to renderer/index.html). */
  rendererHtmlPath: string;
  /** Dev-server URL prefix when running under vite. Set to null for prod. */
  devServerUrl: string | null;
  /** Path to the compiled preload script. */
  preloadPath: string;
  /** The file's basename, used in the BrowserWindow title. */
  title: string;
  /** When set to "station-remote", the popup fetches the file via SSH
   *  instead of plain `node:fs` (Phase 8 of linkifier-followups). The
   *  popup also enters read-only mode and shows a "Station file" banner. */
  host?: "station-remote";
  /** Round 5 Phase U — when the suffix-fallback finds multiple candidates,
   *  the popup opens to a picker instead of attempting to read the
   *  originally-clicked path. Encoded into the URL as a `candidates`
   *  query param (JSON array). */
  suffixCandidates?: string[];
  /** Round 6 Phase CC — when the popup is opened with a search in flight,
   *  the URL carries `suffixSearchPending=1` and `searchId=<id>` so the
   *  renderer subscribes to the streaming events. `progressCapable`
   *  tells the renderer whether the chosen backend emits
   *  per-readdir progress: the rg backends don't, so for them
   *  `scannedDirs === 0` at done-time carries no stalled-mount signal
   *  and the plain no-matches banner must render instead. */
  suffixSearchPending?: {
    searchId: string;
    suffix: string;
    progressCapable?: boolean;
  };
  /** Round 6 Phase DD1 — display-only path override for banners. When
   *  the resolved path is a Mac mount-mirror of a Pi file, the create
   *  banner should show the Pi path (the user is mentally on the
   *  station). The underlying read / create still uses the Mac path
   *  via sshfs. */
  displayPath?: string;
  /** Round 8 Phase MM — the active project's cwd at the time of the
   *  click. Threaded through to the popup so its in-popup linkifiers
   *  (CodeMirror + markdown) can pass the same value back to main on
   *  cascaded clicks, keeping the multi-root suffix search anchored
   *  to the originating project. */
  projectCwd?: string;
  /** Round 8 follow-up — when set, the streaming-picker popup
   *  translates each matched path (Mac mount mirror) into its Pi-side
   *  form for display only. Used for station-context clicks so the
   *  user sees the same path conventions they were mentally working
   *  in. The picker's onClick still calls openInViewer with the Mac
   *  path because main reads files via the local mount. */
  displayTranslation?: { mountRoot: string; stationRoot: string };
}

/**
 * Get the BrowserWindow currently showing `realpath`, or `undefined` if
 * no popup is open for it. Used by main.ts for the focus-existing branch
 * of `file:openInViewer`.
 */
export function getFileViewerWindow(
  realpath: string,
): BrowserWindow | undefined {
  return fileViewerWindows.get(realpath);
}

/**
 * Spawn a parent-less BrowserWindow showing the file at `opts.resolvedPath`.
 * Adds it to the registry. Cleans up on `closed` and `render-process-gone`.
 *
 * Mirrors `createPaneWindow()` in main.ts so the popup chrome (hiddenInset
 * titlebar, theme-matched bgColor, window.open allowlist) is consistent
 * across detach popouts and file viewers.
 */
export function createFileViewerWindow(
  opts: CreateViewerOptions,
): BrowserWindow {
  // Reject second-open of an already-open file: callers should have
  // checked first via getFileViewerWindow(), but defense-in-depth.
  // `shouldFocusExistingViewer` skips streaming-search popups so the
  // cascade from a match-pick doesn't focus+close the streaming popup
  // itself (Round 8.7 follow-up — see the helper's doc comment).
  const existing = fileViewerWindows.get(opts.resolvedPath);
  if (shouldFocusExistingViewer(existing, streamingPopupSearchIds)) {
    existing!.focus();
    return existing!;
  }

  const geometry = computeViewerGeometry(screen.getPrimaryDisplay(), {
    width: opts.width,
    height: opts.height,
    x: opts.x,
    y: opts.y,
  });

  const win = new BrowserWindow({
    width: geometry.width,
    height: geometry.height,
    x: geometry.x,
    y: geometry.y,
    minWidth: FILE_VIEWER_MIN_WIDTH,
    minHeight: FILE_VIEWER_MIN_HEIGHT,
    // same format the renderer sets via document.title on
    // mount, so there's no title flash between window creation and
    // page load. The static file-viewer.html <title> only shows if
    // the renderer never mounts (hard crash).
    title: `Reck — File [${opts.title}]`,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: opts.bgColor,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 },
  });

  const params = new URLSearchParams({ path: opts.resolvedPath });
  if (opts.host) params.set("host", opts.host);
  if (opts.suffixCandidates && opts.suffixCandidates.length > 0) {
    // Cap the encoded list so the URL stays under typical limits even
    // for noisy projects. The renderer caps display similarly.
    params.set(
      "candidates",
      JSON.stringify(opts.suffixCandidates.slice(0, 50)),
    );
  }
  if (opts.suffixSearchPending) {
    params.set("suffixSearchPending", "1");
    params.set("searchId", opts.suffixSearchPending.searchId);
    params.set("suffix", opts.suffixSearchPending.suffix);
    if (typeof opts.suffixSearchPending.progressCapable === "boolean") {
      params.set(
        "searchProgressCapable",
        opts.suffixSearchPending.progressCapable ? "1" : "0",
      );
    }
  }
  if (opts.displayPath) {
    params.set("displayPath", opts.displayPath);
  }
  if (opts.projectCwd) {
    params.set("projectCwd", opts.projectCwd);
  }
  if (opts.displayTranslation) {
    params.set("displayMountRoot", opts.displayTranslation.mountRoot);
    params.set("displayStationRoot", opts.displayTranslation.stationRoot);
  }
  const queryString = params.toString();
  if (opts.devServerUrl) {
    win.loadURL(`${opts.devServerUrl}/file-viewer.html?${queryString}`);
  } else {
    win.loadFile(opts.rendererHtmlPath, { search: `?${queryString}` });
  }

  // Same external-URL allowlist as the main window's popouts.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const check = checkExternalUrl(url);
    if (check.ok) {
      shell.openExternal(check.url);
    } else {
      console.warn(
        `[file-viewer] rejected window.open: ${check.reason}; url=${JSON.stringify(url)}`,
      );
    }
    return { action: "deny" };
  });

  // Capture webContents.id IMMEDIATELY, before any cleanup races. The
  // `closed` event fires AFTER webContents has been destroyed, so
  // `win.webContents.id` would throw "Object has been destroyed". The
  // captured local closes over the integer instead of touching the
  // destroyed property — see `cleanupWindowResources` regression test.
  const capturedWindowId = win.webContents.id;
  const cleanup = () => {
    cleanupWindowResources({
      resolvedPath: opts.resolvedPath,
      windowId: capturedWindowId,
      win,
      windowsRegistry: fileViewerWindows as unknown as Map<string, unknown>,
      watchersRegistry: watchRegistry as unknown as Map<
        string,
        { watcher: { close(): void }; windowId: number }
      >,
    });
  };
  win.on("closed", cleanup);
  win.webContents.on("render-process-gone", (_e, details) => {
    console.warn(
      `[file-viewer] render-process-gone window=${win.id} path=${opts.resolvedPath} ` +
        `reason=${details.reason} exitCode=${details.exitCode}`,
    );
    if (!win.isDestroyed()) win.close();
    cleanup();
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (isMain) {
      console.warn(
        `[file-viewer] did-fail-load window=${win.id} path=${opts.resolvedPath} ` +
          `code=${code} desc=${desc} url=${url}`,
      );
    }
  });
  win.webContents.on("unresponsive", () => {
    console.warn(`[file-viewer] unresponsive window=${win.id} path=${opts.resolvedPath}`);
  });
  // Forward renderer console output to main stdout so the popup's
  // [diag] traces appear in /tmp/reck-log.txt without needing DevTools.
  win.webContents.on(
    "console-message",
    (_e, level, message, line, sourceId) => {
      console.log(
        `[file-viewer.${win.id}.renderer] ${message} (lvl=${level} ${sourceId}:${line})`,
      );
    },
  );

  fileViewerWindows.set(opts.resolvedPath, win);
  console.log(`[file-viewer] open ${opts.resolvedPath} → window ${win.id}`);
  win.on("close", () => {
    console.log(
      `[file-viewer] close ${opts.resolvedPath} window=${win.id} ` +
        `crashed=${win.webContents.isCrashed()}`,
    );
  });
  return win;
}

/**
 * Close every file-viewer popup. Called from main.ts on app quit so we
 * don't leak windows past the parent process.
 */
export function closeAllFileViewers(): void {
  for (const win of fileViewerWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  fileViewerWindows.clear();
}

// --- IPC wiring --------------------------------------------------------------

export interface FileViewerIpcDeps extends FileViewerDeps {
  /** Build the per-window options bag. Lets main.ts inject the renderer
   *  HTML path, dev URL, preload path, and theme bgColor without those
   *  details leaking into this module. */
  buildCreateOptions(resolvedPath: string): Omit<CreateViewerOptions, "title">;
  /** sshfs mount root, used to decide whether to force polling for
   *  chokidar watchers. */
  mountPoint(): string;
  /** test-only backend overrides; production never sets it. */
  searchBackendOverrides?: SearchBackendOverrides;
}

/**
 * Wire the `file:*` IPC handlers. Call once from main.ts after the main
 * window has been created so the deps closure can capture live state
 * (current theme, project-derived roots, dev server URL).
 *
 * Idempotent: if called twice, replaces the previous handlers (Electron
 * throws on a duplicate `ipcMain.handle` registration, so we remove first).
 */
export function registerFileViewerIpc(deps: FileViewerIpcDeps): void {
  ipcMain.removeHandler("file:read");
  ipcMain.removeHandler("file:readStation");
  ipcMain.removeHandler("file:writeStation");
  ipcMain.removeHandler("file:stat");
  ipcMain.removeHandler("file:resolve");
  ipcMain.removeHandler("file:create");
  ipcMain.removeHandler("file:write");
  ipcMain.removeHandler("file:watch:subscribe");
  ipcMain.removeHandler("file:watch:unsubscribe");
  ipcMain.removeHandler("file:openInViewer");
  ipcMain.removeHandler("file:suffix:cancel");
  ipcMain.removeHandler("file:createStation");

  ipcMain.handle("file:read", (_e, p: unknown) => handleFileRead(deps, p));
  // Phase 8 of linkifier-followups: SSH-backed read for station files
  // OUTSIDE the sshfs projects mount. The renderer popup hits this
  // when its URL carries `?host=station-remote`. No allowlist check —
  // the station SSH path validator (isStationPathSafe) is the gate.
  ipcMain.handle("file:readStation", async (_e, rawPath: unknown) => {
    if (typeof rawPath !== "string") {
      return {
        ok: false,
        code: "invalid-input",
        error: "path must be a string",
      };
    }
    return readStationFile(rawPath);
  });
  // Round 4 Phase S — SSH-backed write counterpart of file:readStation.
  // Same security model as the read path: isStationPathSafe + the SSH
  // key's POSIX permissions are the gate. The renderer's autoSave
  // pipeline calls this for any popup opened with ?host=station-remote
  // (which now also drops its read-only flag).
  ipcMain.handle("file:writeStation", async (_e, req: unknown): Promise<StationWriteResult> => {
    if (!isStationWriteRequest(req)) {
      return {
        ok: false,
        code: "invalid-input",
        error: "malformed write request",
      };
    }
    return writeStationFile(req);
  });
  ipcMain.handle("file:stat", (_e, p: unknown) => handleFileStat(deps, p));
  ipcMain.handle("file:resolve", (_e, ps: unknown) => handleFileResolve(deps, ps));
  ipcMain.handle("file:create", (_e, p: unknown) => handleFileCreate(deps, p));
  ipcMain.handle("file:write", (_e, req: unknown) => handleFileWrite(deps, req));

  ipcMain.handle("file:watch:subscribe", (e, rawPath: unknown) => {
    if (typeof rawPath !== "string") {
      return { ok: false, code: "invalid-input", error: "path must be a string" };
    }
    const resolved = resolveInsideAllowedRoots(deps.roots(), expandTilde(rawPath));
    if (!resolved) {
      return {
        ok: false,
        code: "out-of-roots",
        error: "path is not inside any accessible project",
      };
    }
    const windowId = e.sender.id;
    const key = watchKey(windowId, resolved);
    // Tear down any existing subscription so resubscribing during a
    // re-render doesn't leak watchers.
    const existing = watchRegistry.get(key);
    if (existing) {
      void existing.watcher.close();
      watchRegistry.delete(key);
    }
    const watcher = watchSingleFile(resolved, deps.mountPoint(), (kind) => {
      const target = BrowserWindow.fromWebContents(e.sender);
      if (!target || target.isDestroyed()) return;
      // Round 3 D1 — drop watch events that match a recent self-write.
      // `unlink` is never suppressed: a delete is always meaningful even
      // if it follows one of our writes (which shouldn't happen, but
      // failing-open here prevents a stuck viewer).
      const now = Date.now();
      const suppress = kind === "change" && shouldSuppressWatchEvent(resolved, now);
      console.log(
        `[file-viewer] watch path=${path.basename(resolved)} ` +
          `kind=${kind} suppressed=${suppress}`,
      );
      if (suppress) return;
      target.webContents.send("file:watch:event", { path: resolved, kind });
    });
    watchRegistry.set(key, { watcher, realpath: resolved, windowId });
    return { ok: true, resolvedPath: resolved };
  });

  ipcMain.handle("file:watch:unsubscribe", (e, rawPath: unknown) => {
    if (typeof rawPath !== "string") {
      return { ok: false, code: "invalid-input", error: "path must be a string" };
    }
    const resolved = resolveInsideAllowedRoots(deps.roots(), expandTilde(rawPath));
    if (!resolved) {
      return { ok: false, code: "out-of-roots", error: "out of roots" };
    }
    const key = watchKey(e.sender.id, resolved);
    const rec = watchRegistry.get(key);
    if (rec) {
      rec.watcher.close();
      watchRegistry.delete(key);
    }
    return { ok: true };
  });

  // Round 8.5 — when the user Cmd+clicks a link that resolves to a
  // file already shown in a popup, we'd previously call
  // `existing.focus()` and return `{ok: true}`. That's correct
  // cross-window behaviour (a different popup pops to front), but a
  // SELF-click — link in popup P points to P's own file — focuses the
  // already-focused window: pure silence. Distinguish by comparing
  // the sender's WebContents id to the existing window's so the
  // renderer can show a "Already viewing this file" toast.
  const focusOrSameWindow = (
    existing: BrowserWindow,
    senderId: number,
  ): { ok: true; code: "same-popup" | "focused-existing" } => {
    if (senderId === existing.webContents.id) {
      return { ok: true, code: "same-popup" };
    }
    existing.focus();
    return { ok: true, code: "focused-existing" };
  };

  ipcMain.handle(
    "file:openInViewer",
    async (
      e,
      arg: {
        path?: unknown;
        opener?: unknown;
        sourceHost?: unknown;
        originalText?: unknown;
        projectCwd?: unknown;
      },
    ) => {
      const rawPath = arg?.path;
      if (typeof rawPath !== "string") {
        return {
          ok: false,
          code: "invalid-input",
          error: "path must be a string",
        };
      }
      const sourceHost =
        arg?.sourceHost === "station" || arg?.sourceHost === "local"
          ? arg.sourceHost
          : undefined;
      // Round 6 Phase CC3 — originalText preserves the raw click text
      // BEFORE resolveActivatePath's project-root prepending, so main
      // can detect deterministic inputs (absolute / ~/x) and skip the
      // suffix-fallback search for those.
      const originalText =
        typeof arg?.originalText === "string" ? arg.originalText : rawPath;
      // Round 8 Phase MM — the active project's cwd at the time of the
      // click. Forwarded to every `createFileViewerWindow` call below
      // so the popup's in-popup linkifiers can re-attach it on
      // cascaded clicks. Phase NN uses this for multi-root search.
      const projectCwd =
        typeof arg?.projectCwd === "string" && arg.projectCwd.length > 0
          ? arg.projectCwd
          : undefined;
      const opener = typeof arg?.opener === "string" ? arg.opener : undefined;
      const mountPoint =
        deps.mountPointPath?.() ?? path.join(os.homedir(), "reck", "projects");
      const stationRoot = deps.stationRoot?.() ?? null;
      // Round 9 — normalize the threaded cwd by FORM (which root prefix
      // it sits under), not by the sourceHost flag. Popups stamp the cwd
      // in whichever form their surface knew (station panes: Pi form;
      // local popups: mount form), and cascaded popup clicks forward it
      // WITHOUT sourceHost — the old flag-gated translation left a
      // Pi-form cwd untranslated on those, and the truthy-but-
      // Mac-nonexistent path disarmed every miss rescue (2026-07-10
      // obsidian-brain `.raw/...` field failure).
      const cwdForms = normalizeProjectCwd(projectCwd, {
        mountPoint,
        stationRoot,
      });
      console.log("[file-viewer] [file:openInViewer] in", {
        rawPath,
        sourceHost,
        opener,
        originalText,
        projectCwd,
        cwdForms,
      });
      // Phase 3 of linkifier-followups: host-aware expansion. Station-pane
      // tildes expand against the Pi's home; non-mount station paths are
      // surfaced as `unreachable` so the renderer can show an explicit
      // banner instead of the misleading "file doesn't exist yet" message.
      const expanded = expandTildeForHost(rawPath, {
        sourceHost,
        localHome: deps.localHome?.() ?? os.homedir(),
        stationHome: deps.stationHome?.() ?? undefined,
        stationRoot: stationRoot ?? undefined,
        mountPoint,
        // Round 8.6 — anchor project-relative paths from station panes.
        // Round 9 — prefer the Pi FORM of the cwd: a mount-form cwd
        // threaded to a station click would otherwise anchor a garbage
        // Mac-prefixed "station" path and misroute to station-remote.
        projectCwd:
          sourceHost === "station" ? cwdForms.station ?? projectCwd : undefined,
      });
      console.log("[file-viewer] expandTildeForHost ->", {
        kind: expanded.kind,
        path: expanded.kind === "unreachable" ? undefined : expanded.path,
      });
      if (expanded.kind === "unreachable") {
        try {
          dialog.showMessageBox({
            type: "info",
            title: "Station file outside mount",
            message: "This file lives on the station and isn't reachable from this Mac.",
            detail: expanded.reason,
            buttons: ["OK"],
          });
        } catch {
          // dialog is unavailable in tests / non-Electron contexts.
        }
        console.warn(`[file-viewer] unreachable: ${expanded.reason}`);
        return {
          ok: false,
          code: "unreachable",
          error: expanded.reason,
        };
      }
      // Phase 8 of linkifier-followups: station-remote paths are
      // reachable via SSH (same key sshfs uses). Open a popup whose URL
      // carries `host=station-remote`; the popup uses `file:readStation`
      // for read and is forced into read-only mode (writes deferred).
      if (expanded.kind === "station-remote") {
        const stationPath = expanded.path;

        // Round 8 Phase NN — when the click is non-deterministic
        // (relative path) AND projectCwd is set AND the project's
        // tree exists at the local mount mirror, run a streaming
        // suffix search against the mirror BEFORE falling through to
        // the station-remote popup. The mirror has the same files as
        // the Pi (sshfs); a hit lets us open the local mount path
        // (which already classifies as STATION via title-badge)
        // instead of going through SSH for every read.
        // Round 9 — the normalized local form covers BOTH a Pi-form cwd
        // (translated) and an already-mount-form cwd; the prefix check
        // keeps Mac-local (non-mount) projects from arming the mirror.
        const mp = mountPoint.replace(/\/+$/, "");
        const mountMirror =
          cwdForms.local &&
          (cwdForms.local === mp || cwdForms.local.startsWith(mp + "/"))
            ? cwdForms.local
            : null;
        const stationSearchRoots = mountMirror
          ? await composeSuffixSearchRoots(null, mountMirror)
          : [];
        const stationSuffix = originalText.replace(/^\.\/+/, "");
        const canStationSearch =
          !isDeterministicInput(originalText) &&
          stationSearchRoots.length > 0 &&
          stationSuffix.length > 0 &&
          !stationSuffix.startsWith("/") &&
          !stationSuffix.startsWith("~");
        console.log("[file-viewer] station-remote branch decision", {
          stationPath,
          canStationSearch,
          stationSuffix,
          stationSearchRoots,
          isDeterministic: isDeterministicInput(originalText),
        });
        if (canStationSearch) {
          const searchId = newSearchId();
          // The popup needs a registry key — use the suffix-anchored
          // path under the mount mirror as a stable identifier. It
          // doesn't have to exist; it's the slot the streaming-picker
          // popup occupies while the worker walks.
          const popupKey = path.join(mountMirror!, stationSuffix);
          const existingMirror = fileViewerWindows.get(popupKey);
          if (existingMirror && !existingMirror.isDestroyed()) {
            // Round 8.1 Phase SS — if the existing popup is still
            // streaming (worker handle not yet done), the user
            // re-clicked to retry a hung search. Close it so a fresh
            // search runs instead of refocusing the stuck popup.
            const existingSearchId =
              streamingPopupSearchIds.get(existingMirror);
            const existingHandle = existingSearchId
              ? activeSuffixSearches.get(existingSearchId)
              : undefined;
            if (existingHandle && !existingHandle.isDone()) {
              existingMirror.close();
            } else {
              return focusOrSameWindow(existingMirror, e.sender.id);
            }
          }
          const baseOpts = deps.buildCreateOptions(popupKey);
          // Hoisted above the window creation so the popup URL carries
          // the backend's progress capability (see the
          // local-branch twin). The thunk body runs only after
          // `safeSend` below is initialised.
          const backend = await pickSearchBackend(
            "station",
            () => safeSend("file:suffix:fallback-start", { searchId }),
            deps.searchBackendOverrides,
          );
          // stationRoot is provably non-null here: expandTildeForHost
          // only returns kind "station-remote" when stationHome AND
          // stationRoot were configured. The non-null assertion
          // satisfies TS's narrowing limit across the boundary.
          const win = createFileViewerWindow({
            ...baseOpts,
            title: path.basename(stationSuffix),
            suffixSearchPending: {
              searchId,
              suffix: stationSuffix,
              progressCapable: backend.progressCapable,
            },
            // Round 9 — stamp the Pi FORM: this popup's cascaded clicks
            // send sourceHost:"station", whose expansion anchors on a
            // Pi-form cwd.
            projectCwd: cwdForms.station ?? projectCwd,
            displayTranslation: {
              mountRoot: mountPoint,
              stationRoot: stationRoot!,
            },
          });
          const safeSend = (channel: string, payload: unknown) => {
            if (win.isDestroyed()) return;
            try {
              win.webContents.send(channel, payload);
            } catch {
              // webContents destroyed mid-send.
            }
          };
          // same translation as the local branch: the
          // ssh fallback needs Pi-side roots, not the mirror's.
          const stationRemoteFallbackRoots = backend.fallback
            ? translateSearchRootsToStation(
                stationSearchRoots,
                mountPoint,
                stationRoot,
              )
            : [];
          const handle = suffixSearchOrchestrator.startSearch({
            roots: stationSearchRoots,
            suffix: stationSuffix,
            workerFactory: backend.workerFactory,
            fallback:
              backend.fallback && stationRemoteFallbackRoots.length > 0
                ? {
                    ...backend.fallback,
                    roots: stationRemoteFallbackRoots,
                  }
                : undefined,
            onMatch: (matchedPath) =>
              safeSend("file:suffix:match", {
                searchId,
                path: matchedPath,
              }),
            onProgress: (info) =>
              safeSend("file:suffix:progress", {
                searchId,
                scannedDirs: info.scannedDirs,
                foundCount: info.foundCount,
              }),
            onDone: (totalFound) => {
              activeSuffixSearches.delete(searchId);
              // say WHERE we searched so the renderer's
              // no-match banner can render it (the 2026-06-06 failure
              // would have been a 5-second diagnosis with this line).
              safeSend("file:suffix:done", {
                searchId,
                totalFound,
                searchedRoots: stationSearchRoots,
              });
            },
            onCancelled: (totalFound) => {
              activeSuffixSearches.delete(searchId);
              safeSend("file:suffix:cancelled", {
                searchId,
                totalFound,
              });
            },
          });
          activeSuffixSearches.set(searchId, handle);
          streamingPopupSearchIds.set(win, searchId);
          win.once("closed", () => {
            const h = activeSuffixSearches.get(searchId);
            if (h && !h.isDone()) h.cancel();
            activeSuffixSearches.delete(searchId);
            streamingPopupSearchIds.delete(win);
          });
          return { ok: true };
        }

        const key = `station-remote:${stationPath}`;
        const existingRemote = fileViewerWindows.get(key);
        if (existingRemote && !existingRemote.isDestroyed()) {
          return focusOrSameWindow(existingRemote, e.sender.id);
        }
        const baseOpts = deps.buildCreateOptions(stationPath);
        const title = path.basename(stationPath);
        // Register under the special station-remote key so the local
        // realpath registry doesn't collide. The window's identity is
        // the station-remote path; closing it cleans up the same key.
        const win = createFileViewerWindow({
          ...baseOpts,
          resolvedPath: stationPath,
          host: "station-remote",
          title,
          // Round 9 — Pi form for station-remote cascades (see above).
          projectCwd: cwdForms.station ?? projectCwd,
        });
        fileViewerWindows.delete(stationPath);
        fileViewerWindows.set(key, win);
        return { ok: true };
      }
      const resolved = resolveInsideAllowedRoots(
        deps.roots(),
        expanded.path,
      );
      if (!resolved) {
        console.warn("[file-viewer] resolveInsideAllowedRoots -> out-of-roots", {
          attempted: expanded.path,
          roots: deps.roots(),
        });
        return {
          ok: false,
          code: "out-of-roots",
          error: "path is not inside any accessible project",
        };
      }
      console.log("[file-viewer] resolveInsideAllowedRoots ->", { resolved });
      // Round 5 Phase U + Round 6 Phase CC — find-by-suffix fallback.
      // If the resolved path doesn't exist:
      //   - deterministic input (`/abs`, `~/x`) → no search; the popup
      //     opens directly on the not-found path and renders the
      //     create banner.
      //   - relative input → open the popup IMMEDIATELY with a
      //     suffixSearchPending flag and stream worker results into it.
      const exists = await pathExists(resolved);
      if (exists) {
        console.log("[file-viewer] exists -> spawn popup", { resolved });
        const existing = fileViewerWindows.get(resolved);
        // See shouldFocusExistingViewer's doc comment for the
        // streaming-popup skip rationale.
        if (shouldFocusExistingViewer(existing, streamingPopupSearchIds)) {
          return focusOrSameWindow(existing!, e.sender.id);
        }
        const baseOpts = deps.buildCreateOptions(resolved);
        createFileViewerWindow({
          ...baseOpts,
          title: path.basename(resolved),
          // Round 9 — stamp the LOCAL form (this popup's cascaded clicks
          // send no sourceHost), deriving from the opened path when no
          // cwd was threaded so cascades stay self-healing.
          projectCwd:
            cwdForms.local ??
            deriveProjectAnchor(resolved, {
              roots: deps.roots(),
              mountPoint,
            }) ??
            undefined,
        });
        return { ok: true };
      }
      console.log("[file-viewer] not-exists, choosing fallback", { resolved });

      // Round 6 Phase DD1 — when the resolved path is a Mac mount-mirror
      // of a Pi file AND the click came from a station pane, the create
      // banner should display the Pi-side path (the user is mentally on
      // the station). The underlying create still writes via sshfs at
      // the Mac path. For non-station-pane clicks we leave the display
      // path unset (banner shows the resolved Mac path as before).
      const isMountMirror =
        sourceHost === "station" && stationRoot != null
          ? resolved === mountPoint.replace(/\/+$/, "") ||
            resolved.startsWith(mountPoint.replace(/\/+$/, "") + "/")
          : false;
      const displayPath =
        isMountMirror && stationRoot != null
          ? translateMountToStationPath(resolved, mountPoint, stationRoot)
          : undefined;

      // Not exists. Determine whether to stream-search.
      const wasDeterministic = isDeterministicInput(originalText);
      if (wasDeterministic) {
        console.log(
          `[file-viewer] deterministic miss ${originalText} → create-banner`,
        );
        const existing = fileViewerWindows.get(resolved);
        if (shouldFocusExistingViewer(existing, streamingPopupSearchIds)) {
          return focusOrSameWindow(existing!, e.sender.id);
        }
        const baseOpts = deps.buildCreateOptions(resolved);
        createFileViewerWindow({
          ...baseOpts,
          title: path.basename(resolved),
          displayPath,
          // Round 9 — local form, derived from the miss path when no
          // cwd was threaded (see the exists-branch stamp).
          projectCwd:
            cwdForms.local ??
            deriveProjectAnchor(resolved, {
              roots: deps.roots(),
              mountPoint,
            }) ??
            undefined,
        });
        return { ok: true };
      }

      // Ambiguous input — pick a search base, open the popup, kick off
      // the worker.
      const searchBase = await deriveSearchBase(resolved);
      const suffix = searchBase ? path.relative(searchBase, resolved) : "";
      // Round 8 Phase NN — combine [searchBase, projectCwd] so the
      // walker also walks the project tree when the failed path's
      // deepest existing ancestor doesn't include it (e.g. printed
      // sub-dir cwd that doesn't share an ancestor with the project
      // root).
      //
      // Round 9 — use the FORM-normalized local cwd (a Pi-form cwd is
      // mount-translated regardless of the sourceHost flag: cascaded
      // popup clicks forward a Pi cwd WITHOUT sourceHost, and the old
      // flag-gated translation left it untranslated — the truthy Pi
      // path then shadowed deriveProjectAnchor and disarmed every miss
      // rescue below, collapsing the search to the popup file's own
      // folder).
      const projectCwdForSearch = cwdForms.local;

      // `projectCwd` is nullable and silently absent on
      // cascaded popup clicks. Without a fallback, the root-relative
      // retry below disarms AND composeSuffixSearchRoots collapses to
      // searchBase (the popup file's own folder) — guaranteeing zero
      // matches for anything outside it. The resolved miss path itself
      // identifies the project (`<mount>/<project>/…` or a local root),
      // so derive the anchor from it whenever the cwd wasn't threaded.
      // The pathExists guard makes a stale/garbage threaded cwd fall
      // through to the derived anchor instead of poisoning the retry,
      // the anchored stat, and the search roots.
      const effectiveProjectCwd =
        (projectCwdForSearch && (await pathExists(projectCwdForSearch))
          ? projectCwdForSearch
          : undefined) ??
        deriveProjectAnchor(resolved, {
          roots: deps.roots(),
          mountPoint,
        }) ??
        undefined;

      // defect 3 — root-relative retry BEFORE the streaming
      // search. A reference written relative to the PROJECT ROOT but
      // clicked inside a popup showing a subfolder file resolves via
      // resolveAgainst(currentFile, href) to a doubled path
      // (…/subfolder/subfolder/x.md) — a guaranteed miss. Joining the
      // raw click text onto the (mount-translated) project cwd gives a
      // deterministic second candidate: if that exact file exists
      // inside the allowed roots, open it directly — no streaming
      // search, no picker. Same allowlist gate as the primary path.
      const rootCandidate = rootRelativeCandidate(
        originalText,
        effectiveProjectCwd,
      );
      if (rootCandidate && rootCandidate !== resolved) {
        const rootResolved = resolveInsideAllowedRoots(
          deps.roots(),
          rootCandidate,
        );
        if (rootResolved && (await pathExists(rootResolved))) {
          console.log("[file-viewer] root-relative retry hit -> spawn popup", {
            originalText,
            rootResolved,
          });
          const existing = fileViewerWindows.get(rootResolved);
          if (shouldFocusExistingViewer(existing, streamingPopupSearchIds)) {
            return focusOrSameWindow(existing!, e.sender.id);
          }
          const baseOpts = deps.buildCreateOptions(rootResolved);
          createFileViewerWindow({
            ...baseOpts,
            title: path.basename(rootResolved),
            // Round 9 — validated local-form anchor (cascades self-heal).
            projectCwd: effectiveProjectCwd,
          });
          return { ok: true };
        }
      }

      const searchRoots = await composeSuffixSearchRoots(
        searchBase,
        effectiveProjectCwd,
      );
      const canSearch =
        searchBase != null &&
        suffix.length > 0 &&
        !suffix.startsWith("..") &&
        searchRoots.length > 0;
      if (!canSearch) {
        // No reasonable place to search — open the popup at the resolved
        // path (renderer will show the not-found banner).
        console.log("[file-viewer] canSearch=false -> create-banner", {
          resolved,
          suffix,
          searchBase,
          searchRoots,
        });
        const existing = fileViewerWindows.get(resolved);
        if (shouldFocusExistingViewer(existing, streamingPopupSearchIds)) {
          return focusOrSameWindow(existing!, e.sender.id);
        }
        const baseOpts = deps.buildCreateOptions(resolved);
        createFileViewerWindow({
          ...baseOpts,
          title: path.basename(resolved),
          displayPath,
          // Round 9 — validated local-form anchor (cascades self-heal).
          projectCwd: effectiveProjectCwd,
        });
        return { ok: true };
      }
      console.log("[file-viewer] streaming suffix-search start", {
        suffix,
        searchRoots,
        searchBase,
      });

      const searchId = newSearchId();
      const existing = fileViewerWindows.get(resolved);
      if (existing && !existing.isDestroyed()) {
        // Round 8.1 Phase SS — same retry rule as the station-remote
        // branch: a still-streaming popup is almost certainly a hung
        // walker (sshfs stall) that the user is trying to retry.
        // Close it instead of refocusing.
        const existingSearchId = streamingPopupSearchIds.get(existing);
        const existingHandle = existingSearchId
          ? activeSuffixSearches.get(existingSearchId)
          : undefined;
        if (existingHandle && !existingHandle.isDone()) {
          existing.close();
        } else {
          return focusOrSameWindow(existing, e.sender.id);
        }
      }
      const baseOpts = deps.buildCreateOptions(resolved);
      // Round 8 follow-up — surface Pi-side paths in the picker when
      // the user is mentally on the station. Trigger when sourceHost
      // is station OR the resolved path lives under the local mount
      // mirror (any popup walking the mirror's tree should display
      // Pi conventions, regardless of how the click was routed).
      const localDisplayTranslation =
        stationRoot &&
        (sourceHost === "station" ||
          resolved === mountPoint.replace(/\/+$/, "") ||
          resolved.startsWith(mountPoint.replace(/\/+$/, "") + "/"))
          ? { mountRoot: mountPoint, stationRoot }
          : undefined;
      // Round 8.6 Phase 3 — pick rg-local primary + rg-ssh fallback
      // (when origin is a station pane). If ripgrep is missing the
      // factory degrades to the readdir walker. Hoisted above the
      // window creation so the popup URL can carry the backend's
      // progress capability (the rg backends never emit
      // per-readdir progress, so the renderer must not read
      // scannedDirs===0 as a stalled mount). The thunk body runs only
      // after `safeSend` below is initialised.
      const backend = await pickSearchBackend(
        sourceHost ?? "local",
        () => safeSend("file:suffix:fallback-start", { searchId }),
        deps.searchBackendOverrides,
      );
      const win = createFileViewerWindow({
        ...baseOpts,
        title: path.basename(resolved),
        suffixSearchPending: {
          searchId,
          suffix,
          progressCapable: backend.progressCapable,
        },
        displayPath,
        // Round 9 — validated local-form anchor (cascades self-heal).
        projectCwd: effectiveProjectCwd,
        displayTranslation: localDisplayTranslation,
      });

      // Helper to forward worker events to the popup's webContents.
      // Guards against destroyed windows so a slow worker reply after
      // close doesn't crash main.
      const safeSend = (channel: string, payload: unknown) => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.send(channel, payload);
        } catch {
          // webContents destroyed mid-send.
        }
      };

      // Round 8.6 Phase 2 — root-anchored stat fast-path. Before
      // launching the walker, try the most likely full path: the
      // project cwd joined with the raw clicked text. On hit, the
      // orchestrator fires onMatch+onDone synchronously and never
      // spawns a worker. Saves ~3–20s for the project-relative
      // path convention documented in CLAUDE.md.
      const anchoredCandidate =
        effectiveProjectCwd && typeof originalText === "string"
          ? path.join(
              effectiveProjectCwd,
              originalText.replace(/^\.\/+/, ""),
            )
          : null;
      // the ssh fallback enumerates on the Pi; give it
      // the station-side translation of the search roots (and disarm
      // it when none of them exist on the station).
      const stationFallbackRoots = backend.fallback
        ? translateSearchRootsToStation(searchRoots, mountPoint, stationRoot)
        : [];
      const handle = suffixSearchOrchestrator.startSearch({
        roots: searchRoots,
        suffix,
        workerFactory: backend.workerFactory,
        fallback:
          backend.fallback && stationFallbackRoots.length > 0
            ? { ...backend.fallback, roots: stationFallbackRoots }
            : undefined,
        anchoredStat:
          anchoredCandidate && !path.isAbsolute(originalText)
            ? { absolutePath: anchoredCandidate }
            : undefined,
        onMatch: (matchedPath) =>
          safeSend("file:suffix:match", { searchId, path: matchedPath }),
        onProgress: (info) =>
          safeSend("file:suffix:progress", {
            searchId,
            scannedDirs: info.scannedDirs,
            foundCount: info.foundCount,
          }),
        onDone: (totalFound) => {
          activeSuffixSearches.delete(searchId);
          // thread the searched roots to the popup so
          // the no-match banner can show them.
          safeSend("file:suffix:done", {
            searchId,
            totalFound,
            searchedRoots: searchRoots,
          });
        },
        onCancelled: (totalFound) => {
          activeSuffixSearches.delete(searchId);
          safeSend("file:suffix:cancelled", { searchId, totalFound });
        },
      });
      activeSuffixSearches.set(searchId, handle);
      streamingPopupSearchIds.set(win, searchId);

      // If the window closes mid-search, terminate the worker so it
      // doesn't keep walking forever.
      win.once("closed", () => {
        const h = activeSuffixSearches.get(searchId);
        if (h && !h.isDone()) h.cancel();
        activeSuffixSearches.delete(searchId);
        streamingPopupSearchIds.delete(win);
      });

      return { ok: true };
    },
  );

  // Round 6 Phase CC — cancel an in-flight streaming suffix search.
  ipcMain.removeHandler("file:suffix:cancel");
  ipcMain.handle("file:suffix:cancel", (_e, rawId: unknown) => {
    if (typeof rawId !== "string") return { ok: false };
    const h = activeSuffixSearches.get(rawId);
    if (!h) return { ok: false };
    h.cancel();
    return { ok: true };
  });

  // Round 6 Phase DD2 — station-remote create. The path is validated
  // by createStationFile (isStationPathSafe) before any SSH call.
  ipcMain.removeHandler("file:createStation");
  ipcMain.handle(
    "file:createStation",
    async (_e, rawPath: unknown): Promise<StationCreateResult> => {
      if (typeof rawPath !== "string") {
        return {
          ok: false,
          code: "invalid-input",
          error: "path must be a string",
        };
      }
      return createStationFile(rawPath);
    },
  );
}

/** Async existence probe; resolves true for files and dirs, false otherwise. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Round 8 Phase NN — compose the streaming-suffix-search walker roots.
 *
 * The walker accepts a `readonly string[]` of roots. We always include
 * the deepest existing ancestor of the failed path (`searchBase`). When
 * the renderer passes the active project's cwd (Phase MM), we ALSO
 * include that — useful when the printed sub-dir cwd doesn't sit
 * under the project root from main's perspective (e.g. station paths
 * resolved against `~/.claude/plans/` instead of `~/projects/<id>/`).
 *
 * Existence is checked per-root so a stale `projectCwd` doesn't make
 * the walker error out. Dedupe keeps the walker from double-counting
 * matches when the two roots overlap (one is an ancestor of the
 * other).
 *
 * Pure function — no fs writes — but does sync stat checks. Exported
 * for unit testing.
 */
export async function composeSuffixSearchRoots(
  searchBase: string | null,
  projectCwd: string | undefined,
): Promise<string[]> {
  const candidates: string[] = [];
  if (searchBase) candidates.push(searchBase);
  if (projectCwd && projectCwd.length > 0 && projectCwd !== searchBase) {
    candidates.push(projectCwd);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    try {
      const s = await fsp.stat(c);
      if (s.isDirectory()) out.push(c);
    } catch {
      // skip missing / unreadable roots
    }
  }
  return out;
}

/**
 * Mac mount-mirror roots → Pi-side roots for the ssh
 * fallback worker, which enumerates files ON the station. Roots outside
 * the mount have no Pi-side equivalent and are dropped; callers disarm
 * the fallback entirely when nothing survives (an ssh `rg` with no
 * roots would walk the Pi-side cwd). Exported for unit tests.
 */
export function translateSearchRootsToStation(
  roots: readonly string[],
  mountPoint: string,
  stationRoot: string | null,
): string[] {
  if (!stationRoot) return [];
  const mp = mountPoint.replace(/\/+$/, "");
  const out: string[] = [];
  for (const r of roots) {
    if (r === mp || r.startsWith(mp + "/")) {
      out.push(translateMountToStationPath(r, mountPoint, stationRoot));
    }
  }
  return out;
}

// Round 8 Phase NN's Pi-path → Mac mount-mirror translator now lives in
// project-cwd.ts (form normalization owns both directions); re-exported
// here so existing importers/tests keep working.
export { translateStationCwdToMount } from "./project-cwd";

/**
 * Walk up `failedPath`'s ancestry until an existing directory is found.
 * Used by the suffix-fallback to seed its search root — the deepest
 * existing ancestor of a missing path is almost always the project
 * root (the missing leaf is typically a few segments below).
 */
async function deriveSearchBase(failedPath: string): Promise<string | null> {
  let dir = path.dirname(failedPath);
  let prev = "";
  while (dir && dir !== prev) {
    try {
      const s = await fsp.stat(dir);
      if (s.isDirectory()) return dir;
    } catch {
      // continue walking up
    }
    prev = dir;
    dir = path.dirname(dir);
  }
  return null;
}
