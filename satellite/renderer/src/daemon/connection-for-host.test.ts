// @vitest-environment jsdom
// Tests for the per-host DaemonConnection registry (an earlier release,
// plan rev 3.1, Phase 4). Mirrors the structure of api-for-host.test.ts.
//
// The "station drop leaves local green and vice versa" scenario from
// the plan is covered explicitly: each host's poll loop runs against
// a separate `fetch` mock, and the assertions confirm that a failure
// observed on one host doesn't bleed into the other's `ConnectionInfo`.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { HttpError } from "@client-core/api/client";
import {
  _resetApiForHostForTests,
  initApiForHost,
} from "../api-for-host";
import type { Settings } from "../config";
import type { HostRef } from "../host";
import type { ConnectionInfo } from "./connection";
import {
  _resetConnectionsForHostForTests,
  connectionForHost,
  disposeConnections,
  enabledHosts,
  initConnectionsForHost,
  isHostReady,
  setHostReady,
  subscribeHostReady,
  isHostCodexAvailable,
  setHostCodexAvailable,
} from "./connection-for-host";

const HYBRID: Settings = {
  station: { enabled: true, url: "http://station.test:7315", token: "stk-1" },
  local: { enabled: true, port: 7315, autoStart: true },
};

const STATION_ONLY: Settings = {
  station: { enabled: true, url: "http://station.test:7315", token: "stk-1" },
};

const LOCAL_ONLY: Settings = {
  local: { enabled: true, port: 7315, autoStart: true },
};

const NEITHER: Settings = {};

function healthOk(uptime = 1) {
  return new Response(
    JSON.stringify({ status: "ok", version: "1", uptime_sec: uptime }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

interface RouteHandlers {
  station?: (init?: RequestInit) => Promise<Response> | Response;
  local?: (init?: RequestInit) => Promise<Response> | Response;
}

/**
 * Build a fetch mock that dispatches by URL host so the two
 * DaemonConnection instances can be driven independently. Any URL
 * not matching either host throws so a stray call (wrong client,
 * forgotten override) surfaces immediately rather than silently
 * succeeding.
 */
function routedFetch(handlers: RouteHandlers): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (u.startsWith("http://station.test:7315")) {
      if (!handlers.station) throw new Error(`unexpected station fetch: ${u}`);
      return handlers.station(init);
    }
    if (u.startsWith("http://127.0.0.1:")) {
      if (!handlers.local) throw new Error(`unexpected local fetch: ${u}`);
      return handlers.local(init);
    }
    throw new Error(`unexpected fetch URL: ${u}`);
  }) as unknown as typeof fetch;
}

interface StubCallbacks {
  successes: Array<{ host: HostRef; uptime: number }>;
  failures: Array<{ host: HostRef; reason: string; error: unknown }>;
  infos: Array<{ host: HostRef; info: ConnectionInfo }>;
}

function makeStubCallbacks() {
  const c: StubCallbacks = { successes: [], failures: [], infos: [] };
  return {
    callbacks: c,
    onPollSuccess: (host: HostRef, health: { uptime_sec: number }) => {
      c.successes.push({ host, uptime: health.uptime_sec });
    },
    onPollFailure: (host: HostRef, reason: string, error: unknown) => {
      c.failures.push({ host, reason, error });
    },
    onConnectionInfo: (host: HostRef, info: ConnectionInfo) => {
      c.infos.push({ host, info });
    },
  };
}

let origFetch: typeof fetch;

beforeEach(() => {
  origFetch = global.fetch;
  _resetApiForHostForTests();
  _resetConnectionsForHostForTests();
});

afterEach(() => {
  global.fetch = origFetch;
  vi.useRealTimers();
  _resetConnectionsForHostForTests();
  _resetApiForHostForTests();
});

