// Streaming filesystem walk for the file-viewer suffix-fallback.
//
// Round 6 Phase CC — extracted from `searchProjectTreeBySuffix` in
// file-viewer.ts so the same core walk can be reused by:
//   - the legacy sync API (used by Round 5 Phase U find-by-suffix); and
//   - the new worker_threads streaming search (Round 6 Phase CC1).
//
// Contract change vs. the original: the walker emits matches and
// progress through callbacks instead of accumulating into a returned
// array. Callers that want the array shape build it via `onMatch`.

import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Directory basenames that are almost certainly NOT user source code
 * (build outputs, vendored deps, VCS, IDE config). The walker prunes
 * any subtree whose root matches this set, which dominates total cost
 * on real projects.
 */
export const SUFFIX_SEARCH_BLOCKLIST = new Set<string>([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".vite",
  ".cache",
  ".pnpm",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".gradle",
  ".idea",
  ".vscode",
  ".DS_Store",
  // Round 5 extras: release/target also dominate cost on packaged repos.
  "release",
  "target",
]);

export interface SearchWalkOptions {
  /** Cap on the number of matches before bailing out (default 50). */
  maxMatches?: number;
  /** Cap on directory recursion depth (default 8). */
  maxDepth?: number;
  /** Hard timeout in ms after which the walk bails out (default 2000). */
  timeoutMs?: number;
  /**
   * Round 8.1 — per-readdir timeout in ms (default 3000). Defends against
   * stalled sshfs mounts: without this, a hung `fsp.readdir` wedges the
   * walker forever because the `timeoutMs` deadline check only runs
   * between iterations, never inside the awaited readdir.
   */
  perReaddirTimeoutMs?: number;
  /**
   * Reported by the worker via the progress channel every ~50ms OR every
   * ~50 dirs. Optional; defaults to a no-op.
   */
  onProgress?: (info: { scannedDirs: number; foundCount: number }) => void;
  /**
   * Fired once per discovered match. The match is the full absolute path.
   */
  onMatch?: (matchedPath: string) => void;
  /**
   * When true, the walker checks this on every iteration and exits early
   * if it returns true. The worker uses this to react to `stop` messages.
   */
  isCancelled?: () => boolean;
}

/**
 * Walk each `root` directory tree looking for files whose absolute path
 * ends with `/<suffix>` (or equals `suffix` outright). Fires `onMatch`
 * for each match and `onProgress` periodically. Resolves when the walk
 * completes, hits a cap, or is cancelled.
 *
 * Returns `{ done: boolean, matches: string[], scannedDirs: number }`:
 *   - `done` true means the walk reached natural end OR a cap; false
 *     means cancelled by `isCancelled` or timeout.
 *   - `matches` is the full accumulated list (also reported live).
 *
 * The walker rejects absolute / home-anchored inputs (returns empty
 * immediately) — those don't need a fallback search; they have an
 * anchor.
 */
