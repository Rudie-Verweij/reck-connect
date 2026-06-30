import { describe, it, expect, vi } from "vitest";
import { ProjectRefresher } from "./project-refresh";

/**
 * A manually-resolvable promise, so a test can hold a refresh "in flight"
 * and assert single-flight coalescing deterministically.
 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ProjectRefresher", () => {
  it("on success: clears the error and delivers the projects to onResult", async () => {
    const onError = vi.fn();
    const onResult = vi.fn();
    const r = new ProjectRefresher<string>({
      refresh: async () => ["a", "b"],
      onResult,
      onError,
    });

    await r.run();

    expect(onError).toHaveBeenCalledWith(null);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(["a", "b"], {
      firstSuccess: true,
      firstNonEmpty: true,
    });
  });

  it("on failure: reports the error, never calls onResult, and never throws", async () => {
    const onError = vi.fn();
    const onResult = vi.fn();
    const r = new ProjectRefresher<string>({
      refresh: async () => {
        throw new Error("boom");
      },
      onResult,
      onError,
      describeError: (e) => (e as Error).message,
    });

    // run() must not reject even though the refresh threw.
    await expect(r.run()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("boom");
    expect(onResult).not.toHaveBeenCalled();
  });

  it("success after a failure clears the previously-set error", async () => {
    const onError = vi.fn();
    let mode: "fail" | "ok" = "fail";
    const r = new ProjectRefresher<string>({
      refresh: async () => {
        if (mode === "fail") throw new Error("down");
        return ["x"];
      },
      onError,
      describeError: (e) => (e as Error).message,
    });

    await r.run();
    expect(onError).toHaveBeenLastCalledWith("down");

    mode = "ok";
    await r.run();
    expect(onError).toHaveBeenLastCalledWith(null);
  });

  it("single-flight: concurrent run() calls coalesce into exactly one extra refresh", async () => {
    let calls = 0;
    const gates: Array<ReturnType<typeof deferred<string[]>>> = [];
    const r = new ProjectRefresher<string>({
      refresh: () => {
        calls += 1;
        const d = deferred<string[]>();
        gates.push(d);
        return d.promise;
      },
    });

    // First run starts an in-flight refresh; two more while it's pending
    // must collapse to a single queued re-run.
    const p = r.run();
    r.run();
    r.run();
    expect(calls).toBe(1); // only the first has started

    gates[0].resolve(["a"]); // finish the first → the coalesced re-run fires
    await new Promise((r) => setTimeout(r, 0)); // flush the continuation chain
    expect(calls).toBe(2); // exactly one extra, not three

    gates[1].resolve(["a"]);
    await p;
    expect(calls).toBe(2);
  });

  it("firstNonEmpty fires once, on the first non-empty result", async () => {
    const infos: Array<{ firstSuccess: boolean; firstNonEmpty: boolean }> = [];
    let result: string[] = [];
    const r = new ProjectRefresher<string>({
      refresh: async () => result,
      onResult: (_p, info) => {
        infos.push(info);
      },
    });

    result = [];
    await r.run(); // success but empty
    result = ["p1"];
    await r.run(); // first non-empty
    result = ["p1", "p2"];
    await r.run(); // subsequent

    expect(infos).toEqual([
      { firstSuccess: true, firstNonEmpty: false },
      { firstSuccess: false, firstNonEmpty: true },
      { firstSuccess: false, firstNonEmpty: false },
    ]);
  });
});
