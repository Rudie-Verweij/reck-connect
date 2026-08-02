import { test, expect, type Page } from "@playwright/test";

import { E2E_ORIGIN } from "../playwright.config";

// Browser-level tests of the usage overlay against the synthetic-API
// harness (renderer/usage-harness.html — no daemon needed). Covers the
// two field reports from v1: the card growing on hover, and the fixed
// bin widths. Screenshots land in e2e/artifacts/ for visual review.

// Origin comes from the config, not a literal: 5173 is contested (see the
// comment there), and a hardcoded port meant RECK_E2E_PORT moved the dev
// server while this file kept pointing at whatever still owned 5173.
const HARNESS = `${E2E_ORIGIN}/usage-harness.html`;

async function openHarness(page: Page, theme: "light" | "dark" = "light") {
  await page.goto(`${HARNESS}?theme=${theme}`);
  await expect(page.locator(".usage-card")).toBeVisible();
  // First fetch resolves and draws.
  await expect(page.locator(".usage-chart canvas")).toBeVisible();
}

test("hovering the chart never resizes the card", async ({ page }) => {
  await openHarness(page);
  const card = page.locator(".usage-card");
  const before = await card.boundingBox();
  expect(before).not.toBeNull();

  // Sweep the cursor across the plot area; the readout populates but
  // the card must not change size (v1 bug: live legend + unreserved
  // readout line grew the layout on every mousemove).
  const chart = page.locator(".usage-chart .u-over");
  const box = (await chart.boundingBox())!;
  for (let i = 0; i <= 10; i++) {
    await page.mouse.move(box.x + 2 + ((box.width - 4) * i) / 10, box.y + box.height / 2);
  }
  // Park mid-chart: the readout stays populated (sweeping fully off the
  // right edge would legitimately clear it).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".usage-readout")).not.toHaveText("");

  // Precision 2 (±0.005px), not 0: the original ±0.5px tolerance was wider
  // than the bug it was written for — .usage-readout reserved 1.2em against
  // a line box that renders at ~1.32em, so the card grew by well under half
  // a pixel and this assertion passed anyway.
  const after = await card.boundingBox();
  expect(after!.width).toBeCloseTo(before!.width, 2);
  expect(after!.height).toBeCloseTo(before!.height, 2);
});

test("bin selector offers per-view widths and re-renders", async ({ page }) => {
  await openHarness(page);

  // Week view default: 30-minute bins.
  await expect(page.locator(".usage-bins")).toHaveValue("30m");
  const weekOptions = await page.locator(".usage-bins option").allTextContents();
  expect(weekOptions).toEqual(["5 min", "10 min", "30 min", "1 hour", "4 hours", "1 day"]);

  // Fine bins → curve (uPlot still draws one canvas; assert data volume
  // via the readout after hover, and take a screenshot for the eye).
  await page.locator(".usage-bins").selectOption("5m");
  await expect(page.locator(".usage-bins")).toHaveValue("5m");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "e2e/artifacts/usage-week-5m-curve.png" });

  // Bin width is a density control, not an axis control (issue #106):
  // these two shots are 12× apart in bin count and their x-axis rows
  // must read identically — "Mon 13 … Sun 19" either way. The label
  // logic itself is pinned in usage-axis.test.ts; these are for the eye.
  await page.locator(".usage-bins").selectOption("4h");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "e2e/artifacts/usage-week-axis-4h.png" });
  await page.locator(".usage-bins").selectOption("5m");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "e2e/artifacts/usage-week-axis-5m.png" });

  // Day view: defaults to 5 minutes, offers 1 minute up to 4 hours.
  await page.locator('.usage-chip[data-g="day"]').click();
  await expect(page.locator(".usage-bins")).toHaveValue("5m");
  const dayOptions = await page.locator(".usage-bins option").allTextContents();
  expect(dayOptions).toEqual(["1 min", "2 min", "5 min", "10 min", "30 min", "1 hour", "4 hours"]);
  await page.locator(".usage-bins").selectOption("1m");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "e2e/artifacts/usage-day-1m-curve.png" });

  // Year view: day bins or calendar months.
  await page.locator('.usage-chip[data-g="year"]').click();
  await expect(page.locator(".usage-bins")).toHaveValue("month");
  const yearOptions = await page.locator(".usage-bins option").allTextContents();
  expect(yearOptions).toEqual(["1 day", "Month"]);
});

