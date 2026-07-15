// resolution-pipeline regression tests.
//
// Drives the REAL `file:openInViewer` handler (registered via
// `registerFileViewerIpc`) end-to-end against a real temp-dir project
// tree: "click text X inside popup Y → which file opens / which roots
// get searched". Every row encodes a field failure from 2026-06-06
// (TotoScopeBeta plan popup) as expected-correct behavior.
//
// Why this file exists: 1441 green unit tests missed the projectCwd
// degradation because every piece (rootRelativeCandidate,
// composeSuffixSearchRoots, workers, banner) was tested in isolation.
// The failure lived in the seams. This harness tests the seams.
//
// Honesty constraints:
//   - real fs fixtures (no fs mocks),
//   - real ripgrep over the fixture (rows are skipped if rg is not
//     installed — `brew install ripgrep`); a fake rg would have masked
//     the exact --no-ignore defect this guards against,
//   - the only fakes are Electron (BrowserWindow/ipcMain recorders)
//     and the ssh spawn (never dial the Pi from a unit test).
//
// Rows that document a NOT-YET-FIXED defect are marked `it.fails` so
// the suite stays green while the defect is open; fixing phases flip
// them to plain `it`. A `.fails` row that starts passing errors — so
// regressions in either direction are caught.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

// ── Electron fake ────────────────────────────────────────────────────
// `vi.mock` is hoisted above imports, so shared state must live in
// `vi.hoisted`. The fake BrowserWindow records the popup URL (the
// observable boundary the renderer would see) and every
// webContents.send (the streaming-search event feed).

