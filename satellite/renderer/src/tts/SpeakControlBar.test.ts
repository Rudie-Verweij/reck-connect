import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSpeakControlBar } from "./SpeakControlBar";
import { TTS_THEME_LIGHT, TTS_THEME_DARK } from "./ttsTheme";

function makeCallbacks() {
  return {
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onStop: vi.fn(),
    onRateChange: vi.fn(),
  };
}

function setup() {
  document.body.innerHTML = "";
  const parent = document.createElement("div");
  parent.style.position = "relative";
  parent.style.width = "800px";
  parent.style.height = "600px";
  document.body.appendChild(parent);
  return parent;
}

describe("createSpeakControlBar", () => {
  it("appends a control bar element under the parent", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    expect(parent.querySelector(".tts-control-bar")).not.toBeNull();
    bar.dispose();
  });

  it("renders play, pause, stop buttons and a rate slider", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });

    expect(parent.querySelector(".tts-btn-play")).not.toBeNull();
    expect(parent.querySelector(".tts-btn-pause")).not.toBeNull();
    expect(parent.querySelector(".tts-btn-stop")).not.toBeNull();
    const slider = parent.querySelector<HTMLInputElement>(".tts-rate-slider");
    expect(slider).not.toBeNull();
    expect(slider!.type).toBe("range");
    expect(slider!.min).toBe("0.5");
    expect(slider!.max).toBe("6");
    expect(slider!.step).toBe("0.05");
    bar.dispose();
  });

  it("starts with the initial rate when provided", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
      initialRate: 1.25,
    });
    const slider = parent.querySelector<HTMLInputElement>(".tts-rate-slider")!;
    expect(slider.value).toBe("1.25");
    bar.dispose();
  });

  it("defaults to rate 1.0 when no initial provided", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    const slider = parent.querySelector<HTMLInputElement>(".tts-rate-slider")!;
    expect(slider.value).toBe("1");
    bar.dispose();
  });

  it("displays the voice name when provided", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
      voiceName: "Samantha",
    });
    const label = parent.querySelector(".tts-voice-name");
    expect(label?.textContent).toBe("Samantha");
    bar.dispose();
  });
});

describe("SpeakControlBar interactions", () => {
  it("fires onPlay when the play button is clicked from idle state", () => {
    const parent = setup();
    const cbs = makeCallbacks();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: cbs,
    });
    bar.setState("idle");
    parent.querySelector<HTMLButtonElement>(".tts-btn-play")!.click();
    expect(cbs.onPlay).toHaveBeenCalledTimes(1);
    bar.dispose();
  });

  it("fires onResume when the play button is clicked from paused state", () => {
    const parent = setup();
    const cbs = makeCallbacks();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: cbs,
    });
    bar.setState("paused");
    parent.querySelector<HTMLButtonElement>(".tts-btn-play")!.click();
    expect(cbs.onResume).toHaveBeenCalledTimes(1);
    expect(cbs.onPlay).not.toHaveBeenCalled();
    bar.dispose();
  });

  it("fires onPause when the pause button is clicked while playing", () => {
    const parent = setup();
    const cbs = makeCallbacks();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: cbs,
    });
    bar.setState("playing");
    parent.querySelector<HTMLButtonElement>(".tts-btn-pause")!.click();
    expect(cbs.onPause).toHaveBeenCalledTimes(1);
    bar.dispose();
  });

  it("fires onStop when the stop button is clicked", () => {
    const parent = setup();
    const cbs = makeCallbacks();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: cbs,
    });
    bar.setState("playing");
    parent.querySelector<HTMLButtonElement>(".tts-btn-stop")!.click();
    expect(cbs.onStop).toHaveBeenCalledTimes(1);
    bar.dispose();
  });

  it("fires onRateChange (snapped to 0.05) when the slider moves", () => {
    const parent = setup();
    const cbs = makeCallbacks();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: cbs,
    });
    const slider = parent.querySelector<HTMLInputElement>(".tts-rate-slider")!;
    slider.value = "1.27";
    slider.dispatchEvent(new Event("input"));
    expect(cbs.onRateChange).toHaveBeenCalledWith(1.25);
    bar.dispose();
  });
});

