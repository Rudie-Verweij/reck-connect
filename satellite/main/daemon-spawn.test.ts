import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// Hybrid mode (an earlier release, plan rev 3.1) Phase 5 main-process tests for
// the multi-daemon spawn registry, per-spawn random local-daemon
// bearer token, IPC host validation helper, and port-bind failure
// surfacing. These are pure unit tests — no real Electron, no real
// child processes, no real network. The spawn dependency is injected
// via the `StartDaemonDeps` shape so we can drive every branch
// (success, EADDRINUSE on stderr, generic exit-without-listen) from
// JavaScript without leaking processes.

// `electron` is touched once, in the `app.on("will-quit")` placeholder
// at module load; everything else just needs `app` to exist as a
// shape with `.on`.
vi.mock("electron", () => ({
  app: { on: vi.fn() },
}));

// Dynamic import so the mock above is in place before daemon-spawn.ts
// evaluates (mirrors the storage.test.ts pattern).
const {
  isValidHost,
  startDaemon,
  stopDaemon,
  daemonStatus,
  localDaemonToken,
  ensureSpawnPath,
  _resetDaemonSpawnForTests,
  _setHermeticKillDefaultsForTests,
} = await import("./daemon-spawn");

// --- Fake ChildProcess -----------------------------------------------
//
// Minimal shape: emits `data` on stdout/stderr, supports `kill()`,
// `exit` event, `exitCode`/`killed` flags. Sufficient for the spawn
// path in daemon-spawn.ts which only reads those surfaces.

interface FakeChildOptions {
  /** Emit this string on stderr immediately after the spawn callback. */
  stderr?: string;
  /** Emit this string on stdout immediately after the spawn callback.
   * The real daemon logs via slog's JSONHandler to STDOUT — including
   * the `listen failed` bind error (main.go:49 / :402) — so stdout is
   * the canonical diagnostics stream, not stderr. */
  stdout?: string;
  /** Exit code to set after `exitAfterMs` fires. Default: don't auto-exit. */
  exitCode?: number;
  /** Milliseconds after spawn before the fake child auto-exits. */
  exitAfterMs?: number;
  /** Emit this Error as the child's 'error' event right after spawn.
   * Models posix_spawn-level failures (EACCES, exec-format, Gatekeeper
   * SIGKILL-before-main): NO exit event, NO output, exitCode stays
   * null. */
  errorEvent?: Error;
}

class FakeChild extends EventEmitter {
  pid = 12345;
  exitCode: number | null = null;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  private _killSignal: NodeJS.Signals | null = null;
  constructor(opts: FakeChildOptions = {}) {
    super();
    if (opts.stderr) {
      // Async to mimic real spawn — handlers attach synchronously
      // before the first chunk lands.
      queueMicrotask(() => this.stderr.emit("data", Buffer.from(opts.stderr!)));
    }
    if (opts.stdout) {
      queueMicrotask(() => this.stdout.emit("data", Buffer.from(opts.stdout!)));
    }
    if (opts.errorEvent) {
      queueMicrotask(() => this.emit("error", opts.errorEvent!));
    }
    if (opts.exitCode !== undefined) {
      const ms = opts.exitAfterMs ?? 0;
      setTimeout(() => {
        this.exitCode = opts.exitCode!;
        this.emit("exit", opts.exitCode!, null);
      }, ms);
    }
  }
  kill(signal?: NodeJS.Signals | number) {
    if (this.killed) return true;
    this.killed = true;
    this._killSignal =
      typeof signal === "string" ? signal : signal !== undefined ? null : "SIGTERM";
    // Real ChildProcess emits exit asynchronously after kill — we do
    // the same so any pending probe loop sees the kill take effect on
    // the next tick.
    queueMicrotask(() => {
      if (this.exitCode === null) this.exitCode = 0;
      this.emit("exit", this.exitCode ?? 0, this._killSignal);
    });
    return true;
  }
}

// --- Spawn dep + probe builders --------------------------------------

interface SpawnRecord {
  bin: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

function makeSpawnRecorder(opts: FakeChildOptions = {}) {
  const calls: SpawnRecord[] = [];
  const fn = vi.fn((bin: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ bin, args, env: options.env ?? {} });
    return new FakeChild(opts) as unknown as ReturnType<typeof import("node:child_process").spawn>;
  });
  // Cast to `typeof spawn` so the daemon-spawn signature accepts it.
  return { calls, fn: fn as unknown as typeof import("node:child_process").spawn };
}