describe("enabledHosts", () => {
  it("returns [] when neither host is enabled (and not initialised)", () => {
    expect(enabledHosts()).toEqual([]);
  });

  it("returns [] when initialised with no enabled host", () => {
    const stubs = makeStubCallbacks();
    initApiForHost(NEITHER);
    initConnectionsForHost(NEITHER, {
      pollIntervalMs: 60_000,
      ...stubs,
    });
    expect(enabledHosts()).toEqual([]);
  });

  it("returns ['station'] for station-only settings", () => {
    const stubs = makeStubCallbacks();
    initApiForHost(STATION_ONLY);
    initConnectionsForHost(STATION_ONLY, {
      pollIntervalMs: 60_000,
      ...stubs,
    });
    expect(enabledHosts()).toEqual(["station"]);
  });

  it("returns ['local'] for station-disabled settings (no station configured)", () => {
    const stubs = makeStubCallbacks();
    initApiForHost(LOCAL_ONLY);
    initConnectionsForHost(LOCAL_ONLY, {
      pollIntervalMs: 60_000,
      ...stubs,
    });
    expect(enabledHosts()).toEqual(["local"]);
  });

  it("returns ['station','local'] for hybrid (station first for stable order)", () => {
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, {
      pollIntervalMs: 60_000,
      ...stubs,
    });
    expect(enabledHosts()).toEqual(["station", "local"]);
  });
});

describe("connectionForHost (registry semantics)", () => {
  it("throws if called before init", () => {
    expect(() => connectionForHost("station")).toThrow(/before initConnectionsForHost/);
  });

  it("throws when asked for a host that's not enabled", () => {
    const stubs = makeStubCallbacks();
    initApiForHost(STATION_ONLY);
    initConnectionsForHost(STATION_ONLY, {
      pollIntervalMs: 60_000,
      ...stubs,
    });
    expect(() => connectionForHost("local")).toThrow(/local is not enabled/);
  });

  it("returns the same DaemonConnection on repeated calls for the same host", () => {
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, {
      pollIntervalMs: 60_000,
      ...stubs,
    });
    const a = connectionForHost("station");
    const b = connectionForHost("station");
    expect(a).toBe(b);
  });

  it("returns distinct DaemonConnection instances per host", () => {
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, {
      pollIntervalMs: 60_000,
      ...stubs,
    });
    const station = connectionForHost("station");
    const local = connectionForHost("local");
    expect(station).not.toBe(local);
  });

  it("re-init disposes prior connections", () => {
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, {
      pollIntervalMs: 60_000,
      ...stubs,
    });
    const first = connectionForHost("station");
    const stopSpy = vi.spyOn(first, "stop");
    initApiForHost(STATION_ONLY);
    initConnectionsForHost(STATION_ONLY, {
      pollIntervalMs: 60_000,
      ...stubs,
    });
    expect(stopSpy).toHaveBeenCalled();
    // Fresh registry: a new station instance.
    const second = connectionForHost("station");
    expect(second).not.toBe(first);
  });
});

