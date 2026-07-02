// Per-host ApiClient registry for the hybrid-mode plumbing
// (an earlier release, plan rev 3.1, Phase 3).
//
// Until Phase 3 the renderer constructed a single ApiClient from the
// resolved active URL; under hybrid mode each tab knows which daemon
// its pane lives on (`Tab.host`) and the renderer needs a separate
// client per host so token rotations on one don't disturb the other.
//
// This module owns the singletons. Callers that know the tab's host
// call `apiForHost(tab.host)`; the active-host shortcut in `boot.ts`
// still goes through `apiForHost(derivedMode(settings))`. Behaviour is
// unchanged at Phase 3 — every tab is still stamped `"station"` —
// but the type plumbing is honest, so Phase 4 (DaemonConnection split)
// and Phase 9 (two-host runtime) can reach in without another rewrite.
import { ApiClient } from "@client-core/api/client";
import type { HostRef } from "./host";
import type { Settings } from "./config";

const DEFAULT_LOCAL_PORT = 7315;

// Lazily constructed: the local client is only built on first
// `apiForHost("local")` call (typically Phase 5+ when local-mode runtime
// actually wires up). Pre-constructing both on boot would force the
// renderer to know a Settings shape it doesn't otherwise need to.
const clients = new Map<HostRef, ApiClient>();

// The cached Settings the registry was initialised with. Mutates only
// via `resetForHost(host, settings)` if a future surface needs to
// re-key off a settings change mid-session; Phase 3 doesn't exercise
// that path (the 1008 → token-rotate flow goes through
// `setApiTokenForHost`, which mutates the existing client in place).
let cachedSettings: Settings | null = null;

/**
 * Initialise the registry from a Settings blob. Call once during boot,
 * before any `apiForHost(...)` call. Idempotent — calling again with a
 * different blob clears any cached clients so they're rebuilt from the
 * new URL/port on next access.
 */
export function initApiForHost(settings: Settings): void {
  cachedSettings = settings;
  clients.clear();
}

/**
 * Get (or lazily construct) the ApiClient for `host`. Throws if the
 * registry hasn't been initialised, or if `host` isn't enabled in the
 * cached settings.
 *
 * Throw-on-disabled is deliberate: a caller that asks for a host the
 * user hasn't enabled is a programmer error (the UI should have hidden
 * the relevant control), not a recoverable runtime condition. Catch at
 * the call site if you actually want the soft-fail behaviour.
 */
export function apiForHost(host: HostRef): ApiClient {
  if (!cachedSettings) {
    throw new Error("apiForHost called before initApiForHost");
  }
  const cached = clients.get(host);
  if (cached) return cached;
  const client = buildClient(host, cachedSettings);
  clients.set(host, client);
  return client;
}

/**
 * Mutate the bearer token on a single host's client without touching
 * the other. Used by the 1008 → token-rotate path in `boot.ts`. Lazily
 * constructs the client if it didn't exist yet (matches `apiForHost`).
 */
export function setApiTokenForHost(host: HostRef, token: string | undefined): void {
  apiForHost(host).setToken(token);
}

/**
 * True when `host`'s client currently holds a bearer token. The poll-gate
 * in `connection-for-host.ts` reads this to hold off probing a host until
 * it's authenticated — a token-less probe just draws a 401 and greys the
 * host out. Lazily constructs the client if needed (matches `apiForHost`).
 */
export function hasTokenForHost(host: HostRef): boolean {
  return apiForHost(host).config.token !== undefined;
}

/**
 * Drop the cached client for `host`. Next `apiForHost(host)` rebuilds
 * from the current settings. Intended for the "URL or port changed"
 * surface in the future preferences view; Phase 3 has no caller, but
 * exporting it keeps the lifecycle complete.
 */
export function clearApiForHost(host: HostRef): void {
  clients.delete(host);
}

/**
 * Re-initialise a single host from a fresh Settings slice. Drops the
 * cached client for `host` and merges the corresponding slice from
 * `settings` into the cached blob, leaving the *other* host's slice
 * (and its cached client) untouched. Calling
 * `resetForHost("station", { station: {...} })` after a hybrid init
 * therefore lets `apiForHost("local")` keep working from the
 * pre-existing local slice rather than rebuilding from a partial
 * blob and crashing with `host is not enabled`.
 *
 * Throws if the registry hasn't been initialised yet (call
 * `initApiForHost` first).
 */
export function resetForHost(host: HostRef, settings: Settings): void {
  if (!cachedSettings) {
    throw new Error("resetForHost called before initApiForHost");
  }
  // Merge: only the slice for `host` is replaced. Pulling the slice
  // by host keeps the contract honest — even if the caller passed a
  // full Settings blob, only the requested host's data is honoured,
  // so cross-host bleed is impossible.
  if (host === "station") {
    cachedSettings = { ...cachedSettings, station: settings.station };
  } else {
    cachedSettings = { ...cachedSettings, local: settings.local };
  }
  clients.delete(host);
}

/**
 * Test-only: drop all cached state. Vitest's per-file module isolation
 * normally handles this, but tests that share a file and want a clean
 * registry between cases can call this in `beforeEach`.
 */
export function _resetApiForHostForTests(): void {
  cachedSettings = null;
  clients.clear();
}

function buildClient(host: HostRef, settings: Settings): ApiClient {
  if (host === "station") {
    if (!settings.station?.enabled) {
      throw new Error("apiForHost('station') called but station is not enabled");
    }
    if (!settings.station.url) {
      throw new Error("apiForHost('station') called but station.url is empty");
    }
    return new ApiClient({
      baseUrl: settings.station.url.replace(/\/$/, ""),
      token: settings.station.token,
    });
  }
  // host === "local"
  if (!settings.local?.enabled) {
    throw new Error("apiForHost('local') called but local is not enabled");
  }
  const port = settings.local.port || DEFAULT_LOCAL_PORT;
  // Phase 5 (an earlier release, plan rev 3.1): the local daemon's bearer is a
  // per-spawn random 32-byte token generated in the Electron main
  // process (see `daemon-spawn.ts:startDaemon("local")`). Construction
  // of the client is synchronous, so we start with no token and rely
  // on `boot.ts` calling `refreshLocalDaemonToken()` (which fetches
  // via the `daemon:localToken` IPC) right after `daemon.start("local")`
  // resolves. The token never lives anywhere except this client and
  // main-process memory — never persisted, never copied to settings.
  return new ApiClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token: undefined,
  });
}

/**
 * Pull the current local-daemon bearer token from the Electron main
 * process and apply it to the local ApiClient. Returns the token that
 * was applied, or `null` when the local daemon isn't running (in which
 * case the local client's token is cleared so a stale token doesn't
 * leak into the next request).
 *
 * Idempotent — safe to call after every successful `daemon.start("local")`,
 * after a 1008 close on a local pane (the daemon may have rotated under
 * us), and from manual recovery surfaces. The fetch goes through IPC
 * and main is the single source of truth, so racing two callers can't
 * desync the client from the daemon.
 *
 * Test boundary: the IPC dependency is injectable so vitest can drive
 * the function without a `window.reckAPI` mock. Production callers omit
 * the second arg.
 */
export async function refreshLocalDaemonToken(
  fetchToken: () => Promise<string | null> = () =>
    window.reckAPI.daemon.localToken(),
): Promise<string | null> {
  const token = await fetchToken();
  setApiTokenForHost("local", token ?? undefined);
  return token;
}
