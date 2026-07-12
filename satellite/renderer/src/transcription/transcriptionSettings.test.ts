import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  coerce,
  embeddedModelRepo,
} from "./transcriptionSettings";

describe("transcriptionSettings.coerce", () => {
  it("returns defaults for non-objects", () => {
    expect(coerce(null)).toEqual(DEFAULT_TRANSCRIPTION_SETTINGS);
    expect(coerce(undefined)).toEqual(DEFAULT_TRANSCRIPTION_SETTINGS);
    expect(coerce("nope")).toEqual(DEFAULT_TRANSCRIPTION_SETTINGS);
    expect(coerce(42)).toEqual(DEFAULT_TRANSCRIPTION_SETTINGS);
    expect(coerce([])).toEqual(DEFAULT_TRANSCRIPTION_SETTINGS);
  });

  it("defaults to local provider, turbo model, enabled", () => {
    expect(DEFAULT_TRANSCRIPTION_SETTINGS.provider).toBe("local");
    expect(DEFAULT_TRANSCRIPTION_SETTINGS.localModel).toBe("whisper-large-v3-turbo");
    expect(DEFAULT_TRANSCRIPTION_SETTINGS.enabled).toBe(true);
  });

  it("keeps a valid full object", () => {
    const input = {
      enabled: false,
      provider: "deepgram",
      localModel: "whisper-tiny",
      hotkeyToggle: "Mod+Shift+D",
      hotkeyPushToTalk: "Ctrl+Space",
      autoSubmit: true,
    };
    expect(coerce(input)).toEqual(input);
  });

  it("falls back on an unknown provider", () => {
    expect(coerce({ provider: "azure" }).provider).toBe("local");
  });

  it("falls back on an unknown model id", () => {
    expect(coerce({ localModel: "whisper-huge" }).localModel).toBe(
      DEFAULT_TRANSCRIPTION_SETTINGS.localModel,
    );
  });

  it("trims and rejects empty hotkeys", () => {
    expect(coerce({ hotkeyToggle: "  Mod+K  " }).hotkeyToggle).toBe("Mod+K");
    expect(coerce({ hotkeyToggle: "   " }).hotkeyToggle).toBe(
      DEFAULT_TRANSCRIPTION_SETTINGS.hotkeyToggle,
    );
    expect(coerce({ hotkeyToggle: 123 }).hotkeyToggle).toBe(
      DEFAULT_TRANSCRIPTION_SETTINGS.hotkeyToggle,
    );
  });

  it("coerces non-boolean flags to their defaults", () => {
    expect(coerce({ enabled: "yes" }).enabled).toBe(DEFAULT_TRANSCRIPTION_SETTINGS.enabled);
    expect(coerce({ autoSubmit: 1 }).autoSubmit).toBe(false);
  });

  it("ignores unknown extra keys", () => {
    expect(coerce({ provider: "deepgram", bogus: true })).toEqual({
      ...DEFAULT_TRANSCRIPTION_SETTINGS,
      provider: "deepgram",
    });
  });
});

describe("embeddedModelRepo", () => {
  it("maps each model id to a HF repo", () => {
    expect(embeddedModelRepo("whisper-large-v3-turbo")).toBe(
      "onnx-community/whisper-large-v3-turbo",
    );
    expect(embeddedModelRepo("whisper-tiny")).toBe("Xenova/whisper-tiny");
  });
});
