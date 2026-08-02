import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launchApp, type LaunchedApp } from "./harness";

// Content-only zoom, in a real Electron window.
//
// The bug this locks down: Electron's built-in `role: "viewMenu"` zoom scaled the
// whole page, so the title bar grew on ⌘+ while the macOS traffic lights stayed
// at their fixed OS size — the close button ended up crowding the title. Zoom is
// now content-only, and the assertion that matters is the negative one: the title
// bar's height must not move.
//
// Driven through the actual menu items rather than the IPC, so the accelerators
// and the wiring behind them are covered too.

/** Click a View-menu item by label, in the main process. */
async function clickViewItem(ctx: LaunchedApp, label: string): Promise<void> {
  const found = await ctx.app.evaluate(async ({ Menu }, itemLabel) => {
    const menu = Menu.getApplicationMenu();
    const view = menu?.items.find((i) => i.label === "View");
    const item = view?.submenu?.items.find(
      (i) => i.label === itemLabel && i.visible !== false,
    );
    if (!item) return false;
    item.click();
    return true;
  }, label);
  expect(found, `View > ${label} should exist`).toBe(true);
}

function contentZoomVar(ctx: LaunchedApp): Promise<string> {
  return ctx.window.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--content-zoom")
      .trim(),
  );
}

test.describe("content zoom", () => {
  test("the title bar holds its size while the content scales", async () => {
    // Measured in a file-viewer popup rather than the main window: on a fresh
    // profile boot renders Preferences and never mounts the app bar, whereas a
    // popup always has a title bar. Same shared `.reck-window-header` base and
    // the same zoom broadcast, and it lets us assert BOTH halves at once —
    // chrome fixed, content scaled.
    const ctx = await launchApp();
    try {
      await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
        timeout: 15_000,
      });

      const filePath = path.join(ctx.homeDir, "zoom-check.md");
      fs.writeFileSync(filePath, "# Heading\n\nSome prose to scale.\n", "utf8");
      const popupPromise = ctx.app.waitForEvent("window");
      await ctx.window.evaluate(async (p) => {
        await (
          window as unknown as {
            reckAPI: { files: { openInViewer(t: string): Promise<unknown> } };
          }
        ).reckAPI.files.openInViewer(p);
      }, filePath);
      const popup = await popupPromise;
      await popup.waitForLoadState("domcontentloaded");

      const header = popup.locator(".reck-window-header").first();
      const body = popup.locator(".file-viewer-body");
      await expect(header).toBeVisible({ timeout: 15_000 });

      const headerBefore = await header.evaluate(
        (el) => el.getBoundingClientRect().height,
      );
      const fontBefore = await body.evaluate((el) =>
        parseFloat(getComputedStyle(el).fontSize),
      );
      expect(headerBefore).toBeGreaterThan(0);

      await clickViewItem(ctx, "Zoom In");
      await clickViewItem(ctx, "Zoom In");

      // Content grew...
      await expect
        .poll(() =>
          body.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
        )
        .toBeGreaterThan(fontBefore);

      // ...and the chrome did not. This is the bug: a title bar that grew slid
      // out of alignment with the fixed-size macOS traffic lights.
      expect(
        await header.evaluate((el) => el.getBoundingClientRect().height),
      ).toBeCloseTo(headerBefore, 1);

      await clickViewItem(ctx, "Zoom Out");
      await clickViewItem(ctx, "Zoom Out");
      expect(
        await header.evaluate((el) => el.getBoundingClientRect().height),
      ).toBeCloseTo(headerBefore, 1);
    } finally {
      await ctx.close();
    }
  });

  test("the page itself is never zoomed", async () => {
    const ctx = await launchApp();
    try {
      await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
        timeout: 15_000,
      });
      await clickViewItem(ctx, "Zoom In");
      await expect.poll(() => contentZoomVar(ctx)).not.toBe("1");

      // If this drifts from 0, something has gone back to setZoomLevel and the
      // traffic-light misalignment is back with it.
      const zoomLevel = await ctx.app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return win.webContents.getZoomLevel();
      });
      expect(zoomLevel).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test("Actual Size returns to 1", async () => {
    const ctx = await launchApp();
    try {
      await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
        timeout: 15_000,
      });
      await clickViewItem(ctx, "Zoom In");
      await expect.poll(() => contentZoomVar(ctx)).not.toBe("1");
      await clickViewItem(ctx, "Actual Size");
      await expect.poll(() => contentZoomVar(ctx)).toBe("1");
    } finally {
      await ctx.close();
    }
  });

  test("the factor is persisted, not just held in memory", async () => {
    // Electron's per-origin page zoom persisted for free; ours has to be
    // written, so prove the write happens. Only the KEY is asserted — the
    // config blob is safeStorage-encrypted, so the value isn't readable from
    // outside the app. (A true restart-and-restore would need the harness to
    // support reusing a userData dir; it always mints a fresh one.)
    const ctx = await launchApp();
    try {
      await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
        timeout: 15_000,
      });
      await clickViewItem(ctx, "Zoom In");
      await expect.poll(() => contentZoomVar(ctx)).toBe("1.1");

      const configFile = path.join(ctx.userDataDir, "config", "settings.json");
      await expect
        .poll(() => {
          try {
            return Object.keys(JSON.parse(fs.readFileSync(configFile, "utf8")));
          } catch {
            return [];
          }
        })
        .toContain("contentZoom");
    } finally {
      await ctx.close();
    }
  });
});
