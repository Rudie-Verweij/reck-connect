import { describe, it, expect } from "vitest";
import {
  extractProjectIdsFromToml,
  planMigration,
  type MigrationIo,
} from "./settings-migration";

// Hybrid mode (an earlier release, plan rev 3.1) Phase 2 migration. The planner is
// pure: it reads via the supplied `MigrationIo` and returns a plan; the
// caller (`runSettingsMigration` in main.ts) performs the writes. These
// tests cover every plan branch + the toml extractor without touching
// Electron or the filesystem.

function makeIo(opts: {
  store?: Record<string, unknown>;
  toml?: string | null;
}): { io: MigrationIo; logs: string[]; store: Map<string, unknown> } {
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}));
  const logs: string[] = [];
  const io: MigrationIo = {
    readKey: (k) => (store.has(k) ? store.get(k) : null),
    hasKey: (k) => store.has(k),
    readProjectsToml: () => opts.toml ?? null,
    log: (m) => logs.push(m),
  };
  return { io, logs, store };
}

describe("planMigration — fresh install", () => {
  it("returns no-op when no legacy keys are present", () => {
    const { io } = makeIo({});
    const r = planMigration(io);
    expect(r.migrated).toBe(false);
    expect(r.reason).toBe("fresh-install");
  });

  it("treats a non-string mode as fresh", () => {
    const { io } = makeIo({ store: { mode: 42 } });
    const r = planMigration(io);
    expect(r.reason).toBe("fresh-install");
  });

  it("treats an empty mode string as fresh", () => {
    const { io } = makeIo({ store: { mode: "" } });
    const r = planMigration(io);
    expect(r.reason).toBe("fresh-install");
  });
});

describe("planMigration — already migrated (idempotency)", () => {
  it("short-circuits when the new 'settings' key exists", () => {
    const { io } = makeIo({
      store: {
        settings: { local: { enabled: true, port: 7315, autoStart: true } },
        // Legacy keys still hanging around from rollback retention —
        // must NOT trigger another migration.
        mode: "local",
        stationUrl: "http://x",
      },
    });
    const r = planMigration(io);
    expect(r.migrated).toBe(false);
    expect(r.reason).toBe("already-migrated");
  });

  it("counts a deliberately-empty {} settings as migrated", () => {
    // hasKey-not-truthy: a user who cleared their settings (mode chooser
    // path) shouldn't have the migration overwrite their {}.
    const { io } = makeIo({ store: { settings: {} } });
    const r = planMigration(io);
    expect(r.reason).toBe("already-migrated");
  });
});

describe("planMigration — mode === 'station'", () => {
  it("produces the canonical station block", () => {
    const { io, logs } = makeIo({
      store: {
        mode: "station",
        stationUrl: "http://station-host:7315",
        daemonToken: "abc-token",
      },
    });
    const r = planMigration(io);
    expect(r.migrated).toBe(true);
    expect(r.reason).toBe("from-station");
    expect(r.settings).toEqual({
      station: { enabled: true, url: "http://station-host:7315" },
      // an earlier release — migrated configs land in true hybrid (local always
      // enabled, autoStart on). The Older from-station migration
      // wrote `enabled: false, autoStart: false`; flipping both to true
      // matches the new "local always available" UX so an upgrading
      // station-only user gets a working local fallback for free.
      local: { enabled: true, port: 7315, autoStart: true },
    });
    expect(r.stationTokenToWrite).toBe("abc-token");
    expect(logs.some((l) => l.includes("from-station"))).toBe(true);
  });

  it("handles missing stationUrl gracefully (empty string)", () => {
    const { io } = makeIo({ store: { mode: "station" } });
    const r = planMigration(io);
    expect(r.settings?.station?.url).toBe("");
    expect(r.stationTokenToWrite).toBe("");
  });

  it("does not read projects.toml on the station path", () => {
    let read = false;
    const io: MigrationIo = {
      readKey: (k) => (k === "mode" ? "station" : null),
      hasKey: () => false,
      readProjectsToml: () => {
        read = true;
        return "[[projects]]\nid = \"shouldnt-load\"";
      },
      log: () => {},
    };
    planMigration(io);
    expect(read).toBe(false);
  });
});