test("drill-down resets the bin width to the finer view's default", async ({ page }) => {
  await openHarness(page);
  await page.locator('.usage-chip[data-g="year"]').click();
  await expect(page.locator(".usage-bins")).toHaveValue("month");

  // Click mid-chart → month view at 4-hour bins.
  const chart = page.locator(".usage-chart .u-over");
  const box = (await chart.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  await expect(page.locator('.usage-chip[data-g="month"]')).toHaveClass(/active/);
  await expect(page.locator(".usage-bins")).toHaveValue("4h");
  // Month's axis row is bare dates — no clock times, and no weekday
  // names either (30 of them is noise; the space buys more dates).
  await page.waitForTimeout(150);
  await page.screenshot({ path: "e2e/artifacts/usage-month-4h-axis.png" });

  // ↑ drills back up (month → year on the ladder) with year's default.
  await page.locator(".usage-drill-up").click();
  await expect(page.locator('.usage-chip[data-g="year"]')).toHaveClass(/active/);
  await expect(page.locator(".usage-bins")).toHaveValue("month");
  // At the ceiling the ↑ button disables.
  await expect(page.locator(".usage-drill-up")).toBeDisabled();
});

test("series toggles hide/show data and survive re-renders", async ({ page }) => {
  await openHarness(page);
  const tokens = page.locator('.usage-series-toggle[data-series="tokens"]');
  const fiveHour = page.locator('.usage-series-toggle[data-series="fiveHour"]');
  const sevenDay = page.locator('.usage-series-toggle[data-series="sevenDay"]');
  await expect(tokens).toBeVisible();

  // Hiding a series is visible on the canvas: capture the plot with
  // everything on, toggle tokens off, and the pixels must change.
  const chart = page.locator(".usage-chart");
  const before = await chart.screenshot();
  await tokens.click();
  await expect(tokens).toHaveClass(/off/);
  await expect(tokens).toHaveAttribute("aria-pressed", "false");
  const after = await chart.screenshot();
  expect(before.equals(after)).toBe(false);

  // Toggle state survives a chart rebuild (bin-width change refetches
  // and reconstructs the uPlot instance).
  await sevenDay.click();
  await page.locator(".usage-bins").selectOption("4h");
  await page.waitForTimeout(200);
  await expect(tokens).toHaveClass(/off/);
  await expect(sevenDay).toHaveClass(/off/);
  await expect(fiveHour).not.toHaveClass(/off/);
  await page.screenshot({ path: "e2e/artifacts/usage-toggles-5h-only.png" });

  // Back on.
  await tokens.click();
  await expect(tokens).not.toHaveClass(/off/);
  await expect(tokens).toHaveAttribute("aria-pressed", "true");
});

test("drag-selecting a span zooms into that time frame", async ({ page }) => {
  await openHarness(page);
  await expect(page.locator(".usage-period")).toContainText("Week of");

  // Drag across the middle ~30% of the plot.
  const chart = page.locator(".usage-chart .u-over");
  const box = (await chart.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.35, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, y, { steps: 8 });
  await page.mouse.up();

  // Now in a zoomed range: the label shows a time range (– between
  // endpoints), granularity chips deactivate, and the bin width is
  // re-derived from the span rather than kept from the week view.
  await expect(page.locator(".usage-period")).toContainText("–");
  await expect(page.locator(".usage-chip.active")).toHaveCount(0);
  // ~30% of a week is ~50 h, for which defaultWidthForSpan aims at
  // ≤240 bins. (Asserting "not the week default" stopped meaning
  // anything once that default became 30m — which is also what this
  // span picks.)
  const zoomBucket = await page.locator(".usage-bins").inputValue();
  expect(["2m", "5m", "10m", "30m"]).toContain(zoomBucket);
  // The menu is rebuilt from the span too, so day-wide bins — two of
  // them across 50 hours — drop off it.
  const zoomOptions = await page.locator(".usage-bins option").allTextContents();
  expect(zoomOptions).not.toContain("1 day");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "e2e/artifacts/usage-drag-zoom.png" });

  // Zooming again inside the zoom narrows further.
  const label1 = await page.locator(".usage-period").textContent();
  await page.mouse.move(box.x + box.width * 0.4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".usage-period")).not.toHaveText(label1!);
  await expect(page.locator(".usage-period")).toContainText("–");

  // ↑ exits the zoom back to the calendar week.
  await page.locator(".usage-drill-up").click();
  await expect(page.locator(".usage-period")).toContainText("Week of");
  await expect(page.locator('.usage-chip[data-g="week"]')).toHaveClass(/active/);
  await expect(page.locator(".usage-bins")).toHaveValue("30m");
});

