import { spawn, ChildProcess, execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { app } from "electron";

// HostRef mirrors the renderer-side type in `renderer/src/host.ts`. We
// re-declare here rather than import so the main-process bundle stays
// independent of the renderer module graph; the runtime allowlist below
// keeps the two in lockstep.
export type HostRef = "station" | "local";

const VALID_HOSTS: ReadonlySet<HostRef> = new Set<HostRef>(["station", "local"]);

export function isValidHost(h: unknown): h is HostRef {
  return typeof h === "string" && VALID_HOSTS.has(h as HostRef);
}

// resolveLoginPath spawns the user's login shell briefly to capture the
// PATH they'd see in a terminal. Electron launched from Finder/Dock
// inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), which makes
// it impossible for the daemon to find user-installed tools like
// `claude`, `node`, or anything under /opt/homebrew. Resolving once at
// startup and passing through to the daemon fixes spawn-not-found
// failures without shipping a runtime shell-env package.
let cachedLoginPath: string | null = null;
function resolveLoginPath(): string {
  if (cachedLoginPath !== null) return cachedLoginPath;
  const shell = process.env.SHELL || "/bin/zsh";
  let loginPath: string;
  try {
    const out = execSync(`${shell} -l -c 'echo "$PATH"'`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    loginPath = out || process.env.PATH || "";
  } catch {
    loginPath = process.env.PATH || "";
  }
  cachedLoginPath = ensureSpawnPath(loginPath, homedir());
  return cachedLoginPath;
}

/**
 * Append well-known per-user binary dirs that a NON-INTERACTIVE login
 * shell misses. `zsh -l -c` reads ~/.zprofile but NOT ~/.zshrc, and the
 * native claude installer drops its binary in ~/.local/bin with the
 * PATH export in ~/.zshrc — so a Finder-launched Satellite spawned the
 * daemon without ~/.local/bin and the daemon os.Exit(1)'d on `resolve
 * claude binary failed` (daemon/cmd/reck-stationd/main.go:220).
 * Append-only: existing entries keep their order and win lookup.
 */
export function ensureSpawnPath(loginPath: string, home: string): string {
  const wellKnown = [`${home}/.local/bin`, "/opt/homebrew/bin"];
  const entries = loginPath.split(":").filter((e) => e.length > 0);
  const present = new Set(entries);
  for (const dir of wellKnown) {
    if (!present.has(dir)) {
      entries.push(dir);
      present.add(dir);
    }
  }
  return entries.join(":");
}

/**
 * Per-host daemon child registry. Hybrid mode (an earlier release, plan rev 3.1,
 * Phase 5): the renderer can target either the station daemon (remote,
 * launchd-managed — Satellite doesn't spawn it) or a locally-spawned
 * daemon. Only `"local"` ever holds a `ChildProcess` here; `"station"`
 * is no-op'd at every call site so the typed surface is uniform.
 */
const children = new Map<HostRef, ChildProcess>();
const lastExits = new Map<HostRef, { code: number | null; signal: NodeJS.Signals | null }>();

/**
 * Per-spawn random bearer token for the local daemon. Generated on every
 * `startDaemon("local")`, passed via `DAEMON_TOKEN=` env var, surfaced
 * to the renderer via the `daemon:localToken` IPC handler. Lives in
 * main-process memory only — never persisted (see CONFIG_KEYS in
 * storage.ts: no entry).
 *
 * Rotates on every successful spawn. A `stopDaemon("local")` clears it
 * so the renderer can't read a stale token after the daemon is gone.
 */
let localToken: string | null = null;

export function localDaemonToken(): string | null {
  return localToken;
}

/**
 * Canonical label of the station's LaunchAgent, per
 * `~/Library/LaunchAgents/eu.verwey.reck-stationd.plist`. Per-user Aqua
 * scope (issue #215 phase 1), so the live pid is queried under
 * `gui/<uid>/<label>`. The previous `system/<label>` form pointed at the
 * old LaunchDaemon and was retired with the migration; leaving it in
 * place silently fails the unprivileged `launchctl print` and makes the
 * orphan sweep SIGTERM the supervised station daemon.
 */
function stationLaunchAgentLabel(): string {
  // Electron main process always runs as the desktop user on macOS, so
  // process.getuid() is defined; the `?? 0` fallback exists only to
  // satisfy the TypeScript Node.js types where getuid() is typed as
  // `number | undefined` (Windows builds expose a typed-undefined).
  const uid = process.getuid?.() ?? 0;
  return `gui/${uid}/eu.verwey.reck-stationd`;
}

/**
 * Return the currently-running pid of the station LaunchAgent, or null
 * if launchctl can't find one (service unloaded, or an older macOS /
 * domain restriction that refuses the unprivileged query). A null means
 * "don't skip anything" — the orphan sweep falls back to killing every
 * reck-stationd on the port, i.e. exactly the pre-fix behaviour. That
 * matches what a local-mode-only Satellite expects and is the right
 * default for a host that has never run the station service.
 *
 * The station LaunchAgent binds `0.0.0.0:7315`, so a local-mode
 * Satellite starting on the same host would see it in `lsof` and —
 * without this guard — SIGTERM it. launchd respawns via KeepAlive,
 * hits ThrottleInterval=30 s, and the station goes dark for 30 s every
 * time the Satellite starts up. A 2026-04-24 incident (two overlapping
 * kickstarts bouncing the station for 30 s) was the live repro that
 * prompted this code path.
 *
 * Injectable so the unit tests don't need real `launchctl` on the
 * vitest host. The default is the real binary.
 */
function defaultStationDaemonPid(): number | null {
  let out = "";
  try {
    out = execFileSync("/bin/launchctl", ["print", stationLaunchAgentLabel()], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2000,
    });
  } catch {
    // Service not loaded, or unprivileged query refused by this macOS
    // release. Null = "don't skip anything" (see doc above).
    return null;
  }
  // launchctl print emits a block of `key = value` lines; the `pid` line
  // is present only while the job is actually running. Anchor on the
  // line start so we don't match a substring in some URL-like value.
  const match = out.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  if (!match) return null;
  const pid = parseInt(match[1], 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * List every `reck-stationd` PID listening on `port`. Default impl shells
 * out to `lsof`; tests inject a synchronous fake so they can drive the
 * skip/kill branches without a real listener on the vitest host.
 */
function defaultListReckStationdPids(port: number): number[] {
  let out = "";
  try {
    out = execFileSync(
      "/usr/sbin/lsof",
      ["-t", "-i", `tcp:${port}`, "-sTCP:LISTEN", "-a", "-c", "reck-stationd"],
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    );
  } catch {
    return []; // no listener, or lsof missing — nothing to clean
  }
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const pid = parseInt(line.trim(), 10);
    if (pid) pids.push(pid);
  }
  return pids;
}

// Test-only fallbacks for the orphan-sweep side-effects. Tests install
// hermetic no-op impls here via `_setHermeticKillDefaultsForTests` so
// that any `startDaemon`/`stopDaemon` call that doesn't explicitly
// pass kill deps stays off real `lsof`/`launchctl`/`process.kill`.
// Production never touches these (they stay null; the real defaults
// below kick in).
let _testFallbackStationDaemonPid: (() => number | null) | null = null;
let _testFallbackListPids: ((port: number) => number[]) | null = null;
let _testFallbackSignalPid: ((pid: number) => void) | null = null;

// killOrphanedDaemons SIGTERMs any reck-stationd bound to the given port
// that this Electron instance doesn't own AND isn't the station
// LaunchAgent. Orphans show up when a previous Satellite launch
// spawned a daemon and then crashed / was force-quit before stopDaemon
// ran — the child process kept running after its parent died. Without
// cleanup, startDaemon() would later fail with a bind error because the
// port is still taken.
//
// The station-LaunchAgent guard protects the supervised
// `gui/<uid>/eu.verwey.reck-stationd` process from being killed by a
// local-mode Satellite running on the same host; see
// defaultStationDaemonPid for the rationale and the 2026-04-24 incident
// that motivated this code.
function killOrphanedDaemons(
  port: number,
  stationDaemonPid: () => number | null = _testFallbackStationDaemonPid ??
    defaultStationDaemonPid,
  listPids: (port: number) => number[] = _testFallbackListPids ??
    defaultListReckStationdPids,
  signalPid: (pid: number) => void = _testFallbackSignalPid ??
    ((pid) => process.kill(pid, "SIGTERM")),
) {
  const myPid = children.get("local")?.pid;
  // Resolve the station daemon pid once per sweep: the set of pids
  // lsof returns is typically ≤ 1, but even for a larger set one
  // launchctl shell-out is enough because the station daemon's pid
  // is stable across the sweep.
  const stationPid = stationDaemonPid();
  for (const pid of listPids(port)) {
    if (pid === myPid) continue;
    if (stationPid !== null && pid === stationPid) {
      console.log(`[reck-stationd] skip kill pid=${pid} (station LaunchAgent)`);
      continue;
    }
    try {
      signalPid(pid);
      console.log(`[reck-stationd] killed orphan pid=${pid}`);
    } catch (err) {
      // Silently swallow ESRCH (orphan died between lsof and kill, fine).
      // Everything else — EPERM (different uid leaves the port held), or
      // an injected test stub that throws a non-Errno error — should
      // surface so a future "EADDRINUSE on launch" or "orphan in Activity
      // Monitor" complaint has a diagnostic trail.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ESRCH") {
        console.warn(
          `[reck-stationd] failed to signal orphan pid=${pid} code=${code ?? "unknown"}`,
        );
      }
    }
  }
}

function candidatePaths(): string[] {
  return [
    process.env.RECK_STATIONDCMD ?? "",
    join(homedir(), ".local/bin/reck-stationd"),
    "/opt/homebrew/bin/reck-stationd",
    "/usr/local/bin/reck-stationd",
    join(homedir(), "go/bin/reck-stationd"),
  ].filter(Boolean);
}

export function findDaemonBinary(): string | null {
  for (const p of candidatePaths()) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Liveness probe: TCP-connect to the listening port. Used after spawn
 * to verify the local daemon actually bound the address before we hand
 * a "running" signal back to the renderer. Bounded by `timeoutMs` so a
 * dead-but-not-yet-exited child can't stall the IPC reply.
 *
 * Plain TCP (vs HTTP /health) keeps the probe dependency-free — we only
 * need to confirm `Listen` succeeded, and an HTTP probe would pull in
 * `node:http` plus a successful response shape contract.
 */
export function probePort(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const sock = connect({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Spawn options abstracted so tests can inject a fake spawn / probe
 * without monkey-patching `node:child_process` and `node:net`. Real
 * callers always use the defaults — the signature stays backwards-
 * compatible with the single-host `startDaemon(port)` shape via the
 * legacy alias below.
 */
export interface StartDaemonDeps {
  spawn?: typeof spawn;
  probePort?: (port: number, timeoutMs?: number) => Promise<boolean>;
  /** Override the wait-for-listen budget. Default 8 s: a freshly
   * rebuilt ad-hoc-signed binary triggers a one-time macOS Gatekeeper
   * (syspolicyd) assessment between posix_spawn and Go's main() that
   * can exceed the old 3 s budget — warm binds take ~100 ms. The tests
   * use a shorter value to keep the suite fast. */
  liveProbeTimeoutMs?: number;
  /** Override the per-attempt TCP probe timeout. Default 250 ms. */
  liveProbeStepMs?: number;
  /** Override the "what pid is the station LaunchAgent running as?"
   * probe used by the orphan sweep. Tests inject a synchronous fake so
   * the skip-vs-kill branch can be driven without real `launchctl`.
   * Returning `null` means "no station daemon running" → sweep is a
   * pass-through. */
  stationDaemonPid?: () => number | null;
  /** Override the list of reck-stationd pids bound to the port. Tests
   * inject a fixture list so the sweep logic can be driven without a
   * real listener on the vitest host. */
  listReckStationdPids?: (port: number) => number[];
  /** Override `process.kill(pid, "SIGTERM")` so tests can observe which
   * pids were signalled without actually signalling anything on the
   * test host. */
  signalPid?: (pid: number) => void;
}

export type StartDaemonResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      code?: "EADDRINUSE" | "ENOENT" | "ESPAWN" | "EUNKNOWN";
    };

/**
 * Start the daemon for the given host.
 *
 * - `"station"`: no-op. The station daemon is launchd-managed on a
 *   remote Mac Studio; Satellite never spawns it. Returns `{ ok: true }`
 *   so callers can use a single uniform code path regardless of host.
 *
 * - `"local"`: spawn `reck-stationd --mode=local --addr 127.0.0.1:<port>
 *   --config <user-toml>` with `DAEMON_TOKEN=<random32hex>` in env. The
 *   token is regenerated on every call (rotation per spawn) and only
 *   lives in main-process memory — see `localDaemonToken()`. After
 *   spawning, we wait briefly for the daemon to actually bind the port
 *   so a port-bind failure (EADDRINUSE) is surfaced as a typed error
 *   instead of the renderer eventually timing out on the first poll.
 */
export async function startDaemon(
  host: HostRef,
  port = 7315,
  deps: StartDaemonDeps = {},
): Promise<StartDaemonResult> {
  if (host === "station") {
    // Satellite never spawns the station daemon. Reporting `ok: true`
    // lets the renderer treat "did the daemon come up?" uniformly across
    // hosts; the connection-for-host poll is what actually verifies the
    // station is reachable.
    return { ok: true };
  }
  if (host !== "local") {
    return { ok: false, reason: `invalid host: ${JSON.stringify(host)}` };
  }
  const existing = children.get("local");
  if (existing && !existing.killed) {
    return { ok: true };
  }
  // Sweep orphans from prior Satellite launches before binding the port.
  killOrphanedDaemons(
    port,
    deps.stationDaemonPid,
    deps.listReckStationdPids,
    deps.signalPid,
  );
  const bin = findDaemonBinary();
  if (!bin) {
    return {
      ok: false,
      code: "ENOENT",
      reason:
        "reck-stationd not found. Run ops/install-local.sh (or build it manually: cd v2 && go build -o ~/.local/bin/reck-stationd ./daemon/cmd/reck-stationd).",
    };
  }
  // Token: 32 random bytes → 64-char hex. Rotates on every spawn. Lives
  // in this process only — never persisted, never surfaced via
  // window.reckAPI.config.set. See storage.ts CONFIG_KEYS for the
  // negative invariant (no entry).
  const token = randomBytes(32).toString("hex");
  const configPath = join(homedir(), ".config/reck/projects.toml");

  const spawnFn = deps.spawn ?? spawn;
  const probeFn = deps.probePort ?? probePort;
  const probeTimeoutMs = deps.liveProbeTimeoutMs ?? 8000;
  const probeStepMs = deps.liveProbeStepMs ?? 250;

  const child = spawnFn(
    bin,
    [
      "--mode=local",
      "--config",
      configPath,
      "--addr",
      `127.0.0.1:${port}`,
    ],
    {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: resolveLoginPath(),
        DAEMON_TOKEN: token,
        // Match the station LaunchAgent plist so panes spawned by the
        // local daemon advertise truecolor to Claude — without this, a
        // Finder-launched Electron has no COLORTERM in its env and Claude
        // falls back to 256-color rendering, producing the slight color
        // drift between local and station panes .
        COLORTERM: "truecolor",
      },
    },
  );
  // Capture BOTH streams for diagnostics. The daemon's slog JSONHandler
  // writes to os.Stdout (daemon/cmd/reck-stationd/main.go:49), so the
  // actionable failure reason — including the `listen failed` bind
  // error at main.go:402 — lands on STDOUT, not stderr. Stderr still
  // carries the top-level fatal path (`fmt.Fprintf` at main.go:59), so
  // both feed the same diagnostic buffer.
  let diagBuf = "";
  const onStdoutCapture = (d: Buffer | string) => {
    const s = d.toString();
    diagBuf += s;
    console.log(`[reck-stationd] ${s.trimEnd()}`);
  };
  const onStderrCapture = (d: Buffer | string) => {
    const s = d.toString();
    diagBuf += s;
    console.error(`[reck-stationd] ${s.trimEnd()}`);
  };
  child.stdout?.on("data", onStdoutCapture);
  child.stderr?.on("data", onStderrCapture);
  child.on("exit", (code, signal) => {
    lastExits.set("local", { code, signal });
    console.log(`[reck-stationd] exited code=${code} signal=${signal}`);
    if (children.get("local") === child) {
      children.delete("local");
      // Token only valid while a child is alive — once gone, clear so
      // the next `localDaemonToken()` returns null.
      localToken = null;
    }
  });
  // posix_spawn-level failure (EACCES, exec-format error, Gatekeeper
  // killing the binary before main). Node surfaces these as an 'error'
  // event with NO 'exit' and exitCode stuck at null — without a
  // listener the EventEmitter throw would crash the main process, and
  // the probe loop below would burn its full budget on a child that
  // never existed. Capture it; the loop breaks on it and the
  // classification below returns a typed ESPAWN.
  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
  });
  children.set("local", child);
  // Stash the token *before* the probe so a fast-listening daemon can't
  // race the renderer fetching it before we record. The probe outcome
  // decides whether we keep it.
  localToken = token;

  // Wait for the daemon to actually bind. Poll TCP every `probeStepMs`
  // until success or budget exhausted, OR until the child exits early
  // (port collision typically logs to stderr then exits non-zero), OR
  // until a spawn-level 'error' fires.
  const deadline = Date.now() + probeTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError !== null || child.exitCode !== null || child.killed) break;
    if (await probeFn(port, probeStepMs)) {
      return { ok: true };
    }
    // Tiny gap between attempts so we don't pin the event loop. The
    // `await probeFn` itself absorbs `probeStepMs` of wait too.
    await new Promise((r) => setTimeout(r, 50));
  }

  // Exited or never bound. Tear down whatever's left and surface a
  // typed error. Don't leave the token / child reference dangling.
  const exitedEarly = child.exitCode !== null || child.killed;
  try {
    if (!exitedEarly) child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  if (children.get("local") === child) {
    children.delete("local");
  }
  localToken = null;

  // Spawn-level error beats stream classification: there was never a
  // process to produce diagnostics, so the errno from the 'error'
  // event IS the reason.
  if (spawnError !== null) {
    return {
      ok: false,
      code: "ESPAWN",
      reason: `local daemon failed to spawn: ${(spawnError as Error).message}`,
    };
  }

  // EADDRINUSE detection: the daemon's `net.Listen` failure path logs
  // the err string verbatim via slog to STDOUT (JSONHandler at
  // daemon/cmd/reck-stationd/main.go:49; `logger.Error("listen
  // failed", "err", err, ...)` at main.go:402). Match the canonical Go
  // error substring across the combined capture; if we don't see it
  // but the child never bound, return EUNKNOWN carrying the daemon's
  // own ERROR line so the renderer / user can still diagnose.
  const diagLower = diagBuf.toLowerCase();
  if (diagLower.includes("address already in use")) {
    return {
      ok: false,
      code: "EADDRINUSE",
      reason: `Port ${port} is already in use by another process. Stop it (or pick a different port in Settings) and try again.`,
    };
  }
  // Prefer the daemon's own failure line over a raw tail dump — it's a
  // single JSON log line with the exact errno text. Any ERROR-level
  // slog line qualifies (bind failures, `resolve claude binary failed`
  // + os.Exit(1) at main.go:220, …); fall back to the tail of whatever
  // we captured (either stream), then to the bare timeout message.
  const errorLine = diagBuf
    .split("\n")
    .filter(
      (l) =>
        l.includes('"level":"ERROR"') ||
        l.toLowerCase().includes("listen failed"),
    )
    .pop();
  const detail = (errorLine ?? diagBuf).trim().slice(-500);
  return {
    ok: false,
    code: "EUNKNOWN",
    reason: detail
      ? `local daemon failed to listen within ${probeTimeoutMs} ms: ${detail}`
      : `local daemon failed to listen within ${probeTimeoutMs} ms`,
  };
}

