import { describe, it, expect } from "vitest";
import { createVoiceErrorDetector } from "./voiceErrorDetector";

const ESC = "\x1b";

describe("createVoiceErrorDetector", () => {
  it("fires on Claude Code's voice-failure message", () => {
    const d = createVoiceErrorDetector();
    expect(
      d.push(
        "Voice input is failing repeatedly and has been paused. Check your microphone and try again in a moment.",
      ),
    ).toBe(true);
  });

  it("fires on the underlying ALSA capture error", () => {
    const d = createVoiceErrorDetector();
    expect(
      d.push(
        "ALSA lib pcm_asym.c:105:(_snd_pcm_asym_open) capture slave is not defined\r\n",
      ),
    ).toBe(true);
  });

  it("fires on the SoX 'could not open an audio capture device' message", () => {
    const d = createVoiceErrorDetector();
    expect(
      d.push("Voice mode requires a microphone, but SoX could not open an audio capture device"),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    const d = createVoiceErrorDetector();
    expect(d.push("VOICE INPUT IS FAILING REPEATEDLY")).toBe(true);
  });

  it("matches a phrase split across two output chunks", () => {
    const d = createVoiceErrorDetector();
    expect(d.push("...capture slave ")).toBe(false);
    expect(d.push("is not defined")).toBe(true);
  });

  it("matches through interspersed ANSI color/cursor escapes", () => {
    const d = createVoiceErrorDetector();
    const noisy = `${ESC}[31mVoice input is failing repeatedly${ESC}[0m`;
    expect(d.push(noisy)).toBe(true);
  });

  it("matches when a wrapped line inserts a newline mid-phrase", () => {
    const d = createVoiceErrorDetector();
    expect(d.push("voice input is failing\r\nrepeatedly and has been paused")).toBe(true);
  });

  it("latches: fires once, then never again", () => {
    const d = createVoiceErrorDetector();
    expect(d.push("capture slave is not defined")).toBe(true);
    expect(d.push("capture slave is not defined")).toBe(false);
    expect(d.push("voice input is failing repeatedly")).toBe(false);
  });

  it("ignores ordinary output that merely mentions a microphone", () => {
    const d = createVoiceErrorDetector();
    expect(d.push("I've enabled the microphone in your settings.")).toBe(false);
    expect(d.push("Let me check the audio device configuration.")).toBe(false);
    expect(d.push("$ npm run build\r\nBuild succeeded.\r\n")).toBe(false);
  });

  it("ignores empty chunks", () => {
    const d = createVoiceErrorDetector();
    expect(d.push("")).toBe(false);
  });

  it("reset() clears the latch so it can fire again", () => {
    const d = createVoiceErrorDetector();
    expect(d.push("capture slave is not defined")).toBe(true);
    d.reset();
    expect(d.push("capture slave is not defined")).toBe(true);
  });

  it("does not accumulate unboundedly across a long session", () => {
    const d = createVoiceErrorDetector();
    for (let i = 0; i < 1000; i++) {
      expect(d.push("some ordinary terminal output line ".repeat(4))).toBe(false);
    }
    // Still detects a real failure after lots of noise.
    expect(d.push("capture slave is not defined")).toBe(true);
  });
});
