import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Shape the mocked electron surface. `safeStorage.isEncryptionAvailable` and
// `encryptString`/`decryptString` are swapped per-test so we can exercise
// both the encryption-available and encryption-unavailable branches.
type SafeStorageShape = {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
};

const mockState: {
  userDataDir: string;
  safeStorage: SafeStorageShape;
} = {
  userDataDir: "",
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from("ENC:" + s, "utf8"),
    decryptString: (b: Buffer) => {
      const str = b.toString("utf8");
      if (!str.startsWith("ENC:")) throw new Error("not encrypted");
      return str.slice(4);
    },
  },
};

vi.mock("electron", () => ({
  app: {
    getPath: (_key: string) => mockState.userDataDir,
  },
  safeStorage: {
    isEncryptionAvailable: () => mockState.safeStorage.isEncryptionAvailable(),
    encryptString: (s: string) => mockState.safeStorage.encryptString(s),
    decryptString: (b: Buffer) => mockState.safeStorage.decryptString(b),
  },
}));

// Dynamic import so the mock above is in place before `storage.ts` evaluates.
const {
  readConfig,
  writeConfig,
  hasConfigKey,
  isAllowedConfigKey,
  CONFIG_KEYS,
  listSecretConfigKeys,
} = await import("./storage");

describe("storage.CONFIG_KEYS allowlist", () => {
  it("isAllowedConfigKey accepts every key in the tuple", () => {
    for (const k of CONFIG_KEYS) {
      expect(isAllowedConfigKey(k)).toBe(true);
    }
  });

  it("isAllowedConfigKey rejects unknown keys", () => {
    expect(isAllowedConfigKey("notARealKey")).toBe(false);
    expect(isAllowedConfigKey("")).toBe(false);
    expect(isAllowedConfigKey("__proto__")).toBe(false);
    // Common keys that historically might have been used but never landed.
    expect(isAllowedConfigKey("currentProjectId")).toBe(false);
    expect(isAllowedConfigKey("agentLogs:foo")).toBe(false);
  });

  it("isAllowedConfigKey rejects non-string input", () => {
    expect(isAllowedConfigKey(undefined)).toBe(false);
    expect(isAllowedConfigKey(null)).toBe(false);
    expect(isAllowedConfigKey(42)).toBe(false);
    expect(isAllowedConfigKey({})).toBe(false);
    expect(isAllowedConfigKey([])).toBe(false);
  });

  it("every secret key is also in the public CONFIG_KEYS allowlist", () => {
    // Secrets get extra restriction (refused when safeStorage is unavailable),
    // but they MUST also pass the IPC-boundary allowlist check; otherwise the
    // secret would be unwriteable for a different reason than "no encryption".
    const allowed = new Set<string>(CONFIG_KEYS);
    for (const k of listSecretConfigKeys()) {
      expect(allowed.has(k)).toBe(true);
    }
  });

  it("includes every key the renderer is known to read or write today", () => {
    // Audit list — keep in sync with satellite/renderer/src/config.ts and
    // any other reckAPI.config.{get,set} call sites in the renderer. If a
    // renderer call site moves to a new key, BOTH places need updating; this
    // test catches the IPC half.
    const rendererKeys = [
      // Hybrid mode (an earlier release, plan rev 3.1) Phase 2 — the active
      // shape: everything settable via config goes through "settings"
      // (non-secret blob) and "station.token" (secret).
      "settings",
      "station.token",
      // Legacy keys — held one release for rollback. The Phase 2
      // migration writes the new shape and leaves these in place; a
      // downgrade still finds its config.
      "mode",
      "stationUrl",
      "daemonToken",
      // Other persistent settings (no Phase 2 changes here).
      "layouts_v2",
      "railWidth",
      "theme",
      "projectNames",
      "projectOrder",
      "claudeLaunchArgs",
      "claudeLaunchArgsByProject",
    ];
    for (const k of rendererKeys) {
      expect(isAllowedConfigKey(k)).toBe(true);
    }
  });

  it("classifies station.token as a secret (Phase 2)", () => {
    // The new station bearer-token key must trigger the safeStorage
    // refusal path when encryption isn't available — same contract as
    // the legacy `daemonToken` key it replaces.
    expect(listSecretConfigKeys().has("station.token")).toBe(true);
  });

  it("never allows persisting the local-daemon per-spawn token (Phase 5 invariant)", () => {
    // Hybrid mode (an earlier release, plan rev 3.1) Phase 5: the local daemon
    // gets a fresh random 32-byte bearer on every spawn, generated in
    // the Electron main process. The token MUST live only in
    // main-process memory — never persisted, never reachable via the
    // renderer's config IPC. Adding any of these keys to CONFIG_KEYS
    // would silently break that contract by giving a compromised
    // renderer a write-path to disk.
    expect(isAllowedConfigKey("local.token")).toBe(false);
    expect(isAllowedConfigKey("localToken")).toBe(false);
    expect(isAllowedConfigKey("daemon.localToken")).toBe(false);
    // Also assert it isn't classified as a secret (which would mean
    // it lives in CONFIG_KEYS too — see the cross-check above).
    expect(listSecretConfigKeys().has("local.token")).toBe(false);
  });
});

