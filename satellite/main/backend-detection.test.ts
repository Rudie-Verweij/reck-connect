// Round 8.6 Phase 3a — backend-detection cache.
//
// Probes whether `rg` (ripgrep) is available locally and on the Pi.
// Results are memoized per-process; probes are injectable so tests
// don't spawn real subprocesses.
//
// Phase 3e (follow-up) — `hasLocalRg` now resolves to the ABSOLUTE
// PATH of `rg` (or null on miss). Returning the path lets callers
// spawn the binary directly even when Electron's PATH (inherited
// from launchd, not the user shell) doesn't include /opt/homebrew/bin.

import { describe, it, expect, vi } from "vitest";
import { createBackendDetection } from "./backend-detection";

describe("createBackendDetection", () => {
  it("hasLocalRg memoizes the probe (one call across many invocations)", async () => {
    const probe = vi.fn().mockResolvedValue("/opt/homebrew/bin/rg");
    const det = createBackendDetection({
      executableProbe: probe,
      sshProbe: async () => false,
    });
    const [a, b, c] = await Promise.all([
      det.hasLocalRg(),
      det.hasLocalRg(),
      det.hasLocalRg(),
    ]);
    expect(a).toBe("/opt/homebrew/bin/rg");
    expect(b).toBe("/opt/homebrew/bin/rg");
    expect(c).toBe("/opt/homebrew/bin/rg");
    // One in-flight probe should serve all callers.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith("rg");
  });

  it("hasLocalRg returns null when the probe resolves null", async () => {
    const det = createBackendDetection({
      executableProbe: async () => null,
      sshProbe: async () => false,
    });
    expect(await det.hasLocalRg()).toBeNull();
  });

  it("hasLocalRg returns null when the probe throws", async () => {
    const det = createBackendDetection({
      executableProbe: async () => {
        throw new Error("which: command not found");
      },
      sshProbe: async () => false,
    });
    expect(await det.hasLocalRg()).toBeNull();
  });

  it("hasSshRg memoizes the SSH probe", async () => {
    const sshProbe = vi.fn().mockResolvedValue(true);
    const det = createBackendDetection({
      executableProbe: async () => true,
      sshProbe,
    });
    await det.hasSshRg();
    await det.hasSshRg();
    await det.hasSshRg();
    expect(sshProbe).toHaveBeenCalledTimes(1);
  });

  it("hasSshRg returns false when SSH probe throws (network down)", async () => {
    const det = createBackendDetection({
      executableProbe: async () => true,
      sshProbe: async () => {
        throw new Error("ssh: connect to host reck-station port 22: Operation timed out");
      },
    });
    expect(await det.hasSshRg()).toBe(false);
  });

  it("independent caches — local + ssh probes don't interfere", async () => {
    const local = vi.fn().mockResolvedValue("/usr/local/bin/rg");
    const ssh = vi.fn().mockResolvedValue(false);
    const det = createBackendDetection({
      executableProbe: local,
      sshProbe: ssh,
    });
    expect(await det.hasLocalRg()).toBe("/usr/local/bin/rg");
    expect(await det.hasSshRg()).toBe(false);
    expect(local).toHaveBeenCalledTimes(1);
    expect(ssh).toHaveBeenCalledTimes(1);
  });
});

// Phase 3e (follow-up) — defaultLocalExecutableProbe must find rg even
// when Electron's launchd-inherited PATH excludes Homebrew. The probe
// tries `which` first (works in dev / login-shell PATH) then checks
// a list of well-known absolute paths (works in production .app).
describe("defaultLocalExecutableProbe", () => {
  it("returns the absolute path when `which` succeeds", async () => {
    const { _probeForTesting } = await import("./backend-detection");
    const result = await _probeForTesting({
      cmd: "rg",
      whichSpawn: () => ({ exitCode: 0, stdout: "/opt/homebrew/bin/rg\n" }),
      pathExists: () => true,
    });
    expect(result).toBe("/opt/homebrew/bin/rg");
  });

  it("falls back to well-known paths when `which` fails", async () => {
    const { _probeForTesting } = await import("./backend-detection");
    const result = await _probeForTesting({
      cmd: "rg",
      whichSpawn: () => ({ exitCode: 1, stdout: "" }),
      pathExists: (p) => p === "/opt/homebrew/bin/rg",
    });
    expect(result).toBe("/opt/homebrew/bin/rg");
  });

  it("returns null when `which` fails AND no well-known path exists", async () => {
    const { _probeForTesting } = await import("./backend-detection");
    const result = await _probeForTesting({
      cmd: "rg",
      whichSpawn: () => ({ exitCode: 1, stdout: "" }),
      pathExists: () => false,
    });
    expect(result).toBeNull();
  });

  it("returns null when `which` spawn itself throws", async () => {
    const { _probeForTesting } = await import("./backend-detection");
    const result = await _probeForTesting({
      cmd: "rg",
      whichSpawn: () => {
        throw new Error("ENOENT: which");
      },
      pathExists: () => false,
    });
    expect(result).toBeNull();
  });

  it("prefers /opt/homebrew/bin (Apple Silicon) over /usr/local/bin (Intel) when both exist", async () => {
    const { _probeForTesting } = await import("./backend-detection");
    const result = await _probeForTesting({
      cmd: "rg",
      whichSpawn: () => ({ exitCode: 1, stdout: "" }),
      pathExists: () => true, // every candidate exists
    });
    expect(result).toBe("/opt/homebrew/bin/rg");
  });
});