function probeAlwaysFalse() {
  return vi.fn(async () => false);
}

function probeAlwaysTrue() {
  return vi.fn(async () => true);
}


// --- Test setup ------------------------------------------------------

const ORIG_ENV = process.env;

beforeEach(() => {
  // Point findDaemonBinary at a guaranteed-existing executable so the
  // ENOENT short-circuit doesn't fire. /bin/sh exists on every macOS;
  // the fake spawn ignores `bin` anyway, but daemon-spawn.ts asserts
  // findDaemonBinary() returns non-null before spawning.
  process.env = { ...ORIG_ENV, RECK_STATIONDCMD: "/bin/sh" };
  _resetDaemonSpawnForTests();
  // Hermetic fallback so tests that don't explicitly inject kill deps
  // never hit real `lsof` / `launchctl` / `process.kill`. The specific
  // orphan-sweep tests below override these via per-call deps.
  _setHermeticKillDefaultsForTests();
});

afterEach(() => {
  process.env = ORIG_ENV;
  _resetDaemonSpawnForTests();
});

// --- Tests -----------------------------------------------------------

describe("isValidHost", () => {
  it("accepts station and local", () => {
    expect(isValidHost("station")).toBe(true);
    expect(isValidHost("local")).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isValidHost("remote")).toBe(false);
    expect(isValidHost("")).toBe(false);
    expect(isValidHost("STATION")).toBe(false);
  });

  it("rejects non-strings (renderer-untrusted boundary)", () => {
    // The IPC handler treats anything not isValidHost as untrusted
    // input. A compromised renderer must not be able to slip through
    // a truthy non-string.
    expect(isValidHost(undefined)).toBe(false);
    expect(isValidHost(null)).toBe(false);
    expect(isValidHost(42)).toBe(false);
    expect(isValidHost({ host: "station" })).toBe(false);
    expect(isValidHost(["station"])).toBe(false);
  });
});

describe("startDaemon('station')", () => {
  it("is a no-op (returns ok without spawning)", async () => {
    const spawn = makeSpawnRecorder();
    const probe = probeAlwaysTrue();
    const result = await startDaemon("station", 7315, {
      spawn: spawn.fn,
      probePort: probe,
    });
    expect(result).toEqual({ ok: true });
    expect(spawn.calls).toHaveLength(0);
    // No spawn means no token, so the localDaemonToken accessor stays
    // null even after a "successful" station start.
    expect(localDaemonToken()).toBeNull();
  });

  it("does not affect the local spawn map", async () => {
    const spawn = makeSpawnRecorder();
    const probe = probeAlwaysTrue();
    await startDaemon("station", 7315, { spawn: spawn.fn, probePort: probe });
    // Status of "local" must report not-running because we only
    // pretended to start "station". Cross-host bleed would let the
    // renderer believe the local daemon is up when it isn't.
    expect(daemonStatus("local").running).toBe(false);
  });
});