export interface StopDaemonDeps {
  /** See `StartDaemonDeps.stationDaemonPid`. */
  stationDaemonPid?: () => number | null;
  listReckStationdPids?: (port: number) => number[];
  signalPid?: (pid: number) => void;
}

/**
 * Stop the daemon for the given host.
 *
 * - `"station"`: no-op. (Resolves immediately.)
 * - `"local"`: SIGTERM the spawned child, escalate to SIGKILL after 3 s,
 *   sweep orphan listeners on the port for good measure.
 */
export function stopDaemon(
  host: HostRef,
  port = 7315,
  deps: StopDaemonDeps = {},
): Promise<void> {
  if (host === "station") {
    return Promise.resolve();
  }
  if (host !== "local") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      // Also sweep anything else bound to this port — our child may have
      // spawned a grandchild, or a prior Satellite leaked an orphan that
      // outlived stopDaemon's `child` reference.
      killOrphanedDaemons(
        port,
        deps.stationDaemonPid,
        deps.listReckStationdPids,
        deps.signalPid,
      );
      resolve();
    };
    const child = children.get("local");
    if (!child || child.killed) {
      // The exit handler clears `localToken` already, but if we never
      // had a child this is a defensive clear.
      localToken = null;
      done();
      return;
    }
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      done();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timeout);
      done();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timeout);
      done();
    }
  });
}

