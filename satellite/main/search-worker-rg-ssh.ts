// Round 8.6 Phase 3c — SSH `rg --files` worker.
//
// Same StreamingWorkerLike contract as search-worker-rg-local.ts, but
// runs the file enumeration on the Pi via ssh. Used as the last-resort
// fallback (orchestrator chain) when:
//   1. local search returned 0 matches, AND
//   2. the originating click came from a station pane.
//
// Catches the rare case where a file is on the Pi but not yet visible
// in the local sshfs mirror (cache stale, sub-tree not yet listed, etc.).
//
// Safety: root paths are validated to contain no shell metacharacters
// before being interpolated into the remote command. Single quotes are
// `'\''`-escaped using the standard POSIX shell idiom. This mirrors
// the defense-in-depth pattern used by station-ssh.ts for file reads
// and writes.

import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { StreamingWorkerLike } from "./suffix-search-orchestrator";
import { cleanSuffix, matchesPathSuffix } from "./search-suffix-match";
import { SUFFIX_SEARCH_BLOCKLIST } from "./search-walk";

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

export type SshSpawnFn = (args: readonly string[]) => SpawnedChild;

export interface SshConfig {
  sshKey: string;
  sshHost: string;
  /** Seconds; defaults to 5. Same value the file-read SSH path uses. */
  connectTimeoutSec?: number;
}

export interface CreateRgSshWorkerOpts {
  sshConfig: SshConfig;
  /** Override for testing; defaults to spawn("ssh", args, {...}). */
  sshSpawnFn?: SshSpawnFn;
}

interface StartMessage {
  type: "start";
  roots: string[];
  suffix: string;
  opts?: { maxMatches?: number; maxDepth?: number; timeoutMs?: number };
}

/**
 * Accept POSIX absolute paths only, no metacharacters that could
 * survive the single-quote escape and break out (`;`, `|`, `$`,
 * backticks, newlines, etc.). Single quotes are permitted because
 * singleQuoteEscape() defangs them via the `'\''` idiom. Mirrors the
 * `isStationPathSafe` philosophy of station-ssh.ts but tailored for
 * search roots (always absolute Pi paths).
 */
const STATION_PATH_SAFE = /^\/[A-Za-z0-9._/\- ']*$/;

function isSafeRoot(root: string): boolean {
  return STATION_PATH_SAFE.test(root);
}

/**
 * POSIX-style single-quote escape: `'foo'\''bar'` for an input
 * containing a single quote. Wrapping in `'...'` on top of the
 * escaped string defangs `;`, `|`, `$`, backticks, etc.
 */
function singleQuoteEscape(input: string): string {
  return "'" + input.replace(/'/g, "'\\''") + "'";
}

export function createRgSshWorker(
  opts: CreateRgSshWorkerOpts,
): StreamingWorkerLike {
  const sshSpawn: SshSpawnFn =
    opts.sshSpawnFn ??
    ((args) =>
      nodeSpawn("ssh", args as readonly string[], {
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
        // ssh child already exited
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
    if (!msg.roots.every(isSafeRoot)) {
      console.error(
        "[rg-ssh] refusing unsafe root path; falling back to done=0",
      );
      finish(0);
      return;
    }
    maxMatches = msg.opts?.maxMatches ?? Number.POSITIVE_INFINITY;

    // Build remote command. `rg --files <root1> <root2> ...` lists
    // every file. We do the suffix match on the satellite side.
    // same pay-per-use dotfile affordance as the local rg
    // worker (and search-walk.ts:183-188): only a dotfile-targeting
    // suffix turns on --hidden --no-ignore + one --glob exclusion per
    // SUFFIX_SEARCH_BLOCKLIST entry (single-quoted for the remote
    // shell — the glob text is static and quote-free). Unconditional
    // listing of ignored trees was a perf regression.
    const targetsDotfile =
      cleaned.startsWith(".") || cleaned.includes("/.");
    const ignoreOverrideFlags =
      " --hidden --no-ignore " +
      [...SUFFIX_SEARCH_BLOCKLIST]
        .map((dir) => `--glob '!**/${dir}/**'`)
        .join(" ");
    const quotedRoots = msg.roots.map(singleQuoteEscape).join(" ");

    // mirror of the local worker's zero-match second
    // pass: gitignored non-dot files on the Pi are invisible to the
    // fast pass, so relaunch ONCE with the ignore override.
    const launch = (withIgnoreOverride: boolean): void => {
      const remoteCmd = `rg --files --no-messages${
        withIgnoreOverride ? ignoreOverrideFlags : ""
      } ${quotedRoots}`;

      const sshArgs = [
        "-i",
        opts.sshConfig.sshKey,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        `ConnectTimeout=${opts.sshConfig.connectTimeoutSec ?? 5}`,
        opts.sshConfig.sshHost,
        remoteCmd,
      ];

      try {
        child = sshSpawn(sshArgs);
      } catch (err) {
        console.error("[rg-ssh] spawn failed:", err);
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
            console.error("[rg-ssh] stderr:", text.trim());
          }
        });
      }

      child.on("exit", (_code, _signal) => {
        if (finished) return;
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
        console.error("[rg-ssh] child error:", err);
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
          // ssh child already exited
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
        // ssh child already exited
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