test("dark theme renders and looks right", async ({ page }) => {
  await openHarness(page, "dark");
  await page.locator(".usage-bins").selectOption("1h");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "e2e/artifacts/usage-week-1h-dark.png" });
  await expect(page.locator(".usage-chart canvas")).toBeVisible();
});

test("close button hovers orange in both themes", async ({ page }) => {
  const orange = "rgb(212, 104, 58)"; // --claude-orange
  for (const theme of ["light", "dark"] as const) {
    await openHarness(page, theme);
    const closeBtn = page.locator(".usage-close");
    await closeBtn.hover();
    await expect(closeBtn).toHaveCSS("color", orange);
  }
});

test("the gear opens polling settings and saves an interval", async ({ page }) => {
  await openHarness(page);

  await page.locator(".usage-poll-settings").click();
  const card = page.locator(".usage-poll-card");
  await expect(card).toBeVisible();

  // Opens on what the station reports: 60s, shown as "1 min".
  await expect(page.locator(".usage-poll-input")).toHaveValue("1");
  await expect(page.locator('.usage-poll-unit .slide-switch-opt[data-value="min"]')).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator(".usage-poll-summary")).toContainText("every minute");

  // The summary states the storage cost, live, as the value changes.
  await page.locator('.usage-poll-unit .slide-switch-opt[data-value="sec"]').click();
  await page.locator(".usage-poll-input").fill("30");
  await expect(page.locator(".usage-poll-summary")).toContainText("every 30 seconds");
  await expect(page.locator(".usage-poll-summary")).toContainText("a month");

  await page.locator(".usage-poll-save").click();
  await expect(card).toBeHidden();

  // Reopening shows what was saved, not the default.
  await page.locator(".usage-poll-settings").click();
  await expect(page.locator(".usage-poll-input")).toHaveValue("30");
});

test("turning polling off dims the interval but keeps its value", async ({ page }) => {
  await openHarness(page);
  await page.locator(".usage-poll-settings").click();
  await expect(page.locator(".usage-poll-card")).toBeVisible();

  await page.locator('.usage-poll-switches .slide-switch-opt[data-value="off"]').click();
  await expect(page.locator(".usage-poll-interval")).toHaveClass(/is-disabled/);
  await expect(page.locator(".usage-poll-input")).toBeDisabled();
  // The number stays on screen: turning polling back on resumes at it.
  await expect(page.locator(".usage-poll-input")).toHaveValue("1");
  await expect(page.locator(".usage-poll-summary")).toContainText("Polling is off");
});