export async function searchTreeBySuffix(
  roots: readonly string[],
  suffix: string,
  opts: SearchWalkOptions = {},
): Promise<{ done: boolean; matches: string[]; scannedDirs: number }> {
  if (typeof suffix !== "string" || suffix.length === 0) {
    return { done: true, matches: [], scannedDirs: 0 };
  }
  if (suffix.startsWith("/") || suffix.startsWith("~")) {
    return { done: true, matches: [], scannedDirs: 0 };
  }
  // Normalize away leading `./` so the suffix is "providers/ovh.py"
  // not "./providers/ovh.py" — the match check would otherwise fail.
  const cleanSuffix = suffix.replace(/^\.\/+/, "");
  if (cleanSuffix.length === 0) {
    return { done: true, matches: [], scannedDirs: 0 };
  }

  const maxMatches = opts.maxMatches ?? 50;
  const maxDepth = opts.maxDepth ?? 8;
  // Round 7 Phase GG — default raised from 2s → 30s. The user has a
  // user-visible Stop button now (renderSuffixStreamingPicker), so
  // the budget exists only as a runaway safety net rather than as an
  // optimistic latency cap.
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  // Round 8.1 — 3s per-readdir is generous for any healthy filesystem
  // (local disks and a working sshfs over LAN both complete in <100ms).
  // On a stalled mount the walker treats the dir as unreadable and
  // moves on instead of hanging forever.
  const perReaddirTimeoutMs = opts.perReaddirTimeoutMs ?? 3_000;
  const matches: string[] = [];
  const platformSuffix = "/" + cleanSuffix;
  let scannedDirs = 0;
  let lastProgressAt = 0;
  let lastProgressCount = 0;

  // Throttled progress emission so a deep walk doesn't pay the cost of
  // a postMessage per dir. Triggers when EITHER 50 dirs since last call
  // OR 50ms since last call. The "match-found" path always fires.
  const maybeProgress = (force: boolean): void => {
    if (!opts.onProgress) return;
    const now = Date.now();
    const dirsSince = scannedDirs - lastProgressCount;
    if (force || dirsSince >= 50 || now - lastProgressAt >= 50) {
      opts.onProgress({ scannedDirs, foundCount: matches.length });
      lastProgressAt = now;
      lastProgressCount = scannedDirs;
    }
  };

  const isCancelled = opts.isCancelled ?? (() => false);

  async function walk(dir: string, depth: number): Promise<boolean> {
    // Return value: false → keep walking; true → bail out (cap/cancel/timeout).
    if (isCancelled()) return true;
    if (matches.length >= maxMatches) return true;
    if (depth > maxDepth) return false;
    if (Date.now() > deadline) return true;

    let entries: import("node:fs").Dirent[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      entries = await Promise.race<import("node:fs").Dirent[]>([
        fsp.readdir(dir, { withFileTypes: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`readdir timeout: ${dir}`)),
            perReaddirTimeoutMs,
          );
        }),
      ]);
    } catch {
      // Permission denied / not-a-dir / vanished mid-walk / sshfs stalled
      // — skip silently.
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    scannedDirs += 1;
    maybeProgress(false);

    for (const entry of entries) {
      if (isCancelled()) return true;
      if (matches.length >= maxMatches) return true;
      if (Date.now() > deadline) return true;
      if (SUFFIX_SEARCH_BLOCKLIST.has(entry.name)) continue;
      if (
        entry.name.startsWith(".") &&
        entry.name !== "." &&
        entry.name !== ".."
      ) {
        // Hidden files are usually metadata; skip unless suffix references them.
        if (!cleanSuffix.includes("/.") && !cleanSuffix.startsWith(".")) {
          continue;
        }
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const bail = await walk(full, depth + 1);
        if (bail) return true;
      } else if (entry.isFile()) {
        if (
          full.endsWith(platformSuffix) ||
          full.endsWith(path.sep + cleanSuffix) ||
          path.basename(full) === cleanSuffix
        ) {
          matches.push(full);
          opts.onMatch?.(full);
          maybeProgress(true);
        }
      }
    }
    return false;
  }

  for (const root of roots) {
    if (isCancelled()) {
      return { done: false, matches, scannedDirs };
    }
    if (matches.length >= maxMatches) break;
    if (Date.now() > deadline) break;
    await walk(root, 0);
  }
  // Final progress emission so the renderer's counter matches reality.
  maybeProgress(true);
  // Round 7 Phase GG — `done` reflects ONLY whether the user cancelled.
  // Timeout / maxMatches / maxDepth are budget safety nets — the walk
  // is still reported as completed (the worker turns this into a
  // `done` IPC event, not a misleading `cancelled`). The user can
  // re-issue the search if they want a wider net.
  return {
    done: !isCancelled(),
    matches,
    scannedDirs,
  };
}

/**
 * Determinism rule for the suffix-fallback (Round 6 Phase CC3).
 *
 * The popup shows a streaming "looking for matches…" UI ONLY when the
 * input path is ambiguous — i.e. when the user clicked a token that
 * could plausibly resolve to multiple files under the project. Absolute
 * paths (`/abs`), home-anchored paths (`~/x`, `~`), and project-root-
 * anchored paths already point at one file; if that file is missing,
 * we route directly to the create-banner without a search.
 *
 * Pure function — no fs access — so the caller can decide whether to
 * spawn the worker in the first place.
 */
export function isDeterministicInput(originalText: string): boolean {
  if (typeof originalText !== "string") return false;
  const t = originalText.trim();
  if (t.length === 0) return false;
  if (t.startsWith("/")) return true;
  if (t.startsWith("~/") || t === "~") return true;
  return false;
}
