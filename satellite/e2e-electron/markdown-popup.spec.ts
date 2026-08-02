import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "./harness";

// Acceptance test for the markdown viewer's post-mount enhancement passes
// (issue #109) in the REAL popup: a real BrowserWindow, the real preload, the
// real `file:openInViewer` IPC and the built renderer loaded from disk.
//
// e2e/markdown-viewer.spec.ts covers the same rendering against the dev-server
// harness page, which is faster and where the detailed assertions live. This
// spec exists to prove the one thing that harness cannot: that it all still
// works inside the actual popup window rather than a bare page.
//
// The fixture is written into the harness's temp HOME because $HOME is one of
// the built-in allowed roots (see main/file-roots.ts) — the file-viewer IPC
// refuses any path outside them.

const FIXTURE = `# Popup rendering check

Prose before the diagram.

\`\`\`mermaid
flowchart LR
  A[fence] --> B[svg]
\`\`\`

## Math

Inline math $E=mc^2$ and display math:

$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$

## Trailing

Prose so the last heading has something under it.
`;

test("markdown popup renders mermaid diagrams and KaTeX math", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });

    const filePath = path.join(ctx.homeDir, "popup-render-check.md");
    fs.writeFileSync(filePath, FIXTURE, "utf8");

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

    // The diagram: mermaid replaced the fence, and it is NOT inside a <pre>.
    const diagram = popup.locator(".file-viewer-body .reck-mermaid svg");
    await expect(diagram).toBeVisible({ timeout: 15_000 });
    await expect(
      popup.locator(".file-viewer-body pre code.language-mermaid"),
    ).toHaveCount(0);
    await expect(popup.locator(".file-viewer-body pre svg")).toHaveCount(0);

    // The math: typeset, and HTML-only so search/TTS see each equation once.
    await expect(popup.locator(".file-viewer-body .katex").first()).toBeVisible();
    await expect(popup.locator(".file-viewer-body .katex-mathml")).toHaveCount(0);

    await popup.screenshot({ path: "e2e/artifacts/markdown-popup-electron.png" });

    // The TOC: collapsed by default, opens from the header chip, and the body
    // stays the sole scroll container.
    const tocChip = popup.locator(".file-viewer-toc-toggle-slot button");
    await expect(tocChip).toBeVisible();
    await expect(popup.locator(".file-viewer-toc")).toBeHidden();

    await tocChip.click();
    await expect(popup.locator(".file-viewer-toc")).toBeVisible();
    await expect(popup.locator(".file-viewer-toc a")).toHaveCount(3);

    await popup.screenshot({
      path: "e2e/artifacts/markdown-popup-electron-toc.png",
    });
  } finally {
    await ctx.close();
  }
});
