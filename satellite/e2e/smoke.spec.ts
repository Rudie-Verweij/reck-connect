import { test, expect } from "@playwright/test";

// Browser-level test of the renderer against the Vite dev server.
// Without the Electron preload, window.reckAPI is undefined. boot.ts calls
// loadSettings() which accesses window.reckAPI — we install a no-op stub
// via an init script so the first-launch flow renders for the smoke test.
//
// Phase 12 (an earlier release, plan rev 3.1): the two-button mode-chooser has
// been retired. First launch now lands on the preferences view, where
// the user enables either or both hosts directly.

test("first launch shows preferences; station fields render", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { reckAPI: unknown }).reckAPI = {
      config: {
        get: async () => null,
        set: async () => true,
      },
      daemon: {
        status: async () => ({ running: false, binary: null }),
        start: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
      },
      dialog: {
        pickFolder: async () => null,
      },
      onMenuAddProject: () => {},
      onMenuPreferences: () => {},
    };
  });
  await page.goto("http://localhost:5173/");

  await expect(page.locator(".settings-card")).toBeVisible();
  await expect(page.locator("#s-station-enabled")).toBeVisible();
  await expect(page.locator("#s-local-enabled")).toBeVisible();

  // Enabling station exposes URL + token inputs (rendered
  // unconditionally under the toggle in the preferences view).
  await page.check("#s-station-enabled");
  await page.fill("#s-url", "http://127.0.0.1:9999");
  await expect(page.locator("#s-url")).toHaveValue("http://127.0.0.1:9999");
});
