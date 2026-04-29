import { BrowserWindow, ipcMain } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { validateRsyncLocalPath } from "./ipc-validation";

const REMOTE_ROOT = "/Users/reck-connect/projects";
const SSH_KEY = path.join(homedir(), ".ssh", "reck_mount");
const SSH_HOST = "reck-station";

/** macOS 14+ ships `openrsync` as /usr/bin/rsync — it doesn't support
 *  --info=progress2. Prefer Homebrew's real rsync when present; fall
 *  back to whatever's on PATH. */
function findRsync(): string {
  for (const p of ["/opt/homebrew/bin/rsync", "/usr/local/bin/rsync"]) {
    if (existsSync(p)) return p;
  }
  return "rsync";
}

const EXCLUDES = [
  ".DS_Store",
  "._*",
  "node_modules",
  "dist",
  "build",
  ".venv",
  "__pycache__",
  "target",
  ".next",
  ".cache",
];

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let active: { proc: ChildProcess; slug: string } | null = null;

function assertValidSlug(slug: string): void {
  if (!slug || !SLUG_RE.test(slug) || slug.length > 64) {
    throw new Error(`invalid slug: ${JSON.stringify(slug)}`);
  }
}

function remotePath(slug: string): string {
  assertValidSlug(slug);
  return `${REMOTE_ROOT}/${slug}`;
}

/**
 * an audit finding — atomic slug reservation.
 *
 * The previous flow ran a `test -d <remotePath>` preflight here and a
 * separate rsync write later in `rsync:toStation`. In the gap between the
 * two SSH round-trips a second `Add Project` attempt (or a maliciously
 * placed symlink) could win the race and rsync would clobber whatever
 * landed first.
 *
 * Replace that with `mkdir <remotePath>` (no `-p`):
 *
 *   - mkdir(2) is atomic on the server side; if a directory or symlink
 *     already exists at the target, mkdir fails with EEXIST. There is no
 *     check-then-create gap to race.
 *   - Without `-p`, the parent (`/Users/reck-connect/projects`) must
 *     already exist; if it doesn't, mkdir fails with ENOENT — a
 *     station-setup bug we want to surface clearly rather than silently
 *     papering over with auto-created intermediates.
 *
 * We do NOT lean on rsync `--mkpath` for this lock: rsync's create path
 * is check-then-create (not atomic with EEXIST semantics), and openrsync
 * differs from real rsync here. The explicit `ssh ... mkdir` is the
 * lock; rsync just fills the reserved directory afterwards.
 *
 * `remotePath()` gates the slug through `SLUG_RE` + a fixed root, so the
 * shell command can't be bent into a different target — but we still
 * single-quote the slug as defence-in-depth (per the audit task design).
 */
type ReserveResult =
  | { ok: true }
  | { ok: false; reason: "slug-in-use" | "parent-missing" | "ssh-error"; detail: string };

