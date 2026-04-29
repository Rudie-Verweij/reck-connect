// Push the station-owned project catalog to the local daemon (hybrid
// mode rev 3.1, phase 9). The station's Satellite renders the rail from
// station-side state, then translates each project's station cwd
// (`/Users/reck-connect/projects/<id>`) to its sshfs-mounted
// laptop-side equivalent (`$HOME/reck/projects/<id>`) and calls
// `PUT /projects` on the local daemon so it can resolve those IDs when
// a user creates a local pane against a station-owned project.
//
// This module is pure translation + a small orchestrator:
//
//   - `translateStationCwd` — single-entry prefix swap, returns null
//     when the cwd isn't under the station's managed root (custom cwds
//     aren't auto-mounted on the laptop, so they can't host local
//     panes).
//   - `buildPutProjectsPayload` — filter + translate a `Project[]` into
//     the wire-ready `PutProjectsEntry[]`. Deterministic ordering for
//     stable fingerprinting.
//   - `fingerprintPayload` — cheap content hash of a payload, used by
//     the caller in `boot.ts` to skip re-pushing when nothing changed.
//
// The REMOTE root string is hard-coded to match the station user's
// home (reck-connect). That value also appears in
// `satellite/main/rsync-copy.ts:REMOTE_ROOT` and
// `satellite/renderer/src/ui/add-project-dialog.ts:REMOTE_PROJECTS_ROOT`;
// if the station deployment ever moves, all three need to move
// together. We don't pull from a shared constant because the three
// call sites live in different module layers (main / renderer / pure)
// and keeping a tight three-line duplication is cheaper than a
// cross-layer shared constant.

import type { Project, PutProjectsEntry } from "@proto/proto";

/**
 * Station's managed projects root. Mirrors
 * `ManagedProjectsRoot` on the daemon and the two other references
 * cited in the module header. Exported for tests; the production
 * pathway always takes the default.
 */
export const STATION_MANAGED_ROOT = "/Users/reck-connect/projects";

/**
 * Translate a station-side cwd into the corresponding local mount
 * path. Returns `null` when the cwd is not under the station's managed
 * root — the laptop's sshfs mount only mirrors that prefix, so a
 * project with a custom cwd (e.g. `/Users/reck-connect/claude-code/*`)
 * has no local-host equivalent and can't run local panes.
 *
 * Prefix matching is strict-segment: `/Users/reck-connect/projects`
 * matches `/Users/reck-connect/projects/foo` but NOT
 * `/Users/reck-connect/projects-evil/foo`. A trailing slash after the
 * prefix is required (or the exact prefix itself, which maps to the
 * mount root and is also not a valid project cwd — returns `null` for
 * safety parity with the daemon's `ReplaceProjects` validator).
 */
export function translateStationCwd(
  stationCwd: string,
  localMount: string,
  stationRoot: string = STATION_MANAGED_ROOT,
): string | null {
  if (!stationCwd || !localMount) return null;
  // Normalize trailing slash off the prefix so the segment check is
  // consistent regardless of how the caller phrased it.
  const root = stationRoot.replace(/\/+$/, "");
  const mount = localMount.replace(/\/+$/, "");
  if (!stationCwd.startsWith(root)) return null;
  // Must be followed by a `/` — otherwise `projects` would match
  // `projects-evil`. Empty suffix (exact prefix match) is rejected:
  // that's the mount root itself, not a project.
  const suffix = stationCwd.slice(root.length);
  if (!suffix.startsWith("/")) return null;
  if (suffix === "/") return null;
  return mount + suffix;
}

/**
 * Filter a station-owned `Project[]` down to those hostable on the
 * local daemon and translate each one into the wire shape the PUT
 * /projects endpoint accepts. Projects whose cwd isn't under the
 * station's managed root are silently dropped — they can't be mounted
 * on the laptop, so the local daemon has no way to spawn against them
 * even if we pushed the ID.
 *
 * Ordering is stable (input order preserved) so a subsequent
 * `fingerprintPayload()` call produces the same hash for the same
 * underlying catalog — the cheap skip-push-if-unchanged path in
 * `boot.ts` depends on this determinism.
 */
export function buildPutProjectsPayload(
  projects: readonly Project[],
  localMount: string,
  stationRoot: string = STATION_MANAGED_ROOT,
): PutProjectsEntry[] {
  const out: PutProjectsEntry[] = [];
  for (const p of projects) {
    if (!p.id) continue;
    const cwd = translateStationCwd(p.cwd, localMount, stationRoot);
    if (cwd === null) continue;
    out.push({ id: p.id, cwd });
  }
  return out;
}

/**
 * Cheap content fingerprint of a PUT /projects payload. Callers cache
 * the last-pushed fingerprint and skip the next PUT when the current
 * payload hashes to the same value — avoids a noisy round-trip on
 * every 2 s station poll when nothing actually changed. Collision risk
 * is zero in practice: the input is a small structured array with
 * ASCII-safe fields.
 */
export function fingerprintPayload(entries: readonly PutProjectsEntry[]): string {
  // JSON.stringify of a sorted-by-id clone — sorting makes the
  // fingerprint robust against the caller re-ordering the input for
  // unrelated reasons (e.g. user-facing project order changes that
  // don't affect the local daemon's map).
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(sorted);
}

// --- Orchestrator (shared with boot.ts) ---------------------------------

/**
 * Minimal HTTP surface the orchestrator needs. Matches
 * `ApiClient.putProjects` so callers can pass an `ApiClient` directly;
 * tests substitute a mock without standing up a full client.
 */
