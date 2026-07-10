import { test } from "@playwright/test";
import { launchApp, LaunchedApp } from "./harness";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

/**
 * Pitch-deck capture spec — drives the Electron app through a few
 * short scenes and dumps a PNG frame sequence per scene under
 * `/tmp/reck-captures/<scene>/`. A separate bash step turns the
 * PNG sequences into MP4 / GIF for embedding in the PowerPoint.
 *
 * Scenes 03+ stand up a tiny in-process HTTP mock that pretends to be
 * reck-stationd. The mock answers GET /health, /projects, and
 * /projects/:id with fixture data so the renderer paints the project
 * rail with mixed stoplight states.
 */

const CAPTURE_ROOT = "/tmp/reck-captures";

interface Recorder {
  stop(): Promise<number>;
}

function startRecording(window: import("@playwright/test").Page, scene: string, fps = 20): Recorder {
  const dir = path.join(CAPTURE_ROOT, scene);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  let frame = 0;
  let stopped = false;
  const intervalMs = Math.max(20, Math.floor(1000 / fps));

  const tick = async () => {
    if (stopped) return;
    const i = frame++;
    const file = path.join(dir, `frame-${String(i).padStart(4, "0")}.png`);
    try {
      await window.screenshot({ path: file, type: "png" });
    } catch {
      // App closed — stop the loop.
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      await new Promise((r) => setTimeout(r, intervalMs + 50));
      return frame;
    },
  };
}

interface MockProjectFixture {
  id: string;
  name: string;
  display_name?: string;
  cwd: string;
  pane_count: number;
  pane_stoplights: ("ready" | "working" | "idle" | "input")[];
  pane_ids: string[];
  stoplight: "ready" | "working" | "idle" | "input";
  available: boolean;
}

const FIXTURE_PROJECTS: MockProjectFixture[] = [
  {
    id: "reck-connect-studio",
    name: "Reck Connect Studio",
    display_name: "Reck Connect",
    cwd: "/Users/reck-connect/projects/reck-connect-studio",
    pane_count: 3,
    pane_stoplights: ["working", "ready", "input"],
    pane_ids: ["p_a1", "p_a2", "p_a3"],
    stoplight: "input",
    available: true,
  },
  {
    id: "reckon-card-game",
    name: "Reckon Card Game",
    cwd: "/Users/reck-connect/projects/reckon-card-game",
    pane_count: 2,
    pane_stoplights: ["working", "working"],
    pane_ids: ["p_b1", "p_b2"],
    stoplight: "working",
    available: true,
  },
  {
    id: "weekly-reckoning",
    name: "Weekly Reckoning",
    cwd: "/Users/reck-connect/projects/weekly-reckoning",
    pane_count: 1,
    pane_stoplights: ["idle"],
    pane_ids: ["p_c1"],
    stoplight: "idle",
    available: true,
  },
  {
    id: "scratch",
    name: "Scratch",
    cwd: "/Users/reck-connect/projects/scratch",
    pane_count: 0,
    pane_stoplights: [],
    pane_ids: [],
    stoplight: "ready",
    available: true,
  },
];

interface MockDaemon {
  url: string;
  close(): void;
}

