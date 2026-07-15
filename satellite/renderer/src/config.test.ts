// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  primaryHost,
  loadLayouts,
  loadProjectOrder,
  loadSettings,
  resolveActiveUrl,
  saveProjectOrder,
  saveSettings,
  applyProjectOrder,
  resolveClaudeLaunchArgs,
  saveClaudeLaunchArgs,
  saveClaudeLaunchArgsForProject,
  stampLegacyHost,
  loadReckConnectPrompt,
  saveReckConnectPrompt,
  resolveEffectiveReckConnectPrompt,
  DEFAULT_RECK_CONNECT_PROMPT,
  DEFAULT_RAIL_WIGGLE,
  loadRailMode,
  saveRailMode,
  loadRailWiggle,
  saveRailWiggle,
  DEFAULT_DRAGDROP_EXTENSIONS,
  DEFAULT_DROP_PROMPT_TEMPLATE,
  DRAGDROP_MAX_BYTES,
  loadDragDropAllowlist,
  saveDragDropAllowlist,
  loadDropPromptTemplate,
  saveDropPromptTemplate,
  renderDropPrompt,
  type Settings,
} from "./config";
import type { Project } from "@proto/proto";

function mk(id: string, name: string): Project {
  return { id, name, cwd: "/", stoplight: "gray", pane_count: 0 };
}

describe("project order persistence", () => {
  const store = new Map<string, unknown>();
  beforeEach(() => {
    store.clear();
    (window as unknown as { reckAPI: unknown }).reckAPI = {
      config: {
        get: async <T>(k: string) => (store.has(k) ? (store.get(k) as T) : null),
        set: async (k: string, v: unknown) => {
          store.set(k, v);
          return true;
        },
      },
      daemon: {
        status: async () => ({ running: false, binary: null }),
        start: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
      },
      dialog: { pickFolder: async () => null },
      onMenuAddProject: () => {},
    };
  });

  it("returns empty list when nothing saved", async () => {
    expect(await loadProjectOrder()).toEqual([]);
  });

  it("round-trips a saved list", async () => {
    await saveProjectOrder(["a", "b", "c"]);
    expect(await loadProjectOrder()).toEqual(["a", "b", "c"]);
  });
});

