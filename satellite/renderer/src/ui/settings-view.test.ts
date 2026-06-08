// Unit tests for the an earlier release host:port collision validator. The
// renderer's Settings save path uses this to refuse a station URL that
// resolves to the same loopback host:port the local daemon binds — both
// would race for the socket and one fails silently.

import { describe, expect, it } from "vitest";
import { sameHostPortAsLocal } from "./settings-view";

describe("sameHostPortAsLocal", () => {
  it("flags 127.0.0.1:7315 vs local 7315", () => {
    expect(sameHostPortAsLocal("http://127.0.0.1:7315", 7315)).toBe(
      "127.0.0.1:7315",
    );
  });

  it("flags localhost:7315 vs local 7315", () => {
    expect(sameHostPortAsLocal("http://localhost:7315", 7315)).toBe(
      "localhost:7315",
    );
  });

  it("flags ::1 (IPv6 loopback) vs local 7315", () => {
    expect(sameHostPortAsLocal("http://[::1]:7315", 7315)).toBe("::1:7315");
  });

  it("does not flag a tailnet IP on the same port", () => {
    expect(sameHostPortAsLocal("http://100.64.0.5:7315", 7315)).toBeNull();
  });

  it("does not flag loopback on a different port", () => {
    expect(sameHostPortAsLocal("http://127.0.0.1:7316", 7315)).toBeNull();
  });

  it("does not flag a tailnet hostname on the same port", () => {
    expect(
      sameHostPortAsLocal("http://your-station.tail-scale.ts.net:7315", 7315),
    ).toBeNull();
  });

  it("returns null for a malformed URL (deferred to probe-time)", () => {
    expect(sameHostPortAsLocal("not a url at all", 7315)).toBeNull();
  });

  it("infers default port 80 for bare http://localhost vs local 80", () => {
    expect(sameHostPortAsLocal("http://localhost", 80)).toBe("localhost:80");
  });

  it("infers default port 443 for https://127.0.0.1 vs local 443", () => {
    expect(sameHostPortAsLocal("https://127.0.0.1", 443)).toBe(
      "127.0.0.1:443",
    );
  });

  it("returns null for an unsupported scheme even on loopback", () => {
    expect(sameHostPortAsLocal("ws://127.0.0.1", 7315)).toBeNull();
  });
});