describe("SpeakControlBar.setState", () => {
  it("hides pause and shows play when state is idle", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    bar.setState("idle");
    const play = parent.querySelector<HTMLButtonElement>(".tts-btn-play")!;
    const pause = parent.querySelector<HTMLButtonElement>(".tts-btn-pause")!;
    expect(play.hidden).toBe(false);
    expect(pause.hidden).toBe(true);
    bar.dispose();
  });

  it("hides play and shows pause when state is playing", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    bar.setState("playing");
    expect(
      parent.querySelector<HTMLButtonElement>(".tts-btn-play")!.hidden,
    ).toBe(true);
    expect(
      parent.querySelector<HTMLButtonElement>(".tts-btn-pause")!.hidden,
    ).toBe(false);
    bar.dispose();
  });

  it("shows play and hides pause when state is paused (so user can resume)", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    bar.setState("paused");
    expect(
      parent.querySelector<HTMLButtonElement>(".tts-btn-play")!.hidden,
    ).toBe(false);
    expect(
      parent.querySelector<HTMLButtonElement>(".tts-btn-pause")!.hidden,
    ).toBe(true);
    bar.dispose();
  });
});

describe("SpeakControlBar visibility", () => {
  it("show() makes the bar visible", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    bar.hide();
    bar.show();
    const el = parent.querySelector<HTMLElement>(".tts-control-bar")!;
    expect(el.hidden).toBe(false);
    bar.dispose();
  });

  it("hide() hides the bar", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    bar.show();
    bar.hide();
    const el = parent.querySelector<HTMLElement>(".tts-control-bar")!;
    expect(el.hidden).toBe(true);
    bar.dispose();
  });
});

describe("SpeakControlBar.setRate", () => {
  it("updates the slider value programmatically (snapped)", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    bar.setRate(1.32);
    const slider = parent.querySelector<HTMLInputElement>(".tts-rate-slider")!;
    expect(slider.value).toBe("1.3");
  });

  it("does NOT fire onRateChange for programmatic updates", () => {
    const parent = setup();
    const cbs = makeCallbacks();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: cbs,
    });
    bar.setRate(1.5);
    expect(cbs.onRateChange).not.toHaveBeenCalled();
    bar.dispose();
  });
});

describe("SpeakControlBar theme", () => {
  it("applies the theme accent color via inline style", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    const el = parent.querySelector<HTMLElement>(".tts-control-bar")!;
    expect(el.style.getPropertyValue("--tts-control-bg")).toBe(
      TTS_THEME_LIGHT.controlBg,
    );
    bar.dispose();
  });

  it("setTheme(...) re-applies new colors", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    bar.setTheme(TTS_THEME_DARK);
    const el = parent.querySelector<HTMLElement>(".tts-control-bar")!;
    expect(el.style.getPropertyValue("--tts-control-bg")).toBe(
      TTS_THEME_DARK.controlBg,
    );
    bar.dispose();
  });
});

describe("SpeakControlBar.setVoiceName", () => {
  it("updates the voice label text", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    bar.setVoiceName("Daniel");
    expect(parent.querySelector(".tts-voice-name")?.textContent).toBe(
      "Daniel",
    );
    bar.dispose();
  });
});

describe("SpeakControlBar rate steppers (±)", () => {
  it("minus and plus step the rate by 0.05 and fire onRateChange", () => {
    const parent = setup();
    const rates: number[] = [];
    const cbs = { ...makeCallbacks(), onRateChange: (r: number) => rates.push(r) };
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: cbs,
      initialRate: 1.0,
    });
    (parent.querySelector(".tts-rate-plus") as HTMLButtonElement).click();
    (parent.querySelector(".tts-rate-plus") as HTMLButtonElement).click();
    (parent.querySelector(".tts-rate-minus") as HTMLButtonElement).click();
    expect(rates).toEqual([1.05, 1.1, 1.05]);
    expect(parent.querySelector(".tts-rate-label")?.textContent).toBe("1.05×");
    bar.dispose();
  });

  it("clamps stepping at the [0.5, 6] bounds", () => {
    const parent = setup();
    const rates: number[] = [];
    const cbs = { ...makeCallbacks(), onRateChange: (r: number) => rates.push(r) };
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: cbs,
      initialRate: 0.5,
    });
    (parent.querySelector(".tts-rate-minus") as HTMLButtonElement).click();
    expect(rates).toEqual([0.5]);
    bar.dispose();
  });

  it("pulses the rate readout on a step", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
      initialRate: 1.0,
    });
    (parent.querySelector(".tts-rate-plus") as HTMLButtonElement).click();
    expect(
      parent.querySelector(".tts-rate-label")?.classList.contains("tts-rate-pulse"),
    ).toBe(true);
    bar.dispose();
  });
});