describe("startDaemon('local') — happy path", () => {
  it("spawns reck-stationd with --mode=local and the resolved binary", async () => {
    const spawn = makeSpawnRecorder();
    const probe = probeAlwaysTrue();
    const result = await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probe,
    });
    expect(result).toEqual({ ok: true });
    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0];
    expect(call.bin).toBe("/bin/sh"); // RECK_STATIONDCMD override
    expect(call.args).toContain("--mode=local");
    // The --addr arg must reflect the requested port so a non-default
    // port from settings reaches the daemon.
    expect(call.args).toContain("--addr");
    const addrIdx = call.args.indexOf("--addr");
    expect(call.args[addrIdx + 1]).toBe("127.0.0.1:7315");
  });

  it("respects a non-default port in --addr", async () => {
    const spawn = makeSpawnRecorder();
    const probe = probeAlwaysTrue();
    await startDaemon("local", 9001, { spawn: spawn.fn, probePort: probe });
    const call = spawn.calls[0];
    const addrIdx = call.args.indexOf("--addr");
    expect(call.args[addrIdx + 1]).toBe("127.0.0.1:9001");
  });

  it("passes a 32-byte (64-hex-char) DAEMON_TOKEN in env", async () => {
    const spawn = makeSpawnRecorder();
    const probe = probeAlwaysTrue();
    await startDaemon("local", 7315, { spawn: spawn.fn, probePort: probe });
    const tok = spawn.calls[0].env.DAEMON_TOKEN;
    expect(typeof tok).toBe("string");
    expect(tok!.length).toBe(64); // 32 bytes hex-encoded
    expect(/^[0-9a-f]{64}$/.test(tok!)).toBe(true);
  });

  it("exposes the env token via localDaemonToken() once running", async () => {
    const spawn = makeSpawnRecorder();
    const probe = probeAlwaysTrue();
    await startDaemon("local", 7315, { spawn: spawn.fn, probePort: probe });
    expect(localDaemonToken()).toBe(spawn.calls[0].env.DAEMON_TOKEN);
  });

  it("daemonStatus reports running:true after a successful start", async () => {
    const spawn = makeSpawnRecorder();
    const probe = probeAlwaysTrue();
    await startDaemon("local", 7315, { spawn: spawn.fn, probePort: probe });
    const status = daemonStatus("local");
    expect(status.running).toBe(true);
    expect(status.binary).toBe("/bin/sh");
  });

  it("short-circuits if the local daemon is already running", async () => {
    const spawn = makeSpawnRecorder();
    const probe = probeAlwaysTrue();
    await startDaemon("local", 7315, { spawn: spawn.fn, probePort: probe });
    const tokFirst = localDaemonToken();
    // Second call should NOT spawn again or rotate the token —
    // there's no point regenerating a bearer the daemon already
    // accepted, and a re-spawn would orphan the existing child.
    const result = await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probe,
    });
    expect(result).toEqual({ ok: true });
    expect(spawn.calls).toHaveLength(1);
    expect(localDaemonToken()).toBe(tokFirst);
  });
});

describe("startDaemon('local') — token rotation per spawn", () => {
  it("generates a distinct token on every successful spawn", async () => {
    const probe = probeAlwaysTrue();
    const spawn1 = makeSpawnRecorder();
    await startDaemon("local", 7315, { spawn: spawn1.fn, probePort: probe });
    const tok1 = localDaemonToken();

    // Stop the current spawn so the next call actually spawns again
    // rather than short-circuiting on the alive child.
    await stopDaemon("local");
    expect(localDaemonToken()).toBeNull();

    const spawn2 = makeSpawnRecorder();
    await startDaemon("local", 7315, { spawn: spawn2.fn, probePort: probe });
    const tok2 = localDaemonToken();

    expect(tok1).toBeTruthy();
    expect(tok2).toBeTruthy();
    expect(tok1).not.toBe(tok2);
    // Token in env was rotated too — the daemon child's view matches
    // what the renderer fetches via IPC.
    expect(spawn1.calls[0].env.DAEMON_TOKEN).toBe(tok1);
    expect(spawn2.calls[0].env.DAEMON_TOKEN).toBe(tok2);
  });
});

