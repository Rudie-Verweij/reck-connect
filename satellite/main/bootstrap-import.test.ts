import { describe, it, expect } from "vitest";
import {
  planBootstrapImport,
  type BootstrapImportIo,
  type ImportedSettings,
} from "./bootstrap-import";

// First-launch bootstrap import. Pure planner: reads via the supplied
// `BootstrapImportIo` and drives writes through it; tests cover every
// branch (no file, malformed, fresh import, idempotent skip) without
// touching Electron or the filesystem.

interface Recorder {
  io: BootstrapImportIo;
  state: {
    bootstrap: string | null;
    bootstrapRemoved: boolean;
    settingsExists: boolean;
    writtenSettings: ImportedSettings | null;
    writtenToken: string | null;
    logs: string[];
  };
}

function makeIo(opts: {
  bootstrap?: string | null;
  settingsExists?: boolean;
  stationTokenExists?: boolean;
  tokenWriteThrows?: Error;
}): Recorder {
  const state = {
    bootstrap: opts.bootstrap ?? null,
    bootstrapRemoved: false,
    settingsExists: opts.settingsExists ?? false,
    stationTokenExists: opts.stationTokenExists ?? false,
    writtenSettings: null as ImportedSettings | null,
    writtenToken: null as string | null,
    logs: [] as string[],
  };
  const io: BootstrapImportIo = {
    readBootstrap: () => state.bootstrap,
    removeBootstrap: () => {
      state.bootstrap = null;
      state.bootstrapRemoved = true;
    },
    hasSettings: () => state.settingsExists,
    hasStationToken: () => state.stationTokenExists,
    writeSettings: (s) => {
      state.writtenSettings = s;
    },
    writeStationToken: (t) => {
      if (opts.tokenWriteThrows) throw opts.tokenWriteThrows;
      state.writtenToken = t;
    },
    log: (m) => state.logs.push(m),
  };
  return { io, state };
}

describe("planBootstrapImport — no bootstrap file", () => {
  it("returns no-bootstrap and writes nothing", () => {
    const { io, state } = makeIo({});
    const r = planBootstrapImport(io);
    expect(r.imported).toBe(false);
    if (!r.imported) expect(r.reason).toBe("no-bootstrap");
    expect(state.writtenSettings).toBeNull();
    expect(state.writtenToken).toBeNull();
    expect(state.bootstrapRemoved).toBe(false);
  });
});

describe("planBootstrapImport — already configured (idempotency)", () => {
  it("removes bootstrap.json when both settings AND station.token are present", () => {
    const { io, state } = makeIo({
      bootstrap: JSON.stringify({
        stationUrl: "http://your-station:7315",
        daemonToken: "deadbeef",
      }),
      settingsExists: true,
      stationTokenExists: true,
    });
    const r = planBootstrapImport(io);
    expect(r.imported).toBe(false);
    if (!r.imported) expect(r.reason).toBe("already-configured");
    expect(state.writtenSettings).toBeNull();
    expect(state.writtenToken).toBeNull();
    expect(state.bootstrapRemoved).toBe(true);
    expect(state.logs.length).toBeGreaterThan(0);
  });

  it("re-imports when settings is present but station.token was lost (recovery from a partial earlier import)", () => {
    const { io, state } = makeIo({
      bootstrap: JSON.stringify({
        stationUrl: "http://your-station:7315",
        daemonToken: "recoverytoken",
      }),
      settingsExists: true,
      stationTokenExists: false,
    });
    const r = planBootstrapImport(io);
    expect(r.imported).toBe(true);
    expect(state.writtenToken).toBe("recoverytoken");
    expect(state.bootstrapRemoved).toBe(true);
  });
});

describe("planBootstrapImport — successful import", () => {
  it("writes settings + token and unlinks bootstrap.json", () => {
    const { io, state } = makeIo({
      bootstrap: JSON.stringify({
        stationUrl: "http://your-station.tail-scale.ts.net:7315",
        daemonToken: "abc123def456",
      }),
    });
    const r = planBootstrapImport(io);
    expect(r.imported).toBe(true);
    expect(state.writtenSettings).toEqual({
      station: { enabled: true, url: "http://your-station.tail-scale.ts.net:7315" },
      local: { enabled: true, port: 7315, autoStart: true },
    });
    expect(state.writtenToken).toBe("abc123def456");
    expect(state.bootstrapRemoved).toBe(true);
  });

  it("accepts https URLs", () => {
    const { io } = makeIo({
      bootstrap: JSON.stringify({
        stationUrl: "https://your-station:7315",
        daemonToken: "x",
      }),
    });
    const r = planBootstrapImport(io);
    expect(r.imported).toBe(true);
  });
});

describe("planBootstrapImport — malformed input", () => {
  it("rejects unparseable JSON without removing the file", () => {
    const { io, state } = makeIo({ bootstrap: "{not json" });
    const r = planBootstrapImport(io);
    expect(r.imported).toBe(false);
    if (!r.imported) expect(r.reason).toBe("malformed");
    expect(state.bootstrapRemoved).toBe(false);
  });

  it("rejects non-object JSON", () => {
    const { io } = makeIo({ bootstrap: '"just a string"' });
    const r = planBootstrapImport(io);
    expect(r.imported).toBe(false);
    if (!r.imported) expect(r.reason).toBe("malformed");
  });

  it("rejects missing stationUrl", () => {
    const { io } = makeIo({
      bootstrap: JSON.stringify({ daemonToken: "x" }),
    });
    const r = planBootstrapImport(io);
    if (!r.imported) {
      expect(r.reason).toBe("malformed");
      expect(r.detail).toMatch(/stationUrl/);
    }
  });

  it("rejects non-http stationUrl", () => {
    const { io } = makeIo({
      bootstrap: JSON.stringify({
        stationUrl: "ftp://example.com",
        daemonToken: "x",
      }),
    });
    const r = planBootstrapImport(io);
    if (!r.imported) expect(r.reason).toBe("malformed");
  });

  it("rejects empty daemonToken", () => {
    const { io } = makeIo({
      bootstrap: JSON.stringify({
        stationUrl: "http://your-station:7315",
        daemonToken: "",
      }),
    });
    const r = planBootstrapImport(io);
    if (!r.imported) {
      expect(r.reason).toBe("malformed");
      expect(r.detail).toMatch(/daemonToken/);
    }
  });

  it("does not remove a malformed bootstrap so the user can inspect", () => {
    const { io, state } = makeIo({
      bootstrap: JSON.stringify({ stationUrl: "ftp://x", daemonToken: "x" }),
    });
    planBootstrapImport(io);
    expect(state.bootstrapRemoved).toBe(false);
  });
});

describe("planBootstrapImport — token write failure (transactional)", () => {
  it("does NOT write settings if writeStationToken throws", () => {
    const { io, state } = makeIo({
      bootstrap: JSON.stringify({
        stationUrl: "http://your-station:7315",
        daemonToken: "x",
      }),
      tokenWriteThrows: new Error("safeStorage unavailable"),
    });
    const r = planBootstrapImport(io);
    expect(r.imported).toBe(false);
    if (!r.imported) {
      expect(r.reason).toBe("token-write-failed");
      expect(r.detail).toMatch(/safeStorage/);
    }
    expect(state.writtenSettings).toBeNull();
    expect(state.bootstrapRemoved).toBe(false);
  });
});
