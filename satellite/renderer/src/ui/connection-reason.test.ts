import { describe, it, expect } from "vitest";
import { deriveConnectionReason, type TailscaleVerdict } from "./connection-reason";

const ts = (over: Partial<TailscaleVerdict>): TailscaleVerdict => ({
  ok: true,
  selfOnline: true,
  stationOnline: true,
  stationLastSeen: null,
  backendState: "Running",
  ...over,
});

describe("deriveConnectionReason", () => {
  it("returns null when there's no error", () => {
    expect(deriveConnectionReason(null, null)).toBeNull();
  });

  it("explains a rejected token", () => {
    expect(deriveConnectionReason("Unauthorized", null)).toMatch(/token/i);
  });

  it("passes through the raw reason when Tailscale can't help", () => {
    expect(deriveConnectionReason("Network unreachable", null)).toBe("Network unreachable");
    expect(deriveConnectionReason("Timed out", null)).toBe("Timed out");
  });

  it("blames this Mac when Tailscale says self is offline", () => {
    expect(deriveConnectionReason("Network unreachable", ts({ selfOnline: false }))).toMatch(
      /this mac is off tailscale/i,
    );
  });

  it("blames the station when Tailscale says the station peer is offline", () => {
    expect(
      deriveConnectionReason("Timed out", ts({ selfOnline: true, stationOnline: false })),
    ).toMatch(/station.*offline/i);
  });

  it("falls back to the raw reason when both ends are online (e.g. daemon crash)", () => {
    expect(
      deriveConnectionReason("Network unreachable", ts({ selfOnline: true, stationOnline: true })),
    ).toBe("Network unreachable");
  });

  it("prefers the token message over any Tailscale enrichment", () => {
    expect(deriveConnectionReason("Unauthorized", ts({ selfOnline: false }))).toMatch(/token/i);
  });
});
