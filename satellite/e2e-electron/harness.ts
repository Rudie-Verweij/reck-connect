import { _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Electron launch harness for hybrid-mode e2e tests (plan rev 3.1,
 * phase 10). Each test gets a fresh userData dir so persisted config
 * from earlier runs can't bleed in, and an isolated `HOME` so the
 * daemon-hook-install path (~/.claude/settings.json) is sandboxed.
 *
 * The harness does not wire up mock daemons — tests that need them
 * should start HTTP mocks before `launchApp()` and pass the URLs into
 * the mode-chooser UI via the renderer driver. Phase 10 lands the
 * harness itself; full daemon mocking is deferred to a follow-up so
 * this file stays small enough to debug when it breaks.
 */

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  /** Temp userData dir — test can inspect persisted config before close. */
  userDataDir: string;
  /** Temp `HOME` override — test can inspect shim files the daemon wrote. */
  homeDir: string;
  close(): Promise<void>;
}

/**
 * Launch the built Electron app from `dist/main/main.js`. Requires
 * `pnpm build` to have run — the launcher does not rebuild on every
 * call (too slow for a tight test loop).
 *
 * Tests pass `env` overrides to drive code paths; the harness always
 * sets a clean `HOME` and `userData` dir so persisted state is
 * isolated per-test. macOS-specific: `ELECTRON_DISABLE_SECURITY_WARNINGS`
 * keeps the console clean.
 */
export async function launchApp(
  opts: { env?: NodeJS.ProcessEnv; args?: string[] } = {},
): Promise<LaunchedApp> {
  const mainPath = path.resolve(__dirname, "..", "dist", "main", "main.js");
  if (!fs.existsSync(mainPath)) {
    throw new Error(
      `dist/main/main.js missing at ${mainPath}; run 'pnpm build' before this test`,
    );
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reck-e2e-userdata-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "reck-e2e-home-"));

  const app = await electron.launch({
    args: [mainPath, `--user-data-dir=${userDataDir}`, ...(opts.args ?? [])],
    env: {
      ...process.env,
      HOME: homeDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      // Unset dev-server env var so main.ts's `isDev` branch doesn't
      // try to reach localhost:5173 (Vite isn't running in this test
      // rig — we load the built renderer from disk).
      VITE_DEV_SERVER_URL: undefined,
      NODE_ENV: "production",
      ...opts.env,
    },
  });

  const window = await app.firstWindow();
  // Defer readiness on the renderer's DOMContentLoaded so tests that
  // immediately query UI don't race the initial mount.
  await window.waitForLoadState("domcontentloaded");

  return {
    app,
    window,
    userDataDir,
    homeDir,
    async close() {
      await app.close();
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        fs.rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; a file lingering in tmp is not a
        // hard failure.
      }
    },
  };
}