describe("startDaemon('local') — port-bind failure surfacing", () => {
  it("returns { ok:false, code:'EADDRINUSE' } when the daemon logs the canonical Go error", async () => {
    // Real reck-stationd logs `listen failed err=...address already in use...`
    // — we emit the substring daemon-spawn.ts greps for and exit
    // non-zero immediately.
    const spawn = makeSpawnRecorder({
      stderr: "level=ERROR msg=\"listen failed\" err=\"listen tcp 127.0.0.1:7315: bind: address already in use\"",
      exitCode: 1,
      exitAfterMs: 5,
    });
    const probe = probeAlwaysFalse();
    const result = await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probe,
      // Tight budget so the test isn't gated on the 3 s production timeout.
      liveProbeTimeoutMs: 200,
      liveProbeStepMs: 25,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EADDRINUSE");
    expect(result.reason).toMatch(/already in use/i);
  });

  it("clears the token + spawn map after a port-bind failure", async () => {
    const spawn = makeSpawnRecorder({
      stderr: "address already in use",
      exitCode: 1,
      exitAfterMs: 5,
    });
    const probe = probeAlwaysFalse();
    await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probe,
      liveProbeTimeoutMs: 200,
      liveProbeStepMs: 25,
    });
    // Critical invariant: a failed spawn must NOT leave a token
    // exposed via IPC — the renderer would then send a bearer to a
    // daemon that doesn't exist, masking the real failure.
    expect(localDaemonToken()).toBeNull();
    expect(daemonStatus("local").running).toBe(false);
  });

  it("returns { ok:false, code:'EUNKNOWN' } when the child never binds and stderr is silent", async () => {
    // Daemon exits cleanly without logging the canonical "address in
    // use" string — we still want a typed error so the rail can show
    // *something* useful. The reason carries whatever stderr we did
    // capture (or a blank-stderr fallback).
    const spawn = makeSpawnRecorder({
      exitCode: 2,
      exitAfterMs: 5,
    });
    const probe = probeAlwaysFalse();
    const result = await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probe,
      liveProbeTimeoutMs: 100,
      liveProbeStepMs: 25,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EUNKNOWN");
  });

  it("returns { ok:false, code:'EADDRINUSE' } when the daemon logs the listen failure to STDOUT (slog JSON)", async () => {
    // The real daemon's slog JSONHandler writes to os.Stdout
    // (daemon/cmd/reck-stationd/main.go:49), so the canonical bind
    // failure arrives on STDOUT — not stderr. The classification
    // previously grepped only stderr, so a live port conflict was
    // misreported as a bare EUNKNOWN timeout.
    const spawn = makeSpawnRecorder({
      stdout:
        '{"time":"2026-06-04T12:00:00Z","level":"ERROR","msg":"listen failed","err":"listen tcp 127.0.0.1:7315: bind: address already in use","addr":"127.0.0.1:7315"}',
      exitCode: 1,
      exitAfterMs: 5,
    });
    const probe = probeAlwaysFalse();
    const result = await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probe,
      liveProbeTimeoutMs: 200,
      liveProbeStepMs: 25,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EADDRINUSE");
    expect(result.reason).toMatch(/already in use/i);
  });

  it("EUNKNOWN reason carries the daemon's stdout 'listen failed' line for non-port-conflict bind errors", async () => {
    // A bind failure that ISN'T a port conflict (e.g. permission
    // denied) must still surface the daemon's own error line so the
    // Settings rail shows an actionable reason instead of the bare
    // "failed to listen within N ms".
    const spawn = makeSpawnRecorder({
      stdout:
        '{"level":"ERROR","msg":"listen failed","err":"listen tcp 127.0.0.1:7315: bind: permission denied","addr":"127.0.0.1:7315"}',
      exitCode: 1,
      exitAfterMs: 5,
    });
    const probe = probeAlwaysFalse();
    const result = await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probe,
      liveProbeTimeoutMs: 200,
      liveProbeStepMs: 25,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EUNKNOWN");
    expect(result.reason).toMatch(/permission denied/);
  });

  it("EUNKNOWN reason carries the last ERROR-level line for non-listen startup failures (e.g. claude not on PATH)", async () => {
    // The daemon exits on startup errors other than the bind: e.g.
    // `resolve claude binary failed` + os.Exit(1) (main.go:220). The
    // reason must surface THAT line, not the INFO noise before it.
    const spawn = makeSpawnRecorder({
      stdout:
        '{"level":"INFO","msg":"daemon mode","mode":"local"}\n' +
        '{"level":"INFO","msg":"daemon token loaded","source":"file:x"}\n' +
        '{"level":"ERROR","msg":"resolve claude binary failed","err":"exec: \\"claude\\": executable file not found in $PATH","candidate":"claude"}\n',
      exitCode: 1,
      exitAfterMs: 5,
    });
    const probe = probeAlwaysFalse();
    const result = await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probe,
      liveProbeTimeoutMs: 200,
      liveProbeStepMs: 25,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EUNKNOWN");
    expect(result.reason).toMatch(/resolve claude binary failed/);
    expect(result.reason).not.toMatch(/daemon token loaded/);
  });
});

