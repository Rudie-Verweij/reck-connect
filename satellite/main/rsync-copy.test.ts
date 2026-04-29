// Tests for rsync-copy.ts cover two concerns:
//
//   1. **Listener cleanup** on the per-copy ChildProcess (the original
//      `proc.stdout.on("data", ...)` / `proc.on("exit"|"error", ...)`
//      detach contract). If they don't get detached on every termination
//      path — success, non-zero exit, signal (cancel), spawn error —
//      late-buffered events from a finished copy can still call
//      `webContents.send("rsync:progress", ...)` for a copy the renderer
//      has moved past.
//
//   2. **an audit finding — atomic mkdir reservation.** The flow
//      now spawns `ssh mkdir <remotePath>` BEFORE rsync. EEXIST → no
//      rsync call, error surfaced with `code: "slug-in-use"`. Any post-
//      reservation rsync failure must trigger `ssh rm -rf <remotePath>`
//      rollback so the slug isn't left orphaned. The slug interpolated
//      into mkdir must match `remotePath(slug)` exactly (no string-
//      interpolation footgun).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// Capture every IPC handler the module registers so the tests can invoke
// them directly (no real Electron event loop).
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  },
}));

// Stub the validator out so we don't need a real filesystem path. The
// validator is exercised in `ipc-validation.test.ts`; here we just want it
// to pass through.
vi.mock("./ipc-validation", () => ({
  validateRsyncLocalPath: (p: string) => ({ ok: true, path: p }),
}));

// `fs/promises.stat` is invoked before the validator. Make it report an
// existing directory so the handler proceeds to spawn.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async () => ({ isDirectory: () => true }) as never,
  };
});

// Fake ChildProcess that the test can drive. Each `spawn` returns a fresh
// instance, so the test can assert listener counts on the per-copy proc
// (mirroring the real shape — listeners registered on `proc.stdout` /
// `proc.stderr` / `proc` itself).
//
// `stdout`/`stderr` are plain EventEmitters rather than real Readable
// streams because the source code only calls `.on("data", ...)` on them —
// using a Readable would bring in flowing-mode mechanics we don't need, and
// the tests rely on synchronous `.emit("data", chunk)` having deterministic
// listener invocation for the stale-progress assertion.
class FakeChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed = false;
  killSignal: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(signal: NodeJS.Signals) {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }

  /** Test helper — drive the process to a normal exit. */
  finishOk() {
    this.emit("exit", 0, null);
  }

  /** Test helper — drive the process to a non-zero exit. */
  finishFail(code = 1) {
    this.stderr.emit("data", Buffer.from("rsync error sample\n"));
    this.emit("exit", code, null);
  }

  /** Test helper — drive the process to a signaled exit (cancel). */
  finishSignal(signal: NodeJS.Signals = "SIGTERM") {
    this.emit("exit", null, signal);
  }

  /** Test helper — drive the process to a spawn-error path. */
  fireError(err: Error) {
    this.emit("error", err);
  }

  /** Test helper — push a chunk to stdout. Synchronous listener dispatch. */
  pushStdout(text: string) {
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }

  /** Test helper — push a chunk to stderr. Synchronous listener dispatch. */
  pushStderr(text: string) {
    this.stderr.emit("data", Buffer.from(text, "utf8"));
  }
}

// Per-spawn record so tests can inspect what the source actually invoked
// (which binary, with which args). Useful for verifying the slug
// interpolated into `mkdir` matches `remotePath(slug)` exactly.
type SpawnCall = { bin: string; args: string[]; proc: FakeChildProcess };
const spawned: SpawnCall[] = [];

// Each test installs an `onSpawn` handler. The handler decides what the
// just-spawned fake should do (synchronously emit success, EEXIST stderr +
// fail, defer until the test pushes data, etc.). Keeping the resolution
// strategy per-test avoids a giant queue/state machine in the global mock
// — the test reads top-to-bottom and the spawn shaping lives next to the
// assertion that depends on it.
type SpawnPlanner = (call: SpawnCall) => void;
let onSpawn: SpawnPlanner = () => {
  /* default: do nothing — caller will drive the proc explicitly */
};

