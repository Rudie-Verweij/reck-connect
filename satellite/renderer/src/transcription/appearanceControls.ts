// The ONE appearance-controls component, shared by the right-click "Advanced"
// panel (dictationAdvancedPanel.ts) AND the tuning lab (dictation-lab.ts). Both
// render the exact same rows from the same descriptor list, so whatever you dial
// in the lab is literally the control the app ships — no divergence.
//
// Every knob carries a `help` string; each row exposes an ℹ️ info affordance
// whose hover/focus reveals it (plus a native `title` fallback), so no parameter
// is a mystery. All styling lives in styles.css under `.dict-ctrl-*`, themed by
// the host's `--app-*` CSS variables (the lab aliases them to its palette).

import {
  coerceAppearance,
  DEFAULT_APPEARANCE,
  type DictationAppearance,
} from "./transcriptionSettings";

/** Numeric knobs (rendered as sliders). */
type NumericKey =
  | "crystallizeMs"
  | "charStaggerMs"
  | "blurStartPx"
  | "blurRestPx"
  | "placeholderBlurPx"
  | "onsetOpen"
  | "onsetClose"
  | "commitWordCount"
  | "commitPauseMs"
  | "settleMs"
  | "ghostResetMs"
  | "tailFontPx";

/** Boolean knobs (rendered as checkboxes). */
type BoolKey = "showBlobs" | "textOutline";

interface SubheadDesc {
  kind: "subhead";
  label: string;
}
interface SliderDesc {
  kind: "slider";
  key: NumericKey;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}
interface CheckDesc {
  kind: "check";
  key: BoolKey;
  label: string;
  help: string;
}
interface SelectDesc {
  kind: "select";
  key: "pillTheme" | "ghostMode";
  label: string;
  help: string;
  options: readonly string[];
}
export type ControlDesc = SubheadDesc | SliderDesc | CheckDesc | SelectDesc;

/**
 * The complete, grouped control list. This is the single source of truth for
 * label text, help/tooltip copy, and slider bounds/steps — edit it here and
 * BOTH the panel and the lab update together.
 */