function startMockDaemon(): Promise<MockDaemon> {
  return new Promise((resolve) => {
    const projects = FIXTURE_PROJECTS;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const send = (status: number, body: unknown) => {
        const text = JSON.stringify(body);
        res.writeHead(status, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "content-length": Buffer.byteLength(text).toString(),
        });
        res.end(text);
      };
      if (url.pathname === "/health") {
        return send(200, { status: "ok", version: "mock-0.0.0", uptime_sec: 42 });
      }
      if (url.pathname === "/projects" && req.method === "GET") {
        return send(200, { projects });
      }
      if (url.pathname.startsWith("/projects/") && req.method === "GET") {
        const id = decodeURIComponent(url.pathname.split("/")[2] ?? "");
        const sub = url.pathname.split("/")[3];
        const proj = projects.find((p) => p.id === id);
        if (!proj) return send(404, { error: "not_found" });
        if (sub === "sessions") {
          return send(200, { sessions: [] });
        }
        return send(200, {
          id: proj.id,
          name: proj.name,
          cwd: proj.cwd,
          panes: proj.pane_ids.map((pid, i) => ({
            id: pid,
            kind: "claude",
            state: "running",
            stoplight: proj.pane_stoplights[i] ?? "ready",
          })),
          display_name: proj.display_name,
        });
      }
      if (url.pathname === "/restore-candidates") {
        return send(200, { candidates: [] });
      }
      // Catch-all so the renderer doesn't sit on a 404 spinner.
      send(200, {});
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as import("node:net").AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

test.describe("pitch capture", () => {
  test.setTimeout(120_000);

  test("scene-01: cold boot to preferences view", async () => {
    let ctx: LaunchedApp | undefined;
    try {
      ctx = await launchApp();
      const rec = startRecording(ctx.window, "scene-01-boot", 20);
      await new Promise((r) => setTimeout(r, 3000));
      const frames = await rec.stop();
      console.log(`[capture] scene-01-boot: ${frames} frames`);
    } finally {
      await ctx?.close();
    }
  });

  test("scene-02: preferences card hover + interaction", async () => {
    let ctx: LaunchedApp | undefined;
    try {
      ctx = await launchApp();
      await ctx.window
        .locator(".settings-card, .app-shell")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
      await new Promise((r) => setTimeout(r, 400));

      const rec = startRecording(ctx.window, "scene-02-prefs", 20);
      const settings = ctx.window.locator(".settings-card").first();
      const box = await settings.boundingBox();
      if (box) {
        await ctx.window.mouse.move(box.x + 40, box.y + 40);
        await new Promise((r) => setTimeout(r, 400));
        await ctx.window.mouse.move(box.x + box.width - 60, box.y + 80, { steps: 12 });
        await new Promise((r) => setTimeout(r, 400));
        await ctx.window.mouse.move(box.x + box.width / 2, box.y + box.height - 40, { steps: 12 });
        await new Promise((r) => setTimeout(r, 800));
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
      const frames = await rec.stop();
      console.log(`[capture] scene-02-prefs: ${frames} frames`);
    } finally {
      await ctx?.close();
    }
  });

  test("scene-03: project rail + stoplight states (mock daemon)", async () => {
    const mock = await startMockDaemon();
    let ctx: LaunchedApp | undefined;
    try {
      // Tell the satellite about the mock daemon by writing a bootstrap.json
      // into its userData dir BEFORE launch — first-run boot reads this file
      // and writes settings.json so the app skips the preferences card.
      // We don't have the userData path until after launchApp creates it,
      // so we override userData via a custom args wrapper.
      ctx = await launchApp({
        env: {
          // Force the renderer's Local-mode autostart off; we want it
          // pointing at our mock as the "Station".
          RECK_E2E_DISABLE_LOCAL_AUTOSTART: "1",
        },
      });
      // Write bootstrap into the userData dir we already created. Since the
      // app already booted, restart by closing + re-launching with the file
      // in place. Simpler: drive the prefs UI to fill in the URL.
      const url = mock.url;

      // Wait for prefs card.
      await ctx.window
        .locator(".settings-card, .app-shell")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });

      // Toggle Station on, fill URL, fill any token, click Save.
      const stationToggle = ctx.window.locator(
        'input[type="checkbox"]:near(:text("Station"))',
      ).first();
      // Best-effort: the actual selectors may differ; fall back to scanning labels.
      try {
        await stationToggle.check({ timeout: 1500 });
      } catch {
        // Fall back to clicking the label.
        await ctx.window.getByText(/Station \(optional/).click().catch(() => {});
      }

      // Fill station URL — use a robust selector by placeholder.
      const urlField = ctx.window.locator('input[placeholder*="tailnet" i], input[placeholder*="7315" i]').first();
      await urlField.fill(url, { timeout: 2000 }).catch(async () => {
        // Fallback by row-label proximity.
        await ctx.window.locator('input').nth(1).fill(url).catch(() => {});
      });

      // Token field — anything will do since the mock ignores auth.
      const tokenField = ctx.window.locator('input[placeholder*="install-station" i]').first();
      await tokenField.fill("mock-token-pitch-deck").catch(() => {});

      // Save.
      const save = ctx.window.getByRole("button", { name: /save/i }).first();
      await save.click({ timeout: 2000 }).catch(() => {});

      // Wait for the rail / app shell to mount.
      await ctx.window
        .locator(".rail, .project-rail, .app-shell")
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => {});
      // Settle.
      await new Promise((r) => setTimeout(r, 800));

      // Now record.
      const rec = startRecording(ctx.window, "scene-03-rail", 20);
      // Hover over different rail rows to surface the per-pane dots.
      const rows = ctx.window.locator('[class*="rail"] [class*="project"], .rail-row, button[role="tab"]');
      const count = await rows.count().catch(() => 0);
      if (count > 0) {
        for (let i = 0; i < Math.min(count, 4); i++) {
          const box = await rows.nth(i).boundingBox().catch(() => null);
          if (box) {
            await ctx.window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      } else {
        // Static dwell so we still capture the rendered shell.
        await new Promise((r) => setTimeout(r, 2500));
      }

      const frames = await rec.stop();
      console.log(`[capture] scene-03-rail: ${frames} frames`);
    } finally {
      await ctx?.close();
      mock.close();
    }
  });
});
