// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetApiForHostForTests,
  apiForHost,
  clearApiForHost,
  hasTokenForHost,
  initApiForHost,
  refreshLocalDaemonToken,
  resetForHost,
  setApiTokenForHost,
} from "./api-for-host";
import type { Settings } from "./config";
import { promptForToken } from "./ui/update-token-dialog";

const STATION_ONLY: Settings = {
  station: { enabled: true, url: "http://station:7315", token: "stk-1" },
};

const HYBRID: Settings = {
  station: { enabled: true, url: "http://station:7315", token: "stk-1" },
  local: { enabled: true, port: 7315, autoStart: true },
};

const LOCAL_ONLY: Settings = {
  local: { enabled: true, port: 9000, autoStart: true },
};

beforeEach(() => {
  _resetApiForHostForTests();
});

describe("apiForHost (Phase 3 registry)", () => {
  it("throws if called before init", () => {
    expect(() => apiForHost("station")).toThrow(/before initApiForHost/);
  });

  it("returns the same instance on repeated calls for the same host", () => {
    initApiForHost(HYBRID);
    const a1 = apiForHost("station");
    const a2 = apiForHost("station");
    expect(a1).toBe(a2);
  });

  it("returns distinct instances for distinct hosts", () => {
    initApiForHost(HYBRID);
    const station = apiForHost("station");
    const local = apiForHost("local");
    expect(station).not.toBe(local);
  });

  it("station client is built from settings.station.url + token, trailing slash stripped", () => {
    initApiForHost({
      station: { enabled: true, url: "http://station:7315/", token: "stk-1" },
    });
    const c = apiForHost("station");
    expect(c.config.baseUrl).toBe("http://station:7315");
    expect(c.config.token).toBe("stk-1");
  });

  it("local client uses 127.0.0.1 + the configured port and no token", () => {
    initApiForHost(LOCAL_ONLY);
    const c = apiForHost("local");
    expect(c.config.baseUrl).toBe("http://127.0.0.1:9000");
    expect(c.config.token).toBeUndefined();
  });

  it("falls back to default port 7315 when local.port is unset / zero", () => {
    initApiForHost({ local: { enabled: true, port: 0, autoStart: true } });
    expect(apiForHost("local").config.baseUrl).toBe("http://127.0.0.1:7315");
  });

  it("throws if local is requested but not enabled", () => {
    initApiForHost(STATION_ONLY);
    expect(() => apiForHost("local")).toThrow(/local is not enabled/);
  });

  it("throws if station is requested but not enabled", () => {
    initApiForHost(LOCAL_ONLY);
    expect(() => apiForHost("station")).toThrow(/station is not enabled/);
  });

  it("throws if station is enabled with an empty URL", () => {
    initApiForHost({ station: { enabled: true, url: "" } });
    expect(() => apiForHost("station")).toThrow(/station\.url is empty/);
  });

  it("does not pre-construct local on init", () => {
    // Lazy: only the host actually requested gets a client. We can't
    // easily observe construction without a spy on ApiClient itself,
    // but we can prove the inverse — asking for the un-enabled host
    // throws regardless of init having run.
    initApiForHost(STATION_ONLY);
    apiForHost("station"); // works
    expect(() => apiForHost("local")).toThrow();
  });
});

describe("setApiTokenForHost", () => {
  it("updates the targeted host's client token", () => {
    initApiForHost(HYBRID);
    const station = apiForHost("station");
    setApiTokenForHost("station", "stk-2");
    expect(station.config.token).toBe("stk-2");
  });

  it("updating station does not touch local's token", () => {
    initApiForHost(HYBRID);
    const station = apiForHost("station");
    const local = apiForHost("local");
    setApiTokenForHost("station", "stk-2");
    expect(station.config.token).toBe("stk-2");
    expect(local.config.token).toBeUndefined();
  });

  it("undefined clears the token", () => {
    initApiForHost(STATION_ONLY);
    const station = apiForHost("station");
    setApiTokenForHost("station", undefined);
    expect(station.config.token).toBeUndefined();
  });

  it("lazily constructs the client if it didn't exist yet", () => {
    initApiForHost(HYBRID);
    // Don't call apiForHost("local") first — setApiTokenForHost
    // should still work via the lazy-construction path.
    setApiTokenForHost("local", "ltk-1");
    expect(apiForHost("local").config.token).toBe("ltk-1");
  });
});