async function reserveRemoteSlug(slug: string): Promise<ReserveResult> {
  const target = remotePath(slug); // assertValidSlug runs here
  // remotePath returns `${REMOTE_ROOT}/${slug}` and slug is whitelisted by
  // SLUG_RE; even unquoted this can't shell-escape. Single-quote anyway as
  // a belt-and-braces measure — if SLUG_RE is ever loosened by accident,
  // the quoting is the second layer of defence (with the strict-validation
  // round-trip in `assertValidSlug` being the first).
  const remoteCmd = `mkdir '${target}'`;
  return new Promise<ReserveResult>((resolve) => {
    let stderr = "";
    const p = spawn(
      "ssh",
      [
        "-i",
        SSH_KEY,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        SSH_HOST,
        remoteCmd,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    p.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    p.on("exit", (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      // Classify the failure from mkdir's stderr. macOS / GNU mkdir both
      // emit human-readable messages; we match on substrings rather than
      // strict equality because exact wording differs between coreutils
      // builds (e.g. "File exists" vs "Operation not permitted" if a
      // symlink to a file is in the way). Anything we can't classify
      // becomes a generic ssh-error so the user sees the raw message.
      const msg = stderr.trim() || `mkdir exit ${code}`;
      const lower = msg.toLowerCase();
      if (lower.includes("file exists")) {
        resolve({ ok: false, reason: "slug-in-use", detail: msg });
      } else if (lower.includes("no such file or directory")) {
        resolve({ ok: false, reason: "parent-missing", detail: msg });
      } else {
        resolve({ ok: false, reason: "ssh-error", detail: msg });
      }
    });
    p.on("error", (err) => {
      resolve({ ok: false, reason: "ssh-error", detail: err.message });
    });
  });
}

export async function rollbackRemote(slug: string): Promise<void> {
  assertValidSlug(slug);
  await new Promise<void>((resolve) => {
    const p = spawn(
      "ssh",
      [
        "-i",
        SSH_KEY,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        SSH_HOST,
        `rm -rf ${remotePath(slug)}`,
      ],
      { stdio: "ignore" },
    );
    p.on("exit", () => resolve());
    p.on("error", () => resolve());
  });
}

type Progress = {
  percent: number;
  bytes: number;
  speed: string;
  eta: string;
};

const PROGRESS_RE =
  /^\s*([\d,]+)\s+(\d+)%\s+(\S+)\s+(\S+)/;

function parseProgressLine(line: string): Progress | null {
  const m = line.match(PROGRESS_RE);
  if (!m) return null;
  return {
    bytes: Number(m[1].replace(/,/g, "")),
    percent: Number(m[2]),
    speed: m[3],
    eta: m[4],
  };
}

export function registerRsyncIpc(getWindow: () => BrowserWindow | null): void {
  // an audit finding — the previous `rsync:checkCollision` handler
  // ran a `test -d` SSH preflight here and was the read half of a TOCTOU
  // race with the rsync write below. It has been removed; `rsync:toStation`
  // now reserves the slug atomically via `mkdir` before any data moves.

  ipcMain.handle(
    "rsync:toStation",
    async (
      _e,
      localPath: string,
      slug: string,
    ): Promise<{ ok: true } | { ok: false; error: string; code?: string }> => {
      try {
        assertValidSlug(slug);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      if (active) {
        return { ok: false, error: "another copy is already running" };
      }

      // Validate the renderer-supplied localPath before handing it to rsync:
      //   - a leading `-` would be parsed as a flag (e.g. `--rsh=<attacker>`)
      //   - a non-directory / missing path would fail mid-copy with a noisy
      //     rsync error; cheaper to reject up front.
      // We also stat the path ourselves and pass the result to the pure
      // validator, which keeps the validator side-effect-free and testable.
      let statInfo: { exists: boolean; isDirectory: boolean } | null = null;
      try {
        const s = await stat(localPath);
        statInfo = { exists: true, isDirectory: s.isDirectory() };
      } catch {
        statInfo = { exists: false, isDirectory: false };
      }
      const pathCheck = validateRsyncLocalPath(localPath, statInfo);
      if (!pathCheck.ok) {
        console.warn(
          `[satellite] rejected rsync:toStation localPath: ${pathCheck.error}; ` +
            `value=${JSON.stringify(localPath)}`,
        );
        return { ok: false, error: pathCheck.error };
      }

      // ---- Atomic slug reservation  ------------------------
      //
      // Reserve the remote directory BEFORE any rsync invocation. This is
      // the lock; everything below assumes ownership of the reserved path.
      // If reservation fails with EEXIST we surface a stable
      // `code: "slug-in-use"` so the renderer can show a user-friendly
      // "choose a different name" message without re-parsing English.
      const reservation = await reserveRemoteSlug(slug);
      if (!reservation.ok) {
        if (reservation.reason === "slug-in-use") {
          return {
            ok: false,
            code: "slug-in-use",
            error:
              `A folder already exists on the station at ${remotePath(slug)}. ` +
              `Choose a different name.`,
          };
        }
        if (reservation.reason === "parent-missing") {
          return {
            ok: false,
            code: "parent-missing",
            error:
              `Station projects root missing (${REMOTE_ROOT}). ` +
              `Re-run install-station.sh on the station. ` +
              `Detail: ${reservation.detail}`,
          };
        }
        return {
          ok: false,
          code: "ssh-error",
          error: `Could not reserve project slug on station: ${reservation.detail}`,
        };
      }

      const src = pathCheck.path.endsWith("/") ? pathCheck.path : `${pathCheck.path}/`;
      const dst = `${SSH_HOST}:${remotePath(slug)}/`;

      const args: string[] = [
        "-a",
        "--info=progress2",
        "--no-inc-recursive",
        "-e",
        `ssh -i ${SSH_KEY} -o IdentitiesOnly=yes -o BatchMode=yes`,
      ];
      for (const ex of EXCLUDES) args.push(`--exclude=${ex}`);
      // `--` terminates rsync's option parsing so any future path with a
      // leading `-` that slips past validation still lands as an operand.
      args.push("--", src, dst);

      // From here on, the slug is reserved on the station. Any failure path
      // MUST roll back (`rm -rf` of the reserved dir) before returning, or
      // the slug stays permanently locked from the user's POV. The
      // try/catch + the resolve-with-rollback inside the spawn callbacks
      // below give us that guarantee; an unexpected sync throw before
      // spawn returns gets caught by the outer try too.
      try {
        const rsyncResult: { ok: true } | { ok: false; error: string } = await new Promise(
          (resolve) => {
            const win = getWindow();
            let stderrBuf = "";
            const proc = spawn(findRsync(), args, { stdio: ["ignore", "pipe", "pipe"] });
            active = { proc, slug };

            // Per-copy listener bookkeeping. The progress / stderr / lifecycle
            // listeners are attached to this specific ChildProcess (and its
            // stdout/stderr streams) and would normally be GC'd along with it,
            // but in the window between `exit` firing and proc being collected
            // we can still see late-buffered data trigger
            // `webContents.send("rsync:progress", ...)` for an already-resolved
            // copy. That confuses any progress UI that has moved on. Track
            // the handlers explicitly so `finalize()` can detach them on every
            // termination path (success, non-zero exit, signal, spawn error,
            // user cancel).
            let carry = "";
            let finalized = false;
            const finalize = () => {
              if (finalized) return;
              finalized = true;
              // Detach in the same order we attached. `removeListener` is the
              // EventEmitter API the docs guarantee — `.off()` is an alias but
              // sticking with the explicit name keeps the intent obvious in the
              // diff. We don't `removeAllListeners()` because the proc's stdio
              // streams may have other internal listeners (e.g. node's own
              // stream pipe machinery) that we shouldn't disturb.
              proc.stdout?.removeListener("data", onStdout);
              proc.stderr?.removeListener("data", onStderr);
              proc.removeListener("exit", onExit);
              proc.removeListener("error", onError);
              // Only clear `active` if it still points at our proc. A racing
              // `rsync:cancel` could in theory have replaced it by now, though
              // the `if (active)` guard at the top of `rsync:toStation` makes
              // this unreachable today; keeping the check defends against a
              // future caller that drops that guard.
              if (active && active.proc === proc) active = null;
            };

            const onStdout = (chunk: Buffer) => {
              const text = carry + chunk.toString("utf8");
              const parts = text.split(/[\r\n]+/);
              carry = parts.pop() ?? "";
              for (const line of parts) {
                const prog = parseProgressLine(line);
                if (prog) win?.webContents.send("rsync:progress", prog);
              }
            };
            const onStderr = (chunk: Buffer) => {
              stderrBuf += chunk.toString("utf8");
            };
            const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
              finalize();
              if (code === 0) {
                resolve({ ok: true });
              } else if (signal === "SIGTERM") {
                resolve({ ok: false, error: "canceled" });
              } else {
                const msg = stderrBuf.trim().split(/\n/).slice(-3).join(" ") || `rsync exit ${code}`;
                resolve({ ok: false, error: msg });
              }
            };
            const onError = (err: Error) => {
              finalize();
              resolve({ ok: false, error: err.message });
            };

            proc.stdout!.on("data", onStdout);
            proc.stderr!.on("data", onStderr);
            proc.on("exit", onExit);
            proc.on("error", onError);
          },
        );

        if (!rsyncResult.ok) {
          // rsync failed (non-zero exit, cancel, or spawn error). Drop
          // the reservation so the user can re-pick the slug. `rm -rf`
          // is safe here because `remotePath()` validated the slug into
          // the fixed `REMOTE_ROOT`; even if rsync wrote partial files
          // they're inside the reserved directory.
          await rollbackRemote(slug);
        }
        return rsyncResult;
      } catch (err) {
        // Defensive: an unexpected sync/async throw from the spawn block
        // (e.g. a future refactor that throws before resolve fires) must
        // still trigger rollback so the slug isn't left orphaned.
        await rollbackRemote(slug);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle("rsync:cancel", () => {
    if (active) {
      active.proc.kill("SIGTERM");
      return { ok: true };
    }
    return { ok: false, error: "no active copy" };
  });

  ipcMain.handle("rsync:rollback", async (_e, slug: string) => {
    await rollbackRemote(slug);
    return { ok: true };
  });
}