/**
 * Status of the daemon for the given host.
 *
 * - `"station"`: `{ running: true, binary: null }`. Liveness of the
 *   remote station is governed by the connection-for-host poll loop;
 *   this handler is just "is Satellite trying to spawn one locally?",
 *   which is always false for the station path.
 * - `"local"`: `{ running: <child alive>, binary: <resolved path> }`.
 */
export function daemonStatus(host: HostRef): { running: boolean; binary: string | null } {
  if (host === "station") {
    return { running: true, binary: null };
  }
  if (host !== "local") {
    return { running: false, binary: null };
  }
  const child = children.get("local");
  return {
    running: !!child && !child.killed,
    binary: findDaemonBinary(),
  };
}

/**
 * Backwards-compatible accessor — keeps the pre-Phase-5 single-host
 * call sites working. New code should pass an explicit `host`.
 */
export function isDaemonRunning(host: HostRef = "local"): boolean {
  return daemonStatus(host).running;
}

export function getLastExit(
  host: HostRef = "local",
): { code: number | null; signal: NodeJS.Signals | null } | null {
  return lastExits.get(host) ?? null;
}

/**
 * Test-only: clear in-memory state so a vitest file can run multiple
 * spawn scenarios in isolation. Doesn't touch real children — call
 * `stopDaemon` first if a real child is involved. Also clears any
 * hermetic test fallbacks installed via
 * `_setHermeticKillDefaultsForTests`.
 */