describe("clearApiForHost / resetForHost", () => {
  it("clearApiForHost forces a rebuild on next access", () => {
    initApiForHost(STATION_ONLY);
    const first = apiForHost("station");
    clearApiForHost("station");
    const second = apiForHost("station");
    expect(second).not.toBe(first);
  });

  it("resetForHost replaces the cached settings and rebuilds the host", () => {
    initApiForHost({
      station: { enabled: true, url: "http://station:7315", token: "stk-1" },
    });
    const first = apiForHost("station");
    resetForHost("station", {
      station: { enabled: true, url: "http://other:7315", token: "stk-2" },
    });
    const second = apiForHost("station");
    expect(second).not.toBe(first);
    expect(second.config.baseUrl).toBe("http://other:7315");
    expect(second.config.token).toBe("stk-2");
  });

  it("resetForHost leaves the other host's cached client alone", () => {
    initApiForHost(HYBRID);
    const localFirst = apiForHost("local");
    resetForHost("station", HYBRID);
    expect(apiForHost("local")).toBe(localFirst);
  });

  // Regression for the codex review on Phase 3: replacing the entire
  // cachedSettings blob (instead of merging the targeted slice) used
  // to break the *other* host on a subsequent rebuild — the next
  // clearApiForHost("local") + apiForHost("local") would throw
  // because the partial blob no longer carried the local slice.
  it("resetForHost(station) preserves the local slice for future rebuilds", () => {
    initApiForHost(HYBRID);
    apiForHost("station");
    apiForHost("local");
    // Caller passes only the slice for the host being reset — the
    // registry must keep the local slice from the original init.
    resetForHost("station", {
      station: { enabled: true, url: "http://other:7315", token: "stk-2" },
    });
    clearApiForHost("local");
    // Without the merge fix this would throw "local is not enabled".
    const local = apiForHost("local");
    expect(local.config.baseUrl).toBe("http://127.0.0.1:7315");
  });

  it("resetForHost throws if called before initApiForHost", () => {
    expect(() => resetForHost("station", STATION_ONLY)).toThrow(
      /before initApiForHost/,
    );
  });
});

// The 1008-close path lives in boot.ts; here we test the dialog
// contract that path depends on — the prompt is host-aware, the
// label/copy switches with the host arg, and only the relevant
// host's token is mutated when the user accepts.
describe("promptForToken host-aware copy", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("station dialog title uses 'station' wording", async () => {
    const promise = promptForToken("station", "");
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector(".dialog-title")?.textContent).toMatch(/station token/i);
    expect(dialog.getAttribute("aria-label")).toBe("Update station token");
    // Cancel so the promise resolves.
    (dialog.querySelector("#tok-cancel") as HTMLElement).click();
    await promise;
  });

  it("local dialog title uses 'local-daemon' wording", async () => {
    const promise = promptForToken("local", "");
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector(".dialog-title")?.textContent).toMatch(
      /local-daemon token/i,
    );
    expect(dialog.getAttribute("aria-label")).toBe("Update local-daemon token");
    (dialog.querySelector("#tok-cancel") as HTMLElement).click();
    await promise;
  });

  it("only mutates the targeted host's token when the user accepts", async () => {
    initApiForHost(HYBRID);
    const station = apiForHost("station");
    const local = apiForHost("local");
    const stationBefore = station.config.token;
    const localBefore = local.config.token;

    const promise = promptForToken("station", "");
    const input = document.body.querySelector("#tok-input") as HTMLInputElement;
    input.value = "rotated-station-token";
    (document.body.querySelector("#tok-save") as HTMLElement).click();
    const result = await promise;
    expect(result).toBe("rotated-station-token");

    // Simulate boot.ts's path: route the result through
    // setApiTokenForHost only for the host the prompt was raised against.
    if (result !== null) setApiTokenForHost("station", result);

    expect(station.config.token).toBe("rotated-station-token");
    // Local left untouched: still `undefined`, not the old station token.
    expect(local.config.token).toBe(localBefore);
    expect(stationBefore).toBe("stk-1"); // sanity on the fixture
  });
});

