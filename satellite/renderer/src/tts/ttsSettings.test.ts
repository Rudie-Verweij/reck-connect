import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadTtsSettings,
  saveTtsSettings,
  DEFAULT_TTS_SETTINGS,
  TTS_CONFIG_KEY,
} from "./ttsSettings";

interface FakeReckAPI {
  config: {
    get: <T>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<boolean>;
  };
}

function installFakeAPI(): {
  store: Map<string, unknown>;
  api: FakeReckAPI;
} {
  const store = new Map<string, unknown>();
  const api: FakeReckAPI = {
    config: {
      get: async <T>(k: string) => (store.has(k) ? (store.get(k) as T) : null),
      set: async (k: string, v: unknown) => {
        store.set(k, v);
        return true;
      },
    },
  };
  (window as unknown as { reckAPI: FakeReckAPI }).reckAPI = api;
  return { store, api };
}

describe("loadTtsSettings", () => {
  beforeEach(() => {
    installFakeAPI();
  });

  it("returns DEFAULT_TTS_SETTINGS when nothing is persisted", async () => {
    const s = await loadTtsSettings();
    expect(s).toEqual(DEFAULT_TTS_SETTINGS);
    expect(s.rate).toBe(1.0);
    expect(s.voice).toBe(null);
  });

  it("returns the persisted value when present", async () => {
    const { api } = installFakeAPI();
    await api.config.set(TTS_CONFIG_KEY, { voice: "Samantha", rate: 1.25 });
    const s = await loadTtsSettings();
    expect(s).toEqual({ voice: "Samantha", rate: 1.25 });
  });

  it("snaps an out-of-range persisted rate at load time", async () => {
    const { api } = installFakeAPI();
    await api.config.set(TTS_CONFIG_KEY, { voice: null, rate: 12 });
    const s = await loadTtsSettings();
    expect(s.rate).toBe(6.0);
  });

  it("snaps an in-range but non-step rate to the nearest 0.05", async () => {
    const { api } = installFakeAPI();
    await api.config.set(TTS_CONFIG_KEY, { voice: null, rate: 1.27 });
    const s = await loadTtsSettings();
    expect(s.rate).toBe(1.25);
  });

  it("falls back to defaults when persisted value is malformed", async () => {
    const { api } = installFakeAPI();
    await api.config.set(TTS_CONFIG_KEY, "not an object");
    const s = await loadTtsSettings();
    expect(s).toEqual(DEFAULT_TTS_SETTINGS);
  });

  it("coerces a non-string voice to null", async () => {
    const { api } = installFakeAPI();
    await api.config.set(TTS_CONFIG_KEY, { voice: 42, rate: 1.0 });
    const s = await loadTtsSettings();
    expect(s.voice).toBe(null);
  });
});

describe("saveTtsSettings", () => {
  beforeEach(() => {
    installFakeAPI();
  });

  it("writes the snapped rate", async () => {
    const { store } = installFakeAPI();
    await saveTtsSettings({ voice: "Daniel", rate: 1.27 });
    expect(store.get(TTS_CONFIG_KEY)).toEqual({
      voice: "Daniel",
      rate: 1.25,
    });
  });

  it("writes a null voice as null (not omitted)", async () => {
    const { store } = installFakeAPI();
    await saveTtsSettings({ voice: null, rate: 1.0 });
    expect(store.get(TTS_CONFIG_KEY)).toEqual({ voice: null, rate: 1.0 });
  });
});