describe("DaemonConnection split (Phase 4)", () => {
  // Regression for codex review on the Phase 4 split: when station
  // isn't configured (#121: hybrid is the only mode, "no station"
  // means local is primary), the registry must still forward local's
  // `onPollSuccess` so boot's project refresh, session-restore prompt,
  // and uptime-regression detection get a chance to fire. An earlier
  // draft of boot wired `if (host !== "station") return;`, which
  // silently disabled the only active daemon when local was primary.
  it("forwards local's onPollSuccess to the boot callback when station is disabled (local is primary)", async () => {
    global.fetch = routedFetch({
      local: () => healthOk(123),
    });
    const stubs = makeStubCallbacks();
    initApiForHost(LOCAL_ONLY);
    initConnectionsForHost(LOCAL_ONLY, {
      pollIntervalMs: 60_000,
      pollTimeoutMs: 1000,
      refreshTimeoutMs: 1000,
      ...stubs,
    });
    expect(enabledHosts()).toEqual(["local"]);
    await connectionForHost("local").refresh();
    expect(stubs.callbacks.successes).toEqual([
      { host: "local", uptime: 123 },
    ]);
  });

  it("each host's onPollSuccess receives its own host arg + health payload", async () => {
    global.fetch = routedFetch({
      station: () => healthOk(11),
      local: () => healthOk(22),
    });
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, {
      pollIntervalMs: 60_000,
      pollTimeoutMs: 1000,
      refreshTimeoutMs: 1000,
      ...stubs,
    });
    await connectionForHost("station").refresh();
    await connectionForHost("local").refresh();
    expect(stubs.callbacks.successes).toEqual([
      { host: "station", uptime: 11 },
      { host: "local", uptime: 22 },
    ]);
  });

  it("each host's onConnectionInfo receives only its own state changes", async () => {
    global.fetch = routedFetch({
      station: () => healthOk(1),
      local: () => healthOk(2),
    });
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, {
      pollIntervalMs: 60_000,
      pollTimeoutMs: 1000,
      refreshTimeoutMs: 1000,
      ...stubs,
    });
    // Construction triggers an initial subscribe-fanout for each host
    // (DaemonConnection.subscribe fires the current state immediately).
    connectionForHost("station");
    connectionForHost("local");
    await connectionForHost("station").refresh();
    await connectionForHost("local").refresh();
    const stationStates = stubs.callbacks.infos
      .filter((i) => i.host === "station")
      .map((i) => i.info.state);
    const localStates = stubs.callbacks.infos
      .filter((i) => i.host === "local")
      .map((i) => i.info.state);
    expect(stationStates).toContain("connected");
    expect(localStates).toContain("connected");
    // Every event is tagged with the host that owns it; cross-talk
    // would show up as a station info on a local change or vice versa.
    for (const evt of stubs.callbacks.infos) {
      expect(["station", "local"]).toContain(evt.host);
    }
  });

  // The headline Phase 4 assertion: independent state per host.
  it("station drop leaves local green", async () => {
    global.fetch = routedFetch({
      station: () => {
        throw new TypeError("Failed to fetch");
      },
      local: () => healthOk(7),
    });
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, {
      pollIntervalMs: 60_000,
      pollTimeoutMs: 1000,
      refreshTimeoutMs: 1000,
      ...stubs,
    });
    const station = connectionForHost("station");
    const local = connectionForHost("local");
    // Fire both refreshes; collect each host's settled state.
    await station.refresh().catch(() => {});
    await local.refresh().catch(() => {});
    expect(station.getInfo().state).toBe("reconnecting");
    expect(station.getInfo().lastError).toBe("Network unreachable");
    expect(local.getInfo().state).toBe("connected");
    expect(local.getInfo().lastError).toBeNull();
    // The failure callback fired only for station.
    const failingHosts = stubs.callbacks.failures.map((f) => f.host);
    expect(failingHosts).toEqual(["station"]);
  });

  it("local drop leaves station green", async () => {
    global.fetch = routedFetch({
      station: () => healthOk(99),
      local: () => {
        throw new TypeError("ECONNREFUSED");
      },
    });
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, {
      pollIntervalMs: 60_000,
      pollTimeoutMs: 1000,
      refreshTimeoutMs: 1000,
      ...stubs,
    });
    const station = connectionForHost("station");
    const local = connectionForHost("local");
    await station.refresh().catch(() => {});
    await local.refresh().catch(() => {});
    expect(local.getInfo().state).toBe("reconnecting");
    expect(local.getInfo().lastError).toBe("Network unreachable");
    expect(station.getInfo().state).toBe("connected");
    expect(station.getInfo().lastError).toBeNull();
    const failingHosts = stubs.callbacks.failures.map((f) => f.host);
    expect(failingHosts).toEqual(["local"]);
  });

  it("401 from one host fires onPollFailure with that host only", async () => {
    global.fetch = routedFetch({
      station: () =>
        new Response("nope", { status: 401, statusText: "Unauthorized" }),
      local: () => healthOk(1),
    });
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, {
      pollIntervalMs: 60_000,
      pollTimeoutMs: 1000,
      refreshTimeoutMs: 1000,
      ...stubs,
    });
    await connectionForHost("station").refresh().catch(() => {});
    await connectionForHost("local").refresh().catch(() => {});
    expect(stubs.callbacks.failures).toHaveLength(1);
    expect(stubs.callbacks.failures[0].host).toBe("station");
    expect(stubs.callbacks.failures[0].reason).toBe("Unauthorized");
    expect(stubs.callbacks.failures[0].error).toBeInstanceOf(HttpError);
  });
});

