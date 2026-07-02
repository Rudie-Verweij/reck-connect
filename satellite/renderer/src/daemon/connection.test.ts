import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApiClient, HttpError } from "@client-core/api/client";
import { DaemonConnection, describeError } from "./connection";

function mockHealthOk(uptime = 42) {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({ status: "ok", version: "1", uptime_sec: uptime }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

function mockFetchRejects(err: Error | string = "ECONNREFUSED") {
  return vi.fn(async () => {
    throw typeof err === "string" ? new TypeError(err) : err;
  }) as unknown as typeof fetch;
}

function captureStates(conn: DaemonConnection) {
  const states: string[] = [];
  conn.subscribe((info) => states.push(`${info.state}${info.lastError ? `:${info.lastError}` : ""}`));
  return states;
}

describe("DaemonConnection", () => {
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = origFetch;
    vi.useRealTimers();
  });

  it("starts in 'connecting' state with no error or uptime", () => {
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const conn = new DaemonConnection({ client });
    const info = conn.getInfo();
    expect(info.state).toBe("connecting");
    expect(info.lastError).toBeNull();
    expect(info.uptimeSec).toBeNull();
  });

  it("fires subscriber immediately with current state", () => {
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const conn = new DaemonConnection({ client });
    const seen: string[] = [];
    conn.subscribe((info) => seen.push(info.state));
    expect(seen).toEqual(["connecting"]);
  });

  it("transitions to 'connected' on a successful probe", async () => {
    global.fetch = mockHealthOk(99);
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const conn = new DaemonConnection({
      client,
      pollIntervalMs: 60_000, // effectively disable auto re-poll
    });
    const states = captureStates(conn);
    await conn.refresh().catch(() => {});
    conn.stop();
    expect(states).toContain("connected");
    expect(conn.getInfo().uptimeSec).toBe(99);
    expect(conn.getInfo().lastError).toBeNull();
  });

  it("surfaces TypeError as 'Network unreachable' and flips to reconnecting", async () => {
    global.fetch = mockFetchRejects(new TypeError("Failed to fetch"));
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const conn = new DaemonConnection({ client, pollIntervalMs: 60_000 });
    const states = captureStates(conn);
    await expect(conn.refresh()).rejects.toThrow();
    conn.stop();
    const last = states[states.length - 1];
    expect(last).toBe("reconnecting:Network unreachable");
  });

  it("surfaces HttpError(401) as 'Unauthorized' and calls onPollFailure", async () => {
    global.fetch = vi.fn(
      async () => new Response("bad token", { status: 401, statusText: "Unauthorized" }),
    ) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const failures: { reason: string; err: unknown }[] = [];
    const conn = new DaemonConnection({
      client,
      pollIntervalMs: 60_000,
      onPollFailure: (reason, err) => failures.push({ reason, err }),
    });
    await expect(conn.refresh()).rejects.toThrow();
    conn.stop();
    expect(conn.getInfo().state).toBe("reconnecting");
    expect(conn.getInfo().lastError).toBe("Unauthorized");
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe("Unauthorized");
    expect(failures[0].err).toBeInstanceOf(HttpError);
  });

  it("externally-superseded probes do NOT emit a stale 'Timed out' state", async () => {
    // Regression for #42 review pass 7: when refresh() aborts an
    // in-flight poll before starting its own probe, the aborted
    // poll's catch block must not overwrite the fresh state with
    // "Timed out" (which would arm the MountHint as if tailnet went
    // down, when in fact the user just clicked Refresh).
    let resolveHang: (r: Response) => void = () => {};
    let firstCalled = false;
    let secondCalled = false;
    global.fetch = vi.fn(async (_u, init) => {
      const signal = (init as RequestInit)?.signal as AbortSignal | undefined;
      if (!firstCalled) {
        firstCalled = true;
        return await new Promise<Response>((resolve, reject) => {
          resolveHang = resolve;
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      secondCalled = true;
      return new Response(
        JSON.stringify({ status: "ok", version: "1", uptime_sec: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const conn = new DaemonConnection({
      client,
      pollIntervalMs: 60_000,
      refreshTimeoutMs: 1000,
    });
    const states: { state: string; err: string | null }[] = [];
    conn.subscribe((info) => states.push({ state: info.state, err: info.lastError }));

    conn.start();
    // Wait for the first probe to be in flight.
    await new Promise((r) => setTimeout(r, 5));
    // User clicks Refresh: aborts the hanging first probe, starts a new one.
    const refreshPromise = conn.refresh();
    // Let the first probe's rejection microtask flush.
    await new Promise((r) => setTimeout(r, 5));
    await refreshPromise;
    conn.stop();
    // Ensure the pending promise doesn't leak.
    resolveHang(new Response("", { status: 200 }));

    expect(firstCalled).toBe(true);
    expect(secondCalled).toBe(true);
    // The second probe succeeded, so final state should be connected
    // with no error. Crucially, we should NEVER have seen a
    // "reconnecting + Timed out" state — only "reconnecting + null"
    // from refresh() and "connected" from the new probe.
    const timedOut = states.find(
      (s) => s.state === "reconnecting" && s.err === "Timed out",
    );
    expect(timedOut).toBeUndefined();
    expect(conn.getInfo().state).toBe("connected");
    expect(conn.getInfo().lastError).toBeNull();
  });

  it("aborts the fetch when refreshTimeoutMs elapses", async () => {
    let aborted = false;
    global.fetch = vi.fn(async (_u, init) => {
      const signal = (init as RequestInit)?.signal as AbortSignal | undefined;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const conn = new DaemonConnection({
      client,
      pollIntervalMs: 60_000,
      refreshTimeoutMs: 30,
    });
    await expect(conn.refresh()).rejects.toThrow();
    conn.stop();
    expect(aborted).toBe(true);
    expect(conn.getInfo().lastError).toBe("Timed out");
  });

  it("onPollSuccess failures demote the state to reconnecting", async () => {
    global.fetch = mockHealthOk();
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const conn = new DaemonConnection({
      client,
      pollIntervalMs: 60_000,
      onPollSuccess: async () => {
        throw new Error("projects fetch failed");
      },
    });
    await expect(conn.refresh()).rejects.toThrow();
    conn.stop();
    expect(conn.getInfo().state).toBe("reconnecting");
    expect(conn.getInfo().lastError).toBe("projects fetch failed");
  });

  it("stop() prevents further polls", async () => {
    vi.useFakeTimers();
    global.fetch = mockHealthOk();
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const calls: number[] = [];
    const conn = new DaemonConnection({
      client,
      pollIntervalMs: 50,
      onPollSuccess: async () => {
        calls.push(Date.now());
      },
    });
    conn.start();
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve(); // flush microtasks
    conn.stop();
    const countAfterStop = calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.length).toBe(countAfterStop);
  });

  it("unsubscribe stops delivering state updates", async () => {
    global.fetch = mockHealthOk();
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const conn = new DaemonConnection({ client, pollIntervalMs: 60_000 });
    let received = 0;
    const off = conn.subscribe(() => received++);
    expect(received).toBe(1); // initial state
    off();
    await conn.refresh().catch(() => {});
    conn.stop();
    expect(received).toBe(1);
  });

  it("refresh() without start() is one-shot and does not schedule a timer", async () => {
    vi.useFakeTimers();
    global.fetch = mockHealthOk();
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const polls: number[] = [];
    const conn = new DaemonConnection({
      client,
      pollIntervalMs: 50,
      onPollSuccess: async () => {
        polls.push(Date.now());
      },
    });
    await conn.refresh();
    expect(polls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(polls.length).toBe(1); // no re-arm because we never called start()
  });
});

describe("describeError", () => {
  it("identifies HTTP 401 as Unauthorized", () => {
    expect(describeError(new HttpError(401, "Unauthorized", ""))).toBe("Unauthorized");
  });
  it("identifies other HTTP errors by status", () => {
    expect(describeError(new HttpError(500, "Server Error", ""))).toBe("HTTP 500");
  });
  it("identifies AbortError as Timed out", () => {
    expect(describeError(new DOMException("aborted", "AbortError"))).toBe("Timed out");
  });
  it("identifies TypeError as Network unreachable", () => {
    expect(describeError(new TypeError("Failed to fetch"))).toBe("Network unreachable");
  });
  it("falls back to the message when present", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });
  it("returns Unknown error for non-Error values", () => {
    expect(describeError({ weird: "object" })).toBe("Unknown error");
  });
});

// The background poll loop can be gated so a host isn't probed until it's
// ready (e.g. local waiting on its per-spawn token). A gated tick must
// still re-arm the loop so the host recovers when the gate opens. A
// user-initiated refresh() is deliberately never gated.
describe("DaemonConnection shouldPoll gate", () => {
  let origFetch: typeof fetch;
  beforeEach(() => {
    origFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = origFetch;
    vi.useRealTimers();
  });

  it("skips the background probe while shouldPoll() is false", async () => {
    vi.useFakeTimers();
    const fetchSpy = mockHealthOk();
    global.fetch = fetchSpy;
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const conn = new DaemonConnection({
      client,
      pollIntervalMs: 2000,
      shouldPoll: () => false,
    });
    conn.start();
    await vi.advanceTimersByTimeAsync(5000); // several would-be ticks
    conn.stop();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(conn.getInfo().state).toBe("connecting");
  });

  it("probes normally when shouldPoll() returns true", async () => {
    vi.useFakeTimers();
    global.fetch = mockHealthOk(7);
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    const conn = new DaemonConnection({
      client,
      pollIntervalMs: 2000,
      shouldPoll: () => true,
    });
    const states = captureStates(conn);
    conn.start();
    await vi.advanceTimersByTimeAsync(0); // fire the initial schedulePoll(0)
    conn.stop();
    expect(states).toContain("connected");
  });

  it("re-arms the loop so the host recovers once the gate opens", async () => {
    vi.useFakeTimers();
    global.fetch = mockHealthOk(3);
    const client = new ApiClient({ baseUrl: "http://x:7315" });
    let ready = false;
    const conn = new DaemonConnection({
      client,
      pollIntervalMs: 2000,
      shouldPoll: () => ready,
    });
    const states = captureStates(conn);
    conn.start();
    await vi.advanceTimersByTimeAsync(2000); // gated tick, no probe
    expect(states).not.toContain("connected");
    ready = true;
    await vi.advanceTimersByTimeAsync(2000); // next tick probes
    conn.stop();
    expect(states).toContain("connected");
  });
});