export interface PutProjectsClient {
  putProjects: (entries: PutProjectsEntry[]) => Promise<{ ok: boolean; count: number }>;
}

/**
 * Classify an error thrown out of `putProjects` into the one-line
 * human-readable message the status bar renders. Kept small and
 * separate from `pushStationProjectsToLocal` so renderer-side callers
 * can share the phrasing with other failure surfaces later (Phase 11
 * will broaden the status bar to display both hosts; the language
 * stays consistent if it lives here).
 */
export function describePushError(e: unknown, httpStatus?: (e: unknown) => number | null): string {
  const status = httpStatus ? httpStatus(e) : defaultHttpStatus(e);
  if (status === 401) return "Local daemon unreachable — auth rejected";
  if (status === 409) return "Local daemon running in station mode — expected --mode=local";
  if (status === 400 && e instanceof Error) return `Local daemon rejected push: ${(e as { body?: string }).body ?? e.message}`;
  if (status !== null) return `Local daemon unreachable — HTTP ${status}`;
  if (e instanceof TypeError) return "Local daemon unreachable — local panes disabled";
  if (e instanceof Error && e.message) return e.message;
  return "Local daemon unreachable";
}

function defaultHttpStatus(e: unknown): number | null {
  // Duck-type the HttpError shape so this module doesn't depend on the
  // client-core client. boot.ts wraps with a typed helper.
  if (typeof e === "object" && e !== null && "status" in e && typeof (e as { status: unknown }).status === "number") {
    return (e as { status: number }).status;
  }
  return null;
}

/**
 * Snapshot of the orchestrator's mutable state. Exposed so callers can
 * construct the holder once (e.g. as module-local `let`s in boot.ts)
 * and pass it into every trigger. Keeping state external makes the
 * function itself pure-ish and testable.
 */
export interface PushState {
  lastPushedFingerprint: string | null;
  inFlight: boolean;
  queued: boolean;
  lastError: string | null;
}

export function makePushState(): PushState {
  return {
    lastPushedFingerprint: null,
    inFlight: false,
    queued: false,
    lastError: null,
  };
}

export interface PushOptions {
  state: PushState;
  client: PutProjectsClient;
  /** Current station catalog — caller provides whatever it has in memory. */
  projects: readonly Project[];
  /** Absolute local sshfs mount root (from `window.reckAPI.paths.localMountPoint`). */
  localMount: string;
  /** Override the station managed root; defaults to `STATION_MANAGED_ROOT`. */
  stationRoot?: string;
  /**
   * Called with `true` after a successful push-ack, `false` after a
   * failure. Boot wires this to `setHostReady("local", ...)`; tests
   * record the sequence to verify the gate transitions.
   */
  onReadyChange: (ready: boolean) => void;
  /**
   * Called on every status change with the current one-line message
   * (or `null` to clear the surface). Boot re-renders the status bar
   * from this callback.
   */
  onStatusChange: (error: string | null) => void;
}

/**
 * One orchestrator call. Idempotent: returns early on a no-op
 * fingerprint, coalesces a concurrent call into a queued retry, and
 * resets the fingerprint on failure so the next trigger retries.
 *
 * Single-flight semantics are implemented on the caller's `state`
 * object — a second call during an in-flight PUT sets `state.queued`
 * and returns; the finally block re-dispatches once on a microtask.
 * This is what the plan's "Pane-create clicked during push in-flight
 * → waits, doesn't 404" test leans on: the gate (set via
 * `onReadyChange`) never falsely reads true while a PUT is still in
 * flight, so a Phase 10 picker that blocks on `ready` can't race.
 *
 * The re-dispatch runs with the *same* inputs (projects/localMount
 * from the closure in boot). That's deliberate — a queued retry
 * represents "something arrived during the PUT, re-evaluate"; the
 * caller is expected to recompute `projects` before invoking this
 * function again, so the coalesced retry just re-runs the caller's
 * trigger.
 */
export async function pushStationProjectsToLocal(
  opts: PushOptions,
  reinvoke?: () => void,
): Promise<void> {
  const { state, client, projects, localMount, stationRoot, onReadyChange, onStatusChange } = opts;
  if (!localMount) return;

  if (state.inFlight) {
    state.queued = true;
    return;
  }

  const payload = buildPutProjectsPayload(projects, localMount, stationRoot);
  const fp = fingerprintPayload(payload);
  // First push after a disconnect (`lastPushedFingerprint === null`)
  // always runs — the daemon lost its in-memory map and we need to
  // re-prime even if the logical catalog is unchanged.
  if (state.lastPushedFingerprint !== null && fp === state.lastPushedFingerprint) {
    return;
  }

  state.inFlight = true;
  try {
    const resp = await client.putProjects(payload);
    if (!resp.ok || resp.count !== payload.length) {
      throw new Error(
        `local daemon reported count mismatch: expected ${payload.length}, got ${resp.count}`,
      );
    }
    state.lastPushedFingerprint = fp;
    if (state.lastError !== null) {
      state.lastError = null;
      onStatusChange(null);
    }
    onReadyChange(true);
  } catch (e) {
    const msg = describePushError(e);
    state.lastError = msg;
    state.lastPushedFingerprint = null;
    onReadyChange(false);
    onStatusChange(msg);
  } finally {
    state.inFlight = false;
    if (state.queued) {
      state.queued = false;
      // Re-dispatch on a microtask so the cleared `inFlight` flag
      // propagates before the caller's trigger fires again.
      if (reinvoke) void Promise.resolve().then(reinvoke);
    }
  }
}