describe("planMigration — mode === 'local'", () => {
  it("produces the canonical local block (autoStart=true) with no station", () => {
    const { io } = makeIo({ store: { mode: "local" } });
    const r = planMigration(io);
    expect(r.migrated).toBe(true);
    expect(r.reason).toBe("from-local");
    expect(r.settings).toEqual({
      local: { enabled: true, port: 7315, autoStart: true },
    });
  });

  it("logs every project ID found in projects.toml", () => {
    const toml = [
      "# header comment",
      "",
      "[[projects]]",
      'id = "alpha"',
      "cwd = \"/some/path\"",
      "",
      "[[projects]]",
      'id = "bravo"',
      "claude_args = \"\"",
      "",
      "[[projects]]",
      "id = 'charlie'",
    ].join("\n");
    const { io, logs } = makeIo({ store: { mode: "local" }, toml });
    const r = planMigration(io);
    expect(r.loggedLocalProjectIds).toEqual(["alpha", "bravo", "charlie"]);
    // The user-visible recovery trail: every id appears as its own
    // "  - id" line, plus a header line that names the count.
    expect(logs.some((l) => l.includes("3 project(s)"))).toBe(true);
    expect(logs.filter((l) => l.startsWith("  - "))).toHaveLength(3);
    expect(logs.find((l) => l.includes("  - alpha"))).toBeTruthy();
    expect(logs.find((l) => l.includes("  - charlie"))).toBeTruthy();
  });

  it("logs a 'no entries' warning when toml is empty", () => {
    const { io, logs } = makeIo({ store: { mode: "local" }, toml: "" });
    const r = planMigration(io);
    expect(r.loggedLocalProjectIds).toEqual([]);
    expect(logs.some((l) => l.includes("no [[projects]] entries"))).toBe(true);
  });

  it("logs a 'missing/unreadable' warning when toml is null", () => {
    const { io, logs } = makeIo({ store: { mode: "local" }, toml: null });
    const r = planMigration(io);
    expect(r.loggedLocalProjectIds).toEqual([]);
    expect(logs.some((l) => l.includes("missing or unreadable"))).toBe(true);
    expect(r.migrated).toBe(true); // missing toml never blocks the migration
  });
});

describe("extractProjectIdsFromToml", () => {
  it("returns an empty array on empty input", () => {
    expect(extractProjectIdsFromToml("")).toEqual([]);
  });

  it("ignores files that don't have any [[projects]] block", () => {
    expect(
      extractProjectIdsFromToml("[other]\nfoo = \"bar\""),
    ).toEqual([]);
  });

  it("extracts a single id following the [[projects]] header", () => {
    const toml = '[[projects]]\nid = "alpha"\n';
    expect(extractProjectIdsFromToml(toml)).toEqual(["alpha"]);
  });

  it("extracts multiple ids", () => {
    const toml =
      '[[projects]]\nid = "a"\n\n[[projects]]\nid = "b"\n\n[[projects]]\nid = "c"\n';
    expect(extractProjectIdsFromToml(toml)).toEqual(["a", "b", "c"]);
  });

  it("accepts both single- and double-quoted ids", () => {
    const toml = "[[projects]]\nid = 'alpha'\n[[projects]]\nid = \"bravo\"\n";
    expect(extractProjectIdsFromToml(toml)).toEqual(["alpha", "bravo"]);
  });

  it("tolerates whitespace around the header and the assignment", () => {
    const toml = '  [[ projects ]]  \n   id    =    "zulu"   \n';
    expect(extractProjectIdsFromToml(toml)).toEqual(["zulu"]);
  });

  it("skips comment lines and trailing comments", () => {
    const toml =
      '# top comment\n[[projects]]\n# inner comment\nid = "alpha" # trailing comment\n';
    expect(extractProjectIdsFromToml(toml)).toEqual(["alpha"]);
  });

  it("ignores extra fields between header and id", () => {
    // The first line that matches `id = ...` after the header wins; an
    // unrelated `cwd = ...` doesn't trip the regex.
    const toml =
      '[[projects]]\ncwd = "/x"\nclaude_args = ""\nid = "found"\n';
    expect(extractProjectIdsFromToml(toml)).toEqual(["found"]);
  });

  it("ends a projects scope on a different table header", () => {
    // After `[other]`, an `id = "..."` line is no longer harvested.
    const toml = '[[projects]]\nid = "a"\n[other]\nid = "skip"\n';
    expect(extractProjectIdsFromToml(toml)).toEqual(["a"]);
  });

  it("only takes the first id per [[projects]] block", () => {
    // The canonical writer never emits two `id =` lines, but if the
    // user hand-edits, we don't want to double-count.
    const toml = '[[projects]]\nid = "first"\nid = "ignored"\n';
    expect(extractProjectIdsFromToml(toml)).toEqual(["first"]);
  });
});
