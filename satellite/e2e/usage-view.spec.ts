import { test, expect, type Page } from "@playwright/test";

// Browser-level tests of the usage overlay against the synthetic-API
// harness (renderer/usage-harness.html — no daemon needed). Covers the
// two field reports from v1: the card growing on hover, and the fixed
// bin widths. Screenshots land in e2e/artifacts/ for visual review.

const HARNESS = "http://localhost:5173/usage-harness.html";

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
