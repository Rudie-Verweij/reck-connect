// Developer/testing panel opened by right-clicking the floating mic button.
// Lets the user live-tune the dictation overlay's look (blur, timing, font,
// blobs, theme) with immediate apply + persist. Mirrors the positioning,
// clamping, and outside-click/Escape dismissal of languageMenu.ts so it feels
// consistent with the existing mic context menu.

import {
  coerceAppearance,
  DEFAULT_APPEARANCE,
  type DictationAppearance,
} from "./transcriptionSettings";

export interface AdvancedPanelOpts {
  current: DictationAppearance;
  /** Called on EVERY control change with the full next appearance — used for LIVE apply + persist. */
  onChange: (next: DictationAppearance) => void;
  /** Optional: called when the panel closes. */
  onClose?: () => void;
  /**
   * Optional anchor (the mic button's rect). When given, the panel is placed
   * ABOVE the anchor so the live dictation pill (which sits at/next to the
   * mic) stays visible while you drag the sliders. Falls back to below the
   * anchor if there's no room above.
   */
  anchorRect?: { left: number; top: number; bottom: number };
}

/** A numeric range control's static config (label, bounds, step). */
interface RangeFieldSpec {
  key: NumericAppearanceKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

/** Keys of DictationAppearance whose value is a number. */
type NumericAppearanceKey =
  | "crystallizeMs"
  | "charStaggerMs"
  | "blurStartPx"
  | "blurRestPx"
  | "settleMs"
  | "ghostResetMs"
  | "tailFontPx";

const CRYSTALLIZE_FIELDS: readonly RangeFieldSpec[] = [
  { key: "crystallizeMs", label: "Crystallize (ms)", min: 0, max: 2000, step: 1 },
  { key: "charStaggerMs", label: "Char stagger (ms)", min: 0, max: 200, step: 1 },
  { key: "blurStartPx", label: "Blur start (px)", min: 0, max: 20, step: 1 },
  { key: "blurRestPx", label: "Blur rest (px)", min: 0, max: 8, step: 0.1 },
];

const TIMING_FIELDS: readonly RangeFieldSpec[] = [
  { key: "settleMs", label: "Settle (ms)", min: 80, max: 2000, step: 1 },
  { key: "ghostResetMs", label: "Ghost reset (ms)", min: 300, max: 10000, step: 1 },
];

const LOOK_FIELDS: readonly RangeFieldSpec[] = [
  { key: "tailFontPx", label: "Tail font (px)", min: 9, max: 28, step: 1 },
];

const PILL_THEMES: readonly DictationAppearance["pillTheme"][] = ["auto", "dark", "light"];

export function showDictationAdvancedPanel(x: number, y: number, opts: AdvancedPanelOpts): void {
  // One panel at a time.
  document.querySelector(".dictation-adv-panel")?.remove();

  // Working copy — every control mutates this and we re-coerce on each change.
  let state: DictationAppearance = coerceAppearance(opts.current);

  const panel = document.createElement("div");
  panel.className = "dictation-adv-panel";
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;

  // --- Header (title + close button) ---
  const header = document.createElement("div");
  header.className = "dictation-adv-header";
  const title = document.createElement("span");
  title.className = "dictation-adv-title";
  title.textContent = "Dictation appearance";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "dictation-adv-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => cleanup());
  header.append(title, closeBtn);
  panel.appendChild(header);

  const body = document.createElement("div");
  body.className = "dictation-adv-body";
  panel.appendChild(body);

  // Emit the (coerced) current state to the caller for live apply + persist.
  const emit = (): void => {
    state = coerceAppearance(state);
    opts.onChange(state);
  };

  // Re-sync every control's DOM value from `state` (used by Reset).
  const syncers: (() => void)[] = [];

  const addSubHeading = (text: string): void => {
    const h = document.createElement("div");
    h.className = "dictation-adv-subhead";
    h.textContent = text;
    body.appendChild(h);
  };

  const addRangeField = (spec: RangeFieldSpec): void => {
    const row = document.createElement("label");
    row.className = "dictation-adv-row dictation-adv-range-row";

    const labelWrap = document.createElement("span");
    labelWrap.className = "dictation-adv-label";
    const labelText = document.createElement("span");
    labelText.textContent = spec.label;
    const readout = document.createElement("span");
    readout.className = "dictation-adv-readout";
    labelWrap.append(labelText, readout);

    const range = document.createElement("input");
    range.type = "range";
    range.className = "dictation-adv-range";
    range.min = String(spec.min);
    range.max = String(spec.max);
    range.step = String(spec.step);

    const fmt = (n: number): string => (spec.step < 1 ? n.toFixed(1) : String(Math.round(n)));

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

    row.append(labelWrap, range);
    body.appendChild(row);
  };

  const addCheckboxField = (
    key: "showBlobs" | "textOutline",
    label: string,
  ): void => {
    const row = document.createElement("label");
    row.className = "dictation-adv-row dictation-adv-check-row";

    const labelText = document.createElement("span");
    labelText.className = "dictation-adv-label";
    labelText.textContent = label;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "dictation-adv-check";

    const sync = (): void => {
      check.checked = state[key];
    };
    sync();
    syncers.push(sync);

    check.addEventListener("change", () => {
      state = { ...state, [key]: check.checked };
      emit();
    });

    row.append(labelText, check);
    body.appendChild(row);
  };

  const addThemeField = (): void => {
    const row = document.createElement("label");
    row.className = "dictation-adv-row dictation-adv-select-row";

    const labelText = document.createElement("span");
    labelText.className = "dictation-adv-label";
    labelText.textContent = "Pill theme";

    const select = document.createElement("select");
    select.className = "dictation-adv-select";
    for (const theme of PILL_THEMES) {
      const option = document.createElement("option");
      option.value = theme;
      option.textContent = theme;
      select.appendChild(option);
    }

    const sync = (): void => {
      select.value = state.pillTheme;
    };
    sync();
    syncers.push(sync);

    select.addEventListener("change", () => {
      const v = select.value;
      const pillTheme: DictationAppearance["pillTheme"] =
        v === "dark" || v === "light" ? v : "auto";
      state = { ...state, pillTheme };
      emit();
    });

    row.append(labelText, select);
    body.appendChild(row);
  };

  // --- Build groups ---
  addSubHeading("Crystallize");
  for (const spec of CRYSTALLIZE_FIELDS) addRangeField(spec);

  addSubHeading("Timing");
  for (const spec of TIMING_FIELDS) addRangeField(spec);

  addSubHeading("Look");
  for (const spec of LOOK_FIELDS) addRangeField(spec);
  addCheckboxField("showBlobs", "Show word blobs");
  addThemeField();
  addCheckboxField("textOutline", "Text outline");

  // --- Footer (Reset + Done) ---
  const footer = document.createElement("div");
  footer.className = "dictation-adv-footer";

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "dictation-adv-btn dictation-adv-btn-ghost";
  resetBtn.textContent = "Reset to defaults";
  resetBtn.addEventListener("click", () => {
    state = { ...DEFAULT_APPEARANCE };
    for (const sync of syncers) sync();
    emit();
  });

  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "dictation-adv-btn dictation-adv-btn-primary";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => cleanup());