export const APPEARANCE_CONTROLS: readonly ControlDesc[] = [
  { kind: "subhead", label: "Crystallize" },
  {
    kind: "slider",
    key: "crystallizeMs",
    label: "Crystallize (ms)",
    help: "Per-character de-blur duration. Lower = each letter snaps sharp faster. 0–2000 ms.",
    min: 0,
    max: 2000,
    step: 10,
    unit: "ms",
  },
  {
    kind: "slider",
    key: "charStaggerMs",
    label: "Char stagger (ms)",
    help: "Delay between successive letters de-blurring — the left→right sweep speed. 0–200 ms.",
    min: 0,
    max: 200,
    step: 1,
    unit: "ms",
  },
  {
    kind: "slider",
    key: "blurStartPx",
    label: "Blur start (px)",
    help: "Starting blur of a fresh crystallizing char — how illegible it begins. 0–20 px.",
    min: 0,
    max: 20,
    step: 0.5,
    unit: "px",
  },
  {
    kind: "slider",
    key: "blurRestPx",
    label: "Blur rest (px)",
    help: "Resting blur once crystallized — the lingering 'still a ghost' softness. 0–8 px.",
    min: 0,
    max: 8,
    step: 0.1,
    unit: "px",
  },
  {
    kind: "slider",
    key: "placeholderBlurPx",
    label: "Placeholder blur (px)",
    help: "Heavy blur of a heard-but-unknown word blob (▓ run) before it crystallizes into a word. 0–20 px.",
    min: 0,
    max: 20,
    step: 0.5,
    unit: "px",
  },

  { kind: "subhead", label: "Word detection" },
  {
    kind: "select",
    key: "ghostMode",
    label: "Ghost mode",
    help: "How placeholders are counted: 'onset' = one per detected word onset (instant, accurate); 'estimate' = older voiced-time guess.",
    options: ["onset", "estimate"],
  },
  {
    kind: "slider",
    key: "onsetOpen",
    label: "Onset open (RMS)",
    help: "Mic energy to START a word (higher = needs louder speech). Room/mic dependent. 0.001–0.2.",
    min: 0.001,
    max: 0.2,
    step: 0.001,
    unit: "",
  },
  {
    kind: "slider",
    key: "onsetClose",
    label: "Onset close (RMS)",
    help: "Mic energy to END a word (hysteresis; below onset open). 0.001–0.2.",
    min: 0.001,
    max: 0.2,
    step: 0.001,
    unit: "",
  },

  { kind: "subhead", label: "Chunking" },
  {
    kind: "slider",
    key: "commitWordCount",
    label: "Commit after (words)",
    help: "Drop the pill's crystallized phrase into the terminal once it reaches this many words. 1–20.",
    min: 1,
    max: 20,
    step: 1,
    unit: "w",
  },
  {
    kind: "slider",
    key: "commitPauseMs",
    label: "Commit on pause (ms)",
    help: "…or after this much silence, whichever comes first — flushes the current phrase. 150–3000 ms.",
    min: 150,
    max: 3000,
    step: 50,
    unit: "ms",
  },

  { kind: "subhead", label: "Timing" },
  {
    kind: "slider",
    key: "settleMs",
    label: "Settle (ms)",
    help: "How often buffered updates flush to the pill — batches churn into calm steps. 80–2000 ms.",
    min: 80,
    max: 2000,
    step: 10,
    unit: "ms",
  },
  {
    kind: "slider",
    key: "ghostResetMs",
    label: "Ghost reset (ms)",
    help: "Clear stale ghost text after this much silence with nothing pending. 300–10000 ms.",
    min: 300,
    max: 10000,
    step: 100,
    unit: "ms",
  },

  { kind: "subhead", label: "Look" },
  {
    kind: "slider",
    key: "tailFontPx",
    label: "Tail font (px)",
    help: "Font size of the ghost-tail / crystallizing text. 9–28 px.",
    min: 9,
    max: 28,
    step: 1,
    unit: "px",
  },
  {
    kind: "check",
    key: "showBlobs",
    label: "Show word placeholders",
    help: "Show the leading heavily-blurred blobs for words heard but not yet transcribed.",
  },
  {
    kind: "select",
    key: "pillTheme",
    label: "Pill theme",
    help: "Pill background theme. 'auto' follows the app/lab theme.",
    options: ["auto", "dark", "light"],
  },
  {
    kind: "check",
    key: "textOutline",
    label: "Text outline",
    help: "Draw a contrast outline behind ghost text for legibility over any pane content.",
  },
];

export interface AppearanceControlsHandle {
  /** The current (coerced) appearance value. */
  getValue(): DictationAppearance;
  /** Replace the value and re-sync every control's DOM (used by Reset). */
  setAll(next: DictationAppearance): void;
}

export interface RenderAppearanceControlsOpts {
  current: DictationAppearance;
  /** Called on EVERY change with the full next (coerced) appearance. */
  onChange: (next: DictationAppearance) => void;
}

/** Decimals to display for a slider, derived from its step (0.001→3, 0.1→1, 1→0). */
function decimalsFor(step: number): number {
  return step < 1 ? Math.max(1, Math.ceil(-Math.log10(step))) : 0;
}

/** Build the ℹ️ info affordance whose hover/focus shows `help`. */
function makeInfo(help: string): HTMLElement {
  const info = document.createElement("span");
  info.className = "dict-ctrl-info";
  info.tabIndex = 0;
  info.setAttribute("role", "img");
  info.setAttribute("aria-label", help);
  info.title = help; // native fallback
  info.textContent = "ⓘ";
  const tip = document.createElement("span");
  tip.className = "dict-ctrl-tip";
  tip.textContent = help;
  info.appendChild(tip);
  return info;
}

/**
 * Render the shared appearance controls into `host`. Returns a handle to read
 * the value and to re-sync the DOM after an external change (Reset). All rows
 * use `.dict-ctrl-*` classes (styled in styles.css); the host supplies the
 * palette via `--app-*` variables.
 */