describe("applyProjectOrder", () => {
  it("returns alphabetical order when no saved order", () => {
    const input = [mk("b", "Bravo"), mk("a", "Alpha"), mk("c", "Charlie")];
    expect(applyProjectOrder(input, []).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts known ids by saved order", () => {
    const input = [mk("a", "Alpha"), mk("b", "Bravo"), mk("c", "Charlie")];
    expect(applyProjectOrder(input, ["c", "a", "b"]).map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("appends unknown projects alphabetically after known ones", () => {
    const input = [
      mk("new2", "New Two"),
      mk("a", "Alpha"),
      mk("new1", "New One"),
      mk("b", "Bravo"),
    ];
    expect(applyProjectOrder(input, ["b", "a"]).map((p) => p.id)).toEqual([
      "b",
      "a",
      "new1",
      "new2",
    ]);
  });

  it("ignores saved ids that no longer exist", () => {
    const input = [mk("a", "Alpha"), mk("b", "Bravo")];
    expect(applyProjectOrder(input, ["deleted", "b", "a"]).map((p) => p.id)).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("claude launch args scope resolution", () => {
  const store = new Map<string, unknown>();
  beforeEach(() => {
    store.clear();
    (window as unknown as { reckAPI: unknown }).reckAPI = {
      config: {
        get: async <T>(k: string) => (store.has(k) ? (store.get(k) as T) : null),
        set: async (k: string, v: unknown) => {
          store.set(k, v);
          return true;
        },
      },
    };
  });

  it("returns empty when nothing is configured", async () => {
    expect(await resolveClaudeLaunchArgs("proj-1")).toBe("");
  });

  it("uses machine default when no project override", async () => {
    await saveClaudeLaunchArgs("--dangerously-skip-permissions");
    expect(await resolveClaudeLaunchArgs("proj-1")).toBe("--dangerously-skip-permissions");
  });

  it("project override beats machine default", async () => {
    await saveClaudeLaunchArgs("--effort low");
    await saveClaudeLaunchArgsForProject("proj-1", "--effort high");
    expect(await resolveClaudeLaunchArgs("proj-1")).toBe("--effort high");
    expect(await resolveClaudeLaunchArgs("proj-2")).toBe("--effort low");
  });

  it("clearing a project override falls back to machine default", async () => {
    await saveClaudeLaunchArgs("--model claude-opus-4-7");
    await saveClaudeLaunchArgsForProject("proj-1", "--model claude-haiku-4-5");
    await saveClaudeLaunchArgsForProject("proj-1", "");
    expect(await resolveClaudeLaunchArgs("proj-1")).toBe("--model claude-opus-4-7");
  });
});

// Hybrid mode (an earlier release, plan rev 3.1): every Tab now carries a
// `host: "station" | "local"`. Layouts persisted before Phase 1 don't have
// that field — the load path stamps them "station" so the strict validator
// downstream still accepts them.
describe("stampLegacyHost", () => {
  it("stamps host on every tab in a single-leaf tree", () => {
    const tree = {
      kind: "leaf",
      id: "l_x",
      tabs: [
        { id: "t_1", paneId: "p_1", kind: "claude", title: "Claude" },
        { id: "t_2", paneId: "p_2", kind: "shell", title: "Shell" },
      ],
      activeTabId: "t_1",
    };
    stampLegacyHost(tree);
    expect(tree.tabs.every((t) => (t as { host?: string }).host === "station")).toBe(true);
  });

  it("recurses through splits", () => {
    const tree = {
      kind: "split",
      id: "s_x",
      dir: "vertical",
      ratio: 0.5,
      a: {
        kind: "leaf",
        id: "l_a",
        tabs: [{ id: "t_a", paneId: "p_a", kind: "claude", title: "A" }],
        activeTabId: "t_a",
      },
      b: {
        kind: "split",
        id: "s_inner",
        dir: "horizontal",
        ratio: 0.5,
        a: {
          kind: "leaf",
          id: "l_b",
          tabs: [{ id: "t_b", paneId: "p_b", kind: "shell", title: "B" }],
          activeTabId: "t_b",
        },
        b: {
          kind: "leaf",
          id: "l_c",
          tabs: [{ id: "t_c", paneId: "p_c", kind: "claude", title: "C" }],
          activeTabId: "t_c",
        },
      },
    };
    stampLegacyHost(tree);
    const collect = (n: unknown): string[] => {
      if (!n || typeof n !== "object") return [];
      const node = n as { kind?: string; tabs?: { host?: string }[]; a?: unknown; b?: unknown };
      if (node.kind === "leaf") return (node.tabs ?? []).map((t) => t.host ?? "<missing>");
      if (node.kind === "split") return [...collect(node.a), ...collect(node.b)];
      return [];
    };
    expect(collect(tree)).toEqual(["station", "station", "station"]);
  });

  it("preserves an existing host (idempotent)", () => {
    const tree = {
      kind: "leaf",
      id: "l_x",
      tabs: [
        { id: "t_1", paneId: "p_1", kind: "claude", title: "Claude", host: "local" },
        { id: "t_2", paneId: "p_2", kind: "claude", title: "Claude" },
      ],
      activeTabId: "t_1",
    };
    stampLegacyHost(tree);
    expect((tree.tabs[0] as { host: string }).host).toBe("local");
    expect((tree.tabs[1] as { host: string }).host).toBe("station");
  });

  it("is a no-op on null / undefined / non-object", () => {
    expect(() => stampLegacyHost(null)).not.toThrow();
    expect(() => stampLegacyHost(undefined)).not.toThrow();
    expect(() => stampLegacyHost("leaf")).not.toThrow();
    expect(() => stampLegacyHost(42)).not.toThrow();
  });
});

describe("loadLayouts host stamping", () => {
  const store = new Map<string, unknown>();
  beforeEach(() => {
    store.clear();
    (window as unknown as { reckAPI: unknown }).reckAPI = {
      config: {
        get: async <T>(k: string) => (store.has(k) ? (store.get(k) as T) : null),
        set: async (k: string, v: unknown) => {
          store.set(k, v);
          return true;
        },
      },
    };
  });

  it("stamps station onto every legacy tab across every project", async () => {
    // Two projects, both with un-stamped tabs as if persisted before
    // Phase 1 of the hybrid-mode work.
    store.set("layouts_v2", {
      "proj-a": {
        kind: "leaf",
        id: "l_a",
        tabs: [{ id: "t_a", paneId: "p_a", kind: "claude", title: "Claude" }],
        activeTabId: "t_a",
      },
      "proj-b": {
        kind: "split",
        id: "s_b",
        dir: "vertical",
        ratio: 0.5,
        a: {
          kind: "leaf",
          id: "l_b1",
          tabs: [{ id: "t_b1", paneId: "p_b1", kind: "shell", title: "Shell" }],
          activeTabId: "t_b1",
        },
        b: {
          kind: "leaf",
          id: "l_b2",
          tabs: [{ id: "t_b2", paneId: "p_b2", kind: "claude", title: "Claude" }],
          activeTabId: "t_b2",
        },
      },
    });
    const out = await loadLayouts();
    const projA = out["proj-a"] as { tabs: { host: string }[] };
    expect(projA.tabs[0].host).toBe("station");
    const projB = out["proj-b"] as {
      a: { tabs: { host: string }[] };
      b: { tabs: { host: string }[] };
    };
    expect(projB.a.tabs[0].host).toBe("station");
    expect(projB.b.tabs[0].host).toBe("station");
  });

  it("returns an empty object when nothing is saved", async () => {
    expect(await loadLayouts()).toEqual({});
  });

  it("tolerates a null entry (project with no saved layout)", async () => {
    store.set("layouts_v2", { "proj-a": null });
    const out = await loadLayouts();
    expect(out["proj-a"]).toBeNull();
  });
});

// Hybrid mode (an earlier release, plan rev 3.1) Phase 2: the legacy
// {mode, stationUrl, daemonToken} triplet is replaced by a
// `Settings = { station?, local? }` shape persisted under a single
// "settings" blob plus a separate secret key "station.token".
describe("primaryHost", () => {
  it("returns 'station' when only station is enabled", () => {
    const s: Settings = { station: { enabled: true, url: "http://x" } };
    expect(primaryHost(s)).toBe("station");
  });

  it("returns 'local' when only local is enabled", () => {
    const s: Settings = { local: { enabled: true, port: 7315, autoStart: true } };
    expect(primaryHost(s)).toBe("local");
  });

  it("returns 'station' when both are enabled (station wins)", () => {
    // Hybrid: the station-aware behaviours (mount-hint, primary host
    // for status display) still apply; primaryHost resolves to station
    // so the remaining single-host consumers keep doing the right thing.
    const s: Settings = {
      station: { enabled: true, url: "http://x" },
      local: { enabled: true, port: 7315, autoStart: true },
    };
    expect(primaryHost(s)).toBe("station");
  });

  it("returns 'local' as a defensive default when neither is enabled", () => {
    // Disarms the mount hint; no station URL to display. Match the
    // Phase 12 helper's documented contract.
    const s: Settings = {};
    expect(primaryHost(s)).toBe("local");
  });

  it("returns 'local' when station present but disabled and local enabled", () => {
    const s: Settings = {
      station: { enabled: false, url: "http://x" },
      local: { enabled: true, port: 7315, autoStart: true },
    };
    expect(primaryHost(s)).toBe("local");
  });
});

describe("resolveActiveUrl", () => {
  it("prefers the station URL when station is enabled", () => {
    const s: Settings = {
      station: { enabled: true, url: "http://station:7315" },
      local: { enabled: true, port: 7315, autoStart: true },
    };
    expect(resolveActiveUrl(s)).toBe("http://station:7315");
  });

  it("falls back to a 127.0.0.1 URL built from local.port when only local is enabled", () => {
    const s: Settings = { local: { enabled: true, port: 9000, autoStart: true } };
    expect(resolveActiveUrl(s)).toBe("http://127.0.0.1:9000");
  });

  it("returns null when nothing usable is enabled", () => {
    expect(resolveActiveUrl({})).toBeNull();
    expect(resolveActiveUrl({ station: { enabled: true, url: "" } })).toBeNull();
    expect(
      resolveActiveUrl({ station: { enabled: false, url: "http://x" } }),
    ).toBeNull();
  });
});

describe("loadSettings / saveSettings round-trip (Phase 2 shape)", () => {
  const store = new Map<string, unknown>();
  beforeEach(() => {
    store.clear();
    (window as unknown as { reckAPI: unknown }).reckAPI = {
      config: {
        get: async <T>(k: string) => (store.has(k) ? (store.get(k) as T) : null),
        set: async (k: string, v: unknown) => {
          store.set(k, v);
          return true;
        },
      },
    };
  });

  it("returns null when no settings have been persisted", async () => {
    expect(await loadSettings()).toBeNull();
  });

  it("round-trips a station-only-shaped caller blob (local enabled forced true on save)", async () => {
    // saveSettings normalises: `local.enabled` is always persisted as
    // true (the user can no longer opt out from the UI per an earlier release). Other
    // local fields round-trip as-is — autoStart=false here stays false.
    await saveSettings({
      station: { enabled: true, url: "http://station:7315", token: "tok-abc" },
      local: { enabled: false, port: 7315, autoStart: false },
    });
    const out = await loadSettings();
    expect(out).toEqual({
      station: { enabled: true, url: "http://station:7315", token: "tok-abc" },
      local: { enabled: true, port: 7315, autoStart: false },
    });
  });

  it("round-trips a no-station blob (local-only setup, post-rollout framing)", async () => {
    await saveSettings({
      local: { enabled: true, port: 7315, autoStart: true },
    });
    const out = await loadSettings();
    // saveSettings always persists local; loadSettings always populates
    // it. The absence of a station block round-trips as undefined.
    expect(out).toEqual({
      local: { enabled: true, port: 7315, autoStart: true },
    });
  });

  it("populates local with defaults when the persisted blob has only a station slice", async () => {
    // A Older station-only persisted blob (no `local` key at all)
    // must come out of loadSettings with local populated — otherwise
    // the renderer's "local is always available" assumption breaks.
    store.set("settings", { station: { enabled: true, url: "http://s:7315" } });
    const out = await loadSettings();
    expect(out?.local).toEqual({
      enabled: true,
      port: 7315, // DEFAULT_LOCAL_PORT
      autoStart: true,
    });
  });

  it("migrates a legacy persisted blob with local.enabled=false: forces enabled=true AND autoStart=true", async () => {
    // Bypass saveSettings to simulate a Phase-2-migration-era blob (the
    // from-station migration used to write `local: { enabled: false,
    // autoStart: false }`). Without the autoStart kick, those users
    // would land in "local is available but never starts" — worse than
    // the Older explicit-disabled state.
    store.set("settings", {
      station: { enabled: true, url: "http://s:7315" },
      local: { enabled: false, port: 7315, autoStart: false },
    });
    const out = await loadSettings();
    expect(out?.local).toEqual({
      enabled: true,
      port: 7315,
      autoStart: true,
    });
  });

  it("round-trips a hybrid blob (both hosts enabled)", async () => {
    await saveSettings({
      station: { enabled: true, url: "http://station:7315", token: "secret" },
      local: { enabled: true, port: 7315, autoStart: true },
    });
    const out = await loadSettings();
    expect(out?.station).toEqual({
      enabled: true,
      url: "http://station:7315",
      token: "secret",
    });
    expect(out?.local).toEqual({ enabled: true, port: 7315, autoStart: true });
  });

  it("persists the station token to a separate secret key", async () => {
    await saveSettings({
      station: { enabled: true, url: "http://x", token: "tok-1" },
    });
    // The non-secret blob must NOT carry the token — it lives in
    // "station.token" (a SECRET_CONFIG_KEYS entry on the main side).
    const persisted = store.get("settings") as { station?: { token?: unknown } };
    expect(persisted.station?.token).toBeUndefined();
    expect(store.get("station.token")).toBe("tok-1");
  });

  it("treats an empty string token as undefined on read", async () => {
    // saveSettings writes whatever was passed; storing "" simulates a
    // user clearing the token. loadSettings should normalise back to
    // undefined so consumers don't have to defend the empty string.
    await saveSettings({
      station: { enabled: true, url: "http://x", token: "" },
    });
    const out = await loadSettings();
    expect(out?.station?.token).toBeUndefined();
  });
});

describe("Reck Connect prompt (load/save/resolve)", () => {
  const store = new Map<string, unknown>();
  beforeEach(() => {
    store.clear();
    (window as unknown as { reckAPI: unknown }).reckAPI = {
      config: {
        get: async <T>(k: string) => (store.has(k) ? (store.get(k) as T) : null),
        set: async (k: string, v: unknown) => {
          store.set(k, v);
          return true;
        },
      },
    };
  });

  it("loadReckConnectPrompt returns null on fresh install", async () => {
    expect(await loadReckConnectPrompt()).toBeNull();
  });

  it("round-trips a saved prompt string", async () => {
    await saveReckConnectPrompt("RECK_GLOBAL_RULE\nAlways verbose.");
    expect(await loadReckConnectPrompt()).toBe("RECK_GLOBAL_RULE\nAlways verbose.");
  });

  it("preserves an explicit empty string (user cleared the textarea)", async () => {
    // Distinguishing "" from null is the whole point of the typed
    // return — boot wraps null with the default but treats "" as
    // "the user explicitly wants no global layer".
    await saveReckConnectPrompt("");
    expect(await loadReckConnectPrompt()).toBe("");
  });

  it("loadReckConnectPrompt coerces non-string persisted values to null", async () => {
    // An older malformed write (e.g. a hand-edited config with a number
    // in the slot) should not crash the loader; falling back to null lets
    // resolveEffective seed the defaults next time around.
    store.set("reckConnectPrompt", 42);
    expect(await loadReckConnectPrompt()).toBeNull();
  });

  it("resolveEffectiveReckConnectPrompt returns DEFAULT on fresh install", async () => {
    expect(await resolveEffectiveReckConnectPrompt()).toBe(DEFAULT_RECK_CONNECT_PROMPT);
  });

  it("resolveEffectiveReckConnectPrompt returns the persisted value (even when empty)", async () => {
    await saveReckConnectPrompt("");
    expect(await resolveEffectiveReckConnectPrompt()).toBe("");

    await saveReckConnectPrompt("custom rules");
    expect(await resolveEffectiveReckConnectPrompt()).toBe("custom rules");
  });
});

describe("rail mode + wiggle persistence", () => {
  const store = new Map<string, unknown>();
  beforeEach(() => {
    store.clear();
    (window as unknown as { reckAPI: unknown }).reckAPI = {
      config: {
        get: async <T>(k: string) => (store.has(k) ? (store.get(k) as T) : null),
        set: async (k: string, v: unknown) => {
          store.set(k, v);
          return true;
        },
      },
    };
  });

  it("railMode defaults to expanded on fresh install", async () => {
    expect(await loadRailMode()).toBe("expanded");
  });

  it("railMode round-trips mini", async () => {
    await saveRailMode("mini");
    expect(await loadRailMode()).toBe("mini");
    await saveRailMode("expanded");
    expect(await loadRailMode()).toBe("expanded");
  });

  it("railMode coerces a malformed persisted value to expanded", async () => {
    store.set("railMode", "hidden");
    expect(await loadRailMode()).toBe("expanded");
    store.set("railMode", 3);
    expect(await loadRailMode()).toBe("expanded");
  });

  it("rail wiggle defaults on fresh install", async () => {
    expect(await loadRailWiggle()).toEqual(DEFAULT_RAIL_WIGGLE);
    // Deliberately slow default — a fast wiggle read as jarring in use.
    expect(DEFAULT_RAIL_WIGGLE.legMs).toBe(240);
  });

  it("rail wiggle round-trips all three fields", async () => {
    await saveRailWiggle({ enabled: false, pixels: 20, legMs: 90 });
    expect(await loadRailWiggle()).toEqual({ enabled: false, pixels: 20, legMs: 90 });
  });

  it("rail wiggle falls back per-field on malformed values", async () => {
    store.set("railWiggleEnabled", "yes"); // non-boolean → default true
    store.set("railWigglePixels", -4); // non-positive → default
    store.set("railWiggleLegMs", "fast"); // non-number → default
    expect(await loadRailWiggle()).toEqual(DEFAULT_RAIL_WIGGLE);
  });
});

describe("drag-drop config", () => {
  const store = new Map<string, unknown>();
  beforeEach(() => {
    store.clear();
    (window as unknown as { reckAPI: unknown }).reckAPI = {
      config: {
        get: async <T>(k: string) => (store.has(k) ? (store.get(k) as T) : null),
        set: async (k: string, v: unknown) => {
          store.set(k, v);
          return true;
        },
      },
    };
  });

  it("max size is 10 MB (decimal)", () => {
    expect(DRAGDROP_MAX_BYTES).toBe(10 * 1000 * 1000);
  });

  it("allowlist is null on fresh install (callers seed defaults)", async () => {
    expect(await loadDragDropAllowlist()).toBeNull();
    expect(DEFAULT_DRAGDROP_EXTENSIONS).toContain("pdf");
    expect(DEFAULT_DRAGDROP_EXTENSIONS).toContain("png");
  });

  it("allowlist normalises (lowercase, strips leading dot) and dedupes", async () => {
    await saveDragDropAllowlist([".PNG", "png", "  Pdf ", ""]);
    expect(await loadDragDropAllowlist()).toEqual(["png", "pdf"]);
  });

  it("allowlist round-trips an emptied list as [] (not null)", async () => {
    await saveDragDropAllowlist([]);
    expect(await loadDragDropAllowlist()).toEqual([]);
  });

  it("prompt template defaults when unset or blank", async () => {
    expect(await loadDropPromptTemplate()).toBe(DEFAULT_DROP_PROMPT_TEMPLATE);
    store.set("dragDrop.promptTemplate", "   ");
    expect(await loadDropPromptTemplate()).toBe(DEFAULT_DROP_PROMPT_TEMPLATE);
  });

  it("prompt template round-trips a custom value", async () => {
    await saveDropPromptTemplate("look at {filename}");
    expect(await loadDropPromptTemplate()).toBe("look at {filename}");
  });

  it("renderDropPrompt substitutes {path} and {filename} (all occurrences)", () => {
    expect(renderDropPrompt("{path} :: {filename} :: {path}", "sub/x.md", "x.md")).toBe(
      "sub/x.md :: x.md :: sub/x.md",
    );
  });
});