const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  let nextId = 1;

  class FakeWebContents {
    id: number;
    sent: Array<{ channel: string; payload: unknown }> = [];
    private listeners = new Map<string, Listener[]>();
    constructor(id: number) {
      this.id = id;
    }
    send(channel: string, payload: unknown): void {
      this.sent.push({ channel, payload });
    }
    on(event: string, cb: Listener): void {
      const arr = this.listeners.get(event) ?? [];
      arr.push(cb);
      this.listeners.set(event, arr);
    }
    setWindowOpenHandler(_cb: Listener): void {
      // recorded-only; popups never window.open in these tests
    }
    isCrashed(): boolean {
      return false;
    }
  }

  class FakeBrowserWindow {
    id: number;
    webContents: FakeWebContents;
    ctorOpts: Record<string, unknown>;
    loadedSearch: string | null = null;
    loadedUrl: string | null = null;
    focusCount = 0;
    private destroyed = false;
    private listeners = new Map<string, Listener[]>();
    private onceListeners = new Map<string, Listener[]>();

    constructor(opts: Record<string, unknown>) {
      this.id = nextId;
      this.webContents = new FakeWebContents(nextId * 1000);
      nextId += 1;
      this.ctorOpts = opts;
      FakeBrowserWindow.instances.push(this);
    }

    static instances: FakeBrowserWindow[] = [];

    loadURL(url: string): void {
      this.loadedUrl = url;
      const q = url.indexOf("?");
      this.loadedSearch = q === -1 ? "" : url.slice(q);
    }
    loadFile(_p: string, opts?: { search?: string }): void {
      this.loadedUrl = `file://${_p}`;
      this.loadedSearch = opts?.search ?? "";
    }
    on(event: string, cb: Listener): void {
      const arr = this.listeners.get(event) ?? [];
      arr.push(cb);
      this.listeners.set(event, arr);
    }
    once(event: string, cb: Listener): void {
      const arr = this.onceListeners.get(event) ?? [];
      arr.push(cb);
      this.onceListeners.set(event, arr);
    }
    private emit(event: string, ...args: unknown[]): void {
      for (const cb of this.listeners.get(event) ?? []) cb(...args);
      const once = this.onceListeners.get(event) ?? [];
      this.onceListeners.delete(event);
      for (const cb of once) cb(...args);
    }
    focus(): void {
      this.focusCount += 1;
    }
    close(): void {
      if (this.destroyed) return;
      this.emit("close");
      this.destroyed = true;
      this.emit("closed");
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
  }

  const ipcHandlers = new Map<
    string,
    (e: unknown, arg: unknown) => unknown
  >();

  return { FakeBrowserWindow, ipcHandlers };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, arg: unknown) => unknown) => {
      h.ipcHandlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      h.ipcHandlers.delete(channel);
    },
  },
  BrowserWindow: h.FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({
      workAreaSize: { width: 1920, height: 1080 },
    }),
  },
  app: { on: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

const {
  registerFileViewerIpc,
  closeAllFileViewers,
} = await import("./file-viewer");
type FileViewerIpcDeps = import("./file-viewer").FileViewerIpcDeps;
type SearchBackendOverrides = import("./file-viewer").SearchBackendOverrides;
const { defaultLocalExecutableProbe } = await import("./backend-detection");
type SpawnedChild = import("./search-worker-rg-ssh").SpawnedChild;

// Real ripgrep — required for the search rows. Rows degrade to skip
// (with this constant named in the skip reason) rather than fake rg.
const rgPath = await defaultLocalExecutableProbe("rg");
const itRg = rgPath ? it : it.skip;
const itRgFails = rgPath ? it.fails : it.skip;

// ── Fixture ──────────────────────────────────────────────────────────
// Mirrors the field layout: a mount root, one project under it, a plan
// popup inside `.claude/plans/`, one gitignored target, one nested
// bare-name target. `.git/` makes rg honor the .gitignore exactly like
// the real (git-managed) TotoScopeBeta project.

const STATION_ROOT = "/home/pi/projects";
const STATION_HOME = "/home/pi";

// Cascaded clicks inside a mount-mirror popup arrive as PI-style
// absolute paths: the popup displays Pi conventions (displayTranslation)
// and the renderer resolves link text against the displayed dir. Pinned
// by the field evidence — the create banner showed the Pi-form doubled
// path `/home/pi/projects/TotoScopeBeta/.claude/plans/frontend/…`,
// which only the station+absolute → mount-translate route produces.
const PI_PROJ = `${STATION_ROOT}/TotoScopeBeta`;
const PI_PLANS = `${PI_PROJ}/.claude/plans`;
const PI_PLAN_FILE = `${PI_PLANS}/state-to-database-plan.md`;

interface Fixture {
  tmp: string;
  mountPoint: string;
  home: string;
  proj: string;
  plansDir: string;
  planFile: string;
}

function makeFixture(): Fixture {
  // realpathSync: /tmp is a symlink on macOS; the pipeline realpaths
  // resolved files, so fixture strings must be in canonical form or
  // every path assertion fails on /tmp vs /private/tmp.
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "reck-pipeline-")),
  );
  const mountPoint = path.join(tmp, "mount");
  const home = path.join(tmp, "home");
  const proj = path.join(mountPoint, "TotoScopeBeta");
  const plansDir = path.join(proj, ".claude", "plans");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  fs.mkdirSync(path.join(proj, "frontend"), { recursive: true });
  fs.mkdirSync(path.join(proj, "backend", "app", "utils"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(proj, "docs", "sub"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".gitignore"), "next-env.d.ts\n");
  const planFile = path.join(plansDir, "state-to-database-plan.md");
  fs.writeFileSync(planFile, "# plan\nsee frontend/next-env.d.ts\n");
  fs.writeFileSync(
    path.join(proj, "frontend", "next-env.d.ts"),
    "/// <reference types=\"next\" />\n",
  );
  fs.writeFileSync(
    path.join(proj, "backend", "app", "utils", "snapshot_lookup.py"),
    "def lookup():\n    pass\n",
  );
  fs.writeFileSync(path.join(proj, "docs", "x.md"), "# x\n");
  fs.writeFileSync(
    path.join(proj, "docs", "sub", "readme-link.md"),
    "[x](docs/x.md)\n",
  );
  // 2026-07-10 obsidian-brain field layout: a wiki note in a subfolder
  // linking to a dot-dir target relative to the PROJECT ROOT.
  fs.mkdirSync(path.join(proj, "wiki", "concepts"), { recursive: true });
  fs.mkdirSync(
    path.join(proj, ".raw", "personal", "clients", "unidis", "notes"),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(proj, "wiki", "concepts", "page.md"),
    "sources:\n- .raw/personal/clients/unidis/notes/note.md\n",
  );
  fs.writeFileSync(
    path.join(proj, ".raw", "personal", "clients", "unidis", "notes", "note.md"),
    "# interview notes\n",
  );
  return { tmp, mountPoint, home, proj, plansDir, planFile };
}

