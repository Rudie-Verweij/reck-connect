import { test, expect, type Page } from "@playwright/test";

// Browser-level tests of the markdown viewer's post-mount enhancement passes
// against renderer/markdown-harness.html (no daemon, no Electron).
//
// These live here rather than in vitest on purpose: jsdom has no layout engine
// and no real SVG, so it cannot tell a rendered mermaid diagram from a blank
// div. Only a real browser can judge whether §3/§4 of
// docs/markdown-viewer-integration.md actually work. The vitest suite covers
// the surrounding contract (when we load the libraries, what config we hand
// them, staleness); this file covers "did it paint".
//
// Screenshots land in e2e/artifacts/ alongside the usage-view ones.

// Relative to `use.baseURL` — see playwright.config.ts, which honours
// RECK_E2E_PORT so the suite can move off a contested 5173.
const HARNESS = "/markdown-harness.html";

async function openHarness(
  page: Page,
  opts: { fixture?: "rich" | "plain" | "bare"; theme?: "light" | "dark" } = {},
): Promise<void> {
  const fixture = opts.fixture ?? "rich";
  const theme = opts.theme ?? "dark";
  await page.goto(`${HARNESS}?fixture=${fixture}&theme=${theme}`);
  // The harness sets this once whenEnhanced() has settled, so every assertion
  // below runs against a final layout rather than racing the lazy imports.
  await expect(page.locator("body[data-enhanced='true']")).toBeAttached();
}

test.describe("mermaid", () => {
  test("replaces the fence with an inline SVG diagram", async ({ page }) => {
    await openHarness(page);

    const svg = page.locator(".file-viewer-body .reck-mermaid svg");
    await expect(svg.first()).toBeVisible();

    // The source block must be gone, not merely hidden behind the diagram.
    await expect(
      page.locator(".file-viewer-body pre code.language-mermaid"),
    ).toHaveCount(0);

    // A diagram with real geometry, not a collapsed 0x0 placeholder.
    const box = await svg.first().boundingBox();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(50);
  });

  test("renders the diagram outside any code block", async ({ page }) => {
    await openHarness(page);
    // Regression guard for the shape the source doc's recipe produces: the SVG
    // living inside <pre><code>, wearing the code-block treatment. (Note
    // `.file-viewer-body` itself falls back to the mono stack when --font-sans
    // is unset, so the container's font proves nothing — check the diagram's.)
    await expect(page.locator(".file-viewer-body pre svg")).toHaveCount(0);
    await expect(page.locator(".file-viewer-body pre .reck-mermaid")).toHaveCount(0);

    const font = await page
      .locator(".file-viewer-body .reck-mermaid svg")
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font).not.toMatch(/mono/i);
  });

  test("renders the node labels from the flowchart", async ({ page }) => {
    await openHarness(page);
    // Mermaid v11 flowcharts put labels in <foreignObject> HTML rather than
    // SVG <text>, so assert on the diagram's text content instead of a tag.
    const labels = await page
      .locator(".file-viewer-body .reck-mermaid svg")
      .first()
      .evaluate((el) => el.textContent ?? "");
    expect(labels).toContain("Open .md popup");
    expect(labels).toContain("Skip the 600 KB");
  });

  test("leaves non-mermaid fenced code as a code block", async ({ page }) => {
    await openHarness(page);
    const ts = page.locator(".file-viewer-body code.language-typescript");
    await expect(ts).toBeVisible();
    // The `$E=mc^2$` inside the code sample must NOT have been typeset —
    // KaTeX ignores pre/code by default and we rely on that.
    await expect(ts.locator(".katex")).toHaveCount(0);
    await expect(ts).toContainText("$E=mc^2$");
  });
});

test.describe("KaTeX", () => {
  test("typesets inline and display math", async ({ page }) => {
    await openHarness(page);
    const katex = page.locator(".file-viewer-body .katex");
    // Inline, display, and the deliberately-malformed one.
    expect(await katex.count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".file-viewer-body .katex-display")).toBeVisible();
  });

  test("emits no MathML, so search and TTS see each equation once", async ({
    page,
  }) => {
    await openHarness(page);
    // output:"html" — the default htmlAndMathml would add a parallel subtree
    // holding the LaTeX source, which both text-walkers would index twice.
    await expect(page.locator(".file-viewer-body .katex-mathml")).toHaveCount(0);
    await expect(page.locator(".file-viewer-body math")).toHaveCount(0);
  });

  test("a malformed equation renders in place instead of breaking the page", async ({
    page,
  }) => {
    await openHarness(page);
    // throwOnError:false — the rest of the document must still be there.
    await expect(page.locator(".file-viewer-body h1")).toBeVisible();
    await expect(page.locator(".file-viewer-body img")).toBeVisible();
  });
});

