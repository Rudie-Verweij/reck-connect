// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachStartupSplash } from "./startup-splash";

function mountSplash(): HTMLElement {
  document.body.innerHTML = `
    <div id="boot-splash">
      <span class="boot-splash-step-label"></span>
      <div class="boot-splash-progress-fill"></div>
    </div>
  `;
  return document.getElementById("boot-splash")!;
}

describe("attachStartupSplash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("holds the splash visible for at least MIN_DISPLAY_MS before starting fade", async () => {
    const root = mountSplash();
    const splash = attachStartupSplash();

    const dismissed = splash.dismiss();

    // Immediately after dismiss(): still no fade class — waiting out the floor.
    expect(root.classList.contains("boot-splash-dismissed")).toBe(false);
    expect(document.getElementById("boot-splash")).toBe(root);

    // Halfway through the floor — still visible.
    await vi.advanceTimersByTimeAsync(500);
    expect(root.classList.contains("boot-splash-dismissed")).toBe(false);

    // Just past the floor — fade class applied.
    await vi.advanceTimersByTimeAsync(500);
    expect(root.classList.contains("boot-splash-dismissed")).toBe(true);

    // Safety-timeout removes the element so the promise resolves.
    await vi.advanceTimersByTimeAsync(600);
    await dismissed;
    expect(document.getElementById("boot-splash")).toBeNull();
  });

  it("starts the fade immediately if the floor has already elapsed", async () => {
    const root = mountSplash();
    const splash = attachStartupSplash();

    await vi.advanceTimersByTimeAsync(1500);

    const dismissed = splash.dismiss();

    // No zero-delay setTimeout delay to advance through — should fade now.
    await vi.advanceTimersByTimeAsync(0);
    expect(root.classList.contains("boot-splash-dismissed")).toBe(true);

    await vi.advanceTimersByTimeAsync(600);
    await dismissed;
    expect(document.getElementById("boot-splash")).toBeNull();
  });

  it("a second dismiss() is a no-op even before the floor elapses", async () => {
    mountSplash();
    const splash = attachStartupSplash();

    void splash.dismiss();
    const second = splash.dismiss();
    await expect(second).resolves.toBeUndefined();
  });

  it("step() updates the label and progress width", () => {
    const root = mountSplash();
    attachStartupSplash().step("station");
    const label = root.querySelector<HTMLElement>(".boot-splash-step-label")!;
    const fill = root.querySelector<HTMLElement>(".boot-splash-progress-fill")!;
    expect(label.textContent).toBe("Connecting to station");
    expect(fill.style.width).toBe("30%");
  });

  it("markFirstLaunch() overrides the label and maxes the progress bar", () => {
    const root = mountSplash();
    attachStartupSplash().markFirstLaunch();
    const label = root.querySelector<HTMLElement>(".boot-splash-step-label")!;
    const fill = root.querySelector<HTMLElement>(".boot-splash-progress-fill")!;
    expect(label.textContent).toBe("Opening setup");
    expect(fill.style.width).toBe("100%");
  });
});