describe("storage.writeConfig / readConfig", () => {
  beforeEach(() => {
    mockState.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reck-storage-"));
    // Default: encryption available.
    mockState.safeStorage.isEncryptionAvailable = () => true;
    mockState.safeStorage.encryptString = (s) => Buffer.from("ENC:" + s, "utf8");
    mockState.safeStorage.decryptString = (b) => {
      const str = b.toString("utf8");
      if (!str.startsWith("ENC:")) throw new Error("not encrypted");
      return str.slice(4);
    };
  });

  it("round-trips a non-secret value when encryption is available", () => {
    writeConfig("theme", "dark");
    expect(readConfig("theme")).toBe("dark");
  });

  it("round-trips a secret value when encryption is available", () => {
    writeConfig("daemonToken", "secret-123");
    expect(readConfig("daemonToken")).toBe("secret-123");
  });

  it("refuses to write a secret when encryption is unavailable", () => {
    mockState.safeStorage.isEncryptionAvailable = () => false;
    expect(() => writeConfig("daemonToken", "secret-123")).toThrow(
      /safeStorage|keychain|encryption|cannot persist/i,
    );
  });

  it("still writes non-secret values when encryption is unavailable", () => {
    mockState.safeStorage.isEncryptionAvailable = () => false;
    expect(() => writeConfig("theme", "light")).not.toThrow();
    expect(readConfig("theme")).toBe("light");
  });

  it("returns null for a secret when encryption is unavailable, even if stored", () => {
    // Write with encryption available…
    writeConfig("daemonToken", "legacy");
    // …then pretend encryption went away on next read (e.g. keychain locked,
    // user moved profile between machines). We must NOT fall back to reading
    // any previously-stored value as plaintext.
    mockState.safeStorage.isEncryptionAvailable = () => false;
    expect(readConfig("daemonToken")).toBeNull();
  });

  it("returns null for a secret that doesn't exist", () => {
    expect(readConfig("daemonToken")).toBeNull();
  });

  it("returns null when decryption fails (corrupt value)", () => {
    // Directly write a non-encrypted value to simulate pre-existing plaintext
    // that shouldn't decode under the new write path.
    const file = path.join(mockState.userDataDir, "config", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ theme: Buffer.from("just-plaintext", "utf8").toString("base64") }),
      "utf8",
    );
    // With encryption available, the stored value fails the ENC: prefix check
    // so decryptString throws and readConfig returns null.
    expect(readConfig("theme")).toBeNull();
  });

  it("overwrites existing values", () => {
    writeConfig("theme", "dark");
    writeConfig("theme", "light");
    expect(readConfig("theme")).toBe("light");
  });

  it("keeps other keys intact when writing one", () => {
    writeConfig("theme", "dark");
    writeConfig("stationUrl", "http://127.0.0.1:7315");
    expect(readConfig("theme")).toBe("dark");
    expect(readConfig("stationUrl")).toBe("http://127.0.0.1:7315");
  });

  // hasConfigKey is the Phase 2 idempotency check — it must return true
  // whenever the key is *present* on disk, even when the value would
  // decrypt to falsy or fail to decrypt entirely. Otherwise re-running
  // the migration after a deliberate `{}` save would clobber it back to
  // the legacy values.
  it("hasConfigKey returns false for an unset key", () => {
    expect(hasConfigKey("settings")).toBe(false);
  });

  it("hasConfigKey returns true after writing, even for an empty object", () => {
    writeConfig("settings", {});
    expect(hasConfigKey("settings")).toBe(true);
  });

  it("hasConfigKey returns true even when readConfig would return null on undecryptable secret", () => {
    writeConfig("station.token", "tok-1");
    // Pretend safeStorage went away: readConfig refuses to return a
    // secret it can't decrypt, but the key is still present on disk —
    // the migration must NOT misread that as "no value, please re-run".
    mockState.safeStorage.isEncryptionAvailable = () => false;
    expect(readConfig("station.token")).toBeNull();
    expect(hasConfigKey("station.token")).toBe(true);
  });
});
