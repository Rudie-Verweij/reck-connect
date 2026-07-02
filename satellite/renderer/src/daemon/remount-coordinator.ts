import type { ConnState } from "./connection";
import type { HostRef } from "../host";

export interface RemountCoordinatorOptions {
  /** Only `"station"` arms — local is a loopback daemon with no sshfs mount. */
  primaryHost: HostRef;
  /** Injected remount trigger (boot passes a wrapper over `mount.forceRemount`). */
  forceRemount: () => Promise<unknown>;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Suppress repeat remounts within this window (default 30 s). */
  cooldownMs?: number;
}

/**
 * Auto-remounts the sshfs project mount when the station connection
 * recovers from a drop.
 *
 * The mount and the HTTP connection both ride the same Tailscale link but
 * recover on independent timers: HTTP re-polls every ~2 s, while the
 * fuse-t watchdog (`eu.verwey.reck-mount`) only ticks every 60 s. So after
 * a Tailscale flap the rail can come back green while project files stay
 * stale for up to a minute. Feeding CONN transitions here kicks an
 * immediate `mount.forceRemount()` on the recovery edge so the mount
 * catches up with HTTP instead of lagging the watchdog.
 *
 * Fires only on a genuine recovery — a transition INTO `connected` from a
 * non-connected state where a drop (`reconnecting`) was actually seen.
 * First-boot `connecting → connected` does not fire (nothing to remount).
 * Debounced by `cooldownMs` and an in-flight guard so a flapping link
 * can't spam kickstarts, and `noteRemount()` lets the manual ⟳
 * (`forceRefresh`) share the same cooldown so the two paths never
 * double-kick.
 */
export class RemountCoordinator {
  private prev: ConnState | null = null;
  private sawDrop = false;
  private inFlight = false;
  private lastRemountAt: number | null = null;
  private readonly now: () => number;
  private readonly cooldownMs: number;

  constructor(private readonly opts: RemountCoordinatorOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.cooldownMs = opts.cooldownMs ?? 30_000;
  }

  /** Feed each CONN state update (from `onConnectionInfo`). */
  onConn(state: ConnState): void {
    if (this.opts.primaryHost !== "station") {
      this.prev = state;
      return;
    }
    const prev = this.prev;
    this.prev = state;
    if (state === "reconnecting") {
      this.sawDrop = true;
      return;
    }
    if (state === "connected") {
      const recovered = prev !== "connected" && this.sawDrop;
      this.sawDrop = false;
      if (recovered) this.maybeFire();
    }
  }

  /**
   * Record that a remount just happened by another path (the manual ⟳),
   * so an auto-recovery in the same window won't fire a second kickstart.
   */
  noteRemount(): void {
    this.lastRemountAt = this.now();
  }

  private maybeFire(): void {
    if (this.inFlight) return;
    if (this.lastRemountAt !== null && this.now() - this.lastRemountAt < this.cooldownMs) {
      return;
    }
    this.lastRemountAt = this.now();
    this.inFlight = true;
    Promise.resolve(this.opts.forceRemount())
      .catch((e) => console.warn("[remount-coordinator] forceRemount failed", e))
      .finally(() => {
        this.inFlight = false;
      });
  }
}
