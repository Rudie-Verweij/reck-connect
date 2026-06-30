import { describe, it, expect, vi } from "vitest";
import { RemountCoordinator } from "./remount-coordinator";

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("RemountCoordinator", () => {
  it("triggers exactly one remount on reconnecting -> connected", () => {
    const forceRemount = vi.fn(async () => {});
    const c = new RemountCoordinator({ primaryHost: "station", forceRemount });
    c.onConn("connecting");
    c.onConn("reconnecting");
    c.onConn("connected");
    expect(forceRemount).toHaveBeenCalledTimes(1);
  });

  it("does not trigger on first-boot connecting -> connected (no prior drop)", () => {
    const forceRemount = vi.fn(async () => {});
    const c = new RemountCoordinator({ primaryHost: "station", forceRemount });
    c.onConn("connecting");
    c.onConn("connected");
    expect(forceRemount).not.toHaveBeenCalled();
  });

  it("coalesces flapping within the cooldown to a single remount", async () => {
    const clock = makeClock();
    const forceRemount = vi.fn(async () => {});
    const c = new RemountCoordinator({
      primaryHost: "station",
      forceRemount,
      now: clock.now,
      cooldownMs: 30_000,
    });
    c.onConn("connected");
    c.onConn("reconnecting");
    c.onConn("connected"); // trigger 1
    await Promise.resolve(); // let in-flight flag reset
    clock.advance(5_000); // still within cooldown
    c.onConn("reconnecting");
    c.onConn("connected"); // suppressed
    expect(forceRemount).toHaveBeenCalledTimes(1);
  });

  it("triggers again after the cooldown elapses", async () => {
    const clock = makeClock();
    const forceRemount = vi.fn(async () => {});
    const c = new RemountCoordinator({
      primaryHost: "station",
      forceRemount,
      now: clock.now,
      cooldownMs: 30_000,
    });
    c.onConn("connected");
    c.onConn("reconnecting");
    c.onConn("connected"); // trigger 1
    await new Promise((r) => setTimeout(r, 0)); // flush the in-flight reset
    clock.advance(31_000); // past cooldown
    c.onConn("reconnecting");
    c.onConn("connected"); // trigger 2
    expect(forceRemount).toHaveBeenCalledTimes(2);
  });

  it("never triggers when primaryHost is local (loopback, no sshfs)", () => {
    const forceRemount = vi.fn(async () => {});
    const c = new RemountCoordinator({ primaryHost: "local", forceRemount });
    c.onConn("reconnecting");
    c.onConn("connected");
    expect(forceRemount).not.toHaveBeenCalled();
  });

  it("noteRemount() shares the cooldown so an immediate auto-recovery doesn't double-kick", () => {
    const clock = makeClock();
    const forceRemount = vi.fn(async () => {});
    const c = new RemountCoordinator({
      primaryHost: "station",
      forceRemount,
      now: clock.now,
      cooldownMs: 30_000,
    });
    c.noteRemount(); // e.g. the manual ⟳ just kicked a remount
    c.onConn("reconnecting");
    c.onConn("connected"); // would trigger, but it's within the shared cooldown
    expect(forceRemount).not.toHaveBeenCalled();
  });
});
