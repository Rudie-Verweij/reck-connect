// `station-ssh.ts` — SSH-backed file read/stat/write for files that live
// on the station OUTSIDE the sshfs `~/projects` mount. Paths under
// `~/projects` are reachable via the local mount (fast, plain `node:fs`).
// Anything else on the Pi (e.g. `~/.claude/...`) needs an SSH shell-out.
//
// The existing rsync flow (`main/rsync-copy.ts`) already uses the same
// SSH config — host alias `reck-station` + key `~/.ssh/reck_mount`. We
// reuse those credentials. Round 4 Phase S added writeStationFile so
// the viewer can edit `~/.claude/plans/*.md` and similar Pi-side files
// in-place; the concurrency story is identical to the local handler —
// baseline mtime+sha compare, atomic tmp+rename, conflict-aware return.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

// Exported so the Round 8.6 rg-ssh search worker + backend-detection
// can reuse the same SSH identity without re-deriving the key path.
export const SSH_KEY = path.join(homedir(), ".ssh", "reck_mount");
export const SSH_HOST = "reck-station";
export const SSH_CONNECT_TIMEOUT_SEC = 5;

/**
 * Round 4 Phase R — structured result from the path-safety validator.
 * Switched from bare boolean so callers can surface the reason in the
 * error string they hand back to the renderer. Previously the user
 * saw a generic "Path is not safe for station SSH read" with no clue
 * which check failed.
 */
export type PathSafetyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Defence-in-depth path validator for station SSH operations.
 *
 * The SSH command line is constructed by the caller; this validator
 * refuses any path that could escape the intended target or that carries
 * shell metacharacters. Keeps the implementation surface narrow even
 * though the caller is also expected to single-quote the path on the
 * remote side.
 *
 * Returns `{ok: true}` if the path is safe, otherwise `{ok: false,
 * reason}` with a human-readable explanation of which check rejected
 * the path. Callers surface the reason in their error responses so the
 * user can see exactly why (e.g. "path contains a '..' segment" vs
 * "forbidden character: $").
 */
export function isStationPathSafe(p: string): PathSafetyResult {
  if (typeof p !== "string") {
    return { ok: false, reason: "path must be a string" };
  }
  const trimmed = p.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty path" };
  }
  if (trimmed !== p) {
    return { ok: false, reason: "path has leading or trailing whitespace" };
  }
  if (!trimmed.startsWith("/")) {
    return {
      ok: false,
      reason: `not an absolute POSIX path (got "${p}")`,
    };
  }
  // Reject `..` segments — they'd let the path traverse out of an
  // intended root, e.g. /home/pi/../etc/passwd.
  const segments = trimmed.split("/");
  if (segments.includes("..")) {
    return { ok: false, reason: "path contains a '..' segment" };
  }
  // Reject shell metacharacters, newlines, NUL, etc. The remote `cat`
  // is shell-invoked via SSH; even single-quoted paths can be coerced
  // if these slip through. Whitelisting is safer than blacklisting:
  // allow [A-Za-z0-9._\-/+@:].
  const bad = trimmed.match(/[^A-Za-z0-9._\-/+@:]/);
  if (bad) {
    const ch = bad[0];
    const display = ch === "\n" ? "newline"
      : ch === "\x00" ? "NUL"
      : ch === "\t" ? "tab"
      : `"${ch}"`;
    return { ok: false, reason: `forbidden character: ${display}` };
  }
  return { ok: true };
}

/**
 * Parse the output of `stat --format='%Y %s %a'`. Round 5 Phase V
 * extends the format with `%a` (octal access mode) so the caller can
 * derive owner-writable status without an extra `test -w` round-trip.
 * Still accepts the older 2-field `%Y %s` shape for forward/backward
 * compatibility — modeOctal is null in that case.
 *
 * mtime is returned in milliseconds for parity with the rest of the
 * file-viewer's FileBaseline shape. Returns null on any malformed result.
 */
