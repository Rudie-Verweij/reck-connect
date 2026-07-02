// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { attachViewerSearch, type ViewerSearchHandle } from "./attachViewerSearch";

let root: HTMLElement;
let body: HTMLElement;
let handle: ViewerSearchHandle;

beforeEach(() => {
  root = document.createElement("div");
  root.className = "file-viewer-root";
  root.style.position = "relative";
  body = document.createElement("div");
  body.className = "file-viewer-body";
  body.innerHTML = "<p>alpha beta alpha</p>";
  root.appendChild(body);
  document.body.appendChild(root);
});

afterEach(() => {
  handle?.dispose();
  document.body.innerHTML = "";
});

describe("attachViewerSearch (markdown path)", () => {
  it("mounts the overlay scrollbar immediately and the search bar on Cmd+F", () => {
    handle = attachViewerSearch({ root, body, view: null });
    expect(root.querySelector(".reck-scrollbar")).toBeTruthy();
    expect(root.querySelector(".reck-search-bar")).toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    expect(root.querySelector(".reck-search-bar")).toBeTruthy();
  });

  it("dispose() removes the bar and scrollbar and unbinds the shortcut", () => {
    handle = attachViewerSearch({ root, body, view: null });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    handle.dispose();
    expect(root.querySelector(".reck-search-bar")).toBeNull();
    expect(root.querySelector(".reck-scrollbar")).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    expect(root.querySelector(".reck-search-bar")).toBeNull();
  });
});