// Phase 5 (an earlier release, plan rev 3.1): the local-daemon bearer is owned
// by the Electron main process (per-spawn random 32-byte token, lives
// only in main memory). The renderer fetches it via
// `window.reckAPI.daemon.localToken()` and applies it to the local
// ApiClient via `setApiTokenForHost("local", ...)`. The
// `refreshLocalDaemonToken` helper bundles the fetch + apply so boot
// (post-spawn) and the 1008/401 paths can call a single function.
describe("refreshLocalDaemonToken (Phase 5)", () => {
  it("fetches via the injected fetcher and applies the result to the local client", async () => {
    initApiForHost(LOCAL_ONLY);
    const token = await refreshLocalDaemonToken(async () => "spawn-token-1");
    expect(token).toBe("spawn-token-1");
    expect(apiForHost("local").config.token).toBe("spawn-token-1");
  });

  it("clears the local client's token when the IPC returns null (daemon down)", async () => {
    initApiForHost(LOCAL_ONLY);
    // Seed something first so we can prove the clear path runs.
    setApiTokenForHost("local", "stale-token");
    expect(apiForHost("local").config.token).toBe("stale-token");
    const token = await refreshLocalDaemonToken(async () => null);
    expect(token).toBeNull();
    expect(apiForHost("local").config.token).toBeUndefined();
  });

  it("never touches the station client", async () => {
    initApiForHost(HYBRID);
    const station = apiForHost("station");
    const stationTokenBefore = station.config.token;
    await refreshLocalDaemonToken(async () => "fresh-local-token");
    expect(apiForHost("local").config.token).toBe("fresh-local-token");
    expect(station.config.token).toBe(stationTokenBefore);
  });

  it("can be called repeatedly with different tokens (rotation per spawn)", async () => {
    initApiForHost(LOCAL_ONLY);
    await refreshLocalDaemonToken(async () => "tok-a");
    expect(apiForHost("local").config.token).toBe("tok-a");
    await refreshLocalDaemonToken(async () => "tok-b");
    expect(apiForHost("local").config.token).toBe("tok-b");
  });
});

// The poll-gate in `connection-for-host.ts` uses this to hold off
// probing a host until it's authenticated, so a token-less probe never
// draws a spurious 401 (which would grey the host out in the UI).
describe("hasTokenForHost", () => {
  it("is false for a freshly-built local client (no token yet)", () => {
    initApiForHost(HYBRID);
    expect(hasTokenForHost("local")).toBe(false);
  });

  it("is true once a token has been applied to the host", () => {
    initApiForHost(HYBRID);
    setApiTokenForHost("local", "spawn-token-1");
    expect(hasTokenForHost("local")).toBe(true);
  });

  it("reflects the station token that came from settings", () => {
    initApiForHost(HYBRID); // station seeded with "stk-1"
    expect(hasTokenForHost("station")).toBe(true);
  });

  it("flips back to false when the token is cleared", () => {
    initApiForHost(HYBRID);
    setApiTokenForHost("local", "tok");
    expect(hasTokenForHost("local")).toBe(true);
    setApiTokenForHost("local", undefined);
    expect(hasTokenForHost("local")).toBe(false);
  });
});

// Regression: a single 1008-on-station handler must call
// promptForToken("station", ...) — never plumb the wrong host arg
// through. We can't run the WS-close handler in isolation without
// reconstructing boot.ts, so this is a unit sketch of the contract:
// a mock prompter, called with host "station", writes only to station.
describe("1008-prompt routing contract", () => {
  it("dispatcher passes the same host arg the close handler resolved", () => {
    initApiForHost(HYBRID);
    const station = apiForHost("station");
    const local = apiForHost("local");

    const prompter = vi.fn(async (host: "station" | "local") => `tok-for-${host}`);
    // Simulate the boot.ts path: resolve host from a "tab", call
    // prompter(host), apply via setApiTokenForHost(host, ...).
    const fakeOnClose = async (host: "station" | "local") => {
      const v = await prompter(host);
      setApiTokenForHost(host, v);
    };

    return fakeOnClose("station").then(() => {
      expect(prompter).toHaveBeenCalledWith("station");
      expect(prompter).toHaveBeenCalledTimes(1);
      expect(station.config.token).toBe("tok-for-station");
      // Local untouched.
      expect(local.config.token).toBeUndefined();
    });
  });
});