describe("SpeakControlBar typed rate editing", () => {
  function setupEdit(onRateChange = (_: number) => {}) {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: { ...makeCallbacks(), onRateChange },
      initialRate: 1.25,
    });
    const label = parent.querySelector(".tts-rate-label") as HTMLButtonElement;
    const input = parent.querySelector(".tts-rate-input") as HTMLInputElement;
    return { parent, bar, label, input };
  }

  function type(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event("input"));
  }

  function pressEnter(input: HTMLInputElement) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  }

  it("clicking the readout opens the inline editor prefilled with the rate", () => {
    const { bar, label, input } = setupEdit();
    expect(input.hidden).toBe(true);
    label.click();
    expect(input.hidden).toBe(false);
    expect(label.hidden).toBe(true);
    expect(input.value).toBe("1.25");
    bar.dispose();
  });

  it("commits a typed value on Enter, snapped and clamped", () => {
    const rates: number[] = [];
    const { bar, label, input } = setupEdit((r) => rates.push(r));
    label.click();
    type(input, "2.5");
    pressEnter(input);
    expect(rates).toEqual([2.5]);
    expect(input.hidden).toBe(true);
    // Always two decimals so the readout (and the whole bar) keeps a
    // constant width — "2.50×", never "2.5×" vs "2.05×" jitter.
    expect(label.textContent).toBe("2.50×");
    bar.dispose();
  });

  it("accepts a comma as decimal separator", () => {
    const rates: number[] = [];
    const { bar, label, input } = setupEdit((r) => rates.push(r));
    label.click();
    type(input, "1,75");
    pressEnter(input);
    expect(rates).toEqual([1.75]);
    bar.dispose();
  });

  it("strips non-numeric characters (incl. minus) while typing", () => {
    const { bar, label, input } = setupEdit();
    label.click();
    type(input, "-2a.5x");
    expect(input.value).toBe("2.5");
    bar.dispose();
  });

  it("rejects empty/invalid input and keeps the old rate", () => {
    const rates: number[] = [];
    const { bar, label, input } = setupEdit((r) => rates.push(r));
    label.click();
    type(input, "");
    pressEnter(input);
    expect(rates).toEqual([]);
    expect(label.textContent).toBe("1.25×");
    bar.dispose();
  });

  it("clamps out-of-range typed values into [0.5, 6]", () => {
    const rates: number[] = [];
    const { bar, label, input } = setupEdit((r) => rates.push(r));
    label.click();
    type(input, "99");
    pressEnter(input);
    expect(rates).toEqual([6]);
    label.click();
    type(input, "0.1");
    pressEnter(input);
    expect(rates).toEqual([6, 0.5]);
    bar.dispose();
  });

  it("Escape cancels the edit without changing the rate", () => {
    const rates: number[] = [];
    const { bar, label, input } = setupEdit((r) => rates.push(r));
    label.click();
    type(input, "3");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(rates).toEqual([]);
    expect(input.hidden).toBe(true);
    expect(label.textContent).toBe("1.25×");
    bar.dispose();
  });
});