export function renderAppearanceControls(
  host: HTMLElement,
  opts: RenderAppearanceControlsOpts,
): AppearanceControlsHandle {
  let state: DictationAppearance = coerceAppearance(opts.current);
  const syncers: (() => void)[] = [];

  const emit = (): void => {
    state = coerceAppearance(state);
    opts.onChange(state);
  };

  const labelWithInfo = (text: string, help: string): HTMLElement => {
    const label = document.createElement("span");
    label.className = "dict-ctrl-label";
    label.append(document.createTextNode(text), makeInfo(help));
    return label;
  };

  const addSlider = (spec: SliderDesc): void => {
    const row = document.createElement("div");
    row.className = "dict-ctrl-row dict-ctrl-slider";

    const labelRow = document.createElement("div");
    labelRow.className = "dict-ctrl-labelrow";
    const readout = document.createElement("span");
    readout.className = "dict-ctrl-readout";
    labelRow.append(labelWithInfo(spec.label, spec.help), readout);

    const range = document.createElement("input");
    range.type = "range";
    range.className = "dict-ctrl-range";
    range.min = String(spec.min);
    range.max = String(spec.max);
    range.step = String(spec.step);

    const decimals = decimalsFor(spec.step);
    const fmt = (n: number): string =>
      `${decimals > 0 ? n.toFixed(decimals) : String(Math.round(n))}${spec.unit}`;

    const sync = (): void => {
      const v = state[spec.key];
      range.value = String(v);
      readout.textContent = fmt(v);
    };
    sync();
    syncers.push(sync);

    range.addEventListener("input", () => {
      const raw = Number(range.value);
      const v = Number.isFinite(raw) ? raw : DEFAULT_APPEARANCE[spec.key];
      state = { ...state, [spec.key]: v };
      readout.textContent = fmt(v);
      emit();
    });

    row.append(labelRow, range);
    host.appendChild(row);
  };

  const addCheck = (spec: CheckDesc): void => {
    const row = document.createElement("label");
    row.className = "dict-ctrl-row dict-ctrl-check";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "dict-ctrl-checkbox";

    const sync = (): void => {
      check.checked = state[spec.key];
    };
    sync();
    syncers.push(sync);

    check.addEventListener("change", () => {
      state = { ...state, [spec.key]: check.checked };
      emit();
    });

    row.append(labelWithInfo(spec.label, spec.help), check);
    host.appendChild(row);
  };

  const addSelect = (spec: SelectDesc): void => {
    const row = document.createElement("label");
    row.className = "dict-ctrl-row dict-ctrl-select";

    const select = document.createElement("select");
    select.className = "dict-ctrl-selectbox";
    for (const opt of spec.options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    }

    const sync = (): void => {
      select.value = String(state[spec.key]);
    };
    sync();
    syncers.push(sync);

    select.addEventListener("change", () => {
      const v = select.value;
      if (spec.key === "pillTheme") {
        state = { ...state, pillTheme: v === "dark" || v === "light" ? v : "auto" };
      } else {
        state = { ...state, ghostMode: v === "estimate" ? "estimate" : "onset" };
      }
      emit();
    });

    row.append(labelWithInfo(spec.label, spec.help), select);
    host.appendChild(row);
  };

  const addSubhead = (spec: SubheadDesc): void => {
    const h = document.createElement("div");
    h.className = "dict-ctrl-subhead";
    h.textContent = spec.label;
    host.appendChild(h);
  };

  for (const desc of APPEARANCE_CONTROLS) {
    switch (desc.kind) {
      case "subhead":
        addSubhead(desc);
        break;
      case "slider":
        addSlider(desc);
        break;
      case "check":
        addCheck(desc);
        break;
      case "select":
        addSelect(desc);
        break;
    }
  }

  return {
    getValue: () => state,
    setAll: (next) => {
      state = coerceAppearance(next);
      for (const sync of syncers) sync();
    },
  };
}
