import { describe, it, expect } from "vitest";
import { parseTailscaleStatus, stationHostFromUrl } from "./tailscale-status";

// Synthetic fixtures — NOT real machines. These are hand-built inputs to
// the pure parser; the test never runs the `tailscale` CLI or touches the
// network, so it's deterministic on any laptop / CI. IPs use the tailnet
// CGNAT range (100.64.0.0/10) with generic low octets; names are generic.
const SELF_IP = "100.64.0.1";
const PEER_IP = "100.64.0.2";
const STATION_IP = "100.64.0.3";
const STATION_NAME = "station-host";

// Trimmed shape of `tailscale status --json`: Self carries this node's
// Online flag; each Peer has Online + LastSeen + TailscaleIPs. Online
// peers report LastSeen as the zero time.
function sample(over?: {
  selfOnline?: boolean;
  backendState?: string;
  stationOnline?: boolean;
}) {
  return {
    BackendState: over?.backendState ?? "Running",
    Self: { Online: over?.selfOnline ?? true, TailscaleIPs: [SELF_IP] },
    Peer: {
      keyA: {
        HostName: "peer-a",
        Online: true,
        LastSeen: "0001-01-01T00:00:00Z",
        TailscaleIPs: [PEER_IP],
      },
      keyB: {
        HostName: STATION_NAME,
        Online: over?.stationOnline ?? false,
        LastSeen: "2026-06-29T07:11:46Z",
        TailscaleIPs: [STATION_IP],
      },
    },
  };
}

describe("stationHostFromUrl", () => {
  it("extracts the hostname from a station URL", () => {
    expect(stationHostFromUrl(`http://${STATION_IP}:7315`)).toBe(STATION_IP);
  });
  it("returns null for an unparseable URL", () => {
    expect(stationHostFromUrl("not a url")).toBeNull();
    expect(stationHostFromUrl(null)).toBeNull();
  });
});

describe("parseTailscaleStatus", () => {
  it("reports the station peer offline while this Mac is online", () => {
    const v = parseTailscaleStatus(sample({ stationOnline: false }), STATION_IP);
    expect(v.ok).toBe(true);
    expect(v.selfOnline).toBe(true);
    expect(v.stationOnline).toBe(false);
    expect(v.stationLastSeen).toBe("2026-06-29T07:11:46Z");
    expect(v.backendState).toBe("Running");
  });

  it("reports this Mac off the tailnet (backend stopped)", () => {
    const v = parseTailscaleStatus(
      sample({ selfOnline: false, backendState: "Stopped" }),
      STATION_IP,
    );
    expect(v.ok).toBe(true);
    expect(v.selfOnline).toBe(false);
    expect(v.backendState).toBe("Stopped");
  });

  it("matches the station peer by IP among several peers", () => {
    const v = parseTailscaleStatus(sample({ stationOnline: true }), STATION_IP);
    expect(v.stationOnline).toBe(true);
  });

  it("returns null station fields when no peer matches the station host", () => {
    const v = parseTailscaleStatus(sample(), "100.64.0.255");
    expect(v.ok).toBe(true);
    expect(v.stationOnline).toBeNull();
    expect(v.stationLastSeen).toBeNull();
  });

  it("also matches the station peer by HostName when the host isn't an IP", () => {
    const v = parseTailscaleStatus(sample({ stationOnline: false }), STATION_NAME);
    expect(v.stationOnline).toBe(false);
  });

  it("degrades to ok:false for malformed input", () => {
    for (const bad of [null, undefined, "string", 42, []]) {
      const v = parseTailscaleStatus(bad, STATION_IP);
      expect(v.ok).toBe(false);
      expect(v.selfOnline).toBeNull();
      expect(v.stationOnline).toBeNull();
    }
  });
});
