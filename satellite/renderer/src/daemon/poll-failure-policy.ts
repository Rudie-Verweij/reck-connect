import { HttpError } from "@client-core/api/client";
import type { HostRef } from "../host";

/**
 * What a background poll failure should trigger. Kept separate from the
 * boot wiring so the (subtle) host-vs-primary routing is unit-testable —
 * boot.ts has no unit harness.
 */
export type PollFailureAction =
  | "refresh-local-token"
  | "prompt-station-token"
  | "ignore";

/**
 * Decide how to react to a failed background poll on `host`, given which
 * host is currently `primaryHost`.
 *
 * Only a 401 is actionable. The important rule — and the reason this is a
 * pure, tested function — is that a **local** 401 always self-heals,
 * regardless of which host is primary: the local daemon's per-spawn
 * bearer rotates on every (re)start, so when the station is primary the
 * local host is a background connection whose token still needs
 * refreshing. Gating that behind `host === primaryHost` is what makes
 * local 401-loop and grey out until the app is restarted.
 *
 * A **station** 401 is only actionable when the station is the host we're
 * actively driving; a background station 401 (local primary) has no
 * visible surface to prompt against, so it's ignored.
 */
export function decidePollFailureAction(
  host: HostRef,
  primaryHost: HostRef,
  error: unknown,
): PollFailureAction {
  if (!(error instanceof HttpError) || error.status !== 401) return "ignore";
  if (host === "local") return "refresh-local-token";
  if (host === primaryHost) return "prompt-station-token";
  return "ignore";
}
