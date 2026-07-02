// Round 8.6 Phase 3b — local `rg --files` worker.
//
// Implements the StreamingWorkerLike contract used by the suffix-search
// orchestrator. Instead of recursively reading directories from Node
// (the historical readdir walker), this worker spawns a single child
// `rg --files <root> [<root>...]`, line-buffers stdout, filters the
// paths client-side via matchesPathSuffix, and emits one `match` event
// per qualifying line.
//
// Why ripgrep:
//   - Ships on most dev machines (Homebrew, apt, Arch, NixOS, Fedora).
//   - Native parallel filesystem walker; ~10–50× faster than a Node
//     readdir tree on sshfs-backed projects.
//   - Honours .gitignore by default (we keep that; the readdir walker
//     also blocklists node_modules/etc.). Pass --no-ignore to disable.
//
// Why client-side filter rather than ripgrep's --glob:
//   - The user's clicked suffix can contain glob metacharacters
//     (parens, brackets, plus, etc.) that would need escaping. A
//     straight stdout filter is bulletproof and stays cheap for the
//     sizes we see (10k–50k files per project).

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { StreamingWorkerLike } from "./suffix-search-orchestrator";
import { cleanSuffix, matchesPathSuffix } from "./search-suffix-match";
import { SUFFIX_SEARCH_BLOCKLIST } from "./search-walk";

/** Minimal child shape the worker depends on — injectable for tests. */
export interface SpawnedChild {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream | null;
  on(
    event: "exit",
    cb: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
) => SpawnedChild;

export interface CreateRgLocalWorkerOpts {
  /** Override for testing; defaults to node:child_process.spawn. */
  spawnFn?: SpawnFn;
  /**
   * Absolute path to the `rg` binary. Defaults to bare `"rg"` (relies
   * on PATH). Pass an absolute path when PATH may not include the
   * install dir — e.g. production Electron inherits launchd's PATH
   * which excludes /opt/homebrew/bin.
   */
  rgPath?: string;
}

interface StartMessage {
  type: "start";
  roots: string[];
  suffix: string;
  opts?: { maxMatches?: number; maxDepth?: number; timeoutMs?: number };
}

/**
 * Factory: returns a fresh worker per call. The orchestrator's
 * workerFactory contract spawns a new worker per startSearch.
 */
export function createRgLocalWorker(
  opts: CreateRgLocalWorkerOpts = {},
): StreamingWorkerLike {
  const spawnImpl: SpawnFn =
    opts.spawnFn ??
    ((command, args) =>
      nodeSpawn(command, args as readonly string[], {
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as SpawnedChild);

  const events = new EventEmitter();
  let child: SpawnedChild | null = null;
  let buffer = "";
  let matchCount = 0;
  let maxMatches = Number.POSITIVE_INFINITY;
  let finished = false;

  const finish = (totalFound: number): void => {
    if (finished) return;
    finished = true;
    events.emit("message", { type: "done", totalFound });
    events.emit("exit", 0);
  };

  const processLine = (line: string, cleaned: string): void => {
    if (finished) return;
    if (line.length === 0) return;
    if (!matchesPathSuffix(line, cleaned)) return;
    matchCount += 1;
    events.emit("message", { type: "match", path: line });
    if (matchCount >= maxMatches) {
      try {
        child?.kill("SIGTERM");
      } catch {
        // child may have already exited
      }
      finish(matchCount);
    }
  };

  const start = (msg: StartMessage): void => {
    const cleaned = cleanSuffix(msg.suffix);
    if (cleaned.length === 0) {
      finish(0);
      return;
    }
    maxMatches = msg.opts?.maxMatches ?? Number.POSITIVE_INFINITY;

    // `--files` lists every file under the roots, honouring .gitignore
    // — the fast default.: rg skips hidden AND .gitignored
    // files, and `.env` is both, so dotfile clicks could never be
    // found. Mirror the walker's pay-per-use affordance
    // (search-walk.ts:183-188): ONLY when the clicked suffix targets a
    // dotfile, list hidden+ignored files with the walker's static dir
    // blocklist as --glob exclusions. Unconditional --no-ignore was a
    // perf regression — it listed every previously-gitignored tree
    // (release/, venvs, …), which takes ages on the sshfs mount.
    // No-messages silences "is a directory" stderr noise; we still log
    // unexpected stderr below.
    const targetsDotfile =
      cleaned.startsWith(".") || cleaned.includes("/.");
    const ignoreOverrideArgs = [
      "--hidden",
      "--no-ignore",
      ...[...SUFFIX_SEARCH_BLOCKLIST].flatMap((dir) => [
        "--glob",
        `!**/${dir}/**`,
      ]),
    ];
    const binary = opts.rgPath ?? "rg";

    // a pass that found nothing relaunches ONCE with the
    // ignore override: gitignored non-dot files (next-env.d.ts in the
    // field failure) are invisible to the fast default pass. Dotfile
    // suffixes start with the override on (pass 1 === pass 2), so the
    // `withIgnoreOverride` guard naturally prevents a useless re-run.
    const launch = (withIgnoreOverride: boolean): void => {
      const args: string[] = [
        "--files",
        "--no-messages",
        ...(withIgnoreOverride ? ignoreOverrideArgs : []),
        ...msg.roots,
      ];
      try {
        child = spawnImpl(binary, args);
      } catch (err) {
        console.error("[rg-local] spawn failed:", err);
        finish(matchCount);
        return;
      }

      child.stdout.on("data", (chunk: Buffer | string) => {
        if (finished) return;
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          processLine(line, cleaned);
          if (finished) return;
          idx = buffer.indexOf("\n");
        }
      });

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer | string) => {
          const text =
            typeof chunk === "string" ? chunk : chunk.toString("utf8");
          if (text.trim().length > 0) {
            console.error("[rg-local] stderr:", text.trim());
          }
        });
      }

      child.on("exit", (_code, _signal) => {
        if (finished) return;
        // Flush any trailing partial line that didn't end in \n.
        if (buffer.length > 0) {
          processLine(buffer, cleaned);
          buffer = "";
        }
        if (matchCount === 0 && !withIgnoreOverride) {
          launch(true);
          return;
        }
        finish(matchCount);
      });

      child.on("error", (err) => {
        console.error("[rg-local] child error:", err);
        finish(matchCount);
      });
    };

    launch(targetsDotfile);
  };

  const worker = {
    postMessage(raw: unknown) {
      if (!raw || typeof raw !== "object") return;
      const msg = raw as { type?: unknown };
      if (msg.type === "start") {
        start(raw as StartMessage);
      } else if (msg.type === "stop") {
        try {
          child?.kill("SIGTERM");
        } catch {
          // child may have already exited
        }
      }
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      events.on(event, cb);
    },
    terminate() {
      try {
        child?.kill("SIGKILL");
      } catch {
        // child may have already exited
      }
      if (!finished) {
        finished = true;
        events.emit("exit", 0);
      }
      return undefined;
    },
  };
  return worker as unknown as StreamingWorkerLike;
}

// Re-export the type so tests don't import it from suffix-search-orchestrator
// indirectly.
export type { ChildProcess };