test.describe("images", () => {
  test("carry the native lazy-loading hints through sanitization", async ({
    page,
  }) => {
    await openHarness(page);
    const img = page.locator(".file-viewer-body img").first();
    await expect(img).toHaveAttribute("loading", "lazy");
    await expect(img).toHaveAttribute("decoding", "async");
    // And they survive as live DOM properties, not just as markup — i.e.
    // DOMPurify's ALLOWED_ATTR really does keep them.
    expect(await img.evaluate((el: HTMLImageElement) => el.loading)).toBe("lazy");
  });
});

test.describe("lazy loading", () => {
  test("a document with diagrams and math fetches both libraries", async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));
    await openHarness(page, { fixture: "rich" });

    expect(requested.some((u) => /mermaid/i.test(u))).toBe(true);
    expect(requested.some((u) => /katex/i.test(u))).toBe(true);
  });

  test("a plain document fetches neither", async ({ page }) => {
    // This is the whole point of the lazy import: ~600 KB of mermaid and
    // ~280 KB of KaTeX must not load for the majority of files, which contain
    // neither diagrams nor math.
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));
    await openHarness(page, { fixture: "plain" });

    expect(requested.filter((u) => /mermaid/i.test(u))).toEqual([]);
    expect(requested.filter((u) => /katex/i.test(u))).toEqual([]);
  });
});

test.describe("console health", () => {
  test("renders without CSP violations or library errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));

    await openHarness(page);

    expect(
      errors.filter((e) => /Content Security Policy|mermaid|katex/i.test(e)),
    ).toEqual([]);
  });
});

test.describe("TOC sidebar", () => {
  test("is collapsed by default and the body still scrolls", async ({ page }) => {
    await openHarness(page);
    // The popup is small and most files are short: the TOC must not steal
    // width until asked.
    await expect(page.locator(".file-viewer-toc")).toBeHidden();
    await expect(page.locator(".file-viewer-toc-toggle-slot button")).toBeVisible();

    // The whole point of keeping `body` as the sole scroll container.
    const scrollers = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".file-viewer-root *"))
        .filter((el) => el.scrollHeight > el.clientHeight + 1)
        .filter((el) => {
          const o = getComputedStyle(el).overflowY;
          return o === "auto" || o === "scroll";
        })
        .map((el) => el.className),
    );
    expect(scrollers).toEqual(["file-viewer-body"]);
  });

  test("the chip opens it and lists the document's headings", async ({ page }) => {
    await openHarness(page);
    await page.locator(".file-viewer-toc-toggle-slot button").click();

    const toc = page.locator(".file-viewer-toc");
    await expect(toc).toBeVisible();
    await expect(toc.locator("a").first()).toHaveText("Markdown viewer harness");
    // h1-h4 from the rich fixture, and no h5+.
    expect(await toc.locator("a").count()).toBeGreaterThanOrEqual(6);

    // Animated open to a real width, not a 0px sliver.
    await expect
      .poll(async () => (await toc.boundingBox())!.width)
      .toBeGreaterThan(100);
  });

  test("clicking an entry scrolls to that heading", async ({ page }) => {
    await openHarness(page);
    await page.locator(".file-viewer-toc-toggle-slot button").click();
    await expect(page.locator(".file-viewer-toc")).toBeVisible();

    const body = page.locator(".file-viewer-body");
    expect(await body.evaluate((el) => el.scrollTop)).toBe(0);

    await page.locator(".file-viewer-toc a", { hasText: "Image" }).click();
    await expect.poll(async () => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
  });

  test("scroll-spy marks the heading currently in view", async ({ page }) => {
    await openHarness(page);
    await page.locator(".file-viewer-toc-toggle-slot button").click();
    await expect(page.locator(".file-viewer-toc")).toBeVisible();

    // Scroll a specific heading to the top of the scroller rather than
    // slamming to the bottom: `rootMargin: "0px 0px -70% 0px"` means only the
    // top 30% of the viewport counts as "current", so at scrollHeight every
    // heading can sit above the band and nothing is active — which says
    // nothing about whether scroll-spy works.
    await page.locator(".file-viewer-body").evaluate((el) => {
      const target = el.querySelector<HTMLElement>("#math")!;
      el.scrollTop = target.offsetTop - el.offsetTop;
    });
    await expect
      .poll(async () => page.locator(".file-viewer-toc a.active").count())
      .toBeGreaterThan(0);
    await expect(page.locator(".file-viewer-toc a.active").first()).toHaveText(
      /Math/,
    );
  });

  test("its open state survives a reload", async ({ page }) => {
    await openHarness(page);
    await page.locator(".file-viewer-toc-toggle-slot button").click();
    await expect(page.locator(".file-viewer-toc")).toBeVisible();

    await page.reload();
    await expect(page.locator("body[data-enhanced='true']")).toBeAttached();
    await expect(page.locator(".file-viewer-toc")).toBeVisible();
  });

  test("a document with no headings gets no chip at all", async ({ page }) => {
    // A control that opens an empty panel is worse than no control.
    await openHarness(page, { fixture: "bare" });
    await expect(page.locator(".file-viewer-toc-toggle-slot button")).toHaveCount(0);
    await expect(page.locator(".file-viewer-toc")).toBeHidden();
    // And the body keeps the full width.
    const cols = await page
      .locator(".file-viewer-content")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
    expect(cols.startsWith("0px")).toBe(true);
  });
});

