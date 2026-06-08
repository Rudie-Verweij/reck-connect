import { describe, it, expect } from "vitest";
import { SelectSequence, fetchSequenced } from "./select-project";
import type { ProjectDetail } from "@proto/proto";

function makeDetail(id: string): ProjectDetail {
  return { id, name: id, cwd: "/tmp/" + id, panes: [] };
}

// Manual deferred promise so tests can control fetch resolution order.
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SelectSequence", () => {
  it("hands out monotonically increasing sequence numbers", () => {
    const s = new SelectSequence();
    expect(s.next()).toBe(1);
    expect(s.next()).toBe(2);
    expect(s.next()).toBe(3);
    expect(s.current()).toBe(3);
  });

  it("aborts the previous signal when next() is called again", () => {
    const s = new SelectSequence();
    s.next();
    const firstSignal = s.signal()!;
    expect(firstSignal.aborted).toBe(false);
    s.next();
    expect(firstSignal.aborted).toBe(true);
  });

  it("provides a signal that can be consumed by fetch-style callers", () => {
    const s = new SelectSequence();
    s.next();
    const sig = s.signal();
    expect(sig).not.toBeNull();
    expect(sig!.aborted).toBe(false);
  });

  it("settle() clears the in-flight controller without aborting", () => {
    const s = new SelectSequence();
    s.next();
    const sig = s.signal();
    s.settle();
    expect(s.signal()).toBeNull();
    // The already-issued signal stays non-aborted — it belongs to the
    // caller who just applied state successfully.
    expect(sig!.aborted).toBe(false);
  });
});

describe("fetchSequenced", () => {
  it("returns the detail when the fetch resolves and sequence is current", async () => {
    const s = new SelectSequence();
    const mySeq = s.next();
    const res = await fetchSequenced(s, mySeq, async (signal) => {
      expect(signal).toBeDefined();
      return makeDetail("A");
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.detail.id).toBe("A");
  });

  it("returns aborted=true when a newer next() supersedes the in-flight fetch", async () => {
    const s = new SelectSequence();
    const aSeq = s.next();
    const aFetch = deferred<ProjectDetail>();

    // Kick off the sequenced fetch for A.
    const pA = fetchSequenced(s, aSeq, () => aFetch.promise);

    // Supersede with a newer selection B.
    s.next();
    // Resolve A late — should be reported as aborted (not used).
    aFetch.resolve(makeDetail("A"));

    const resA = await pA;
    expect(resA.ok).toBe(false);
    if (!resA.ok) expect(resA.aborted).toBe(true);
  });

  it("regression: A-then-B with delayed A response does not paint A into B's slot", async () => {
    // Narrate the an earlier release scenario end-to-end.
    const s = new SelectSequence();

    const aFetch = deferred<ProjectDetail>();
    const bFetch = deferred<ProjectDetail>();
    const applied: string[] = [];

    // Caller A starts.
    const aSeq = s.next();
    const aPromise = (async () => {
      const res = await fetchSequenced(s, aSeq, () => aFetch.promise);
      if (res.ok) applied.push(res.detail.id);
    })();

    // Caller B starts before A's fetch resolves. B's next() aborts A.
    const bSeq = s.next();
    const bPromise = (async () => {
      const res = await fetchSequenced(s, bSeq, () => bFetch.promise);
      if (res.ok) applied.push(res.detail.id);
    })();

    // B resolves first.
    bFetch.resolve(makeDetail("B"));
    await bPromise;
    expect(applied).toEqual(["B"]);

    // A resolves LATE with its stale response.
    aFetch.resolve(makeDetail("A"));
    await aPromise;

    // A must NOT have been applied — abort superseded it.
    expect(applied).toEqual(["B"]);
  });

  it("abort-in-flight: aborted fetcher error is recognised as cancellation", async () => {
    const s = new SelectSequence();
    const aSeq = s.next();
    const aFetch = deferred<ProjectDetail>();

    const p = fetchSequenced(s, aSeq, (signal) => {
      // Real fetchers reject with an abort error when the signal fires.
      return new Promise<ProjectDetail>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        aFetch.promise.then(
          (v) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            _resolve; // keep signature — we reject on abort only
            reject(new Error("should not resolve — signal should abort first"));
            return v;
          },
          reject,
        );
      });
    });

    // Supersede → aborts signal.
    s.next();
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.aborted).toBe(true);
  });

  it("non-abort errors bubble up", async () => {
    const s = new SelectSequence();
    const aSeq = s.next();
    const res = await fetchSequenced(s, aSeq, async () => {
      throw new Error("network fail");
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.aborted).toBe(false);
      if (!res.aborted) expect((res.error as Error).message).toBe("network fail");
    }
  });
});
