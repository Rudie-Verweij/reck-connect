// `SearchBar` — the VSCode-style find widget, built as a factory returning
// a control handle (mirrors `createSpeakControlBar`). Surface-agnostic: it
// knows nothing about terminals / CodeMirror / markdown — it just emits
// query/navigation/toggle/close events and renders the match counter.
//
// Layout matches VSCode's find widget: an input that fills the width with
// the case / whole-word / regex toggles tucked inside its right edge, then
// the result counter, then prev / next / close. Themed with the app's role
// tokens; positioned by CSS (see `.reck-search-bar` in styles.css).

export interface SearchToggles {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export type SearchToggleKey = keyof SearchToggles;

export interface MatchInfo {
  /** Total number of matches. */
  total: number;
  /** 1-based index of the active match, or 0 when none is active. */
  current: number;
  /** Set when the regex failed to compile; shown in place of the count. */
  error?: string;
}

export interface SearchBarCallbacks {
  onQueryChange(query: string): void;
  onNext(): void;
  onPrevious(): void;
  onToggleOption(option: SearchToggleKey, value: boolean): void;
  onClose(): void;
}

export interface SearchBarOptions {
  parent: HTMLElement;
  callbacks: SearchBarCallbacks;
  initialOptions?: Partial<SearchToggles>;
}

export interface SearchBar {
  show(): void;
  hide(): void;
  isVisible(): boolean;
  focus(): void;
  getQuery(): string;
  setQuery(query: string): void;
  setMatchInfo(info: MatchInfo): void;
  setOptions(options: SearchToggles): void;
  dispose(): void;
}

const SVG_PREV =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 4l4 5H4z" fill="currentColor"/></svg>';
const SVG_NEXT =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 12L4 7h8z" fill="currentColor"/></svg>';
const SVG_CLOSE =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';

interface ToggleSpec {
  key: SearchToggleKey;
  label: string;
  className: string;
  title: string;
  ariaLabel: string;
}

const TOGGLE_SPECS: readonly ToggleSpec[] = [
  {
    key: "caseSensitive",
    label: "Aa",
    className: "reck-search-toggle-case",
    title: "Match Case",
    ariaLabel: "Match Case",
  },
  {
    key: "wholeWord",
    label: "ab",
    className: "reck-search-toggle-word",
    title: "Match Whole Word",
    ariaLabel: "Match Whole Word",
  },
  {
    key: "regex",
    label: ".*",
    className: "reck-search-toggle-regex",
    title: "Use Regular Expression",
    ariaLabel: "Use Regular Expression",
  },
];

export function createSearchBar(opts: SearchBarOptions): SearchBar {
  const state: SearchToggles = {
    caseSensitive: opts.initialOptions?.caseSensitive ?? false,
    wholeWord: opts.initialOptions?.wholeWord ?? false,
    regex: opts.initialOptions?.regex ?? false,
  };

  const root = document.createElement("div");
  root.className = "reck-search-bar";
  root.setAttribute("role", "search");
  root.hidden = true;

  const inputWrap = document.createElement("div");
  inputWrap.className = "reck-search-input-wrap";

  const input = document.createElement("input");
  input.className = "reck-search-input";
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Find");
  input.placeholder = "Find";

  const toggles = document.createElement("div");
  toggles.className = "reck-search-toggles";

  const toggleEls = new Map<SearchToggleKey, HTMLButtonElement>();
  for (const spec of TOGGLE_SPECS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `reck-search-toggle ${spec.className}`;
    btn.dataset.opt = spec.key;
    btn.title = spec.title;
    btn.setAttribute("aria-label", spec.ariaLabel);
    btn.setAttribute("aria-pressed", "false");
    btn.textContent = spec.label;
    btn.addEventListener("click", () => {
      const next = !state[spec.key];
      state[spec.key] = next;
      reflectToggle(spec.key);
      opts.callbacks.onToggleOption(spec.key, next);
      input.focus();
    });
    toggleEls.set(spec.key, btn);
    toggles.appendChild(btn);
  }

  inputWrap.appendChild(input);
  inputWrap.appendChild(toggles);

  const countEl = document.createElement("span");
  countEl.className = "reck-search-count";
  countEl.setAttribute("aria-live", "polite");

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "reck-search-nav reck-search-prev";
  prevBtn.title = "Previous Match (Shift+Enter)";
  prevBtn.setAttribute("aria-label", "Previous match");
  prevBtn.innerHTML = SVG_PREV;

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "reck-search-nav reck-search-next";
  nextBtn.title = "Next Match (Enter)";
  nextBtn.setAttribute("aria-label", "Next match");
  nextBtn.innerHTML = SVG_NEXT;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "reck-search-close";
  closeBtn.title = "Close (Escape)";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = SVG_CLOSE;

  root.appendChild(inputWrap);
  root.appendChild(countEl);
  root.appendChild(prevBtn);
  root.appendChild(nextBtn);
  root.appendChild(closeBtn);

  function reflectToggle(key: SearchToggleKey): void {
    const btn = toggleEls.get(key);
    if (!btn) return;
    const on = state[key];
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  for (const spec of TOGGLE_SPECS) reflectToggle(spec.key);

  input.addEventListener("input", () => {
    opts.callbacks.onQueryChange(input.value);
  });

  // Handle the keys the bar owns on the input itself (bubble phase) and
  // stop them propagating to the window so they never reach the global
  // shortcut handler or a focused xterm pane. Typing keys pass through.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) opts.callbacks.onPrevious();
      else opts.callbacks.onNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      opts.callbacks.onClose();
    }
  });

  prevBtn.addEventListener("click", () => opts.callbacks.onPrevious());
  nextBtn.addEventListener("click", () => opts.callbacks.onNext());
  closeBtn.addEventListener("click", () => opts.callbacks.onClose());

  function setNavEnabled(enabled: boolean): void {
    prevBtn.disabled = !enabled;
    nextBtn.disabled = !enabled;
  }
  setNavEnabled(false);
  setMatchInfo({ total: 0, current: 0 });

  function setMatchInfo(info: MatchInfo): void {
    countEl.classList.remove("reck-search-count-error", "reck-search-count-empty");
    if (info.error) {
      countEl.textContent = info.error;
      countEl.classList.add("reck-search-count-error");
      setNavEnabled(false);
      return;
    }
    if (info.total === 0) {
      countEl.textContent = "No results";
      countEl.classList.add("reck-search-count-empty");
    } else {
      countEl.textContent = `${info.current} of ${info.total}`;
    }
    setNavEnabled(info.total > 0);
  }

  opts.parent.appendChild(root);

  let disposed = false;

  return {
    show: () => {
      root.hidden = false;
      input.focus();
      input.select();
    },
    hide: () => {
      root.hidden = true;
    },
    isVisible: () => !root.hidden,
    focus: () => {
      input.focus();
      input.select();
    },
    getQuery: () => input.value,
    setQuery: (query: string) => {
      input.value = query;
    },
    setMatchInfo,
    setOptions: (options: SearchToggles) => {
      state.caseSensitive = options.caseSensitive;
      state.wholeWord = options.wholeWord;
      state.regex = options.regex;
      for (const spec of TOGGLE_SPECS) reflectToggle(spec.key);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      root.remove();
    },
  };
}
