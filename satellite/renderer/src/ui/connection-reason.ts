/**
 * Mirrors the `tailscale.status()` verdict shape (see reckAPI / main).
 */
export interface TailscaleVerdict {
  ok: boolean;
  selfOnline: boolean | null;
  stationOnline: boolean | null;
  stationLastSeen: string | null;
  backendState: string | null;
}

/**
 * Concise, status-bar-sized reason for why CONN isn't connected. Rendered
 * INLINE in the existing bottom status row next to the CONN label —
 * reusing the established UI instead of a separate banner. Returns null
 * when there's nothing to explain.
 *
 * Enriches the raw probe error (`describeError` values) with the
 * Tailscale verdict so the user knows which end to fix: their Mac vs the
 * station. Kept short on purpose — the status row is a single line.
 */
export function deriveConnectionReason(
  connError: string | null,
  tailscale: TailscaleVerdict | null,
): string | null {
  if (!connError) return null;
  if (connError === "Unauthorized") return "token rejected — paste a fresh one";
  if (tailscale?.ok) {
    if (tailscale.selfOnline === false) return "this Mac is off Tailscale";
    if (tailscale.stationOnline === false) return "station offline on Tailscale";
  }
  // "Network unreachable", "Timed out", "HTTP 5xx", etc. pass through.
  return connError;
}
