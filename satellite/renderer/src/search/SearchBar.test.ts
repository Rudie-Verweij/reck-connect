// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSearchBar, type SearchBar, type SearchBarCallbacks } from "./SearchBar";

function makeCallbacks(): SearchBarCallbacks & {
  onQueryChange: ReturnType<typeof vi.fn>;
  onNext: ReturnType<typeof vi.fn>;
  onPrevious: ReturnType<typeof vi.fn>;
  onToggleOption: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  return {
    onQueryChange: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onToggleOption: vi.fn(),
    onClose: vi.fn(),
  };
}

let parent: HTMLElement;
let bar: SearchBar;
let cb: ReturnType<typeof makeCallbacks>;

beforeEach(() => {
  parent = document.createElement("div");
  parent.style.position = "relative";
  document.body.appendChild(parent);
  cb = makeCallbacks();
  bar = createSearchBar({ parent, callbacks: cb });
});

afterEach(() => {
  bar.dispose();
  document.body.innerHTML = "";
});

const root = () => parent.querySelector(".reck-search-bar") as HTMLElement;
const input = () => parent.querySelector(".reck-search-input") as HTMLInputElement;
const count = () => parent.querySelector(".reck-search-count") as HTMLElement;
const toggle = (opt: string) =>
  parent.querySelector(`.reck-search-toggle[data-opt="${opt}"]`) as HTMLButtonElement;

describe("SearchBar — structure & lifecycle", () => {
  it("mounts inside the parent and starts hidden", () => {
    expect(root()).toBeTruthy();
    expect(root().hidden).toBe(true);
  });

  it("renders the three option toggles and nav/close controls", () => {
    expect(toggle("caseSensitive")).toBeTruthy();
    expect(toggle("wholeWord")).toBeTruthy();
    expect(toggle("regex")).toBeTruthy();
    expect(parent.querySelector(".reck-search-prev")).toBeTruthy();
    expect(parent.querySelector(".reck-search-next")).toBeTruthy();
    expect(parent.querySelector(".reck-search-close")).toBeTruthy();
  });

  it("show() reveals the bar and focuses the input", () => {
    bar.show();
    expect(root().hidden).toBe(false);
    expect(bar.isVisible()).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it("hide() conceals the bar", () => {
    bar.show();
    bar.hide();
    expect(root().hidden).toBe(true);
    expect(bar.isVisible()).toBe(false);
  });

  it("dispose() removes the element and is idempotent", () => {
    bar.dispose();
    expect(parent.querySelector(".reck-search-bar")).toBeNull();
    expect(() => bar.dispose()).not.toThrow();
  });
});

describe("SearchBar — input & navigation", () => {
  it("emits onQueryChange as the user types", () => {
    input().value = "deep";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(cb.onQueryChange).toHaveBeenCalledWith("deep");
    expect(bar.getQuery()).toBe("deep");
  });

  it("Enter triggers next, Shift+Enter triggers previous", () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(cb.onNext).toHaveBeenCalledTimes(1);
    expect(cb.onPrevious).not.toHaveBeenCalled();

    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    expect(cb.onPrevious).toHaveBeenCalledTimes(1);
  });

  it("Escape triggers close", () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cb.onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter/Escape do not propagate to the window (no leak to global shortcuts)", () => {
    const windowSaw = vi.fn();
    window.addEventListener("keydown", windowSaw);
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(windowSaw).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowSaw);
  });

  it("clicking prev/next buttons triggers navigation (when enabled)", () => {
    bar.setMatchInfo({ total: 5, current: 1 }); // nav is disabled until there are matches
    (parent.querySelector(".reck-search-next") as HTMLButtonElement).click();
    (parent.querySelector(".reck-search-prev") as HTMLButtonElement).click();
    expect(cb.onNext).toHaveBeenCalledTimes(1);
    expect(cb.onPrevious).toHaveBeenCalledTimes(1);
  });

  it("clicking close triggers onClose", () => {
    (parent.querySelector(".reck-search-close") as HTMLButtonElement).click();
    expect(cb.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SearchBar — option toggles", () => {
  it("clicking a toggle flips its active state and emits onToggleOption", () => {
    const t = toggle("regex");
    expect(t.classList.contains("active")).toBe(false);
    t.click();
    expect(cb.onToggleOption).toHaveBeenCalledWith("regex", true);
    expect(t.classList.contains("active")).toBe(true);
    t.click();
    expect(cb.onToggleOption).toHaveBeenCalledWith("regex", false);
    expect(t.classList.contains("active")).toBe(false);
  });

  it("setOptions() reflects external state without firing callbacks", () => {
    bar.setOptions({ caseSensitive: true, wholeWord: false, regex: true });
    expect(toggle("caseSensitive").classList.contains("active")).toBe(true);
    expect(toggle("wholeWord").classList.contains("active")).toBe(false);
    expect(toggle("regex").classList.contains("active")).toBe(true);
    expect(cb.onToggleOption).not.toHaveBeenCalled();
  });
});

describe("SearchBar — match info", () => {
  it("shows 'No results' and disables nav when there are zero matches", () => {
    bar.setMatchInfo({ total: 0, current: 0 });
    expect(count().textContent).toMatch(/no results/i);
    expect((parent.querySelector(".reck-search-next") as HTMLButtonElement).disabled).toBe(true);
    expect((parent.querySelector(".reck-search-prev") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows 'N of M' and enables nav when there are matches", () => {
    bar.setMatchInfo({ total: 17, current: 3 });
    expect(count().textContent).toBe("3 of 17");
    expect((parent.querySelector(".reck-search-next") as HTMLButtonElement).disabled).toBe(false);
  });

  it("surfaces a regex error in the counter", () => {
    bar.setMatchInfo({ total: 0, current: 0, error: "Invalid regular expression" });
    expect(count().textContent).toMatch(/invalid/i);
    expect(count().classList.contains("reck-search-count-error")).toBe(true);
  });

  it("clears the error class when a valid result follows", () => {
    bar.setMatchInfo({ total: 0, current: 0, error: "bad" });
    bar.setMatchInfo({ total: 2, current: 1 });
    expect(count().classList.contains("reck-search-count-error")).toBe(false);
  });
});