test("Escape closes the polling dialog without closing the usage view", async ({ page }) => {
  await openHarness(page);
  await page.locator(".usage-poll-settings").click();
  await expect(page.locator(".usage-poll-card")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".usage-poll-card")).toBeHidden();
  // The view underneath must survive — this is what confirmDialogOpen()
  // guards, and it only works because the dialog root is .confirm-overlay.
  await expect(page.locator(".usage-card")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Remembered view state + the no-series overlay.
//
// The harness backs window.reckAPI.config with sessionStorage, so a reload
// exercises the real load/save path rather than a mock of it.

/** Click a granularity chip ("Day", "Week", …). */
async function pickGranularity(page: Page, label: string): Promise<void> {
  await page.locator(".usage-chip", { hasText: new RegExp(`^${label}$`) }).click();
  await expect(page.locator(".usage-chart canvas")).toBeVisible();
}

function toggle(page: Page, key: "tokens" | "fiveHour" | "sevenDay") {
  return page.locator(`.usage-series-toggle[data-series="${key}"]`);
}

test.describe("usage view — remembered state", () => {
  test("granularity and bin width come back on reopen", async ({ page }) => {
    await openHarness(page);
    await pickGranularity(page, "Day");
    await page.locator(".usage-bins").selectOption("1m");
    await expect(page.locator(".usage-chart canvas")).toBeVisible();

    await page.reload();
    await expect(page.locator(".usage-card")).toBeVisible();

    await expect(page.locator(".usage-chip.active")).toHaveText("Day");
    await expect(page.locator(".usage-bins")).toHaveValue("1m");
  });

  test("a bin width is remembered PER view, not globally", async ({ page }) => {
    await openHarness(page);
    await pickGranularity(page, "Day");
    await page.locator(".usage-bins").selectOption("1m");
    await expect(page.locator(".usage-bins")).toHaveValue("1m");

    // Glancing at another view must not throw the Day choice away. It used
    // to: switching granularity ran that view's DEFAULT width, and there was
    // only ever one remembered width to come back to.
    await pickGranularity(page, "Week");
    await page.locator(".usage-bins").selectOption("4h");
    await expect(page.locator(".usage-bins")).toHaveValue("4h");

    await pickGranularity(page, "Day");
    await expect(page.locator(".usage-bins")).toHaveValue("1m");
    await pickGranularity(page, "Week");
    await expect(page.locator(".usage-bins")).toHaveValue("4h");
  });

  test("both remembered widths survive a reopen", async ({ page }) => {
    await openHarness(page);
    await pickGranularity(page, "Day");
    await page.locator(".usage-bins").selectOption("1m");
    await pickGranularity(page, "Month");
    await page.locator(".usage-bins").selectOption("1d");
    await expect(page.locator(".usage-bins")).toHaveValue("1d");

    await page.reload();
    await expect(page.locator(".usage-card")).toBeVisible();

    // Lands on the view it was left in, at that view's width…
    await expect(page.locator(".usage-chip.active")).toHaveText("Month");
    await expect(page.locator(".usage-bins")).toHaveValue("1d");
    // …and the other view's width came back too.
    await pickGranularity(page, "Day");
    await expect(page.locator(".usage-bins")).toHaveValue("1m");
  });

  test("Session keeps its own bin width, like any other view", async ({ page }) => {
    // Session rides on a custom range, and custom ranges derive their width
    // from their span — so a width picked in Session was thrown away the
    // moment you left it, and arriving there kept whatever the previous
    // view had. It is a first-class view, so it remembers like one.
    await openHarness(page);
    await pickGranularity(page, "Week");
    await page.locator(".usage-bins").selectOption("4h");

    await page.locator('.usage-chip[data-g="session"]').click();
    await page.waitForTimeout(200);
    await page.locator(".usage-bins").selectOption("10m");
    await expect(page.locator(".usage-bins")).toHaveValue("10m");

    // Away and back: each view holds its own choice.
    await pickGranularity(page, "Week");
    await expect(page.locator(".usage-bins")).toHaveValue("4h");
    await page.locator('.usage-chip[data-g="session"]').click();
    await page.waitForTimeout(200);
    await expect(page.locator(".usage-bins")).toHaveValue("10m");

    // And it survives a reopen.
    await page.reload();
    await expect(page.locator(".usage-card")).toBeVisible();
    await expect(page.locator('.usage-chip[data-g="session"]')).toHaveClass(/active/);
    await expect(page.locator(".usage-bins")).toHaveValue("10m");
  });

  test("reopens on the Session view when that is where it was left", async ({ page }) => {
    await openHarness(page);
    await page.locator('.usage-chip[data-g="session"]').click();
    await expect(page.locator('.usage-chip[data-g="session"]')).toHaveClass(/active/);

    await page.reload();
    await expect(page.locator(".usage-card")).toBeVisible();
    await expect(page.locator(".usage-chart canvas")).toBeVisible();

    await expect(page.locator('.usage-chip[data-g="session"]')).toHaveClass(/active/);
    await expect(page.locator(".usage-period")).toContainText("Session ·");
  });

  test("series toggles come back on reopen", async ({ page }) => {
    await openHarness(page);
    await toggle(page, "fiveHour").click();
    await toggle(page, "sevenDay").click();
    await expect(toggle(page, "fiveHour")).toHaveAttribute("aria-pressed", "false");

    await page.reload();
    await expect(page.locator(".usage-card")).toBeVisible();

    await expect(toggle(page, "tokens")).toHaveAttribute("aria-pressed", "true");
    await expect(toggle(page, "fiveHour")).toHaveAttribute("aria-pressed", "false");
    await expect(toggle(page, "sevenDay")).toHaveAttribute("aria-pressed", "false");
  });

  test("the project filter comes back on reopen", async ({ page }) => {
    await openHarness(page);
    const projectSel = page.locator(".usage-project:not(.usage-bins)");
    const value = await projectSel
      .locator("option")
      .nth(1)
      .evaluate((o: HTMLOptionElement) => o.value);
    await projectSel.selectOption(value);
    await expect(page.locator(".usage-chart canvas")).toBeVisible();

    await page.reload();
    await expect(page.locator(".usage-card")).toBeVisible();
    // The <option> list is fetched async — the restore has to wait for it, or
    // assigning the value silently no-ops and the filter is lost.
    await expect(projectSel).toHaveValue(value);
  });

  test("the anchor date is NOT remembered — reopen lands on the latest period", async ({
    page,
  }) => {
    await openHarness(page);
    await pickGranularity(page, "Day");
    const today = await page.locator(".usage-period").textContent();

    // Page back two days, then reopen.
    await page.locator('.usage-pager[data-dir="-1"]').click();
    await page.locator('.usage-pager[data-dir="-1"]').click();
    await expect(page.locator(".usage-period")).not.toHaveText(today!);

    await page.reload();
    await expect(page.locator(".usage-card")).toBeVisible();
    await expect(page.locator(".usage-chip.active")).toHaveText("Day");
    // Granularity remembered, position in time not.
    await expect(page.locator(".usage-period")).toHaveText(today!);
  });
});

test.describe("usage view — no series selected", () => {
  test("is hidden while any series is on", async ({ page }) => {
    await openHarness(page);
    await expect(page.locator(".usage-no-series")).toBeHidden();
    await toggle(page, "fiveHour").click();
    await toggle(page, "sevenDay").click();
    // Tokens still on.
    await expect(page.locator(".usage-no-series")).toBeHidden();
  });

  test("appears when the last series is switched off", async ({ page }) => {
    await openHarness(page);
    for (const k of ["tokens", "fiveHour", "sevenDay"] as const) {
      await toggle(page, k).click();
    }
    const banner = page.locator(".usage-no-series");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/no series selected/i);

    // It must not swallow clicks aimed at the chart underneath.
    await expect(banner).toHaveCSS("pointer-events", "none");
  });

  test("disappears again as soon as a series comes back", async ({ page }) => {
    await openHarness(page);
    for (const k of ["tokens", "fiveHour", "sevenDay"] as const) {
      await toggle(page, k).click();
    }
    await expect(page.locator(".usage-no-series")).toBeVisible();
    await toggle(page, "tokens").click();
    await expect(page.locator(".usage-no-series")).toBeHidden();
  });

  test("survives a reopen in the empty state", async ({ page }) => {
    await openHarness(page);
    for (const k of ["tokens", "fiveHour", "sevenDay"] as const) {
      await toggle(page, k).click();
    }
    await page.reload();
    await expect(page.locator(".usage-card")).toBeVisible();
    await expect(page.locator(".usage-no-series")).toBeVisible();
    await page.screenshot({ path: "e2e/artifacts/usage-no-series.png" });
  });
});

// The export dialog had no browser coverage at all, which is how a CSS rule
// that made two of its controls inert shipped unnoticed: `field.hidden = true`
// was a no-op because the author-origin `.usage-export-field { display: flex }`
// beats the user-agent `[hidden]` rule on origin. See issue #131.
test.describe("export dialog", () => {
  async function openExport(page: Page) {
    await openHarness(page);
    await page.locator(".usage-download").click();
    const card = page.locator(".usage-export-card");
    await expect(card).toBeVisible();
    // .confirm-card runs `confirm-pop` (a 0.16s scale) on open, and
    // boundingBox() reports the TRANSFORMED rect — so measuring before it
    // settles reads a card that is still ~1.3% small, and every element
    // inside it grows uniformly between samples. Nothing to do with layout.
    await card.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  }

  const dataset = (page: Page) => page.locator(".usage-export-dataset");
  const intervalField = (page: Page) => page.locator(".usage-export-interval-field");
  const projectField = (page: Page) => page.locator(".usage-export-project-field");

  test("Interval and Project are reserved for the datasets that ignore them", async ({ page }) => {
    await openExport(page);

    // Binned honours both.
    await dataset(page).selectOption("binned");
    await expect(intervalField(page)).not.toHaveClass(/is-reserved/);
    await expect(page.locator(".usage-export-interval")).toBeEnabled();
    await expect(projectField(page)).not.toHaveClass(/is-reserved/);
    await expect(page.locator(".usage-export-project")).toBeEnabled();

    // Raw turns aren't binned, but are per-project.
    await dataset(page).selectOption("turns");
    await expect(intervalField(page)).toHaveClass(/is-reserved/);
    await expect(page.locator(".usage-export-interval")).toBeDisabled();
    await expect(projectField(page)).not.toHaveClass(/is-reserved/);

    // Quota is raw AND account-level, so neither applies.
    await dataset(page).selectOption("quota");
    await expect(intervalField(page)).toHaveClass(/is-reserved/);
    await expect(page.locator(".usage-export-interval")).toBeDisabled();
    await expect(projectField(page)).toHaveClass(/is-reserved/);
    await expect(page.locator(".usage-export-project")).toBeDisabled();

    await page.screenshot({ path: "e2e/artifacts/usage-export-quota.png" });
  });

  test("the fields that apply close up to the top", async ({ page }) => {
    await openExport(page);

    // Reserved space belongs at the END of the form. Left in place it is a
    // hole between the dates and Project, which reads as a broken layout
    // rather than as space held back.
    await dataset(page).selectOption("turns");
    const dates = (await page.locator(".usage-export-row").boundingBox())!;
    const project = (await projectField(page).boundingBox())!;
    const interval = (await intervalField(page).boundingBox())!;

    // Project follows the dates directly — no reserved row wedged between.
    expect(project.y - (dates.y + dates.height)).toBeLessThan(interval.height);
    // And the reserved Interval has sunk below Project.
    expect(interval.y).toBeGreaterThan(project.y);
  });

  test("the card never resizes when the dataset changes", async ({ page }) => {
    await openExport(page);
    const card = page.locator(".usage-export-card");

    await dataset(page).selectOption("binned");
    const before = await card.boundingBox();
    expect(before).not.toBeNull();

    // Same precision as the hover test above (±0.005px): the whole point is
    // that Cancel / Download CSV do not move, and .confirm-overlay centres
    // the card, so any height delta moves them by half of it.
    for (const d of ["turns", "quota", "binned"] as const) {
      await dataset(page).selectOption(d);
      await expect(page.locator(".usage-export-hint")).not.toHaveText("");
      const after = await card.boundingBox();
      expect(after!.height, `height changed on "${d}"`).toBeCloseTo(before!.height, 2);
      expect(after!.width, `width changed on "${d}"`).toBeCloseTo(before!.width, 2);
    }
  });
});

test("the plan reads the entitlement, not the stale subscriptionType", async ({ page }) => {
  // The harness serves subscription "pro" with rate_limit_tier
  // "default_claude_max_5x" — the real-world case where the credential
  // blob's subscriptionType lags an upgrade by months. Reading the wrong
  // field renders "Pro" and loses the multiplier entirely. See issue #130.
  await openHarness(page);

  const plan = page.locator(".usage-plan");
  await expect(plan).toBeVisible();
  await expect(plan).toHaveText("Max 5x");

  // And the tier sits next to the numbers it gives meaning to: "peak 5h
  // 87%" is 87% OF a tier.
  await expect(page.locator(".usage-stats")).toContainText("Max 5x");
  await expect(page.locator(".usage-stats")).toContainText("tokens");
});

// The forecast band (issue #130): three projected lines to the window's
// reset, a tinted fill between the bounds, a reset marker and a 100%
// crossing. The harness pins the live windows on the real clock, exactly as
// the daemon's `quota_forecast` does.
test("a tier that names no plan falls back to the subscription", async ({ page }) => {
  // A Pro account's entitlement is the generic "default_claude_ai". Parsing
  // it produced "Ai" in the header and the footer — meaningless, and worse
  // than the "Pro" it displaced. See issue #130.
  await page.goto(`${HARNESS}?theme=light&tier=default_claude_ai`);
  await expect(page.locator(".usage-chart canvas")).toBeVisible();

  await expect(page.locator(".usage-plan")).toHaveText("Pro");
  await expect(page.locator(".usage-stats")).toContainText("Pro");
  await expect(page.locator(".usage-plan")).not.toHaveText(/Ai/);

  // A tier that DOES name a plan still wins over the stale subscription.
  await page.goto(`${HARNESS}?theme=light&tier=default_claude_max_20x`);
  await expect(page.locator(".usage-chart canvas")).toBeVisible();
  await expect(page.locator(".usage-plan")).toHaveText("Max 20x");
});

test.describe("quota forecast", () => {
  test("draws a band on Day view and honours the series toggles", async ({ page }) => {
    await openHarness(page);
    await page.locator('.usage-chip[data-g="day"]').click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: "e2e/artifacts/usage-forecast-day.png" });

    const chart = page.locator(".usage-chart");
    const withBoth = await chart.screenshot();

    // Hiding a quota series must take its projection with it.
    await toggle(page, "sevenDay").click();
    await page.waitForTimeout(200);
    const without7d = await chart.screenshot();
    expect(withBoth.equals(without7d)).toBe(false);

    await toggle(page, "fiveHour").click();
    await page.waitForTimeout(200);
    const withNeither = await chart.screenshot();
    expect(without7d.equals(withNeither)).toBe(false);
    await page.screenshot({ path: "e2e/artifacts/usage-forecast-tokens-only.png" });
  });

  test("names the projected 100% time in the readout", async ({ page }) => {
    await openHarness(page);
    await page.locator('.usage-chip[data-g="day"]').click();
    await page.waitForTimeout(250);

    const plot = page.locator(".usage-chart .u-over");
    const box = (await plot.boundingBox())!;
    // Park past the data, in the forecast region.
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2);
    const readout = page.locator(".usage-readout");
    await expect(readout).toContainText("projected");
    // A range, not a single number — the band is a span between two
    // observed paces, and the readout must not imply a point estimate.
    await expect(readout).toContainText(/\d+–\d+%/);
    // The crossing carries a weekday once it is not today: a bare "12:46"
    // for something 16 hours out reads as this afternoon.
    await expect(readout).toContainText(/100% from ~(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /);

    // Back over the data and it reverts to the per-bin readout.
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2);
    await expect(readout).toContainText("tokens");
    await expect(readout).not.toContainText("projected");
  });

  test("stays joined to the series at coarse bin widths", async ({ page }) => {
    // A bin is drawn at its START, so at 30-minute bins the bin containing
    // now sits up to half an hour behind the latest reading — and the
    // projection appeared to start out of nowhere, disconnected from the
    // line it continues. bridgeSegment closes that.
    await openHarness(page);
    await page.locator('.usage-chip[data-g="session"]').click();
    await page.waitForTimeout(200);

    const chart = page.locator(".usage-chart");
    await page.locator(".usage-bins").selectOption("30m");
    await expect(page.locator(".usage-bins")).toHaveValue("30m");
    await page.waitForTimeout(250);
    const coarse = await chart.screenshot();

    // Fine bins put the last bin essentially on top of the latest reading,
    // so no bridge is drawn — the two renderings must differ.
    await page.locator(".usage-bins").selectOption("1m");
    await expect(page.locator(".usage-bins")).toHaveValue("1m");
    await page.waitForTimeout(250);
    expect(coarse.equals(await chart.screenshot())).toBe(false);

    await page.locator(".usage-bins").selectOption("30m");
    await page.waitForTimeout(250);
    await page.screenshot({ path: "e2e/artifacts/usage-forecast-coarse-bins.png" });
  });

  test("vanishes on a range that does not contain now", async ({ page }) => {
    await openHarness(page);
    await page.locator('.usage-chip[data-g="day"]').click();
    await page.waitForTimeout(200);
    const today = await page.locator(".usage-chart").screenshot();

    // `quota_forecast` describes the LIVE windows and is not range-scoped,
    // so without the gate this would paint today's projection over last
    // week's data.
    for (let i = 0; i < 7; i++) {
      await page.locator('.usage-pager[data-dir="-1"]').click();
    }
    await page.waitForTimeout(300);
    const weekAgo = await page.locator(".usage-chart").screenshot();
    expect(today.equals(weekAgo)).toBe(false);
    await page.screenshot({ path: "e2e/artifacts/usage-forecast-absent-past.png" });
  });
});