const fakeSpawn = (bin: unknown, args: unknown) => {
  const proc = new FakeChildProcess();
  const call: SpawnCall = {
    bin: String(bin),
    args: Array.isArray(args) ? (args as string[]).map(String) : [],
    proc,
  };
  spawned.push(call);
  // Defer the planner to the next microtask so the source has a chance to
  // attach `.on("exit", ...)` / `.stderr.on("data", ...)` handlers before
  // we try to drive the proc. Without this, a planner that calls
  // `finishOk()` synchronously would emit before the source has subscribed
  // and the test would wedge waiting for a resolve that never fires.
  Promise.resolve().then(() => onSpawn(call));
  return proc;
};

// Partial mock rigged via a minimal re-export: rsync-copy.ts only uses
// `spawn` from this module at runtime, but `ChildProcess` is imported for
// its type. Re-exporting an empty class keeps the value-binding happy even
// though the type is `typeof ChildProcess`. `default` placates Vitest's
// module-interop check.
vi.mock("node:child_process", () => ({
  spawn: (bin: unknown, args: unknown) => fakeSpawn(bin, args),
  ChildProcess: class ChildProcess {},
  default: { spawn: (bin: unknown, args: unknown) => fakeSpawn(bin, args) },
}));

// `existsSync` is consulted by `findRsync()` at module init/run time; just
// always return false so we fall back to `"rsync"` (the spawn mock ignores
// the binary name anyway).
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return { ...real, existsSync: () => false };
});

const { registerRsyncIpc } = await import("./rsync-copy");

function listenerCount(proc: FakeChildProcess): {
  stdoutData: number;
  stderrData: number;
  exit: number;
  error: number;
} {
  return {
    stdoutData: proc.stdout.listenerCount("data"),
    stderrData: proc.stderr.listenerCount("data"),
    exit: proc.listenerCount("exit"),
    error: proc.listenerCount("error"),
  };
}

const fakeWindow = {
  webContents: { send: vi.fn() },
};

/** True iff the spawn call is the `ssh ... mkdir <path>` reservation. */
function isReservationCall(call: SpawnCall): boolean {
  return call.bin === "ssh" && call.args.some((a) => a.startsWith("mkdir "));
}

/** True iff the spawn call is the `ssh ... rm -rf <path>` rollback. */
function isRollbackCall(call: SpawnCall): boolean {
  return call.bin === "ssh" && call.args.some((a) => a.startsWith("rm -rf "));
}

/** True iff the spawn call is the rsync copy itself (any non-ssh binary). */
function isRsyncCall(call: SpawnCall): boolean {
  return call.bin !== "ssh";
}