describe("ensureSpawnPath", () => {
  // The daemon os.Exit(1)s when `claude` isn't resolvable
  // (daemon/cmd/reck-stationd/main.go:220). The native claude installer
  // puts the binary in ~/.local/bin and exports PATH in ~/.zshrc —
  // which a NON-INTERACTIVE login shell (`zsh -l -c`, what
  // resolveLoginPath runs) never reads. A Finder-launched Satellite
  // therefore spawned the daemon without ~/.local/bin and the daemon
  // died on startup.
  it("appends ~/.local/bin when the login PATH lacks it", () => {
    const out = ensureSpawnPath("/usr/bin:/bin", "/Users/u");
    expect(out.split(":")).toContain("/Users/u/.local/bin");
    // Existing entries stay first — we only append, never reorder.
    expect(out.startsWith("/usr/bin:/bin")).toBe(true);
  });

  it("appends /opt/homebrew/bin when missing", () => {
    const out = ensureSpawnPath("/usr/bin", "/Users/u");
    expect(out.split(":")).toContain("/opt/homebrew/bin");
  });

  it("does not duplicate entries that are already present", () => {
    const input = "/Users/u/.local/bin:/opt/homebrew/bin:/usr/bin";
    const out = ensureSpawnPath(input, "/Users/u");
    const entries = out.split(":");
    expect(entries.filter((e) => e === "/Users/u/.local/bin")).toHaveLength(1);
    expect(entries.filter((e) => e === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("handles an empty login PATH", () => {
    const out = ensureSpawnPath("", "/Users/u");
    expect(out.split(":")).toContain("/Users/u/.local/bin");
    expect(out.startsWith(":")).toBe(false);
  });

  it("the spawned daemon env PATH always contains ~/.local/bin (integration)", async () => {
    const spawn = makeSpawnRecorder();
    const probe = probeAlwaysTrue();
    await startDaemon("local", 7315, { spawn: spawn.fn, probePort: probe });
    const envPath = spawn.calls[0].env.PATH ?? "";
    const home = (await import("node:os")).homedir();
    expect(envPath.split(":")).toContain(`${home}/.local/bin`);
  });
});

describe("startDaemon('local') — cold-start probe budget", () => {
  it("defaults liveProbeTimeoutMs to 8000 ms (Gatekeeper first-run assessment headroom)", async () => {
    // A freshly built ad-hoc-signed binary triggers a one-time
    // syspolicyd assessment between posix_spawn and Go's main() that
    // can exceed 3 s (warm bind ≈ 100 ms). The default budget must
    // leave headroom; tests and callers can still inject shorter
    // values. The child exits after 5 ms so the loop breaks
    // immediately; only the message text reflects the configured
    // budget.
    const spawn = makeSpawnRecorder({ exitCode: 2, exitAfterMs: 5 });
    const probe = probeAlwaysFalse();
    const result = await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probe,
      // No liveProbeTimeoutMs override — exercise the default.
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/within 8000 ms/);
  });
});

describe("startDaemon('local') — spawn-level errors", () => {
  it("returns { ok:false, code:'ESPAWN' } without burning the probe budget when the child emits 'error'", async () => {
    // posix_spawn-level failures (EACCES, exec-format, Gatekeeper
    // SIGKILL-before-main) surface as a child 'error' event: no exit,
    // no output, exitCode stays null. Previously unhandled, so the
    // probe loop burned its full budget and the user saw the bare
    // EUNKNOWN timeout — and the unhandled 'error' event could crash
    // the main process.
    const spawn = makeSpawnRecorder({ errorEvent: new Error("spawn EACCES") });
    const probe = probeAlwaysFalse();
    const startedAt = Date.now();
    const result = await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probe,
      // Deliberately generous: the implementation must resolve from the
      // 'error' event, NOT from this deadline expiring.
      liveProbeTimeoutMs: 4000,
      liveProbeStepMs: 25,
    });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ESPAWN");
    expect(result.reason).toMatch(/EACCES/);
    // Same invariant as the port-bind failure: no token / no child
    // left dangling for the renderer to trust.
    expect(localDaemonToken()).toBeNull();
    expect(daemonStatus("local").running).toBe(false);
  });
});

describe("startDaemon — invalid host rejection", () => {
  it("returns a typed reject for a host outside the allowlist", async () => {
    const spawn = makeSpawnRecorder();
    const result = await startDaemon(
      // deliberate cast — simulating a misbehaving caller
      "remote" as unknown as Parameters<typeof startDaemon>[0],
      7315,
      { spawn: spawn.fn, probePort: probeAlwaysTrue() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/invalid host/);
    expect(spawn.calls).toHaveLength(0);
  });
});

describe("stopDaemon", () => {
  it("station is a no-op (resolves)", async () => {
    await expect(stopDaemon("station")).resolves.toBeUndefined();
  });

  it("local clears the token", async () => {
    const spawn = makeSpawnRecorder();
    const probe = probeAlwaysTrue();
    await startDaemon("local", 7315, { spawn: spawn.fn, probePort: probe });
    expect(localDaemonToken()).toBeTruthy();
    await stopDaemon("local");
    expect(localDaemonToken()).toBeNull();
    expect(daemonStatus("local").running).toBe(false);
  });

  it("local with no running child resolves immediately and leaves token null", async () => {
    expect(localDaemonToken()).toBeNull();
    await expect(stopDaemon("local")).resolves.toBeUndefined();
    expect(localDaemonToken()).toBeNull();
  });
});

describe("two-host independence", () => {
  it("stopping local does not affect a 'station' status query", async () => {
    const spawn = makeSpawnRecorder();
    await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probeAlwaysTrue(),
    });
    await stopDaemon("local");
    // Station status remains its always-running stub regardless of
    // local lifecycle.
    expect(daemonStatus("station")).toEqual({ running: true, binary: null });
  });

  it("station start/stop never spawns and never touches the local token", async () => {
    const spawn = makeSpawnRecorder();
    await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probeAlwaysTrue(),
    });
    const tokBefore = localDaemonToken();
    await startDaemon("station", 7315, {
      spawn: spawn.fn,
      probePort: probeAlwaysTrue(),
    });
    await stopDaemon("station");
    expect(localDaemonToken()).toBe(tokBefore);
    expect(spawn.calls).toHaveLength(1); // only the local spawn earlier
  });
});

