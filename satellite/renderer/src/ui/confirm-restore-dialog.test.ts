// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { confirmRestoreProject } from "./confirm-restore-dialog";

describe("confirmRestoreProject", () => {
  afterEach(() => {
    document.querySelectorAll(".new-pane-dialog").forEach((el) => el.remove());
  });

  it("renders the project name and pluralised pane count", () => {
    void confirmRestoreProject("Alpha", 3);
    const body = document.querySelector(".dialog-body")!;
    expect(body.querySelector("strong")?.textContent).toBe("Alpha");
    expect(body.querySelector(".restore-pane-count")?.textContent).toBe("3 panes");
  });

  it("singularises a one-pane restore", () => {
    void confirmRestoreProject("Alpha", 1);
    expect(document.querySelector(".restore-pane-count")?.textContent).toBe("1 pane");
  });

  it("falls back to a generic label when the pane count is unknown", () => {
    void confirmRestoreProject("Alpha", 0);
    expect(document.querySelector(".restore-pane-count")?.textContent).toBe("its panes");
  });

  it("resolves true when Restore is clicked", async () => {
    const p = confirmRestoreProject("Alpha", 2);
    (document.querySelector("#restore-ok") as HTMLElement).click();
    expect(await p).toBe(true);
  });

  it("resolves false when Cancel is clicked", async () => {
    const p = confirmRestoreProject("Alpha", 2);
    (document.querySelector("#restore-cancel") as HTMLElement).click();
    expect(await p).toBe(false);
  });

  it("resolves false on backdrop click and removes the dialog", async () => {
    const p = confirmRestoreProject("Alpha", 0);
    const overlay = document.querySelector(".new-pane-dialog") as HTMLElement;
    overlay.click();
    expect(await p).toBe(false);
    expect(document.querySelector(".new-pane-dialog")).toBeNull();
  });
});
