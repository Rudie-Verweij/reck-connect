// Per-host DaemonConnection registry for the hybrid-mode plumbing
// (an earlier release, plan rev 3.1, Phase 4).
//
// Phase 3 split the ApiClient into a per-host registry; Phase 4 does
// the same for DaemonConnection. Each enabled host gets its own
// independent poll loop, error state, subscriber list. A station
// outage does not affect local's connection state, and vice versa.
//
// Phase 4 is plumbing only — only the station connection is wired
// to the renderer's UI today (status bar + project refresh). The
// local connection polls in the background but its callbacks largely
// no-op until Phase 9 wires the local-side project push and a later
// phase extends the status bar to surface both. The
// scaffolding is here so those phases plug in without another
// rewrite.
//
// Lifecycle mirrors `api-for-host.ts`:
//   1. `initConnectionsForHost(settings, opts)` once during boot.
//   2. `connectionForHost(host)` to access; lazy-constructed.
//   3. `disposeConnections()` to stop all loops on shutdown / re-init.
//
// `enabledHosts()` is the small helper Phase 4 explicitly calls out;
// it re-derives the enabled set from the same Settings blob the api
// registry saw, so callers don't have to pass it around.

import type { ApiClient } from "@client-core/api/client";
import type { HealthResponse } from "@proto/proto";
import type { ConnectionInfo } from "./connection";
import { DaemonConnection } from "./connection";
import type { HostRef } from "../host";
import type { Settings } from "../config";
import {
  apiForHost,
  hasTokenForHost,
  refreshLocalDaemonToken,
} from "../api-for-host";

export interface ConnectionsForHostOptions {
  /** Interval between polls after a successful probe (per connection). */
  pollIntervalMs: number;
  /** Optional override for the per-poll fetch timeout. */
  pollTimeoutMs?: number;
  /** Optional override for the user-initiated `refresh()` timeout. */
  refreshTimeoutMs?: number;
  /**
   * Called on each successful probe with the host that observed it
   * and the health payload. Phase 4: only station drives renderer
   * state (project refresh); local's hook is invoked too but Phase 4's
   * boot wires it as a no-op (Phase 9 will use it to PUT the project
   * list to the local daemon once it reaches healthy).
   */
  onPollSuccess: (host: HostRef, health: HealthResponse) => void | Promise<void>;
  /**
   * Called whenever a probe fails. The 1008/401 path in boot is
   * already host-aware via `requestTokenUpdate(host, reason)` (Phase 3
   * split); Phase 4 just routes the failure here so each host's
   * recovery is mutated in isolation.
   */
  onPollFailure: (host: HostRef, reason: string, error: unknown) => void;
  /**
   * Called whenever a host's connection state changes. The registry
   * fans out every state transition for every host; Phase 4's boot
   * callback filters to the primary host (single-display status bar),
   * a later phase may broaden it to surface both. Keep the registry
   * contract uniform so future surfaces don't need a second rewrite.
   */
  onConnectionInfo: (host: HostRef, info: ConnectionInfo) => void;
}

interface ConnectionEntry {
  connection: DaemonConnection;
  unsubscribe: () => void;
}

let cachedSettings: Settings | null = null;
let cachedOptions: ConnectionsForHostOptions | null = null;
const entries = new Map<HostRef, ConnectionEntry>();
// DaemonConnection already logs every probe outcome at the per-host
// level ("[conn] state X -> Y"). We layer a once-per-host info on top
// from the registry so an operator scanning the console sees a single
// "host X failing → noise suppressed" line per outage rather than
// having to count probe-fail entries to notice a host is gone. The
// flag clears on recovery, so a flap re-arms the next outage's log.
const failureLogged = new Set<HostRef>();

// Per-host "ready" gate (hybrid mode rev 3.1, phase 9). A host is
// ready when its daemon is reachable *and* any prerequisites for
// pane-create on that host have landed:
//
//   - station: ready ≡ connected. No prerequisites — the station is
//     the project-list source of truth, so a connected station can
//     always accept pane-create.
//   - local:   ready ≡ connected AND first PUT /projects has been
//     acknowledged. Until then the local daemon has an empty project
//     map and pane-create would 404 on any station-sourced ID (Codex
//     blocker 1). Boot toggles this flag from the push orchestrator
//     after `putProjects()` resolves, and resets to false when local
//     disconnects so the next push-ack re-arms the gate.
//
// The registry is policy-free: it stores the flag, fans changes out to
// subscribers, and resets everything on `disposeConnections()`. The
// station-auto-ready policy and local-push-ack wiring live in boot.ts,
// which is the only module that already knows the hybrid-mode shape.
const readyFlags = new Map<HostRef, boolean>();
type ReadyListener = (host: HostRef, ready: boolean) => void;
const readyListeners = new Set<ReadyListener>();

