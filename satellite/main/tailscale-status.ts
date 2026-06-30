/**
 * Tailscale-layer diagnosis — a pure mapping from `tailscale status --json`
 * to a small verdict, so the connection banner can tell the user *what to
 * fix*: their own Mac being off the tailnet ("reconnect Tailscale here")
 * vs the station peer being offline ("bring the station back online").
 * Side-effect-free and unit-tested; binary discovery and the `execFile`
 * live in `main.ts`.
 *
 * Hand-rolled defensive narrowing (no zod) to match the existing
 * `ipc-validation.ts` convention — the parsed JSON is untrusted CLI
 * output and every field is treated as optional/unknown.
 */
export interface TailscaleVerdict {
  /** True iff `tailscale status --json` parsed into a usable object. */
  ok: boolean;
  /** Is THIS Mac on the tailnet (Self.Online)? null if unknown. */
  selfOnline: boolean | null;
  /** Is the station peer online? null if the peer wasn't found. */
  stationOnline: boolean | null;
  /** The station peer's LastSeen timestamp, if found. */
  stationLastSeen: string | null;
  /** Tailscale BackendState ("Running" | "Stopped" | "NeedsLogin" | …). */
  backendState: string | null;
}

const UNKNOWN: TailscaleVerdict = {
  ok: false,
  selfOnline: null,
  stationOnline: null,
  stationLastSeen: null,
  backendState: null,
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Extract the bare hostname/IP from a station URL, or null if unparseable. */
export function stationHostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Map parsed `tailscale status --json` + the station's host (IP or
 * MagicDNS name, from the bootstrap stationUrl) to a {@link TailscaleVerdict}.
 * The station peer is matched by Tailscale IP first, then HostName.
 */
export function parseTailscaleStatus(
  json: unknown,
  stationHost: string | null,
): TailscaleVerdict {
  const root = asRecord(json);
  if (!root) return { ...UNKNOWN };

  const self = asRecord(root.Self);
  const selfOnline = self ? asBool(self.Online) : null;
  const backendState = asStr(root.BackendState);

  let stationOnline: boolean | null = null;
  let stationLastSeen: string | null = null;
  const peers = asRecord(root.Peer);
  if (stationHost && peers) {
    for (const value of Object.values(peers)) {
      const peer = asRecord(value);
      if (!peer) continue;
      const ipMatch = asStrArray(peer.TailscaleIPs).includes(stationHost);
      const nameMatch = asStr(peer.HostName) === stationHost;
      if (ipMatch || nameMatch) {
        stationOnline = asBool(peer.Online);
        stationLastSeen = asStr(peer.LastSeen);
        break;
      }
    }
  }

  return { ok: true, selfOnline, stationOnline, stationLastSeen, backendState };
}
