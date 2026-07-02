// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initSearch, type SearchHandle } from "./initSearch";
import type { SearchSurfaceAdapter } from "./SearchSurfaceAdapter";

let container: HTMLElement;
let handle: SearchHandle;

function fakeSurface(): SearchSurfaceAdapter {
  return {
    kind: "codemirror",
    getContainerEl: () => container,
    getText: () => "hello world hello",
    highlightMatches: () => {},
    scrollToMatch: () => {},
    clearHighlights: () => {},
    dispose: () => {},
  };
}

beforeEach(() => {
  container = document.createElement("div");
  container.style.position = "relative";
  document.body.appendChild(container);
});

afterEach(() => {
  handle?.dispose();
  document.body.innerHTML = "";
});

describe("initSearch", () => {
  it("opens the search bar in the active surface on Cmd+F", () => {
    handle = initSearch({ getActiveSearchSurface: () => fakeSurface() });
    expect(container.querySelector(".reck-search-bar")).toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));

    const bar = container.querySelector(".reck-search-bar") as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.hidden).toBe(false);
  });

  it("dispose() unbinds the shortcut and removes the bar", () => {
    handle = initSearch({ getActiveSearchSurface: () => fakeSurface() });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    handle.dispose();
    expect(container.querySelector(".reck-search-bar")).toBeNull();
    // shortcut no longer responds
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    expect(container.querySelector(".reck-search-bar")).toBeNull();
  });

  it("does nothing when there is no active surface", () => {
    handle = initSearch({ getActiveSearchSurface: () => null });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    expect(container.querySelector(".reck-search-bar")).toBeNull();
  });
});