test.describe("image lightbox", () => {
  test("a plain click opens the image larger than the reading column", async ({
    page,
  }) => {
    // Popup-shaped viewport on purpose. The in-flow image is clamped by the
    // reading column's width AND its 32px side padding, so on a narrow window
    // the overlay is a real gain. On a wide, short window it need not be —
    // `object-fit: contain` fits to the shorter axis, so a 16:9 image in a
    // 1280x720 window renders *narrower* in the overlay than in flow. The
    // feature is for popups, so measure at popup proportions.
    await page.setViewportSize({ width: 720, height: 1000 });
    await openHarness(page);

    const img = page.locator(".file-viewer-body img").first();
    const thumb = (await img.boundingBox())!;

    await img.click();

    const overlay = page.locator(".reck-lightbox");
    await expect(overlay).toBeVisible();
    const full = page.locator(".reck-lightbox img");
    await expect(full).toBeVisible();
    expect((await full.boundingBox())!.width).toBeGreaterThan(thumb.width);
  });

  test("Escape closes it", async ({ page }) => {
    await openHarness(page);
    await page.locator(".file-viewer-body img").first().click();
    await expect(page.locator(".reck-lightbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".reck-lightbox")).toHaveCount(0);
  });

  test("a backdrop click closes it, a click on the image does not", async ({
    page,
  }) => {
    await openHarness(page);
    await page.locator(".file-viewer-body img").first().click();
    const overlay = page.locator(".reck-lightbox");
    await expect(overlay).toBeVisible();

    // Corner of the overlay, well clear of the centred image.
    const box = (await overlay.boundingBox())!;
    await page.mouse.click(box.x + 6, box.y + 6);
    await expect(overlay).toHaveCount(0);

    await page.locator(".file-viewer-body img").first().click();
    await page.locator(".reck-lightbox img").click();
    await expect(page.locator(".reck-lightbox")).toBeVisible();
  });

  test("Cmd+click on an image does not open it", async ({ page }) => {
    await openHarness(page);
    await page
      .locator(".file-viewer-body img")
      .first()
      .click({ modifiers: ["Meta"] });
    await expect(page.locator(".reck-lightbox")).toHaveCount(0);
  });

  test("leaves the header reachable so the popup can still be closed", async ({
    page,
  }) => {
    await openHarness(page);
    await page.locator(".file-viewer-body img").first().click();
    const overlay = (await page.locator(".reck-lightbox").boundingBox())!;
    const header = (await page.locator(".file-viewer-header").boundingBox())!;
    expect(overlay.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  });
});

test.describe("screenshots", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme} theme renders diagrams and math`, async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 1100 });
      await openHarness(page, { theme });
      await expect(page.locator(".file-viewer-body .reck-mermaid svg").first()).toBeVisible();
      await page.screenshot({
        path: `e2e/artifacts/markdown-${theme}.png`,
        fullPage: true,
      });
    });
  }
});
