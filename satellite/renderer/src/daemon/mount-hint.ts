import type { ConnState } from "./connection";
import type { HostRef } from "../host";

export type MountState = "green" | "yellow" | "gray";

/**
 * CONN `lastError` values (from `describeError` in ./connection.ts) that
 * signal the tailnet — and therefore the sshfs mount — is actually
 * unreachable. Kept tight on purpose: a 401 or an app-level
 * onPollSuccess failure ("projects fetch failed") leaves CONN in
 * `reconnecting`, but the tailnet itself is fine and the mount is not
 * implicated.
 */
const TAILNET_DOWN_REASONS: ReadonlySet<string> = new Set([
  "Network unreachable",
  "Timed out",
]);

/**
 * Tiny CONN-driven state for an earlier release soft signal. In station mode the
 * sshfs mount rides the tailnet, so a tailnet-level CONN failure is
 * definitional evidence that the mount is unreliable even if main's
 * last `stat()` returned green from a kernel attr cache.
 *
 * Design: the hint is purely CONN-driven. It arms when CONN transitions
 * to (or stays in) `reconnecting` with a tailnet-down reason, and
 * disarms when CONN reaches `connected` (or the reason changes to
 * something non-tailnet — 401, refresh in flight, app-level). During
 * an ongoing outage the hint stays armed across repeated CONN failure
 * polls, so a cached-green sshfs stat response from main can't disarm
 * it. When the tailnet recovers, the next successful CONN probe
 * disarms the hint within one poll interval (≤ 2 s) and the
 * authoritative mount state takes over the display.
 *
 *  - Only downgrades `green` to `yellow`. Never touches `yellow` (already
 *    a failure signal) or `gray` (never-seen baseline).
 *  - Local mode never arms. CONN there is loopback; no tailnet.
 *  - Boot-time `connecting` is neutral — neither arms nor disarms.
 *
 * Known edge case: if `reck-stationd` crashes on the station but
 * sshd/tailnet are fine, the `/health` fetch fails with TypeError
 * ("Network unreachable" in our classification) even though the
 * sshfs mount is actually healthy. In that scenario the hint will
 * incorrectly force yellow until the daemon comes back. The trade-off
 * is accepted because (a) reck-stationd is launchd-supervised and
 * rarely crashes, (b) the user is already seeing a mustard CONN dot
 * in that case — "something is wrong with the station" is still the
 * right mental model, and (c) once the daemon recovers and CONN goes
 * green, the mount dot also flips back to its authoritative state.
 */
export class MountHint {
  private armed = false;

  constructor(private readonly primaryHost: HostRef) {}

  /**
   * Feed in the current CONN state. Returns whether armed-ness changed
   * (so the caller can skip a re-render when nothing moved).
   *
   * Sticky-while-reconnecting: once armed on a tailnet-down CONN
   * failure, the hint stays armed through subsequent updates as long
   * as CONN remains `reconnecting` for a tailnet-down reason. A
   * mountState change in the middle of an outage (e.g. cached-green
   * → yellow → cached-green) cannot flip the hint off and back on —
   * the outage is continuous, so the hint is continuous.
   */
  onConn(connState: ConnState, connLastError: string | null, mountState: MountState): boolean {
    if (this.primaryHost !== "station") return false;
    if (connState === "connected") return this.setArmed(false);
    if (connState === "reconnecting") {
      const tailnetDown =
        connLastError !== null && TAILNET_DOWN_REASONS.has(connLastError);
      if (tailnetDown) {
        // Already armed? Stay armed regardless of current mountState.
        // Only a CONN recovery or a reclassified reason can disarm.
        if (this.armed) return false;
        // Arming for the first time: require mountState === "green" so
        // we only insert the hint when there's actually a stale-green
        // to downgrade. If main is already yellow or gray, authoritative
        // truth is already correct and the hint adds nothing.
        if (mountState === "green") return this.setArmed(true);
        return false;
      }
      // Non-tailnet reconnect reason (401, null = refresh in-flight,
      // app-level onPollSuccess error) is not evidence the mount is
      // down. Disarm if we were armed from an earlier tailnet blip.
      return this.setArmed(false);
    }
    // `connecting` on first boot: neither arms nor disarms.
    return false;
  }

  /**
   * Decorate the mount state for rendering. Only downgrades `green` to
   * `yellow`; yellow and gray pass through unchanged so authoritative
   * failure signals are never masked and the never-seen baseline stays
   * baseline.
   */
  apply(mountState: MountState): MountState {
    if (!this.armed) return mountState;
    if (mountState !== "green") return mountState;
    return "yellow";
  }

  isArmed(): boolean {
    return this.armed;
  }

  private setArmed(next: boolean): boolean {
    if (this.armed === next) return false;
    this.armed = next;
    return true;
  }
}
