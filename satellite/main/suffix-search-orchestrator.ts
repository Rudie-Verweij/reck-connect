// Round 6 Phase CC2 — orchestrator for streaming worker_threads-based
// suffix search.
//
// The file-viewer IPC handler creates one orchestrator instance per
// process and calls `startSearch(...)` for each Cmd-click that needs a
// fallback. Each call spawns ONE worker, wires its message events to
// renderer-side callbacks, and returns a handle whose `cancel()` posts
// `{type: "stop"}` to the worker AND calls `worker.terminate()` as a
// hard fallback. Listeners deduplicate so onCancelled / onDone fires
// at most once even under races between cancel + worker reply.
//
// Round 8.6 Phase 2 — optional root-anchored stat fast-path. When the
// caller knows a likely absolute target (e.g. `projectCwd + relative
// suffix` from a project-root-relative click), the orchestrator races
// a single fs.stat against a timer before spawning the walker. On hit
// it fires onMatch + onDone synchronously and never spawns the worker;
// on miss or timeout it falls through to the streaming search.

import fs from "node:fs";

/**
 * Minimal worker contract — a subset of `node:worker_threads`'s
 * `Worker` that the orchestrator actually uses. The narrow shape makes
 * the dependency injection straightforward in tests.
 */
export interface StreamingWorkerLike {
  postMessage(msg: unknown): void;
  on(event: "message", cb: (msg: unknown) => void): void;
  on(event: "exit", cb: (code: number) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  terminate(): unknown;
}

export type WorkerFactory = () => StreamingWorkerLike;

export interface StartSuffixSearchArgs {
  roots: string[];
  suffix: string;
  opts?: { maxMatches?: number; maxDepth?: number; timeoutMs?: number };
  /**
   * Round 8.6 Phase 2 — try this absolute path with a fast stat() before
   * spawning the streaming walker. On hit, fires onMatch(absolutePath) +
   * onDone(1) synchronously (no worker spawned). On miss or timeout
   * (default 300 ms), falls through to the normal streaming search.
   * Caller (IPC handler) constructs the absolute path from projectCwd +
   * the raw clicked suffix.
   */
  anchoredStat?: { absolutePath: string; timeoutMs?: number };
  /**
   * Round 8.6 Phase 3d — per-call override of the workerFactory the
   * orchestrator was created with. Lets callers pick a backend per
   * search (e.g. rg-local when ripgrep is available, readdir walker
   * otherwise) without juggling multiple orchestrator instances.
   */
  workerFactory?: WorkerFactory;
  /**
   * Round 8.6 Phase 3d — optional second-wave fallback. If the primary
   * worker finishes with totalFound === 0 AND `when()` returns true,
   * the orchestrator spawns the fallback factory's worker and pipes its
   * matches into the same onMatch/onDone handlers. `onStart` (optional)
   * fires once, between waves, so the renderer can show an interstitial.
   */
  fallback?: {
    factory: WorkerFactory;
    when: () => boolean;
    onStart?: () => void;
    /**
     * roots for the FALLBACK worker when they differ
     * from the primary's. The ssh fallback enumerates on the Pi, where
     * the primary's Mac mount-mirror roots don't exist; callers pass
     * the station-side translation here. Defaults to `args.roots`.
     */
    roots?: string[];
  };
  onMatch(matchedPath: string): void;
  onProgress(info: { scannedDirs: number; foundCount: number }): void;
  onDone(totalFound: number): void;
  onCancelled(totalFound: number): void;
}

const ANCHORED_STAT_DEFAULT_TIMEOUT_MS = 300;

async function tryAnchoredStat(
  absolutePath: string,
  timeoutMs: number,
): Promise<boolean> {
  const statPromise = fs.promises.stat(absolutePath).then(
    (s) => s.isFile(),
    () => false,
  );
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<false>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([statPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export interface SuffixSearchHandle {
  cancel(): void;
  /** True after either onDone, onCancelled, or cancel() has been called. */
  isDone(): boolean;
}

export interface OrchestratorOptions {
  workerFactory: WorkerFactory;
}

interface IncomingMessage {
  type?: string;
  path?: unknown;
  scannedDirs?: unknown;
  foundCount?: unknown;
  totalFound?: unknown;
}

/**
 * Create an orchestrator. The same instance can be reused across many
 * searches; each call to `startSearch` spawns a fresh worker.
 */
export function createSuffixSearchOrchestrator(opts: OrchestratorOptions): {
  startSearch(args: StartSuffixSearchArgs): SuffixSearchHandle;
} {
  return {
    startSearch(args: StartSuffixSearchArgs): SuffixSearchHandle {
      // Track local "found" count so cancel() can report it even if the
      // worker never sends a cancelled message back.
      let foundCount = 0;
      let done = false;
      let worker: StreamingWorkerLike | null = null;
      /** Round 8.6 Phase 3d — set after primary finished with 0 matches and
       *  the fallback worker was spawned. Prevents a recursive fallback. */
      let fallbackUsed = false;
      const primaryFactory = args.workerFactory ?? opts.workerFactory;

      const finalize = (which: "done" | "cancelled", total: number): void => {
        if (done) return;
        done = true;
        if (which === "done") args.onDone(total);
        else args.onCancelled(total);
        try {
          worker?.terminate();
        } catch {
          // Worker may already be exited.
        }
      };

      const tryFallback = (): boolean => {
        if (fallbackUsed) return false;
        if (!args.fallback) return false;
        if (!args.fallback.when()) return false;
        fallbackUsed = true;
        try {
          args.fallback.onStart?.();
        } catch (err) {
          console.error("[suffix-search] fallback.onStart threw:", err);
        }
        spawnAndWire(args.fallback.factory, args.fallback.roots);
        return true;
      };

      const spawnAndWire = (
        factory: WorkerFactory,
        rootsOverride?: string[],
      ): void => {
        if (done) return;
        worker = factory();
        const w = worker;
        // stale-worker guard. The real rg workers emit
        // `exit` right after their `done` message; when that done armed
        // the fallback, the PRIMARY's trailing exit used to land here
        // with done===false and finalize("cancelled") — terminating the
        // fallback worker it had just spawned. Events from any worker
        // that is no longer `worker` are ignored.
        const isCurrent = () => worker === w;

        w.on("message", (raw) => {
          if (done || !isCurrent()) return;
          if (!raw || typeof raw !== "object") return;
          const msg = raw as IncomingMessage;
          switch (msg.type) {
            case "match":
              if (typeof msg.path === "string") {
                foundCount += 1;
                args.onMatch(msg.path);
              }
              break;
            case "progress":
              if (
                typeof msg.scannedDirs === "number" &&
                typeof msg.foundCount === "number"
              ) {
                args.onProgress({
                  scannedDirs: msg.scannedDirs,
                  foundCount: msg.foundCount,
                });
              }
              break;
            case "done": {
              const total =
                typeof msg.totalFound === "number"
                  ? msg.totalFound
                  : foundCount;
              // Phase 3d — second-wave fallback when primary returned 0.
              if (total === 0 && tryFallback()) {
                // foundCount reset so fallback's matches count from scratch.
                // (Primary had 0 by definition.)
                return;
              }
              finalize("done", total);
              break;
            }
            case "cancelled":
              finalize(
                "cancelled",
                typeof msg.totalFound === "number"
                  ? msg.totalFound
                  : foundCount,
              );
              break;
            default:
              break;
          }
        });

        w.on("error", (err) => {
          if (done || !isCurrent()) return;
          console.error("[suffix-search] worker error:", err);
          if (foundCount === 0 && tryFallback()) return;
          finalize("done", foundCount);
        });

        w.on("exit", (_code) => {
          if (done || !isCurrent()) return;
          // Worker exited without sending a terminal event (e.g. crash).
          if (foundCount === 0 && tryFallback()) return;
          // Surface as a cancelled state so the renderer doesn't hang on
          // the "still searching" spinner.
          finalize("cancelled", foundCount);
        });

        w.postMessage({
          type: "start",
          roots: rootsOverride ?? args.roots,
          suffix: args.suffix,
          opts: args.opts,
        });
      };

      // Round 8.6 Phase 2 — race a single stat against the timer before
      // spawning the worker. On hit, finalize as a single synthetic
      // match; on miss/timeout, fall through to the streaming search.
      if (args.anchoredStat) {
        const { absolutePath, timeoutMs } = args.anchoredStat;
        tryAnchoredStat(
          absolutePath,
          timeoutMs ?? ANCHORED_STAT_DEFAULT_TIMEOUT_MS,
        ).then(
          (hit) => {
            if (done) return;
            if (hit) {
              foundCount = 1;
              args.onMatch(absolutePath);
              finalize("done", 1);
            } else {
              spawnAndWire(primaryFactory);
            }
          },
          () => {
            if (!done) spawnAndWire(primaryFactory);
          },
        );
      } else {
        spawnAndWire(primaryFactory);
      }

      return {
        cancel() {
          if (done) return;
          if (worker) {
            try {
              worker.postMessage({ type: "stop" });
            } catch {
              // Worker may have already exited.
            }
          }
          finalize("cancelled", foundCount);
        },
        isDone() {
          return done;
        },
      };
    },
  };
}
