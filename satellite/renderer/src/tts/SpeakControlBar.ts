import { snapRate } from "./TtsEngine";
import type { TtsTheme } from "./ttsTheme";

export type SpeakState = "idle" | "playing" | "paused";

export interface SpeakControlBarCallbacks {
  onPlay(): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  onRateChange(rate: number): void;
}

export interface SpeakControlBarOptions {
  parent: HTMLElement;
  theme: TtsTheme;
  callbacks: SpeakControlBarCallbacks;
  initialRate?: number;
  voiceName?: string;
}

export interface SpeakControlBar {
  show(): void;
  hide(): void;
  setState(state: SpeakState): void;
  setRate(rate: number): void;
  setVoiceName(name: string): void;
  setTheme(theme: TtsTheme): void;
  dispose(): void;
}

const SVG_PLAY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><polygon points="3,2 13,8 3,14" fill="currentColor"/></svg>';
const SVG_PAUSE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="2" width="3" height="12" fill="currentColor"/><rect x="10" y="2" width="3" height="12" fill="currentColor"/></svg>';
const SVG_STOP = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="3" width="10" height="10" fill="currentColor"/></svg>';

export function createSpeakControlBar(
  opts: SpeakControlBarOptions,
): SpeakControlBar {
  const root = document.createElement("div");
  root.className = "tts-control-bar";
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Text-to-speech controls");

  const playBtn = document.createElement("button");
  playBtn.className = "tts-btn tts-btn-play";
  playBtn.setAttribute("aria-label", "Play");
  playBtn.title = "Play (⌘⇧S)";
  playBtn.type = "button";
  playBtn.innerHTML = SVG_PLAY;

  const pauseBtn = document.createElement("button");
  pauseBtn.className = "tts-btn tts-btn-pause";
  pauseBtn.setAttribute("aria-label", "Pause");
  pauseBtn.title = "Pause (⌘⇧X)";
  pauseBtn.type = "button";
  pauseBtn.innerHTML = SVG_PAUSE;

  const stopBtn = document.createElement("button");
  stopBtn.className = "tts-btn tts-btn-stop";
  stopBtn.setAttribute("aria-label", "Stop");
  stopBtn.title = "Stop";
  stopBtn.type = "button";
  stopBtn.innerHTML = SVG_STOP;

  const slider = document.createElement("input");
  slider.className = "tts-rate-slider";
  slider.type = "range";
  slider.min = "0.5";
  slider.max = "6";
  slider.step = "0.05";
  slider.value = String(opts.initialRate ?? 1.0);
  slider.setAttribute("aria-label", "Speech rate");
  slider.title = "Speech rate — drag, or ⌘⇧+ / ⌘⇧- in steps of 0.05";

  const rateLabel = document.createElement("span");
  rateLabel.className = "tts-rate-label";
  rateLabel.textContent = `${slider.value}×`;

  const voiceLabel = document.createElement("span");
  voiceLabel.className = "tts-voice-label";
  voiceLabel.textContent = opts.voiceName ?? "";

  root.appendChild(playBtn);
  root.appendChild(pauseBtn);
  root.appendChild(stopBtn);
  root.appendChild(slider);
  root.appendChild(rateLabel);
  root.appendChild(voiceLabel);

  let state: SpeakState = "idle";
  let suppressInput = false;

  const applyState = () => {
    playBtn.hidden = state === "playing";
    pauseBtn.hidden = state !== "playing";
    // Play button does double duty: shows the Resume hint when paused
    // (since clicking it resumes) and the Play hint otherwise.
    playBtn.title = state === "paused" ? "Resume (⌘⇧X)" : "Play (⌘⇧S)";
    playBtn.setAttribute(
      "aria-label",
      state === "paused" ? "Resume" : "Play",
    );
  };
  applyState();

  const applyTheme = (theme: TtsTheme) => {
    root.style.setProperty("--tts-control-bg", theme.controlBg);
    root.style.setProperty("--tts-control-border", theme.controlBorder);
    root.style.setProperty("--tts-control-text", theme.controlText);
    root.style.setProperty("--tts-control-accent", theme.controlAccent);
  };
  applyTheme(opts.theme);

  playBtn.addEventListener("click", () => {
    if (state === "paused") opts.callbacks.onResume();
    else opts.callbacks.onPlay();
  });
  pauseBtn.addEventListener("click", () => opts.callbacks.onPause());
  stopBtn.addEventListener("click", () => opts.callbacks.onStop());
  slider.addEventListener("input", () => {
    if (suppressInput) return;
    const raw = Number(slider.value);
    const snapped = snapRate(raw);
    if (String(snapped) !== slider.value) {
      slider.value = String(snapped);
    }
    rateLabel.textContent = `${snapped}×`;
    opts.callbacks.onRateChange(snapped);
  });

  opts.parent.appendChild(root);

  return {
    show: () => {
      root.hidden = false;
    },
    hide: () => {
      root.hidden = true;
    },
    setState: (s) => {
      state = s;
      applyState();
    },
    setRate: (r) => {
      const snapped = snapRate(r);
      suppressInput = true;
      slider.value = String(snapped);
      rateLabel.textContent = `${snapped}×`;
      suppressInput = false;
    },
    setVoiceName: (name) => {
      voiceLabel.textContent = name;
    },
    setTheme: (theme) => applyTheme(theme),
    dispose: () => {
      root.remove();
    },
  };
}