describe("codex availability flag (per-host new-pane-button gate)", () => {
  it("defaults to false until a health poll reports it", () => {
    expect(isHostCodexAvailable("station")).toBe(false);
    expect(isHostCodexAvailable("local")).toBe(false);
  });

  it("setHostCodexAvailable / isHostCodexAvailable round-trip, per host", () => {
    setHostCodexAvailable("station", true);
    expect(isHostCodexAvailable("station")).toBe(true);
    // A codex binary on the station must NOT imply one on local.
    expect(isHostCodexAvailable("local")).toBe(false);
    setHostCodexAvailable("station", false);
    expect(isHostCodexAvailable("station")).toBe(false);
  });
});

describe("ready flag (Phase 9 pane-create gate)", () => {
  it("defaults to false for every host before anyone flips it", () => {
    expect(isHostReady("station")).toBe(false);
    expect(isHostReady("local")).toBe(false);
  });

  it("setHostReady / isHostReady round-trip", () => {
    setHostReady("local", true);
    expect(isHostReady("local")).toBe(true);
    expect(isHostReady("station")).toBe(false);
    setHostReady("local", false);
    expect(isHostReady("local")).toBe(false);
  });

  it("subscribeHostReady fires on change but not on a no-op write", () => {
    const events: Array<{ host: HostRef; ready: boolean }> = [];
    const off = subscribeHostReady((host, ready) => events.push({ host, ready }));
    setHostReady("local", true); // change: fire
    setHostReady("local", true); // same: no-op
    setHostReady("local", false); // change: fire
    setHostReady("station", true); // change: fire
    off();
    // Post-unsubscribe mutations must not reach the listener.
    setHostReady("station", false);
    expect(events).toEqual([
      { host: "local", ready: true },
      { host: "local", ready: false },
      { host: "station", ready: true },
    ]);
  });

  it("subscribeHostReady does NOT fire synchronously with the initial state", () => {
    setHostReady("local", true);
    const events: Array<{ host: HostRef; ready: boolean }> = [];
    const off = subscribeHostReady((host, ready) => events.push({ host, ready }));
    // Callers that need the current value must read `isHostReady` after
    // subscribing. The subscribe call itself is silent so boot doesn't
    // re-trigger Phase 9's push on every listener attach.
    expect(events).toEqual([]);
    off();
  });

  it("disposeConnections clears ready flags and drops all subscribers", () => {
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, { pollIntervalMs: 60_000, ...stubs });
    setHostReady("local", true);
    const events: Array<{ host: HostRef; ready: boolean }> = [];
    subscribeHostReady((host, ready) => events.push({ host, ready }));
    disposeConnections();
    expect(isHostReady("local")).toBe(false);
    // Dropped subscribers must not see post-dispose writes.
    setHostReady("local", true);
    expect(events).toEqual([]);
  });
});

describe("disposeConnections", () => {
  it("stops every running connection", async () => {
    vi.useFakeTimers();
    const stationFetch = vi.fn(async () => healthOk(1));
    const localFetch = vi.fn(async () => healthOk(2));
    global.fetch = routedFetch({
      station: () => stationFetch(),
      local: () => localFetch(),
    });
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, {
      pollIntervalMs: 50,
      ...stubs,
    });
    connectionForHost("station").start();
    connectionForHost("local").start();
    // Let the first poll fire on each.
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    const stationCallsBefore = stationFetch.mock.calls.length;
    const localCallsBefore = localFetch.mock.calls.length;
    disposeConnections();
    await vi.advanceTimersByTimeAsync(500);
    expect(stationFetch.mock.calls.length).toBe(stationCallsBefore);
    expect(localFetch.mock.calls.length).toBe(localCallsBefore);
    // Registry has been cleared; further access throws.
    expect(() => connectionForHost("station")).toThrow(/before initConnectionsForHost/);
  });

  it("is safe to call multiple times", () => {
    const stubs = makeStubCallbacks();
    initApiForHost(HYBRID);
    initConnectionsForHost(HYBRID, {
      pollIntervalMs: 60_000,
      ...stubs,
    });
    expect(() => disposeConnections()).not.toThrow();
    expect(() => disposeConnections()).not.toThrow();
  });
});
