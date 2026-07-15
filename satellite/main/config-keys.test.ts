// Guards the renderer-config ↔ IPC-allowlist contract: every key the
// renderer's config.ts reads or writes through window.reckAPI.config
// must appear in storage.ts's CONFIG_KEYS, or the IPC boundary silently
// rejects it (the exact failure mode that shipped with reckConnectPrompt:
// the save "succeeded" in the UI and persisted nothing).
//
// The sweep is behavioural, not a hand-maintained list: it stubs
// window.reckAPI.config with a recorder, invokes every exported function
// of renderer/src/config.ts with generic arguments, and asserts each key
// that reached the recorder is allowlisted. A new load*/save* helper is
// covered automatically the moment it's exported.
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/unused" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

const { CONFIG_KEYS } = await import("./storage");

describe("renderer config keys are allowlisted in CONFIG_KEYS", () => {
  it("every key touched by renderer config.ts survives the IPC allowlist", async () => {
    const touched = new Set<string>();
    // Seed values so load paths take their deep branches (e.g.
    // loadSettings only reads "station.token" when a station block
    // exists in the persisted settings blob).
    const seeded = new Map<string, unknown>([
      ["settings", { station: { enabled: true, url: "http://s" }, local: { enabled: true, port: 7315, autoStart: true } }],
    ]);
    (globalThis as unknown as { window: { reckAPI: unknown } }).window.reckAPI = {
      config: {
        get: async (k: string) => {
          touched.add(k);
          return seeded.get(k) ?? null;
        },
        set: async (k: string) => {
          touched.add(k);
          return true;
        },
      },
    };

    const config = await import("../renderer/src/config");
    for (const [name, value] of Object.entries(config)) {
      if (typeof value !== "function") continue;
      try {
        // Generic args: string-typed setters persist "x"; object-typed
        // setters read missing fields off the string and persist
        // undefined — either way the recorder sees the key. Pure
        // helpers that throw on the dummy args touch no config, so
        // swallowing is safe.
        await (value as (...args: unknown[]) => unknown)("x", "x");
      } catch {
        void name;
      }
    }

    // Sanity: the sweep actually exercised the config surface.
    for (const sentinel of [
      "settings",
      "station.token",
      "railWidth",
      "railMode",
      "railWiggleEnabled",
      "railWigglePixels",
      "railWiggleLegMs",
      "reckConnectPrompt",
      "theme",
    ]) {
      expect(touched.has(sentinel), `sweep never touched ${sentinel}`).toBe(true);
    }

    const allowlisted = new Set<string>(CONFIG_KEYS);
    const missing = [...touched].filter((k) => !allowlisted.has(k));
    expect(
      missing,
      `keys used by renderer config.ts but missing from CONFIG_KEYS (satellite/main/storage.ts): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