describe("rsync-copy", () => {
  beforeEach(() => {
    handlers.clear();
    spawned.length = 0;
    fakeWindow.webContents.send = vi.fn();
    onSpawn = () => {
      /* default planner: succeed reservation/rollback immediately, leave
       * rsync calls for the test to drive. Each test override below
       * either replaces this entirely or wraps it. */
      // (no-op; tests install their own planner)
    };
    registerRsyncIpc(() => fakeWindow as never);
  });

  afterEach(() => {
    handlers.clear();
    spawned.length = 0;
  });

  // --- Listener cleanup tests (carried forward from the pre-F7 suite) -----
  //
  // These tests pre-reserve the slug (`mkdir` succeeds immediately) and
  // then assert listener-cleanup invariants on the rsync child process.
  // The rollback `ssh rm -rf` spawn (if any) is auto-completed by the
  // shared planner so it doesn't block the test from resolving.
  describe("listener cleanup", () => {
    /**
     * Begin a copy via the IPC handler and wait for `spawn(rsync, ...)`
     * to run. Returns the inflight IPC promise + the per-copy
     * FakeChildProcess for the rsync invocation. Tests drive that proc
     * through `finishOk`/`finishFail`/etc. to observe listener cleanup.
     *
     * Auto-handles the prerequisite `ssh mkdir` reservation (resolves it
     * with success) and any subsequent `ssh rm -rf` rollback (also
     * success). The rsync proc itself is left alone for the caller.
     */
    function startCopyAndGetRsyncProc(slug: string): Promise<{
      inflight: Promise<{ ok: true } | { ok: false; error: string; code?: string }>;
      proc: FakeChildProcess;
    }> {
      return (async () => {
        let rsyncProc: FakeChildProcess | null = null;
        let rsyncReady: () => void;
        const rsyncReadyPromise = new Promise<void>((r) => {
          rsyncReady = r;
        });

        onSpawn = (call) => {
          if (isReservationCall(call)) {
            call.proc.finishOk();
            return;
          }
          if (isRollbackCall(call)) {
            call.proc.finishOk();
            return;
          }
          if (isRsyncCall(call)) {
            rsyncProc = call.proc;
            rsyncReady();
            return;
          }
        };

        const handler = handlers.get("rsync:toStation");
        if (!handler) throw new Error("rsync:toStation handler not registered");
        // Wrap the inflight promise in an object so `await startCopy()`
        // doesn't unwrap it. (An async function that returns a Promise
        // unwraps the inner promise's value into the outer promise — which
        // would make us wait for the copy to finish before the test could
        // even drive the proc.)
        const inflight = handler({}, "/Users/alice/src/demo", slug) as Promise<
          { ok: true } | { ok: false; error: string; code?: string }
        >;
        // Swallow rejections so an early failure (e.g. `active` leak)
        // doesn't crash the test runner before the assertion phase.
        void inflight.catch(() => {});

        // Wait for the rsync spawn to fire. There's a microtask budget so
        // a planner mistake (or an early handler return) surfaces as a
        // clear test error rather than a hang.
        const timeout = new Promise<never>((_r, rej) =>
          setTimeout(() => rej(new Error("rsync spawn never fired")), 1000),
        );
        await Promise.race([rsyncReadyPromise, timeout]);
        if (!rsyncProc) {
          const earlyResult = await inflight.catch((e) => `threw: ${(e as Error).message}`);
          throw new Error(
            `rsync spawn was never observed; handler resolved to: ${JSON.stringify(earlyResult)}`,
          );
        }
        return { inflight, proc: rsyncProc };
      })();
    }

    it("removes all per-proc listeners after a successful copy", async () => {
      const { inflight, proc } = await startCopyAndGetRsyncProc("a-project");

      // Sanity: while the copy is in flight, the handlers we registered
      // are attached.
      expect(listenerCount(proc)).toEqual({
        stdoutData: 1,
        stderrData: 1,
        exit: 1,
        error: 1,
      });

      proc.finishOk();
      await expect(inflight).resolves.toEqual({ ok: true });

      // After exit, every handler we attached must be detached.
      expect(listenerCount(proc)).toEqual({
        stdoutData: 0,
        stderrData: 0,
        exit: 0,
        error: 0,
      });
    });

    it("removes all per-proc listeners after a non-zero exit", async () => {
      const { inflight, proc } = await startCopyAndGetRsyncProc("b-project");
      proc.finishFail(23);
      const result = await inflight;
      expect(result.ok).toBe(false);
      expect(listenerCount(proc)).toEqual({
        stdoutData: 0,
        stderrData: 0,
        exit: 0,
        error: 0,
      });
    });

    it("removes all per-proc listeners after a signaled exit (cancel)", async () => {
      const { inflight, proc } = await startCopyAndGetRsyncProc("c-project");
      proc.finishSignal("SIGTERM");
      const result = await inflight;
      expect(result).toMatchObject({ ok: false, error: "canceled" });
      expect(listenerCount(proc)).toEqual({
        stdoutData: 0,
        stderrData: 0,
        exit: 0,
        error: 0,
      });
    });

    it("removes all per-proc listeners after a spawn error", async () => {
      const { inflight, proc } = await startCopyAndGetRsyncProc("d-project");
      proc.fireError(new Error("ENOENT rsync"));
      const result = await inflight;
      expect(result).toMatchObject({ ok: false, error: "ENOENT rsync" });
      expect(listenerCount(proc)).toEqual({
        stdoutData: 0,
        stderrData: 0,
        exit: 0,
        error: 0,
      });
    });

    it("does not send a stale progress event after exit", async () => {
      const { inflight, proc } = await startCopyAndGetRsyncProc("e-project");

      // Drive a real progress line through stdout, then exit, then push
      // more data. The post-exit data MUST NOT translate into another
      // `rsync:progress` IPC send — the listener must already be gone.
      proc.pushStdout("    1,234,567  42% 5.0MB/s 0:00:30\n");
      expect(fakeWindow.webContents.send).toHaveBeenCalledTimes(1);

      proc.finishOk();
      await inflight;

      // Late buffered chunk that arrives after exit (rsync can emit a
      // final progress flush right before exit; on real systems this can
      // race the exit event).
      proc.pushStdout("    9,999,999 100% 6.0MB/s 0:00:00\n");

      // Still exactly one send — the post-exit chunk was ignored because
      // `finalize()` detached the listener.
      expect(fakeWindow.webContents.send).toHaveBeenCalledTimes(1);
    });

    it("returns to baseline listener count across three serial copies", async () => {
      // The plan-doc test: three copies in a row, listener count must
      // return to zero on the per-proc EventEmitters after each one.
      // (The copies use distinct slugs and are awaited sequentially
      // because the handler refuses concurrent runs by design.)
      const counts: ReturnType<typeof listenerCount>[] = [];

      for (const slug of ["serial-one", "serial-two", "serial-three"]) {
        const { inflight, proc } = await startCopyAndGetRsyncProc(slug);
        proc.finishOk();
        await inflight;
        counts.push(listenerCount(proc));
      }

      expect(counts).toEqual([
        { stdoutData: 0, stderrData: 0, exit: 0, error: 0 },
        { stdoutData: 0, stderrData: 0, exit: 0, error: 0 },
        { stdoutData: 0, stderrData: 0, exit: 0, error: 0 },
      ]);
    });

    it("each copy's progress callback only fires for its own copy", async () => {
      // Observation-based variant of the leak test: a callback registered
      // for copy N must NOT fire for copy N+1. We approximate this by
      // checking the IPC sends come in matched batches per spawn — every
      // send happens while exactly one proc is the live one.
      const sendsPerProc: number[] = [];

      for (const slug of ["obs-one", "obs-two", "obs-three"]) {
        fakeWindow.webContents.send = vi.fn();
        const { inflight, proc } = await startCopyAndGetRsyncProc(slug);
        proc.pushStdout("    1,000,000  50% 5.0MB/s 0:00:10\n");
        proc.finishOk();
        await inflight;
        sendsPerProc.push(
          (fakeWindow.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length,
        );
      }

      // Each copy contributed exactly one progress send; later copies
      // didn't pile on top of older listeners.
      expect(sendsPerProc).toEqual([1, 1, 1]);
    });
  });

  // --- an audit finding — atomic mkdir reservation ------------------
  describe("atomic mkdir reservation ", () => {
    /** Invoke the IPC handler. Returns the inflight promise. */
    function invokeToStation(
      slug: string,
      localPath = "/Users/alice/src/demo",
    ): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
      const handler = handlers.get("rsync:toStation");
      if (!handler) throw new Error("rsync:toStation handler not registered");
      return handler({}, localPath, slug) as Promise<
        { ok: true } | { ok: false; error: string; code?: string }
      >;
    }

    it("spawns ssh mkdir BEFORE rsync, with the slug interpolated through remotePath()", async () => {
      let rsyncStarted = false;
      let observedReservation: SpawnCall | null = null;

      onSpawn = (call) => {
        if (isReservationCall(call)) {
          observedReservation = call;
          // Reservation succeeds → handler proceeds to rsync.
          call.proc.finishOk();
          return;
        }
        if (isRsyncCall(call)) {
          rsyncStarted = true;
          // Auto-complete rsync so the test resolves cleanly.
          call.proc.finishOk();
          return;
        }
      };

      const result = await invokeToStation("alpha-project");
      expect(result).toEqual({ ok: true });
      expect(rsyncStarted).toBe(true);
      expect(observedReservation).not.toBeNull();
      // The reservation command MUST be the exact remotePath. Asserting
      // on the literal string is the "no string-interpolation footgun"
      // test from the audit task — if remotePath() ever drifts, this
      // catches it.
      const reservationCmd = observedReservation!.args[observedReservation!.args.length - 1];
      expect(reservationCmd).toBe("mkdir '/Users/reck-connect/projects/alpha-project'");

      // Spawn order must be reservation first, then rsync. (No rollback
      // expected on the success path.)
      expect(spawned.length).toBe(2);
      expect(isReservationCall(spawned[0])).toBe(true);
      expect(isRsyncCall(spawned[1])).toBe(true);
    });

    it("aborts with code='slug-in-use' on EEXIST and never spawns rsync", async () => {
      let rsyncStarted = false;
      onSpawn = (call) => {
        if (isReservationCall(call)) {
          // mkdir prints the macOS / GNU coreutils EEXIST message and
          // exits non-zero. The handler is supposed to recognise this as
          // a slug collision rather than a generic ssh error.
          call.proc.pushStderr(
            "mkdir: cannot create directory '/Users/reck-connect/projects/beta-project': File exists\n",
          );
          call.proc.emit("exit", 1, null);
          return;
        }
        if (isRsyncCall(call)) {
          rsyncStarted = true;
          call.proc.finishFail();
          return;
        }
      };

      const result = await invokeToStation("beta-project");
      expect(result.ok).toBe(false);
      // `code` is the stable contract the renderer keys off — assert on
      // it directly rather than the human-readable error message.
      expect((result as { code?: string }).code).toBe("slug-in-use");
      // The error message should still mention the collision in plain
      // English so it shows up correctly in legacy callers that only
      // surface `result.error`.
      if (!result.ok) {
        expect(result.error).toMatch(/already exists/i);
      }
      expect(rsyncStarted).toBe(false);
      // Only one spawn — the failed reservation. No rsync, no rollback.
      expect(spawned.length).toBe(1);
      expect(isReservationCall(spawned[0])).toBe(true);
    });

    it("classifies parent-missing distinctly from slug-in-use", async () => {
      // If the managed-projects-root doesn't exist on the station (e.g.
      // install-station.sh wasn't run), mkdir prints "No such file or
      // directory". We surface this as `code: "parent-missing"` so the
      // user gets a different remediation than for a slug collision.
      onSpawn = (call) => {
        if (isReservationCall(call)) {
          call.proc.pushStderr(
            "mkdir: /Users/reck-connect/projects/gamma-project: No such file or directory\n",
          );
          call.proc.emit("exit", 1, null);
          return;
        }
      };

      const result = await invokeToStation("gamma-project");
      expect(result.ok).toBe(false);
      expect((result as { code?: string }).code).toBe("parent-missing");
    });

    it("rolls back the reservation when rsync fails after a successful mkdir", async () => {
      let rolledBack = false;
      let rolledBackArgs: string[] | null = null;

      onSpawn = (call) => {
        if (isReservationCall(call)) {
          call.proc.finishOk();
          return;
        }
        if (isRsyncCall(call)) {
          // rsync exits non-zero — must trigger rollback before the
          // handler returns.
          call.proc.finishFail(23);
          return;
        }
        if (isRollbackCall(call)) {
          rolledBack = true;
          rolledBackArgs = call.args;
          call.proc.finishOk();
          return;
        }
      };

      const result = await invokeToStation("delta-project");
      expect(result.ok).toBe(false);
      expect(rolledBack).toBe(true);
      // Rollback path must target the same reserved slug — this is the
      // anti-orphan check from the design doc.
      const rollbackCmd = rolledBackArgs![rolledBackArgs!.length - 1];
      expect(rollbackCmd).toBe("rm -rf /Users/reck-connect/projects/delta-project");
    });

    it("rolls back the reservation when rsync is canceled (SIGTERM)", async () => {
      // `rsync:cancel` is a separate IPC; here we just simulate the
      // signaled exit because the cancel path resolves the same
      // `{ok: false, error: "canceled"}` value as a `SIGTERM` from any
      // other source — and the design says any post-mkdir failure path
      // (including cancel) must roll back the reservation.
      let rolledBack = false;
      onSpawn = (call) => {
        if (isReservationCall(call)) {
          call.proc.finishOk();
          return;
        }
        if (isRsyncCall(call)) {
          call.proc.finishSignal("SIGTERM");
          return;
        }
        if (isRollbackCall(call)) {
          rolledBack = true;
          call.proc.finishOk();
          return;
        }
      };

      const result = await invokeToStation("epsilon-project");
      expect(result).toMatchObject({ ok: false, error: "canceled" });
      expect(rolledBack).toBe(true);
    });

    it("rolls back the reservation when rsync hits a spawn error", async () => {
      // Path-of-rsync-not-found / EBADF / etc. — proc emits 'error'
      // before any 'exit'. The reservation still needs to be released.
      let rolledBack = false;
      onSpawn = (call) => {
        if (isReservationCall(call)) {
          call.proc.finishOk();
          return;
        }
        if (isRsyncCall(call)) {
          call.proc.fireError(new Error("ENOENT rsync"));
          return;
        }
        if (isRollbackCall(call)) {
          rolledBack = true;
          call.proc.finishOk();
          return;
        }
      };

      const result = await invokeToStation("zeta-project");
      expect(result.ok).toBe(false);
      expect(rolledBack).toBe(true);
    });

    it("does NOT roll back on a fully successful copy", async () => {
      // The success path is the only one without a rollback spawn —
      // verify we don't accidentally fire one.
      let rollbackCount = 0;
      onSpawn = (call) => {
        if (isReservationCall(call)) {
          call.proc.finishOk();
          return;
        }
        if (isRsyncCall(call)) {
          call.proc.finishOk();
          return;
        }
        if (isRollbackCall(call)) {
          rollbackCount += 1;
          call.proc.finishOk();
          return;
        }
      };

      const result = await invokeToStation("eta-project");
      expect(result).toEqual({ ok: true });
      expect(rollbackCount).toBe(0);
      // Sanity: the only spawns should be reservation + rsync.
      expect(spawned.length).toBe(2);
    });

    it("rejects an invalid slug before any spawn occurs", async () => {
      // Defence-in-depth check: the slug-validation error must short-
      // circuit before we make any network round-trip. Catches the
      // accidental "skipped assertValidSlug" regression.
      const result = await invokeToStation("BadSlugWithDots..");
      expect(result.ok).toBe(false);
      expect(spawned.length).toBe(0);
    });

    it("does not register a `rsync:checkCollision` handler anymore", async () => {
      // an audit F7 explicitly removed the TOCTOU preflight handler.
      // If a future refactor accidentally re-adds it, this test catches
      // the regression.
      expect(handlers.has("rsync:checkCollision")).toBe(false);
    });
  });
});