function makeDeps(
  fix: Fixture,
  overrides?: SearchBackendOverrides,
): FileViewerIpcDeps {
  return {
    roots: () => [fix.mountPoint],
    localHome: () => fix.home,
    stationHome: () => STATION_HOME,
    stationRoot: () => STATION_ROOT,
    mountPointPath: () => fix.mountPoint,
    mountPoint: () => fix.mountPoint,
    buildCreateOptions: (resolvedPath: string) => ({
      resolvedPath,
      bgColor: "#ffffff",
      rendererHtmlPath: "/nonexistent/file-viewer.html",
      devServerUrl: null,
      preloadPath: "/nonexistent/preload.js",
    }),
    searchBackendOverrides: overrides,
  };
}

// ── Drivers / assertion helpers ──────────────────────────────────────

interface ClickArg {
  /** What the renderer sends after resolving the click against the
   *  opener's directory (resolveActivatePath semantics). */
  path: string;
  originalText: string;
  opener?: string;
  sourceHost?: "station" | "local";
  projectCwd?: string;
}

async function click(arg: ClickArg): Promise<unknown> {
  const handler = h.ipcHandlers.get("file:openInViewer");
  if (!handler) throw new Error("file:openInViewer handler not registered");
  return handler({ sender: { id: 9_999 } }, arg);
}

function popupWindows(): InstanceType<typeof h.FakeBrowserWindow>[] {
  return h.FakeBrowserWindow.instances;
}

