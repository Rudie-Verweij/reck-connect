import { describe, it, expect, vi } from "vitest";
import { performRemount, type RemountDeps } from "./mount-remount";

/** Base deps with instant sleep and tight budgets so tests run fast. */
function baseDeps(over: Partial<RemountDeps>): RemountDeps {
  return {
    kickstart: vi.fn(async () => {}),
    unmountForce: vi.fn(async () => {}),
    sentinelPresent: () => false,
    sleep: async () => {},
    waitMs: 1000,
    pollMs: 250,
    ...over,
  };
}

describe("performRemount", () => {
  it("succeeds on the first attempt without escalating", async () => {
    let mounted = false;
    const kickstart = vi.fn(async () => {
      mounted = true; // a healthy kick brings the mount up
    });
    const unmountForce = vi.fn(async () => {});
    const deps = baseDeps({ kickstart, unmountForce, sentinelPresent: () => mounted });

    const res = await performRemount(deps);

    expect(res).toEqual({ ok: true, escalated: false });
    expect(kickstart).toHaveBeenCalledTimes(1);
    expect(unmountForce).not.toHaveBeenCalled();
  });

  it("escalates (force-unmount + re-kick) when the first attempt times out, then succeeds", async () => {
    let kicks = 0;
    let mounted = false;
    const kickstart = vi.fn(async () => {
      kicks += 1;
      if (kicks === 2) mounted = true; // only the post-escalation kick works
    });
    const unmountForce = vi.fn(async () => {});
    const deps = baseDeps({ kickstart, unmountForce, sentinelPresent: () => mounted });

    const res = await performRemount(deps);

    expect(res.ok).toBe(true);
    expect(res.escalated).toBe(true);
    expect(kickstart).toHaveBeenCalledTimes(2);
    expect(unmountForce).toHaveBeenCalledTimes(1);
  });

  it("returns ok:false without escalating when the first kickstart fails", async () => {
    const kickstart = vi.fn(async () => {
      throw new Error("agent not loaded");
    });
    const unmountForce = vi.fn(async () => {});
    const deps = baseDeps({ kickstart, unmountForce });

    const res = await performRemount(deps);

    expect(res.ok).toBe(false);
    expect(res.escalated).toBe(false);
    expect(res.error).toMatch(/agent not loaded/);
    expect(unmountForce).not.toHaveBeenCalled();
  });

  it("returns ok:false escalated:true when both attempts time out", async () => {
    const kickstart = vi.fn(async () => {});
    const unmountForce = vi.fn(async () => {});
    const deps = baseDeps({ kickstart, unmountForce, sentinelPresent: () => false });

    const res = await performRemount(deps);

    expect(res.ok).toBe(false);
    expect(res.escalated).toBe(true);
    expect(kickstart).toHaveBeenCalledTimes(2);
    expect(unmountForce).toHaveBeenCalledTimes(1);
    expect(res.error).toMatch(/timed out/i);
  });

  it("a failed force-unmount is non-fatal — it still re-kicks", async () => {
    let kicks = 0;
    let mounted = false;
    const kickstart = vi.fn(async () => {
      kicks += 1;
      if (kicks === 2) mounted = true;
    });
    const unmountForce = vi.fn(async () => {
      throw new Error("diskutil: not mounted");
    });
    const deps = baseDeps({ kickstart, unmountForce, sentinelPresent: () => mounted });

    const res = await performRemount(deps);

    expect(res.ok).toBe(true);
    expect(res.escalated).toBe(true);
    expect(kickstart).toHaveBeenCalledTimes(2);
  });
});
