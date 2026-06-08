import { defineConfig } from "@playwright/test";

// Separate Playwright config for Electron-launch tests (hybrid mode
// rev 3.1, phase 10). The app is launched unpacked from `dist/`, so
// this config depends on `pnpm build` having run. Unlike the browser-
// level `playwright.config.ts` it does NOT start a Vite dev server —
// the unpacked main process loads the built renderer directly from
// disk.
//
// Run: `pnpm build && pnpm exec playwright test --config=playwright-electron.config.ts`
export default defineConfig({
  testDir: "./e2e-electron",
  timeout: 60_000,
  use: {
    trace: "retain-on-failure",
  },
  // No webServer block. Each spec launches Electron itself via the
  // `launchApp()` helper in `e2e-electron/harness.ts`.
});
