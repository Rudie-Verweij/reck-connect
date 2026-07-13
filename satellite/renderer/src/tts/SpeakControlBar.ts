import { snapRate } from "./TtsEngine";
import type { TtsTheme } from "./ttsTheme";

export type SpeakState = "idle" | "playing" | "paused";

/** One selectable voice in the picker (structural subset of
 *  SpeechSynthesisVoice so tests can pass plain objects). */
export interface VoiceOption {
  name: string;
  lang: string;
}

export interface SpeakControlBarCallbacks {
  onPlay(): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  onRateChange(rate: number): void;
  /** User picked a voice in the expanded picker; null = automatic. */
  onVoiceChange?(name: string | null): void;
}

export interface SpeakControlBarOptions {
  parent: HTMLElement;
  theme: TtsTheme;
  callbacks: SpeakControlBarCallbacks;
  initialRate?: number;
  voiceName?: string;
  /** Currently persisted voice name (null/undefined = automatic). */
  selectedVoice?: string | null;
  /** Lazily lists the selectable voices when the picker first opens. */
  getVoiceOptions?: () => Promise<VoiceOption[]>;
}

export interface SpeakControlBar {
  show(): void;
  hide(): void;
  setState(state: SpeakState): void;
  setRate(rate: number): void;
  setVoiceName(name: string): void;
  setSelectedVoice(name: string | null): void;
  setTheme(theme: TtsTheme): void;
  dispose(): void;
}

const SVG_PLAY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><polygon points="3,2 13,8 3,14" fill="currentColor"/></svg>';
const SVG_PAUSE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="2" width="3" height="12" fill="currentColor"/><rect x="10" y="2" width="3" height="12" fill="currentColor"/></svg>';
const SVG_STOP = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="3" width="10" height="10" fill="currentColor"/></svg>';

/** Human-readable language name for a BCP-47 primary subtag ("nl" → "Dutch"),
 *  falling back to the uppercased code when Intl can't resolve it. */
function languageDisplayName(subtag: string): string {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    return names.of(subtag) ?? subtag.toUpperCase();
  } catch {
    return subtag.toUpperCase();
  }
}

