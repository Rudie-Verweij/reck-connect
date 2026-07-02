// Round 8.6 Phase 3a — backend detection cache.
//
// Probes whether `rg` (ripgrep) is available locally and on the Pi.
// Results are memoized per-process via Promise caching so concurrent
// callers share a single in-flight probe. Probes are injectable so
// tests don't spawn real subprocesses.
//
// Phase 3e (follow-up to user report) — the local probe now resolves
// to the ABSOLUTE PATH of rg, not just a boolean. Why: when the
// satellite runs as a packaged .app launched from Finder, Electron
// inherits PATH from launchd (typically `/usr/bin:/bin:/usr/sbin:/sbin`)
// which excludes Homebrew. So `spawn("which", ["rg"])` returns nothing
// even when ripgrep is installed at /opt/homebrew/bin/rg. The probe
// falls back to a static list of well-known install paths so detection
// works in production AND dev.
//
// Default probes (createDefault*Probe) shell out to `which rg` locally
// and `ssh ... 'command -v rg'` for the station. Both swallow errors —
// a missing binary should NOT crash the app; the orchestrator just
// falls back to the readdir walker.

import fs from "node:fs";
import { spawn } from "node:child_process";

export interface BackendDetection {
  /**
   * Absolute path to `rg` on this Mac if installed, else null.
   * Cached after the first call. Callers use the returned path to
   * spawn rg directly (bypassing PATH lookup, which can lie under
   * Electron-launched-from-Finder).
   */
  hasLocalRg(): Promise<string | null>;
  /**
   * True if `rg` is reachable on the Pi over SSH. Cached after first call.
   * Returns false if SSH connect fails, times out, or `rg` is missing.
   */
  hasSshRg(): Promise<boolean>;
}

export interface BackendDetectionOpts {
  /**
   * Resolves to the absolute path of the named executable, or null if
   * not found. Implementations should try PATH lookup AND well-known
   * install paths (see defaultLocalExecutableProbe).
   */
  executableProbe: (cmd: string) => Promise<string | null>;
  /** Resolves to true if `rg` is callable on the Pi over SSH. */
  sshProbe: () => Promise<boolean>;
}

export function createBackendDetection(
  opts: BackendDetectionOpts,
): BackendDetection {
  let localPromise: Promise<string | null> | null = null;
  let sshPromise: Promise<boolean> | null = null;

  return {
    hasLocalRg(): Promise<string | null> {
      if (!localPromise) {
        localPromise = opts.executableProbe("rg").catch(() => null);
      }
      return localPromise;
    },
    hasSshRg(): Promise<boolean> {
      if (!sshPromise) {
        sshPromise = opts.sshProbe().catch(() => false);
      }
      return sshPromise;
    },
  };
}

// --- default probe implementations ------------------------------------------

/**
 * Well-known install paths checked when `which <cmd>` returns nothing.
 * Ordered by likelihood on macOS — Apple Silicon Homebrew first,
 * then Intel Homebrew, then system, then MacPorts, then cargo, then
 * Linux snap (for completeness; the Pi side uses SSH which inherits
 * the login shell's PATH and doesn't need this list).
 */
const WELL_KNOWN_PATHS = (cmd: string): string[] => [
  `/opt/homebrew/bin/${cmd}`,
  `/usr/local/bin/${cmd}`,
  `/usr/bin/${cmd}`,
  `/opt/local/bin/${cmd}`,
  `${process.env.HOME ?? ""}/.cargo/bin/${cmd}`,
  `/snap/bin/${cmd}`,
];

/**
 * Default local-executable probe. Returns the absolute path of `cmd`
 * if found via either:
 *   1. `which <cmd>` (works when PATH includes the install dir — i.e.
 *      dev mode launched from a terminal with the user's shell PATH),
 *   2. or a probe of WELL_KNOWN_PATHS (works in production .app where
 *      PATH is the limited launchd default).
 *
 * Returns null when neither approach finds the binary.
 */
export async function defaultLocalExecutableProbe(
  cmd: string,
): Promise<string | null> {
  return _probeForTesting({
    cmd,
    whichSpawn: () =>
      new Promise<{ exitCode: number; stdout: string }>((resolve) => {
        let stdout = "";
        const child = spawn("which", [cmd], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        child.stdout.on("data", (b: Buffer) => {
          stdout += b.toString("utf8");
        });
        child.on("exit", (code) => resolve({ exitCode: code ?? 1, stdout }));
        child.on("error", () => resolve({ exitCode: 1, stdout: "" }));
      }),
    pathExists: (p: string) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/**
 * Test seam — pure function that takes a `whichSpawn` and `pathExists`
 * adapter. Production calls this with real child_process + fs adapters;
 * tests call it with controllable mocks.
 *
 * Exported under the `_` prefix as a convention for "test-only" API
 * that's still part of the module's public surface.
 */
export async function _probeForTesting(opts: {
  cmd: string;
  whichSpawn: () =>
    | Promise<{ exitCode: number; stdout: string }>
    | { exitCode: number; stdout: string };
  pathExists: (p: string) => boolean;
}): Promise<string | null> {
  // 1. Try `which`. If it succeeds and points to an executable file,
  //    use that path (respects the user's PATH, including overrides).
  try {
    const res = await opts.whichSpawn();
    if (res.exitCode === 0 && res.stdout.trim().length > 0) {
      const candidate = res.stdout.trim().split("\n")[0];
      if (candidate.startsWith("/") && opts.pathExists(candidate)) {
        return candidate;
      }
      // `which` returned something non-absolute (e.g. a shell function
      // signature like "rg () { ... }" when invoked under zsh). Treat
      // as miss; fall through to well-known paths.
    }
  } catch {
    // `which` itself failed (binary missing, spawn error). Fall through.
  }

  // 2. Fall back to well-known install paths in priority order.
  for (const candidate of WELL_KNOWN_PATHS(opts.cmd)) {
    if (opts.pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Default SSH probe for `rg` on the station. Uses the same ssh args
 * pattern as station-ssh.ts (BatchMode, IdentitiesOnly, ConnectTimeout)
 * but inlined here to avoid a cycle. Resolves false on any non-zero
 * exit, error, or timeout.
 */
export function defaultSshRgProbe(args: {
  sshKey: string;
  sshHost: string;
  connectTimeoutSec?: number;
}): Promise<boolean> {
  const timeoutSec = args.connectTimeoutSec ?? 5;
  return new Promise((resolve) => {
    const child = spawn(
      "ssh",
      [
        "-i",
        args.sshKey,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        `ConnectTimeout=${timeoutSec}`,
        args.sshHost,
        "command -v rg >/dev/null 2>&1",
      ],
      { stdio: "ignore" },
    );
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