// The live 5h window as a first-class view: the range you are actually
// inside, and the only one whose right edge is a deadline rather than a
// date. Sits ahead of the calendar chips.
test.describe("session view", () => {
  const chip = (page: Page) => page.locator('.usage-chip[data-g="session"]');

  test("pins the range to the live window, start to reset", async ({ page }) => {
    await openHarness(page);
    // First in the row — left of Day.
    await expect(page.locator(".usage-chip").first()).toHaveText("Session");

    await chip(page).click();
    await expect(chip(page)).toHaveClass(/active/);
    // Labelled as a session, not as a bare pair of timestamps.
    await expect(page.locator(".usage-period")).toContainText("Session ·");
    await expect(page.locator(".usage-chart canvas")).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: "e2e/artifacts/usage-session.png" });
  });

  test("leaves session mode on any other navigation", async ({ page }) => {
    await openHarness(page);
    await chip(page).click();
    await expect(chip(page)).toHaveClass(/active/);

    // Paging lands on the window before this one, which is not the session
    // you are in.
    await page.locator('.usage-pager[data-dir="-1"]').click();
    await expect(chip(page)).not.toHaveClass(/active/);

    await chip(page).click();
    await expect(chip(page)).toHaveClass(/active/);
    await page.locator('.usage-chip[data-g="week"]').click();
    await expect(chip(page)).not.toHaveClass(/active/);
    await expect(page.locator('.usage-chip[data-g="week"]')).toHaveClass(/active/);
  });
});