function primarySubtag(lang: string): string {
  return lang.toLowerCase().replace(/_/g, "-").split("-")[0] || "en";
}

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

  const minusBtn = document.createElement("button");
  minusBtn.className = "tts-btn tts-rate-step tts-rate-minus";
  minusBtn.setAttribute("aria-label", "Slower");
  minusBtn.title = "Slower (−0.05)";
  minusBtn.type = "button";
  minusBtn.textContent = "−";

  const plusBtn = document.createElement("button");
  plusBtn.className = "tts-btn tts-rate-step tts-rate-plus";
  plusBtn.setAttribute("aria-label", "Faster");
  plusBtn.title = "Faster (+0.05)";
  plusBtn.type = "button";
  plusBtn.textContent = "+";

  const slider = document.createElement("input");
  slider.className = "tts-rate-slider";
  slider.type = "range";
  slider.min = "0.5";
  slider.max = "6";
  slider.step = "0.05";
  slider.value = String(opts.initialRate ?? 1.0);
  slider.setAttribute("aria-label", "Speech rate");
  slider.title = "Speech rate — drag, or ⌘⇧+ / ⌘⇧- in steps of 0.05";

  // The rate readout doubles as a button: click → type an exact rate.
  const rateLabel = document.createElement("button");
  rateLabel.className = "tts-rate-label";
  rateLabel.type = "button";
  rateLabel.title = "Click to type a speed";
  rateLabel.setAttribute("aria-label", "Speech rate — click to type a value");
  rateLabel.textContent = `${slider.value}×`;

  const rateInput = document.createElement("input");
  rateInput.className = "tts-rate-input";
  rateInput.type = "text";
  rateInput.inputMode = "decimal";
  rateInput.setAttribute("aria-label", "Speech rate value");
  rateInput.hidden = true;

  const voiceBtn = document.createElement("button");
  voiceBtn.className = "tts-voice-label";
  voiceBtn.type = "button";
  voiceBtn.title = "Choose voice";
  voiceBtn.setAttribute("aria-label", "Choose voice");
  voiceBtn.setAttribute("aria-expanded", "false");
  const voiceBtnText = document.createElement("span");
  voiceBtnText.className = "tts-voice-name";
  voiceBtnText.textContent = opts.voiceName ?? "";
  const voiceBtnCaret = document.createElement("span");
  voiceBtnCaret.className = "tts-voice-caret";
  voiceBtnCaret.textContent = "▾";
  voiceBtn.appendChild(voiceBtnText);
  voiceBtn.appendChild(voiceBtnCaret);

  root.appendChild(playBtn);
  root.appendChild(pauseBtn);
  root.appendChild(stopBtn);
  root.appendChild(minusBtn);
  root.appendChild(slider);
  root.appendChild(plusBtn);
  root.appendChild(rateLabel);
  root.appendChild(rateInput);
  root.appendChild(voiceBtn);

  let state: SpeakState = "idle";
  let suppressInput = false;
  let currentRate = snapRate(opts.initialRate ?? 1.0);
  let editingRate = false;

  // Reflect a rate everywhere it shows. `animate` gives the readout a
  // slight, mellow pulse — used for discrete changes (± steps, typed
  // values), not for continuous slider drags where it would flicker.
  const updateRateUI = (r: number, animate: boolean) => {
    currentRate = r;
    suppressInput = true;
    slider.value = String(r);
    suppressInput = false;
    rateLabel.textContent = `${r}×`;
    if (animate) {
      rateLabel.classList.remove("tts-rate-pulse");
      // Force a reflow so re-adding the class restarts the animation.
      void rateLabel.offsetWidth;
      rateLabel.classList.add("tts-rate-pulse");
    }
  };

  const applyRate = (raw: number) => {
    const snapped = snapRate(raw);
    updateRateUI(snapped, true);
    opts.callbacks.onRateChange(snapped);
  };

  // ── Type-a-speed editing ──────────────────────────────────────────
  const startEditRate = () => {
    editingRate = true;
    rateInput.value = String(currentRate);
    rateLabel.hidden = true;
    rateInput.hidden = false;
    rateInput.focus();
    rateInput.select();
  };

  const endEditRate = () => {
    editingRate = false;
    rateInput.hidden = true;
    rateLabel.hidden = false;
  };

  const commitEditRate = () => {
    if (!editingRate) return;
    const raw = rateInput.value.trim().replace(",", ".");
    const num = raw === "" ? NaN : Number(raw);
    endEditRate();
    // Reject empty / non-numeric / non-positive input — keep the old
    // rate. Valid values are clamped to [0.5, 6] and snapped by applyRate.
    if (!Number.isFinite(num) || num <= 0) return;
    applyRate(num);
  };

  // ── Voice picker (expands below the bar) ─────────────────────────
  let selectedVoice: string | null = opts.selectedVoice ?? null;
  let picker: HTMLElement | null = null;
  let pickerOpen = false;
  let voicesByLang = new Map<string, VoiceOption[]>();
  let activeLang: string | null = null;

  const onDocMouseDown = (ev: MouseEvent) => {
    if (!root.contains(ev.target as Node)) closePicker();
  };
  const onDocKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      closePicker();
    }
  };

  function closePicker(): void {
    if (!pickerOpen) return;
    pickerOpen = false;
    root.classList.remove("tts-bar-expanded");
    voiceBtn.setAttribute("aria-expanded", "false");
    if (picker) picker.hidden = true;
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
  }

  async function openPicker(): Promise<void> {
    if (pickerOpen || !opts.getVoiceOptions) return;
    pickerOpen = true;
    root.classList.add("tts-bar-expanded");
    voiceBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);

    if (!picker) {
      let voices: VoiceOption[] = [];
      try {
        voices = await opts.getVoiceOptions();
      } catch {
        voices = [];
      }
      // The await above may resolve after a rapid open→close.
      if (!pickerOpen) return;
      voicesByLang = new Map();
      for (const v of voices) {
        const sub = primarySubtag(v.lang);
        const list = voicesByLang.get(sub);
        if (list) list.push(v);
        else voicesByLang.set(sub, [v]);
      }
      picker = document.createElement("div");
      picker.className = "tts-voice-picker";
      picker.setAttribute("role", "listbox");
      root.appendChild(picker);
    }
    renderPicker();
    if (picker) picker.hidden = false;
  }

  function initialLang(): string {
    if (selectedVoice) {
      for (const [sub, list] of voicesByLang) {
        if (list.some((v) => v.name === selectedVoice)) return sub;
      }
    }
    const navLang = primarySubtag(
      typeof navigator !== "undefined" ? navigator.language || "en" : "en",
    );
    if (voicesByLang.has(navLang)) return navLang;
    if (voicesByLang.has("en")) return "en";
    return voicesByLang.keys().next().value ?? "en";
  }

  function renderPicker(): void {
    if (!picker) return;
    if (activeLang === null || !voicesByLang.has(activeLang)) {
      activeLang = initialLang();
    }
    picker.textContent = "";

    const langCol = document.createElement("div");
    langCol.className = "tts-voice-langs";
    const voiceCol = document.createElement("div");
    voiceCol.className = "tts-voice-list";

    const subtags = [...voicesByLang.keys()].sort((a, b) =>
      languageDisplayName(a).localeCompare(languageDisplayName(b)),
    );
    for (const sub of subtags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tts-voice-lang";
      if (sub === activeLang) btn.classList.add("is-active");
      const nameEl = document.createElement("span");
      nameEl.textContent = languageDisplayName(sub);
      const countEl = document.createElement("span");
      countEl.className = "tts-voice-count";
      countEl.textContent = String(voicesByLang.get(sub)?.length ?? 0);
      btn.appendChild(nameEl);
      btn.appendChild(countEl);
      btn.addEventListener("click", () => {
        activeLang = sub;
        renderPicker();
      });
      langCol.appendChild(btn);
    }

    // "Automatic" row: clear the persisted voice and let the app resolve
    // the best default for the machine.
    const autoRow = document.createElement("button");
    autoRow.type = "button";
    autoRow.className = "tts-voice-option tts-voice-auto";
    if (selectedVoice === null) autoRow.classList.add("is-selected");
    autoRow.textContent = "Automatic (best available)";
    autoRow.addEventListener("click", () => {
      selectedVoice = null;
      opts.callbacks.onVoiceChange?.(null);
      renderPicker();
    });
    voiceCol.appendChild(autoRow);

    for (const v of voicesByLang.get(activeLang) ?? []) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tts-voice-option";
      row.setAttribute("role", "option");
      if (v.name === selectedVoice) row.classList.add("is-selected");
      const nameEl = document.createElement("span");
      nameEl.textContent = v.name;
      const langEl = document.createElement("span");
      langEl.className = "tts-voice-region";
      langEl.textContent = v.lang;
      row.appendChild(nameEl);
      row.appendChild(langEl);
      row.addEventListener("click", () => {
        selectedVoice = v.name;
        opts.callbacks.onVoiceChange?.(v.name);
        renderPicker();
      });
      voiceCol.appendChild(row);
    }

    picker.appendChild(langCol);
    picker.appendChild(voiceCol);
  }

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
  minusBtn.addEventListener("click", () => applyRate(currentRate - 0.05));
  plusBtn.addEventListener("click", () => applyRate(currentRate + 0.05));
  rateLabel.addEventListener("click", startEditRate);
  rateInput.addEventListener("input", () => {
    // Digits plus one decimal separator (dot or comma) only. Stripping
    // everything else also makes negatives untypeable.
    const cleaned = rateInput.value
      .replace(/[^0-9.,]/g, "")
      .replace(/([.,])(?=.*[.,])/g, "");
    if (cleaned !== rateInput.value) rateInput.value = cleaned;
  });
  rateInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      commitEditRate();
    } else if (ev.key === "Escape") {
      // Cancel the edit without stopping playback (Esc is also the
      // global stop-TTS shortcut).
      ev.stopPropagation();
      endEditRate();
    }
  });
  rateInput.addEventListener("blur", () => commitEditRate());
  voiceBtn.addEventListener("click", () => {
    if (pickerOpen) closePicker();
    else void openPicker();
  });
  slider.addEventListener("input", () => {
    if (suppressInput) return;
    const snapped = snapRate(Number(slider.value));
    updateRateUI(snapped, false);
    opts.callbacks.onRateChange(snapped);
  });

  opts.parent.appendChild(root);

  return {
    show: () => {
      root.hidden = false;
    },
    hide: () => {
      closePicker();
      root.hidden = true;
    },
    setState: (s) => {
      state = s;
      applyState();
    },
    setRate: (r) => {
      updateRateUI(snapRate(r), false);
    },
    setVoiceName: (name) => {
      voiceBtnText.textContent = name;
    },
    setSelectedVoice: (name) => {
      selectedVoice = name;
      if (pickerOpen) renderPicker();
    },
    setTheme: (theme) => applyTheme(theme),
    dispose: () => {
      closePicker();
      root.remove();
    },
  };
}