describe("killOrphanedDaemons — station LaunchAgent is skipped", () => {
  // Regression for the 2026-04-24 station bounce: the orphan sweep would
  // SIGTERM the station daemon when a local-mode Satellite started on
  // the same host, because lsof matched on process name alone. The fix
  // threads a `launchctl print gui/<uid>/eu.verwey.reck-stationd` lookup
  // (issue #215 phase 1: per-user Aqua LaunchAgent) through the sweep
  // and skips exactly that pid.
  //
  // We drive the sweep by injecting `listReckStationdPids` to return a
  // fixture set, `stationDaemonPid` to name the supervised pid, and
  // `signalPid` so we can assert exactly which pids got signalled
  // without touching real processes.
  it("does NOT signal the station LaunchAgent pid", async () => {
    const spawn = makeSpawnRecorder();
    const signalled: number[] = [];
    await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probeAlwaysTrue(),
      listReckStationdPids: () => [9001],
      stationDaemonPid: () => 9001,
      signalPid: (pid) => signalled.push(pid),
    });
    expect(signalled).toEqual([]);
  });

  it("DOES signal a real orphan (station daemon not the same pid)", async () => {
    const spawn = makeSpawnRecorder();
    const signalled: number[] = [];
    await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probeAlwaysTrue(),
      listReckStationdPids: () => [9002],
      stationDaemonPid: () => null,
      signalPid: (pid) => signalled.push(pid),
    });
    expect(signalled).toEqual([9002]);
  });

  it("partitions mixed pids: skip the station pid, signal the orphan", async () => {
    const spawn = makeSpawnRecorder();
    const signalled: number[] = [];
    await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probeAlwaysTrue(),
      listReckStationdPids: () => [9001, 9002],
      stationDaemonPid: () => 9001,
      signalPid: (pid) => signalled.push(pid),
    });
    // Only the orphan (9002) gets a SIGTERM; the LaunchAgent (9001)
    // is left alone so KeepAlive doesn't rebound through throttle.
    expect(signalled).toEqual([9002]);
  });

  it("falls back to killing everything when station daemon pid can't be resolved", async () => {
    // stationDaemonPid returning null reproduces the "launchctl print
    // failed / service unloaded" path. The sweep must still clean up
    // actual orphans — otherwise a Satellite on a host that has never
    // registered the station LaunchAgent would be unable to recover
    // from a previous crashed spawn.
    const spawn = makeSpawnRecorder();
    const signalled: number[] = [];
    await startDaemon("local", 7315, {
      spawn: spawn.fn,
      probePort: probeAlwaysTrue(),
      listReckStationdPids: () => [9003, 9004],
      stationDaemonPid: () => null,
      signalPid: (pid) => signalled.push(pid),
    });
    expect(signalled).toEqual([9003, 9004]);
  });
});

describe("token persistence — negative invariant", () => {
  it("daemon-spawn never imports the storage layer (no path to disk)", async () => {
    // Read the source as a string; no `import` line should reference
    // ./storage. This protects against a future refactor that "helps"
    // by persisting the token — exactly the failure mode the design
    // forbids (Phase 5 spec: token never persisted).
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "daemon-spawn.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']\.\/storage["']/);
    expect(src).not.toMatch(/safeStorage/);
    // Sanity: the token-name itself isn't snuck into the storage
    // allowlist via stringification.
    expect(src).not.toMatch(/local\.token/);
    expect(src).not.toMatch(/localDaemonToken_persisted/);
  });
});