function urlParams(
  win: InstanceType<typeof h.FakeBrowserWindow>,
): URLSearchParams {
  const search = win.loadedSearch ?? "";
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  // Below vitest's 5s test timeout so OUR error (naming `what`) wins.
  timeoutMs = 4_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function sentOn(
  win: InstanceType<typeof h.FakeBrowserWindow>,
  channel: string,
): unknown[] {
  return win.webContents.sent
    .filter((s) => s.channel === channel)
    .map((s) => s.payload);
}

async function waitForSearchTerminal(
  win: InstanceType<typeof h.FakeBrowserWindow>,
): Promise<{
  matches: string[];
  kind: "done" | "cancelled";
  payload: Record<string, unknown>;
}> {
  await waitFor(
    () =>
      sentOn(win, "file:suffix:done").length > 0 ||
      sentOn(win, "file:suffix:cancelled").length > 0,
    "search terminal event (done or cancelled)",
  );
  const done = sentOn(win, "file:suffix:done");
  const kind = done.length > 0 ? ("done" as const) : ("cancelled" as const);
  const payload = (
    kind === "done" ? done[0] : sentOn(win, "file:suffix:cancelled")[0]
  ) as Record<string, unknown>;
  const matches = (sentOn(win, "file:suffix:match") as Array<{
    path: string;
  }>).map((m) => m.path);
  return { matches, kind, payload };
}

/** Fake ssh spawn: records argv, emits no stdout, exits 0 shortly after
 *  listeners attach. Matches the SpawnedChild surface the worker uses. */
function makeSshSpawnRecorder(): {
  calls: string[][];
  spawnFn: (args: readonly string[]) => SpawnedChild;
} {
  const calls: string[][] = [];
  const spawnFn = (args: readonly string[]): SpawnedChild => {
    calls.push([...args]);
    const exitListeners: Array<
      (code: number | null, signal: NodeJS.Signals | null) => void
    > = [];
    const child = {
      stdout: {
        on(_event: string, _cb: (chunk: Buffer) => void) {
          return this;
        },
      },
      stderr: null,
      on(event: string, cb: unknown) {
        if (event === "exit") {
          exitListeners.push(
            cb as (code: number | null, signal: NodeJS.Signals | null) => void,
          );
        }
        return child;
      },
      kill() {
        return true;
      },
    };
    setTimeout(() => {
      for (const cb of exitListeners) cb(0, null);
    }, 10);
    return child as unknown as SpawnedChild;
  };
  return { calls, spawnFn };
}

// ── The rows ─────────────────────────────────────────────────────────

describe("openInViewer resolution pipeline", () => {
  let fix: Fixture;

  beforeEach(() => {
    fix = makeFixture();
    h.FakeBrowserWindow.instances = [];
    // hasSshRg MUST be pinned false: without it the real probe dials
    // the Pi over ssh from a unit test (observed live — it armed a
    // real fallback worker that queried the Mac temp path on the Pi).
    registerFileViewerIpc(
      makeDeps(fix, {
        hasLocalRg: async () => rgPath,
        hasSshRg: async () => false,
      }),
    );
  });

  afterEach(() => {
    closeAllFileViewers();
    fs.rmSync(fix.tmp, { recursive: true, force: true });
  });

  // R1 — the headline field failure. Plan popup, projectCwd ABSENT,
  // click a project-root-relative reference. Renderer joins it onto the
  // popup's dir → doubled path. Must open the real project file
  // directly, with no search.
  it(
    "R1: root-relative reference in a plan popup opens the project file when projectCwd is absent",
    async () => {
      const res = await click({
        path: `${PI_PLANS}/frontend/next-env.d.ts`,
        originalText: "frontend/next-env.d.ts",
        opener: PI_PLAN_FILE,
        sourceHost: "station",
      });
      expect(res).toEqual({ ok: true });
      expect(popupWindows()).toHaveLength(1);
      const params = urlParams(popupWindows()[0]);
      expect(params.get("path")).toBe(
        path.join(fix.proj, "frontend", "next-env.d.ts"),
      );
      expect(params.get("suffixSearchPending")).toBeNull();
    },
  );

  // R2 — same click WITH projectCwd threaded (the happy path that
  // shipped). Must keep working — guards the seam refactor and every
  // later phase.
  it("R2: root-relative reference still opens directly when projectCwd IS present", async () => {
    const res = await click({
      path: `${PI_PLANS}/frontend/next-env.d.ts`,
      originalText: "frontend/next-env.d.ts",
      opener: PI_PLAN_FILE,
      sourceHost: "station",
      projectCwd: PI_PROJ,
    });
    expect(res).toEqual({ ok: true });
    expect(popupWindows()).toHaveLength(1);
    const params = urlParams(popupWindows()[0]);
    expect(params.get("path")).toBe(
      path.join(fix.proj, "frontend", "next-env.d.ts"),
    );
    expect(params.get("suffixSearchPending")).toBeNull();
  });

  // R3 — bare nested filename, projectCwd absent. No deterministic
  // rescue possible → a streaming search MUST run and its roots MUST
  // include the project tree (not just the popup's own folder).
  itRg(
    "R3: bare filename search reaches the project tree when projectCwd is absent",
    async () => {
      const res = await click({
        path: `${PI_PLANS}/snapshot_lookup.py`,
        originalText: "snapshot_lookup.py",
        opener: PI_PLAN_FILE,
        sourceHost: "station",
      });
      expect(res).toEqual({ ok: true });
      expect(popupWindows()).toHaveLength(1);
      const win = popupWindows()[0];
      expect(urlParams(win).get("suffixSearchPending")).toBe("1");
      const { matches, kind, payload } = await waitForSearchTerminal(win);
      expect(kind).toBe("done");
      expect(payload.totalFound).toBeGreaterThanOrEqual(1);
      expect(matches).toContain(
        path.join(fix.proj, "backend", "app", "utils", "snapshot_lookup.py"),
      );
    },
  );

  // R4 — doubled path, but with projectCwd absent: popup
  // shows docs/sub/readme-link.md, link text is project-root-relative
  // docs/x.md → renderer joins to docs/sub/docs/x.md.
  it(
    "R4: doubled-path miss recovers to the project-root file when projectCwd is absent",
    async () => {
      const res = await click({
        path: `${PI_PROJ}/docs/sub/docs/x.md`,
        originalText: "docs/x.md",
        opener: `${PI_PROJ}/docs/sub/readme-link.md`,
        sourceHost: "station",
      });
      expect(res).toEqual({ ok: true });
      expect(popupWindows()).toHaveLength(1);
      const params = urlParams(popupWindows()[0]);
      expect(params.get("path")).toBe(path.join(fix.proj, "docs", "x.md"));
      expect(params.get("suffixSearchPending")).toBeNull();
    },
  );

  // R5 — the gitignored target (next-env.d.ts is ignored in the real
  // TotoScopeBeta). Even with project-wide roots, plain `rg --files`
  // skips it; the search must still find it.
  itRg(
    "R5: gitignored file is still findable by the suffix search",
    async () => {
      const res = await click({
        path: `${PI_PLANS}/next-env.d.ts`,
        originalText: "next-env.d.ts",
        opener: PI_PLAN_FILE,
        sourceHost: "station",
      });
      expect(res).toEqual({ ok: true });
      const win = popupWindows()[0];
      expect(urlParams(win).get("suffixSearchPending")).toBe("1");
      const { matches, kind, payload } = await waitForSearchTerminal(win);
      expect(kind).toBe("done");
      expect(payload.totalFound).toBeGreaterThanOrEqual(1);
      expect(matches).toContain(
        path.join(fix.proj, "frontend", "next-env.d.ts"),
      );
    },
  );

  // R6 — the ssh fallback must query Pi-style roots. Mirror roots are
  // Mac paths that don't exist on the Pi; sending them verbatim made
  // the fallback silently dead (Round 8.6 regression).
  itRg(
    "R6: ssh fallback receives station-style roots, not Mac mirror paths",
    async () => {
      const ssh = makeSshSpawnRecorder();
      registerFileViewerIpc(
        makeDeps(fix, {
          hasLocalRg: async () => rgPath,
          hasSshRg: async () => true,
          sshSpawnFn: ssh.spawnFn,
        }),
      );
      const res = await click({
        path: `${PI_PLANS}/only_on_pi.py`,
        originalText: "only_on_pi.py",
        opener: PI_PLAN_FILE,
        sourceHost: "station",
      });
      expect(res).toEqual({ ok: true });
      const win = popupWindows()[0];
      const { kind } = await waitForSearchTerminal(win);
      // D6 — the primary's trailing `exit` must not cancel-terminate
      // the fallback; the chain has to run to a real `done`.
      expect(kind).toBe("done");
      // Two ssh spawns: the fast pass + the D5 zero-match --no-ignore
      // pass. Every remote command must reference Pi-side roots only.
      expect(ssh.calls).toHaveLength(2);
      for (const call of ssh.calls) {
        const remoteCmd = call[call.length - 1];
        expect(remoteCmd).toContain(`${STATION_ROOT}/TotoScopeBeta`);
        expect(remoteCmd).not.toContain(fix.mountPoint);
      }
    },
  );

  // R7 — observability: a 0-match done event must say WHERE it
  // searched, so the no-match banner can render it. Today's bug would
  // have been a five-second diagnosis with this line.
  itRg(
    "R7: zero-match done payload carries the searched roots",
    async () => {
      const res = await click({
        path: `${PI_PLANS}/ghost_nowhere.tsx`,
        originalText: "ghost_nowhere.tsx",
        opener: PI_PLAN_FILE,
        sourceHost: "station",
      });
      expect(res).toEqual({ ok: true });
      const win = popupWindows()[0];
      const { kind, payload } = await waitForSearchTerminal(win);
      expect(kind).toBe("done");
      expect(payload.totalFound).toBe(0);
      expect(payload.searchedRoots).toEqual(
        expect.arrayContaining([fix.proj]),
      );
    },
  );

  // R8 — the 2026-07-10 obsidian-brain field failure. A rendered-markdown
  // popup (LOCAL mount popup with a STATION badge) forwards the Pi-form
  // projectCwd from its URL but sends NO sourceHost. The old flag-gated
  // translation left the Pi cwd untranslated; the truthy-but-Mac-
  // nonexistent path shadowed deriveProjectAnchor and every rescue
  // collapsed to the popup file's own folder ("Searched: …/wiki/concepts").
  // Must open the real project file directly, no search.
  it(
    "R8: Pi-form projectCwd WITHOUT sourceHost still recovers a root-relative link",
    async () => {
      const res = await click({
        // renderer's resolveAgainst joined the href onto the popup dir:
        path: `${fix.proj}/wiki/concepts/.raw/personal/clients/unidis/notes/note.md`,
        originalText: ".raw/personal/clients/unidis/notes/note.md",
        opener: `${fix.proj}/wiki/concepts/page.md`,
        // no sourceHost — cascaded local-popup clicks never send one
        projectCwd: PI_PROJ, // Pi form, exactly as stamped on the popup URL
      });
      expect(res).toEqual({ ok: true });
      expect(popupWindows()).toHaveLength(1);
      const params = urlParams(popupWindows()[0]);
      expect(params.get("path")).toBe(
        path.join(fix.proj, ".raw", "personal", "clients", "unidis", "notes", "note.md"),
      );
      expect(params.get("suffixSearchPending")).toBeNull();
    },
  );

  // R9 — same click with projectCwd fully absent: deriveProjectAnchor
  // must recover the anchor from the miss path (guards the local-popup
  // cascade where no cwd was ever threaded).
  it(
    "R9: root-relative dot-dir link recovers via the derived anchor when projectCwd is absent",
    async () => {
      const res = await click({
        path: `${fix.proj}/wiki/concepts/.raw/personal/clients/unidis/notes/note.md`,
        originalText: ".raw/personal/clients/unidis/notes/note.md",
        opener: `${fix.proj}/wiki/concepts/page.md`,
      });
      expect(res).toEqual({ ok: true });
      const params = urlParams(popupWindows()[0]);
      expect(params.get("path")).toBe(
        path.join(fix.proj, ".raw", "personal", "clients", "unidis", "notes", "note.md"),
      );
      expect(params.get("suffixSearchPending")).toBeNull();
    },
  );

  // R10 — a stale/garbage threaded cwd must fall through (pathExists
  // guard) to the derived anchor instead of poisoning the rescues.
  it(
    "R10: nonexistent projectCwd falls through to the derived anchor",
    async () => {
      const res = await click({
        path: `${fix.proj}/wiki/concepts/.raw/personal/clients/unidis/notes/note.md`,
        originalText: ".raw/personal/clients/unidis/notes/note.md",
        opener: `${fix.proj}/wiki/concepts/page.md`,
        projectCwd: "/nonexistent/gone",
      });
      expect(res).toEqual({ ok: true });
      const params = urlParams(popupWindows()[0]);
      expect(params.get("path")).toBe(
        path.join(fix.proj, ".raw", "personal", "clients", "unidis", "notes", "note.md"),
      );
      expect(params.get("suffixSearchPending")).toBeNull();
    },
  );

  // R11 — stamping invariant: local popups carry the LOCAL (mount) form
  // on their URL regardless of the form the click threaded, so cascaded
  // clicks stay self-healing without depending on sourceHost.
  it(
    "R11: popup URLs are stamped with the mount-form projectCwd",
    async () => {
      const res = await click({
        path: `${PI_PROJ}/docs/x.md`,
        originalText: "docs/x.md",
        opener: PI_PLAN_FILE,
        sourceHost: "station",
        projectCwd: PI_PROJ, // Pi form in…
      });
      expect(res).toEqual({ ok: true });
      const params = urlParams(popupWindows()[0]);
      expect(params.get("path")).toBe(path.join(fix.proj, "docs", "x.md"));
      // …mount form out.
      expect(params.get("projectCwd")).toBe(fix.proj);
    },
  );
});
