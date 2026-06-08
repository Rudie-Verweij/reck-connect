import { test, expect } from "@playwright/test";
import { launchApp } from "./harness";

// Bare-bones Electron smoke test (plan rev 3.1, phase 10). Validates
// that the harness can actually launch the unpacked app and that the
// renderer mounts. With a fresh userData dir and HOME the preferences
// view is the expected first-paint target (phase 12 retired the old
// mode-chooser).
//
// Scope note: richer e2e (mock daemons, two-host tabs, mount-loss
// characterization) layers on top of this harness. This spec stays
// minimal so a regression in the launcher surfaces quickly without
// dragging the heavier tests along.

test("app launches, preferences view renders", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await ctx.close();
  }
});