  footer.append(resetBtn, doneBtn);
  panel.appendChild(footer);

  document.body.appendChild(panel);

  // Position. With an anchor (the mic), sit ABOVE it so the live pill stays
  // visible; otherwise place at (x,y). Either way, clamp fully on screen.
  const rect = panel.getBoundingClientRect();
  const margin = 8;
  if (opts.anchorRect) {
    const left = Math.min(
      Math.max(margin, opts.anchorRect.left),
      Math.max(margin, window.innerWidth - margin - rect.width),
    );
    const above = opts.anchorRect.top - margin - rect.height;
    const top =
      above >= margin
        ? above
        : Math.min(opts.anchorRect.bottom + margin, window.innerHeight - margin - rect.height);
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(margin, top)}px`;
  } else {
    if (rect.right > window.innerWidth - margin) {
      panel.style.left = `${Math.max(margin, window.innerWidth - margin - rect.width)}px`;
    }
    if (rect.bottom > window.innerHeight - margin) {
      panel.style.top = `${Math.max(margin, window.innerHeight - margin - rect.height)}px`;
    }
  }

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    panel.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.();
  };
  const onOutside = (e: PointerEvent): void => {
    if (!panel.contains(e.target as Node)) cleanup();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") cleanup();
  };
  // Defer so the opening right-click doesn't immediately dismiss it.
  setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}