// Per-host "does this station have a codex binary" flag, fed from each
// host's /health `codex_available`. Read synchronously by the New-pane
// dialog to show the Codex button only where a codex pane can spawn.
// Defaults to false for every host until a poll reports otherwise, so a
// codex-less station (or an older daemon that omits the field) hides it.
const codexAvailableFlags = new Map<HostRef, boolean>();

/**
 * Initialise the per-host connection registry. Call once during boot
 * with the loaded `Settings` and the boot-side callbacks; the registry
 * lazily constructs a `DaemonConnection` per enabled host on first
 * access (or on `start()`-as-a-loop below). Calling again disposes the
 * existing connections so a re-init from a settings change rebuilds
 * cleanly.
 *
 * Each constructed connection is auto-subscribed to forward state to
 * `opts.onConnectionInfo(host, info)`. Connections are NOT auto-started
 * — the caller chooses when to begin polling (matches the existing
 * single-host boot flow where `connection.start()` lives at the end of
 * boot, after the subscriber wiring).
 */
export function initConnectionsForHost(
  settings: Settings,
  opts: ConnectionsForHostOptions,
): void {
  // Tear down any prior registry state. Defensive — a single boot
  // call shouldn't hit this, but a future settings-mutation surface
  // (preferences view) would.
  disposeConnections();
  cachedSettings = settings;
  cachedOptions = opts;
}

/**
 * Get (or lazily construct) the `DaemonConnection` for `host`. Throws
 * if the registry hasn't been initialised, or if `host` isn't enabled
 * in the cached settings.
 *
 * Construction is lazy so a host that's enabled in settings but never
 * actually polled (e.g. a future read-only diagnostic view) doesn't
 * spin up a poll loop unnecessarily. The common path is `enabledHosts()`
 * → `connectionForHost(h).start()` for each, which constructs everything
 * up front.
 */
export function connectionForHost(host: HostRef): DaemonConnection {
  if (!cachedSettings || !cachedOptions) {
    throw new Error("connectionForHost called before initConnectionsForHost");
  }
  const cached = entries.get(host);
  if (cached) return cached.connection;
  if (!isHostEnabled(cachedSettings, host)) {
    throw new Error(`connectionForHost('${host}') called but ${host} is not enabled`);
  }
  const entry = buildEntry(host, apiForHost(host), cachedOptions);
  entries.set(host, entry);
  return entry.connection;
}

/**
 * Hosts the user has enabled in settings, in stable order: station
 * first if enabled, then local if enabled. Mirrors the api registry's
 * "what hosts can I talk to" question. Used by the boot wiring to
 * iterate `connectionForHost(h).start()` and by future surfaces that
 * need to know which hosts the user has turned on.
 *
 * Returns `[]` only when neither host is enabled, which is the
 * fresh-install / mode-chooser path — boot returns early before
 * touching the registry, so this is mostly a defensive shape.
 */
export function enabledHosts(): HostRef[] {
  if (!cachedSettings) return [];
  const out: HostRef[] = [];
  if (isHostEnabled(cachedSettings, "station")) out.push("station");
  if (isHostEnabled(cachedSettings, "local")) out.push("local");
  return out;
}

/**
 * Stop every running connection's poll loop, drop subscribers, and
 * clear the registry. Safe to call multiple times. Call from a
 * shutdown handler if/when boot grows one; today it's invoked by
 * `initConnectionsForHost` to reset between configs and by tests in
 * `beforeEach`.
 */
export function disposeConnections(): void {
  for (const [, entry] of entries) {
    entry.connection.stop();
    entry.unsubscribe();
  }
  entries.clear();
  failureLogged.clear();
  readyFlags.clear();
  readyListeners.clear();
  codexAvailableFlags.clear();
  cachedSettings = null;
  cachedOptions = null;
}

/**
 * Report whether `host` has been marked ready. Pane-create UI should
 * gate its per-host affordance on this flag (hybrid mode rev 3.1,
 * phase 9/10). Defaults to `false` for every host until explicitly set;
 * on a fresh registry that means "nothing is ready yet."
 */
export function isHostReady(host: HostRef): boolean {
  return readyFlags.get(host) === true;
}

/**
 * Flip the ready flag for `host`. Idempotent — a no-op write to the
 * same value doesn't re-fanout to subscribers. The registry stores the
 * flag but has no opinion on when it should flip: the station auto-set
 * from `onConnectionInfo` transitions, and the local-push orchestrator
 * in boot.ts are the only legitimate callers today.
 *
 * Reset-on-disconnect is the caller's responsibility (again, in boot —
 * the module that already subscribes to every host's `ConnectionInfo`
 * transitions). Keeping the policy outside the registry means a future
 * "soft ready" state (e.g. local push-in-flight) can be added without
 * untangling registry internals.
 */