export function parseStatOutput(out: string): {
  mtimeMs: number;
  size: number;
  modeOctal: string | null;
} | null {
  if (typeof out !== "string") return null;
  const trimmed = out.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return null;
  const mtimeSec = Number(parts[0]);
  const size = Number(parts[1]);
  if (!Number.isFinite(mtimeSec) || !Number.isInteger(size)) return null;
  let modeOctal: string | null = null;
  if (parts.length === 3) {
    // Validate the third field is an octal-digits-only string. Reject
    // anything else to avoid silently accepting noise.
    if (/^[0-7]+$/.test(parts[2])) {
      modeOctal = parts[2];
    } else {
      return null;
    }
  }
  return { mtimeMs: mtimeSec * 1000, size, modeOctal };
}

/**
 * Round 5 Phase V — derive owner-writable from a POSIX octal mode
 * string (e.g. "644", "755", "4755"). The SSH key always authenticates
 * as the same Pi user, so only the owner bit matters. Returns false
 * for null (no mode info available — treat conservatively).
 */
export function isOwnerWritable(modeOctal: string | null): boolean {
  if (!modeOctal) return false;
  // Take the last three digits (permission bits) and parse the
  // leftmost (owner) digit. Owner-write bit is 0o2 within that nybble.
  const perms = modeOctal.slice(-3).padStart(3, "0");
  const ownerDigit = Number.parseInt(perms[0], 8);
  if (!Number.isFinite(ownerDigit)) return false;
  return (ownerDigit & 0o2) !== 0;
}

export interface StationFileBaseline {
  mtimeMs: number;
  sha256: string;
  size: number;
}

export interface StationReadOk {
  ok: true;
  content: string;
  baseline: StationFileBaseline;
  /** Round 5 Phase V — derived from POSIX mode bits returned by the
   *  remote stat. False if the SSH user can't write the file, true
   *  otherwise. Used by the renderer to gate the lock toggle. */
  writable: boolean;
}

export interface StationReadErr {
  ok: false;
  code: "invalid-input" | "ssh-error" | "not-found" | "too-large";
  error: string;
}

const STATION_READ_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Build SSH argv for a single remote command string. The caller passes
 * the COMPLETE shell-safe command (with single-quoted args) as one
 * string — SSH passes it to the remote shell as-is. Splitting the
 * remote command across multiple SSH args lets the remote shell apply
 * word-splitting AGAIN to flags like `--format='%Y %s'`, which is what
 * silently broke an earlier draft (the `%s` portion got split off and
 * the remote stat tried to stat the literal `%s` filename).
 */