describe("SpeakControlBar voice picker", () => {
  function flush() {
    return new Promise((r) => setTimeout(r, 0));
  }

  const VOICES = [
    { name: "Zoe (Premium)", lang: "en-US" },
    { name: "Samantha", lang: "en-US" },
    { name: "Ellen", lang: "nl-BE" },
    { name: "Xander", lang: "nl-NL" },
  ];

  function setupPicker(onVoiceChange = (_: string | null) => {}) {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: { ...makeCallbacks(), onVoiceChange },
      voiceName: "EN (Zoe)",
      selectedVoice: "Zoe (Premium)",
      getVoiceOptions: async () => VOICES,
    });
    return { parent, bar };
  }

  it("expands into a language/voice panel when the voice label is clicked", async () => {
    const { parent, bar } = setupPicker();
    expect(parent.querySelector(".tts-voice-picker")).toBeNull();
    (parent.querySelector(".tts-voice-label") as HTMLButtonElement).click();
    await flush();
    const picker = parent.querySelector<HTMLElement>(".tts-voice-picker");
    expect(picker).not.toBeNull();
    expect(picker!.hidden).toBe(false);
    // Languages grouped by primary subtag: English + Dutch.
    const langs = [...parent.querySelectorAll(".tts-voice-lang")].map(
      (el) => el.querySelector("span")?.textContent,
    );
    expect(langs).toContain("English");
    expect(langs).toContain("Dutch");
    bar.dispose();
  });

  it("shows the voices of the selected voice's language, current one marked", async () => {
    const { parent, bar } = setupPicker();
    (parent.querySelector(".tts-voice-label") as HTMLButtonElement).click();
    await flush();
    const selected = parent.querySelector(".tts-voice-option.is-selected");
    expect(selected?.textContent).toContain("Zoe (Premium)");
    bar.dispose();
  });

  it("fires onVoiceChange when a voice is picked, and null for Automatic", async () => {
    const picks: Array<string | null> = [];
    const { parent, bar } = setupPicker((name) => picks.push(name));
    (parent.querySelector(".tts-voice-label") as HTMLButtonElement).click();
    await flush();
    // Switch to Dutch and pick Xander.
    const dutch = [...parent.querySelectorAll<HTMLButtonElement>(".tts-voice-lang")]
      .find((el) => el.textContent?.includes("Dutch"));
    dutch!.click();
    const xander = [...parent.querySelectorAll<HTMLButtonElement>(".tts-voice-option")]
      .find((el) => el.textContent?.includes("Xander"));
    xander!.click();
    expect(picks).toEqual(["Xander"]);
    // Automatic resets to null.
    (parent.querySelector(".tts-voice-auto") as HTMLButtonElement).click();
    expect(picks).toEqual(["Xander", null]);
    bar.dispose();
  });

  it("collapses again when the voice label is re-clicked", async () => {
    const { parent, bar } = setupPicker();
    const label = parent.querySelector(".tts-voice-label") as HTMLButtonElement;
    label.click();
    await flush();
    expect(parent.querySelector<HTMLElement>(".tts-voice-picker")!.hidden).toBe(false);
    label.click();
    expect(parent.querySelector<HTMLElement>(".tts-voice-picker")!.hidden).toBe(true);
    bar.dispose();
  });
});

describe("SpeakControlBar tooltips (shortcut hints)", () => {
  it("play button title shows ⌘⇧S in idle state", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    bar.setState("idle");
    const play = parent.querySelector<HTMLButtonElement>(".tts-btn-play")!;
    expect(play.title).toMatch(/⌘⇧S/);
    expect(play.title.toLowerCase()).toContain("play");
    bar.dispose();
  });

  it("play button title shows ⌘⇧X (resume hint) when paused", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    bar.setState("paused");
    const play = parent.querySelector<HTMLButtonElement>(".tts-btn-play")!;
    expect(play.title).toMatch(/⌘⇧X/);
    expect(play.title.toLowerCase()).toContain("resume");
    bar.dispose();
  });

  it("pause button title shows ⌘⇧X", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    const pause = parent.querySelector<HTMLButtonElement>(".tts-btn-pause")!;
    expect(pause.title).toMatch(/⌘⇧X/);
    expect(pause.title.toLowerCase()).toContain("pause");
    bar.dispose();
  });

  it("stop button title is 'Stop' (no shortcut — Esc was retired as a binding)", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    const stop = parent.querySelector<HTMLButtonElement>(".tts-btn-stop")!;
    expect(stop.title.toLowerCase()).toContain("stop");
    expect(stop.title.toLowerCase()).not.toContain("esc");
    bar.dispose();
  });

  it("rate slider title mentions ⌘⇧+ / ⌘⇧-", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    const slider = parent.querySelector<HTMLInputElement>(".tts-rate-slider")!;
    expect(slider.title).toMatch(/⌘⇧\+/);
    expect(slider.title).toMatch(/⌘⇧-/);
    bar.dispose();
  });
});

describe("SpeakControlBar.dispose", () => {
  it("removes the bar from the DOM", () => {
    const parent = setup();
    const bar = createSpeakControlBar({
      parent,
      theme: TTS_THEME_LIGHT,
      callbacks: makeCallbacks(),
    });
    expect(parent.querySelector(".tts-control-bar")).not.toBeNull();
    bar.dispose();
    expect(parent.querySelector(".tts-control-bar")).toBeNull();
  });
});
