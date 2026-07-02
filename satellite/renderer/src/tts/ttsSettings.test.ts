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

  it("returns the persisted value when present (colours default in)", async () => {
    const { api } = installFakeAPI();
    await api.config.set(TTS_CONFIG_KEY, { voice: "Samantha", rate: 1.25 });
    const s = await loadTtsSettings();
    expect(s).toEqual({
      voice: "Samantha",
      rate: 1.25,
      highlightColorLight: DEFAULT_TTS_SETTINGS.highlightColorLight,
      highlightColorDark: DEFAULT_TTS_SETTINGS.highlightColorDark,
    });
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

  it("writes the snapped rate and the colours", async () => {
    const { store } = installFakeAPI();
    await saveTtsSettings({
      voice: "Daniel",
      rate: 1.27,
      highlightColorLight: "#aabbcc",
      highlightColorDark: "#112233",
    });
    expect(store.get(TTS_CONFIG_KEY)).toEqual({
      voice: "Daniel",
      rate: 1.25,
      highlightColorLight: "#aabbcc",
      highlightColorDark: "#112233",
    });
  });

  it("writes a null voice as null (not omitted)", async () => {
    const { store } = installFakeAPI();
    await saveTtsSettings({
      voice: null,
      rate: 1.0,
      highlightColorLight: "#fde68a",
      highlightColorDark: "#696241",
    });
    expect(store.get(TTS_CONFIG_KEY)).toEqual({
      voice: null,
      rate: 1.0,
      highlightColorLight: "#fde68a",
      highlightColorDark: "#696241",
    });
  });
});

describe("highlight colour validation", () => {
  beforeEach(() => {
    installFakeAPI();
  });

  it("keeps valid persisted hex colours (#rrggbb and #rgb)", async () => {
    const { api } = installFakeAPI();
    await api.config.set(TTS_CONFIG_KEY, {
      voice: null,
      rate: 1.0,
      highlightColorLight: "#ff8800",
      highlightColorDark: "#0af",
    });
    const s = await loadTtsSettings();
    expect(s.highlightColorLight).toBe("#ff8800");
    expect(s.highlightColorDark).toBe("#0af");
  });

  it("falls back to defaults for malformed colours", async () => {
    const { api } = installFakeAPI();
    await api.config.set(TTS_CONFIG_KEY, {
      voice: null,
      rate: 1.0,
      highlightColorLight: "rgb(1,2,3)", // not hex
      highlightColorDark: 42, // not a string
    });
    const s = await loadTtsSettings();
    expect(s.highlightColorLight).toBe(DEFAULT_TTS_SETTINGS.highlightColorLight);
    expect(s.highlightColorDark).toBe(DEFAULT_TTS_SETTINGS.highlightColorDark);
  });

  it("normalises an invalid colour to the default on save", async () => {
    const { store } = installFakeAPI();
    await saveTtsSettings({
      voice: null,
      rate: 1.0,
      highlightColorLight: "not-a-color",
      highlightColorDark: "#123456",
    });
    const saved = store.get(TTS_CONFIG_KEY) as { highlightColorLight: string };
    expect(saved.highlightColorLight).toBe(
      DEFAULT_TTS_SETTINGS.highlightColorLight,
    );
  });
});

describe("isHexColor", () => {
  it("validates hex shapes", async () => {
    const { isHexColor } = await import("./ttsSettings");
    expect(isHexColor("#fde68a")).toBe(true);
    expect(isHexColor("#abc")).toBe(true);
    expect(isHexColor("#GGGGGG")).toBe(false);
    expect(isHexColor("fde68a")).toBe(false);
    expect(isHexColor("rgb(0,0,0)")).toBe(false);
    expect(isHexColor(123)).toBe(false);
  });
});