function sshArgs(remoteShellCommand: string): string[] {
  return [
    "-i", SSH_KEY,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SEC}`,
    SSH_HOST,
    remoteShellCommand,
  ];
}

/**
 * Read a Pi file by shelling out to `ssh reck-station cat <path>`. The
 * remote path is single-quoted on the remote shell to defang any
 * metacharacters that slipped past `isStationPathSafe`, and the local
 * `spawn` call passes the SSH args as an array (no shell interpolation
 * on the Mac side). The returned baseline shape mirrors what the local
 * file:read handler returns so the viewer can treat both identically.
 */
export async function readStationFile(
  stationPath: string,
): Promise<StationReadOk | StationReadErr> {
  const safety = isStationPathSafe(stationPath);
  if (!safety.ok) {
    return {
      ok: false,
      code: "invalid-input",
      error: `Path "${stationPath}" is not safe for station SSH read: ${safety.reason}`,
    };
  }
  // First fetch stat so we can fail early on missing / oversized files
  // and have an mtime for the baseline.
  const statRes = await statStationFile(stationPath);
  if (!statRes.ok) return statRes;
  if (statRes.size > STATION_READ_MAX_BYTES) {
    return {
      ok: false,
      code: "too-large",
      error: `Station file is ${statRes.size} bytes (limit ${STATION_READ_MAX_BYTES})`,
    };
  }
  // Build the entire remote command as one shell-safe string. The path
  // is single-quoted on the remote side (the local-side `isStationPathSafe`
  // already rejected anything that could escape the quotes). Passing it
  // as ONE arg to ssh avoids the local spawn's array form getting
  // re-word-split by the remote shell when the command has multiple
  // tokens (which is how `--format='%Y %s'` silently corrupted earlier).
  const remoteCmd = `cat -- '${stationPath}'`;
  const writable = isOwnerWritable(statRes.modeOctal ?? null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let stderr = "";
    const proc = spawn("ssh", sshArgs(remoteCmd), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (b: Buffer) => chunks.push(b));
    proc.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    proc.on("exit", (code) => {
      if (code !== 0) {
        const msg = stderr || `ssh exit ${code}`;
        resolve({
          ok: false,
          code: /no such file/i.test(msg) ? "not-found" : "ssh-error",
          error: msg.trim(),
        });
        return;
      }
      const buffer = Buffer.concat(chunks);
      const content = buffer.toString("utf-8");
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      resolve({
        ok: true,
        content,
        baseline: {
          mtimeMs: statRes.mtimeMs,
          sha256,
          size: buffer.length,
        },
        writable,
      });
    });
    proc.on("error", (err) => {
      resolve({
        ok: false,
        code: "ssh-error",
        error: err.message,
      });
    });
  });
}

export interface StationStatOk {
  ok: true;
  mtimeMs: number;
  size: number;
  /** Round 5 Phase V — POSIX octal mode string from `stat --format=%a`,
   *  or null if the remote stat didn't emit it. Used by readStationFile
   *  to derive `writable`. */
  modeOctal: string | null;
}

export type StationStatResult = StationStatOk | StationReadErr;

/**
 * Stat a Pi file via `ssh reck-station stat --format='%Y %s' <path>`.
 * GNU coreutils' format string is portable across Linux distributions
 * (the station is Linux), so no BSD-fallback dance like macOS's stat
 * needs.
 */
export async function statStationFile(
  stationPath: string,
): Promise<StationStatResult> {
  const safety = isStationPathSafe(stationPath);
  if (!safety.ok) {
    return {
      ok: false,
      code: "invalid-input",
      error: `Path "${stationPath}" is not safe for station SSH stat: ${safety.reason}`,
    };
  }
  // Same shell-safety story as readStationFile — build the WHOLE
  // remote command as one string so the remote shell doesn't get a
  // chance to re-tokenize multi-token args like the stat format string.
  // Round 5 Phase V — also fetch the POSIX access mode (`%a`) so
  // readStationFile can derive `writable` without an extra round-trip.
  const remoteCmd = `stat --format='%Y %s %a' -- '${stationPath}'`;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("ssh", sshArgs(remoteCmd), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf-8");
    });
    proc.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    proc.on("exit", (code) => {
      if (code !== 0) {
        const msg = stderr || `ssh exit ${code}`;
        resolve({
          ok: false,
          code: /no such file/i.test(msg) ? "not-found" : "ssh-error",
          error: msg.trim(),
        });
        return;
      }
      const parsed = parseStatOutput(stdout);
      if (!parsed) {
        resolve({
          ok: false,
          code: "ssh-error",
          error: `Could not parse stat output: ${stdout.trim()}`,
        });
        return;
      }
      resolve({
        ok: true,
        mtimeMs: parsed.mtimeMs,
        size: parsed.size,
        modeOctal: parsed.modeOctal,
      });
    });
    proc.on("error", (err) => {
      resolve({
        ok: false,
        code: "ssh-error",
        error: err.message,
      });
    });
  });
}

// Round 4 Phase S — SSH-backed write.

export interface StationWriteRequest {
  path: string;
  content: string;
  baseline: StationFileBaseline;
  /** Skip the baseline mtime/sha check and overwrite unconditionally.
   *  Used by the "Force mine" conflict-resolution action. */
  force?: boolean;
}

export type StationWriteResult =
  | { ok: true; baseline: StationFileBaseline }
  | {
      ok: false;
      code:
        | "invalid-input"
        | "ssh-error"
        | "not-found"
        | "too-large"
        | "conflict";
      error: string;
      currentBaseline?: StationFileBaseline;
      currentContent?: string;
    };

const STATION_WRITE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Build a `<target>.reck-tmp-<uuid>` companion path. The tmp lives
 * next to the target so the rename can complete atomically — POSIX
 * `rename(2)` only guarantees atomicity when source and destination
 * sit on the same filesystem.
 */
export function buildRemoteTmpPath(targetPath: string, uuid: string): string {
  // We deliberately don't normalize or trim — caller already validated
  // the path via isStationPathSafe.
  return `${targetPath}.reck-tmp-${uuid}`;
}

/**
 * Round 6 Phase DD2 — build the remote shell command for creating an
 * empty file at `stationPath`. Constructs `mkdir -p '<dir>' && touch
 * '<path>'` with single-quoting to defang any metacharacters that
 * slipped past `isStationPathSafe`. Pure function so the production
 * call can be tested without spawning ssh.
 */
export function buildCreateStationCmd(stationPath: string): string {
  const lastSlash = stationPath.lastIndexOf("/");
  // Defensive: a path without `/` shouldn't make it past
  // isStationPathSafe, but be conservative anyway.
  const dir = lastSlash > 0 ? stationPath.slice(0, lastSlash) : "/";
  return `mkdir -p '${dir}' && touch '${stationPath}'`;
}

/**
 * Round 6 Phase DD1 — translate a Mac mount-mirror path back to the
 * Pi-side path for display purposes. Used by the create banner when a
 * station-pane click resolves to a missing file inside the sshfs
 * mount — the underlying `files.create` still writes via the Mac path
 * (sshfs handles the through-translation), but the visible text reads
 * as the Pi path the user is mentally working with.
 *
 * Returns the path unchanged when it's not under the mount root.
 * Trailing slashes on either prefix are tolerated.
 */
export function translateMountToStationPath(
  localPath: string,
  mountPoint: string,
  stationRoot: string,
): string {
  if (typeof localPath !== "string") return localPath;
  const mp = mountPoint.replace(/\/+$/, "");
  const sr = stationRoot.replace(/\/+$/, "");
  if (localPath === mp) return sr;
  // Trailing-slash guard so `/mount/projects` doesn't match
  // `/mount/projectsfoo`.
  if (localPath.startsWith(mp + "/")) {
    return sr + localPath.slice(mp.length);
  }
  return localPath;
}

/**
 * Write `content` to a Pi file by streaming it over SSH stdin to a
 * sibling tmp path, then atomically renaming. The conflict check is
 * a stat+sha compare against `baseline` (skippable via `force`).
 *
 * Returns `{ok: true, baseline}` on success; `{ok: false, code, error}`
 * with `currentBaseline` + `currentContent` populated on conflict so
 * the viewer can hydrate the ConflictBanner without an extra read.
 */
export async function writeStationFile(
  req: StationWriteRequest,
): Promise<StationWriteResult> {
  const safety = isStationPathSafe(req.path);
  if (!safety.ok) {
    return {
      ok: false,
      code: "invalid-input",
      error: `Path "${req.path}" is not safe for station SSH write: ${safety.reason}`,
    };
  }
  if (typeof req.content !== "string") {
    return {
      ok: false,
      code: "invalid-input",
      error: "content must be a string",
    };
  }
  const byteLength = Buffer.byteLength(req.content, "utf-8");
  if (byteLength > STATION_WRITE_MAX_BYTES) {
    return {
      ok: false,
      code: "too-large",
      error: `Station file is ${byteLength} bytes (limit ${STATION_WRITE_MAX_BYTES})`,
    };
  }

  // Baseline check. If !force, fetch current content + sha and compare.
  if (!req.force) {
    const current = await readStationFile(req.path);
    if (current.ok) {
      if (current.baseline.sha256 !== req.baseline.sha256) {
        return {
          ok: false,
          code: "conflict",
          error: "file has changed on disk since last read",
          currentBaseline: current.baseline,
          currentContent: current.content,
        };
      }
    } else if (current.code !== "not-found") {
      // ssh-error / too-large / invalid-input — surface up.
      return current as StationWriteResult;
    }
    // not-found is fine: target doesn't exist yet, just write.
  }

  // Stream content to tmp, then atomic rename.
  const tmpPath = buildRemoteTmpPath(req.path, randomUUID());
  const writeStreamErr = await sshStreamWrite(tmpPath, req.content);
  if (writeStreamErr) {
    // Best-effort cleanup; ignore errors. The tmp will be GC'd by the
    // user eventually if it's left behind.
    await sshRemove(tmpPath).catch(() => {});
    return {
      ok: false,
      code: "ssh-error",
      error: writeStreamErr,
    };
  }
  const renameErr = await sshRename(tmpPath, req.path);
  if (renameErr) {
    await sshRemove(tmpPath).catch(() => {});
    return {
      ok: false,
      code: "ssh-error",
      error: renameErr,
    };
  }

  // Compute new baseline. Use the buffer we just wrote for sha (no
  // round-trip needed) and only stat for mtime.
  const stat = await statStationFile(req.path);
  if (!stat.ok) return stat as StationWriteResult;
  const sha256 = createHash("sha256")
    .update(req.content, "utf-8")
    .digest("hex");
  return {
    ok: true,
    baseline: {
      mtimeMs: stat.mtimeMs,
      sha256,
      size: byteLength,
    },
  };
}

/**
 * Stream `content` over SSH stdin into a remote `cat > '<path>'`.
 * Returns null on success, error message string on failure.
 */
function sshStreamWrite(remotePath: string, content: string): Promise<string | null> {
  const remoteCmd = `cat > '${remotePath}'`;
  return new Promise((resolve) => {
    let stderr = "";
    const proc = spawn("ssh", sshArgs(remoteCmd), {
      stdio: ["pipe", "ignore", "pipe"],
    });
    proc.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    proc.on("exit", (code) => {
      if (code !== 0) {
        resolve((stderr || `ssh exit ${code}`).trim());
        return;
      }
      resolve(null);
    });
    proc.on("error", (err) => {
      resolve(err.message);
    });
    proc.stdin?.end(content, "utf-8");
  });
}

/** Atomic remote rename. Returns null on success, error string on failure. */
function sshRename(fromPath: string, toPath: string): Promise<string | null> {
  // POSIX `mv -f` translates to `rename(2)` when both sides are on the
  // same filesystem (which they always are — tmp sits next to target).
  // The `-f` suppresses an interactive prompt if the target exists.
  const remoteCmd = `mv -f -- '${fromPath}' '${toPath}'`;
  return new Promise((resolve) => {
    let stderr = "";
    const proc = spawn("ssh", sshArgs(remoteCmd), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    proc.on("exit", (code) => {
      if (code !== 0) {
        resolve((stderr || `ssh exit ${code}`).trim());
        return;
      }
      resolve(null);
    });
    proc.on("error", (err) => {
      resolve(err.message);
    });
  });
}

/** Best-effort remove (used to clean up stranded tmp files on error). */
function sshRemove(remotePath: string): Promise<string | null> {
  const remoteCmd = `rm -f -- '${remotePath}'`;
  return new Promise((resolve) => {
    const proc = spawn("ssh", sshArgs(remoteCmd), {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.on("exit", (code) => resolve(code === 0 ? null : `ssh exit ${code}`));
    proc.on("error", (err) => resolve(err.message));
  });
}

export type StationCreateResult =
  | { ok: true; resolvedPath: string }
  | { ok: false; code: string; error: string };

/**
 * Round 6 Phase DD2 — create an empty file on the station via SSH.
 * Validates with isStationPathSafe, then runs `mkdir -p <dir> && touch
 * <path>`. Used by the renderer's create banner for station-remote
 * paths outside the sshfs mount (the in-mount path goes through the
 * regular `files.create` IPC, which writes via sshfs).
 */
export async function createStationFile(
  stationPath: string,
): Promise<StationCreateResult> {
  const safety = isStationPathSafe(stationPath);
  if (!safety.ok) {
    return {
      ok: false,
      code: "invalid-input",
      error: `Path "${stationPath}" is not safe for station SSH create: ${safety.reason}`,
    };
  }
  const cmd = buildCreateStationCmd(stationPath);
  const err = await new Promise<string | null>((resolve) => {
    let stderr = "";
    const proc = spawn("ssh", sshArgs(cmd), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    proc.on("exit", (code) => {
      if (code !== 0) {
        resolve((stderr || `ssh exit ${code}`).trim());
        return;
      }
      resolve(null);
    });
    proc.on("error", (e) => resolve(e.message));
  });
  if (err) {
    return { ok: false, code: "ssh-error", error: err };
  }
  return { ok: true, resolvedPath: stationPath };
}