export function setHostReady(host: HostRef, ready: boolean): void {
  const prev = readyFlags.get(host) === true;
  if (prev === ready) return;
  readyFlags.set(host, ready);
  // The New-pane dialog greys a host on this exact flag. Log every real
  // transition so "why is Local greyed out?" is answerable from the
  // console: ready=false here + a preceding `[boot] local daemon start
  // failed (code=…)` or connection-state line is the whole story.
  console.info(
    `[ready] host=${host} ready=${ready} (pane-create UI ${ready ? "enabled" : "greyed"})`,
  );
  for (const l of readyListeners) l(host, ready);
}

/**
 * Subscribe to ready-flag changes. The callback is NOT invoked with
 * the current state on subscribe — only fires on transitions. Callers
 * that need the initial value should call `isHostReady(host)` after
 * subscribing. Returns an unsubscribe function.
 */
export function subscribeHostReady(cb: ReadyListener): () => void {
  readyListeners.add(cb);
  return () => {
    readyListeners.delete(cb);
  };
}

/**
 * Report whether `host` last advertised a codex binary on /health. The
 * New-pane dialog gates its "Codex" button on this. Defaults to false
 * for every host until a successful poll sets it (see boot's
 * `onPollSuccess`), so the button stays hidden on codex-less stations and
 * on daemons too old to send the field.
 */
export function isHostCodexAvailable(host: HostRef): boolean {
  return codexAvailableFlags.get(host) === true;
}

/**
 * Record `host`'s codex availability from its latest /health poll.
 * Per-host: a codex binary on the station does not imply one on local.
 */
export function setHostCodexAvailable(host: HostRef, available: boolean): void {
  codexAvailableFlags.set(host, available);
}

/**
 * Test-only: drop registry state. Vitest's per-file isolation usually
 * handles this, but tests that share a file and want a clean registry
 * between cases call this in `beforeEach`. Same shape as
 * `_resetApiForHostForTests` in `api-for-host.ts`.
 */
export function _resetConnectionsForHostForTests(): void {
  disposeConnections();
}

function isHostEnabled(settings: Settings, host: HostRef): boolean {
  if (host === "station") return !!settings.station?.enabled;
  return !!settings.local?.enabled;
}

function buildEntry(
  host: HostRef,
  client: ApiClient,
  opts: ConnectionsForHostOptions,
): ConnectionEntry {
  const connection = new DaemonConnection({
    client,
    pollIntervalMs: opts.pollIntervalMs,
    pollTimeoutMs: opts.pollTimeoutMs,
    refreshTimeoutMs: opts.refreshTimeoutMs,
    shouldPoll: () => {
      // Station always polls (its token comes from settings and doesn't
      // rotate under us). Local is different: its per-spawn bearer is
      // owned by main and rotates on every daemon (re)start. Hold off
      // probing until we hold a token — a token-less probe just draws a
      // 401 and greys the host out. When the token is missing (daemon
      // down at boot, or (re)started after boot), quietly re-acquire it
      // from main so a later tick can poll; skip probing this tick.
      if (host === "station") return true;
      if (hasTokenForHost("local")) return true;
      void refreshLocalDaemonToken().catch(() => {});
      return false;
    },
    onPollSuccess: async (health) => {
      // Recovery — clear the once-per-host failure-log gate so the
      // next outage re-arms a single info line. Only emit a recovery
      // log if we actually saw a prior failure; otherwise this would
      // fire on the very first successful boot poll.
      if (failureLogged.has(host)) {
        failureLogged.delete(host);
        console.info(`[conn:${host}] daemon recovered`);
      }
      await opts.onPollSuccess(host, health);
    },
    onPollFailure: (reason, error) => {
      // DaemonConnection's own probe-fail log fires every poll
      // cycle at console.log level. The registry adds a single
      // info-level summary on first failure per host so an operator
      // scanning the console can tell "host X is gone" without
      // counting probe entries; subsequent failures stay silent
      // until recovery clears the gate.
      if (!failureLogged.has(host)) {
        failureLogged.add(host);
        console.info(
          `[conn:${host}] daemon connection failing (${reason}) — further failures suppressed until recovery`,
        );
      }
      opts.onPollFailure(host, reason, error);
    },
  });
  const unsubscribe = connection.subscribe((info) => {
    opts.onConnectionInfo(host, info);
  });
  return { connection, unsubscribe };
}