export function _resetDaemonSpawnForTests(): void {
  children.clear();
  lastExits.clear();
  localToken = null;
  _testFallbackStationDaemonPid = null;
  _testFallbackListPids = null;
  _testFallbackSignalPid = null;
}

/**
 * Test-only: install hermetic no-op defaults for the orphan sweep so
 * tests that exercise lifecycle code don't accidentally shell out to
 * `lsof` / `launchctl` / `process.kill` on the vitest host. The
 * specific sweep tests override these via explicit `deps` args; every
 * other test just relies on these fallbacks.
 */
export function _setHermeticKillDefaultsForTests(opts?: {
  stationDaemonPid?: () => number | null;
  listReckStationdPids?: (port: number) => number[];
  signalPid?: (pid: number) => void;
}): void {
  _testFallbackStationDaemonPid = opts?.stationDaemonPid ?? (() => null);
  _testFallbackListPids = opts?.listReckStationdPids ?? (() => []);
  _testFallbackSignalPid =
    opts?.signalPid ??
    (() => {
      /* no-op */
    });
}

// Bug #2 S1 (2026-05-24) — fallback only. The graceful quit path lives
// in main.ts (`confirmQuitWithLocalDaemon`), which awaits the full
// `stopDaemon("local", …)` teardown (SIGTERM, escalate to SIGKILL after
// 3s, sweep orphans) before letting the app exit. This hook only fires
// if something bypassed that path — e.g. an updater calling `app.quit()`
// directly, or any code path that triggers `before-quit` without going
// through the dialog. The orphan-sweep on next launch is the backstop
// for paths that don't fire `will-quit` at all (force-quit, SIGKILL,
// system shutdown timeout). The station daemon is launchd-managed on a
// remote host and never appears in `children`, so it can't be reached
// from here.
app.on("will-quit", () => {
  const local = children.get("local");
  if (!local?.pid) return;
  try {
    process.kill(local.pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ESRCH") {
      console.warn(
        `[reck-stationd] will-quit fallback failed to SIGTERM local daemon pid=${local.pid} code=${code ?? "unknown"}`,
      );
    }
  }
});
