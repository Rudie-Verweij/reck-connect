import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// `electron` is touched at module load by main wiring. The pure-handler
// API below should not actually import it, so this mock is defensive.
import { vi } from "vitest";
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn(),
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  app: { on: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

const {
  handleFileRead,
  handleFileStat,
  handleFileResolve,
  handleFileCreate,
  handleFileWrite,
  atomicWriteFile,
  computeBaseline,
  chokidarOptionsForPath,
  FILE_VIEWER_WIDTH_FRACTION,
  FILE_VIEWER_HEIGHT_FRACTION,
  FILE_VIEWER_MIN_WIDTH,
  FILE_VIEWER_MIN_HEIGHT,
  computeViewerGeometry,
  cleanupWindowResources,
  expandTildeForHost,
  WATCHER_SUPPRESS_AFTER_WRITE_MS,
  recordSelfWrite,
  shouldSuppressWatchEvent,
  searchProjectTreeBySuffix,
  composeSuffixSearchRoots,
  translateStationCwdToMount,
  translateSearchRootsToStation,
  shouldFocusExistingViewer,
} = await import("./file-viewer");

describe("file-viewer pure handlers", () => {
  let tmpRoot: string;
  let rootA: string;
  let outsideDir: string;
  let mdFile: string;
  let dirInsideRoot: string;
  let deps: { roots: () => readonly string[] };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reck-fv-"));
    rootA = path.join(tmpRoot, "project");
    outsideDir = path.join(tmpRoot, "other");
    fs.mkdirSync(rootA);
    fs.mkdirSync(outsideDir);
    mdFile = path.join(rootA, "notes.md");
    fs.writeFileSync(mdFile, "# Heading\n\nbody text", "utf8");
    dirInsideRoot = path.join(rootA, "subdir");
    fs.mkdirSync(dirInsideRoot);
    deps = { roots: () => [rootA] };
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("computeBaseline()", () => {
    it("returns {mtimeMs, sha256, size} for an existing file", () => {
      const baseline = computeBaseline(mdFile);
      expect(baseline.mtimeMs).toBeTypeOf("number");
      expect(baseline.size).toBeGreaterThan(0);
      const expectedHash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(mdFile))
        .digest("hex");
      expect(baseline.sha256).toBe(expectedHash);
    });
  });

  describe("handleFileRead()", () => {
    it("reads a file inside an allowed root and returns content + baseline", async () => {
      const result = await handleFileRead(deps, mdFile);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain("# Heading");
      expect(result.baseline.size).toBe(
        fs.statSync(mdFile).size,
      );
      expect(result.baseline.sha256).toHaveLength(64);
    });

    it("rejects a path outside all allowed roots", async () => {
      const outsideFile = path.join(outsideDir, "x.md");
      fs.writeFileSync(outsideFile, "secret");
      const result = await handleFileRead(deps, outsideFile);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("out-of-roots");
    });

    it("rejects when target is a directory, not a file", async () => {
      const result = await handleFileRead(deps, dirInsideRoot);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("is-directory");
    });

    it("surfaces not-found cleanly when path is inside root but doesn't exist", async () => {
      const ghost = path.join(rootA, "ghost.md");
      const result = await handleFileRead(deps, ghost);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("not-found");
    });

    it("rejects relative paths (must be absolute)", async () => {
      const result = await handleFileRead(deps, "notes.md");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("out-of-roots");
    });

    it("rejects non-string input", async () => {
      // @ts-expect-error — purposeful runtime abuse
      const result = await handleFileRead(deps, 42);
      expect(result.ok).toBe(false);
    });

    it("uses the deps.roots() function dynamically (root set can change at runtime)", async () => {
      let currentRoots: readonly string[] = [];
      const dynamicDeps = { roots: () => currentRoots };
      let result = await handleFileRead(dynamicDeps, mdFile);
      expect(result.ok).toBe(false);
      // Now expand the root set.
      currentRoots = [rootA];
      result = await handleFileRead(dynamicDeps, mdFile);
      expect(result.ok).toBe(true);
    });
  });

  describe("handleFileStat()", () => {
    it("returns baseline for a file inside an allowed root", async () => {
      const result = await handleFileStat(deps, mdFile);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.baseline.size).toBe(fs.statSync(mdFile).size);
    });

    it("rejects out-of-roots paths", async () => {
      const outsideFile = path.join(outsideDir, "x.md");
      fs.writeFileSync(outsideFile, "secret");
      const result = await handleFileStat(deps, outsideFile);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("out-of-roots");
    });

    it("returns not-found when target doesn't exist", async () => {
      const ghost = path.join(rootA, "ghost.md");
      const result = await handleFileStat(deps, ghost);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("not-found");
    });
  });

  describe("handleFileResolve()", () => {
    // Helper: the handler returns canonical (realpath'd) absolute paths.
    // On macOS /var is a symlink to /private/var, so anything constructed
    // from os.tmpdir() must be realpath'd before comparison.
    const canon = (p: string): string => fs.realpathSync(path.dirname(p)) + "/" + path.basename(p);

    it("returns {exists, isDirectory, parentExists} for an existing file", async () => {
      const res = await handleFileResolve(deps, [mdFile]);
      expect(res.length).toBe(1);
      expect(res[0].path).toBe(canon(mdFile));
      expect(res[0].exists).toBe(true);
      expect(res[0].isDirectory).toBe(false);
      expect(res[0].parentExists).toBe(true);
    });

    it("flags an existing directory", async () => {
      const res = await handleFileResolve(deps, [dirInsideRoot]);
      expect(res[0].exists).toBe(true);
      expect(res[0].isDirectory).toBe(true);
    });

    it("marks missing-leaf with existing parent as exists:false, parentExists:true", async () => {
      const intended = path.join(rootA, "draft.md");
      const res = await handleFileResolve(deps, [intended]);
      expect(res[0].exists).toBe(false);
      expect(res[0].parentExists).toBe(true);
      expect(res[0].isDirectory).toBe(false);
    });

    it("marks missing-leaf with missing parent as exists:false, parentExists:false", async () => {
      const deeperMiss = path.join(rootA, "ghosts", "nowhere", "x.md");
      const res = await handleFileResolve(deps, [deeperMiss]);
      expect(res[0].exists).toBe(false);
      expect(res[0].parentExists).toBe(false);
    });

    it("filters out paths that are outside all allowed roots", async () => {
      const outsideFile = path.join(outsideDir, "x.md");
      fs.writeFileSync(outsideFile, "no");
      const res = await handleFileResolve(deps, [outsideFile, mdFile]);
      // Only mdFile remains. The outsideFile is silently filtered out so
      // the renderer can't infer the existence of files outside its roots.
      expect(res.length).toBe(1);
      expect(res[0].path).toBe(canon(mdFile));
    });

    it("handles a batch of mixed-state paths and preserves input order for in-roots paths", async () => {
      const draft = path.join(rootA, "draft.md");
      const dirChild = path.join(dirInsideRoot, "x.md");
      const outsideFile = path.join(outsideDir, "x.md");
      fs.writeFileSync(outsideFile, "no");
      const res = await handleFileResolve(deps, [
        mdFile,
        outsideFile, // filtered out
        draft,
        dirChild,
      ]);
      // Filtered list, in input order: [mdFile, draft, dirChild]
      expect(res.length).toBe(3);
      expect(res[0].path).toBe(canon(mdFile));
      expect(res[1].path).toBe(canon(draft));
      expect(res[2].path).toBe(canon(dirChild));
    });

    it("returns an empty array for an empty input batch", async () => {
      expect(await handleFileResolve(deps, [])).toEqual([]);
    });

    it("ignores non-string entries in the batch", async () => {
      const res = await handleFileResolve(deps, [42 as unknown as string, mdFile]);
      expect(res.length).toBe(1);
      expect(res[0].path).toBe(canon(mdFile));
    });
  });

  describe("handleFileCreate()", () => {
    it("creates an empty file when the parent dir already exists", async () => {
      const target = path.join(rootA, "draft.md");
      const res = await handleFileCreate(deps, target);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("");
      expect(res.baseline.size).toBe(0);
    });

    it("creates intermediate parent directories (mkdir -p) inside an allowed root", async () => {
      const target = path.join(rootA, "new", "deeper", "x.md");
      const res = await handleFileCreate(deps, target);
      expect(res.ok).toBe(true);
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.statSync(path.dirname(target)).isDirectory()).toBe(true);
    });

    it("rejects paths outside allowed roots", async () => {
      const outside = path.join(outsideDir, "evil.md");
      const res = await handleFileCreate(deps, outside);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("out-of-roots");
      expect(fs.existsSync(outside)).toBe(false);
    });

    it("refuses to overwrite an existing file", async () => {
      const res = await handleFileCreate(deps, mdFile);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("exists");
      // Original content untouched.
      expect(fs.readFileSync(mdFile, "utf8")).toContain("# Heading");
    });
  });

  describe("atomicWriteFile()", () => {
    it("writes the file in-place via tmp + rename", async () => {
      const target = path.join(rootA, "atomic.md");
      fs.writeFileSync(target, "before");
      await atomicWriteFile(target, "after");
      expect(fs.readFileSync(target, "utf8")).toBe("after");
    });

    it("creates the file if it did not exist", async () => {
      const target = path.join(rootA, "new.md");
      await atomicWriteFile(target, "fresh");
      expect(fs.readFileSync(target, "utf8")).toBe("fresh");
    });

    it("leaves no .reck-tmp- sidecar behind on success", async () => {
      const target = path.join(rootA, "clean.md");
      await atomicWriteFile(target, "content");
      const siblings = fs.readdirSync(rootA);
      expect(siblings.find((s) => s.startsWith(".reck-tmp-"))).toBeUndefined();
    });
  });

  describe("handleFileWrite()", () => {
    it("writes when baseline matches the on-disk state and returns the new baseline", async () => {
      const baseline = computeBaseline(mdFile);
      const result = await handleFileWrite(deps, {
        path: mdFile,
        content: "new content",
        baseline,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(fs.readFileSync(mdFile, "utf8")).toBe("new content");
      expect(result.baseline.sha256).not.toBe(baseline.sha256);
      expect(result.baseline.size).toBe("new content".length);
    });

    it("rejects with conflict when the on-disk state has shifted (mtime+sha mismatch)", async () => {
      const baseline = computeBaseline(mdFile);
      // Simulate an external write between read and save.
      fs.writeFileSync(mdFile, "external write");
      // Ensure mtime is detectably different.
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(mdFile, future, future);

      const result = await handleFileWrite(deps, {
        path: mdFile,
        content: "ours",
        baseline,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("conflict");
      expect(result.currentBaseline).toBeDefined();
      expect(result.currentContent).toBe("external write");
      // The file on disk is unchanged.
      expect(fs.readFileSync(mdFile, "utf8")).toBe("external write");
    });

    it("with force:true writes even when the baseline does not match", async () => {
      const baseline = computeBaseline(mdFile);
      fs.writeFileSync(mdFile, "external");
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(mdFile, future, future);

      const result = await handleFileWrite(deps, {
        path: mdFile,
        content: "ours wins",
        baseline,
        force: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(fs.readFileSync(mdFile, "utf8")).toBe("ours wins");
    });

    it("rejects paths outside allowed roots", async () => {
      const outsideFile = path.join(outsideDir, "x.md");
      fs.writeFileSync(outsideFile, "original");
      const baseline = computeBaseline(outsideFile);
      const result = await handleFileWrite(deps, {
        path: outsideFile,
        content: "should not write",
        baseline,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("out-of-roots");
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("original");
    });

    it("rejects when target is a directory", async () => {
      const baseline = { mtimeMs: 0, sha256: "x", size: 0 };
      const result = await handleFileWrite(deps, {
        path: dirInsideRoot,
        content: "x",
        baseline,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("is-directory");
    });

    it("rejects malformed input (missing path / baseline / content)", async () => {
      const result1 = await handleFileWrite(deps, {
        path: 42 as unknown as string,
        content: "x",
        baseline: { mtimeMs: 0, sha256: "", size: 0 },
      });
      expect(result1.ok).toBe(false);

      const result2 = await handleFileWrite(deps, {
        path: mdFile,
        content: undefined as unknown as string,
        baseline: { mtimeMs: 0, sha256: "", size: 0 },
      });
      expect(result2.ok).toBe(false);
    });

    it("identical-content write skips the conflict check when sha matches even if mtime drifted", async () => {
      // Edge case: an editor (vim, etc.) may rewrite-in-place without
      // changing content. Mtime updates but sha256 doesn't. The save
      // should succeed because the meaningful state is unchanged.
      const baseline = computeBaseline(mdFile);
      const before = fs.readFileSync(mdFile, "utf8");
      // Re-write the exact same content; mtime jumps but sha stays the same.
      fs.writeFileSync(mdFile, before);
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(mdFile, future, future);

      const result = await handleFileWrite(deps, {
        path: mdFile,
        content: "new content",
        baseline,
      });
      expect(result.ok).toBe(true);
    });
  });

  // Round 3 Issue D1 — main-side suppression of self-triggered watch
  // events. After we (the main process) write to a file, the next
  // fs.watch event for that same path within
  // WATCHER_SUPPRESS_AFTER_WRITE_MS is filtered out before reaching
  // the renderer. Without this, every auto-save kicked a watch event
  // back into the renderer → handleExternalChange → reload → onChange
  // → autoSave loop at ~1–2 Hz. This is the FIRST defensive layer; the
  // renderer-side silent setContent (D2) and content-equality guard
  // (D3) are the second and third.
  describe("self-write suppression (Round 3 D1)", () => {
    it("exports a sensible suppression window (≥ 250ms, ≤ 2000ms)", () => {
      expect(WATCHER_SUPPRESS_AFTER_WRITE_MS).toBeGreaterThanOrEqual(250);
      expect(WATCHER_SUPPRESS_AFTER_WRITE_MS).toBeLessThanOrEqual(2000);
    });

    it("suppresses a watch event within the window after recordSelfWrite", () => {
      const realpath = path.join(rootA, "x.md");
      const now = 1_000_000;
      recordSelfWrite(realpath, now);
      expect(shouldSuppressWatchEvent(realpath, now + 50)).toBe(true);
      expect(
        shouldSuppressWatchEvent(realpath, now + WATCHER_SUPPRESS_AFTER_WRITE_MS - 1),
      ).toBe(true);
    });

    it("does NOT suppress events past the suppression window", () => {
      const realpath = path.join(rootA, "x.md");
      const now = 2_000_000;
      recordSelfWrite(realpath, now);
      expect(
        shouldSuppressWatchEvent(realpath, now + WATCHER_SUPPRESS_AFTER_WRITE_MS + 1),
      ).toBe(false);
    });

    it("does NOT suppress events for paths never written by main", () => {
      const realpath = path.join(rootA, "untouched.md");
      expect(shouldSuppressWatchEvent(realpath, 3_000_000)).toBe(false);
    });

    it("handleFileWrite records a self-write so the next watch event is suppressed", async () => {
      const baseline = computeBaseline(mdFile);
      const result = await handleFileWrite(deps, {
        path: mdFile,
        content: "post-write",
        baseline,
      });
      expect(result.ok).toBe(true);
      // Suppression is keyed by REALPATH because the watch IPC also
      // works in realpath space (resolveInsideAllowedRoots canonicalises
      // symlinks like macOS's /var/folders → /private/var/folders).
      const realMdFile = fs.realpathSync(mdFile);
      // A watch event firing immediately after the write must be
      // suppressed. `Date.now()` is fine here — the test runs in
      // milliseconds and the suppression window is 500ms.
      expect(shouldSuppressWatchEvent(realMdFile, Date.now())).toBe(true);
    });
  });

  describe("handleFileRead() — P5 error states", () => {
    it("refuses files larger than the size threshold with a clear code", async () => {
      const big = path.join(rootA, "big.md");
      // 2.5 MB ASCII — over the 2 MB threshold.
      fs.writeFileSync(big, "a".repeat(2_500_000));
      const result = await handleFileRead(deps, big);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("too-large");
    });

    it("refuses binary files (NUL byte in first 8 KB) so the viewer doesn't render garbage", async () => {
      const bin = path.join(rootA, "bin.dat");
      const buf = Buffer.alloc(1024);
      buf[42] = 0x00; // explicit NUL
      buf[43] = 0xff;
      fs.writeFileSync(bin, buf);
      const result = await handleFileRead(deps, bin);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("binary");
    });

    it("still reads text files that happen to start with a non-NUL high byte", async () => {
      const utf8File = path.join(rootA, "utf8.md");
      // Valid UTF-8 with non-ASCII chars; no NUL bytes.
      fs.writeFileSync(utf8File, "# Émigré\n\nWorld 🌍");
      const result = await handleFileRead(deps, utf8File);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain("Émigré");
    });
  });

  describe("chokidarOptionsForPath()", () => {
    it("forces polling for paths under the sshfs mount root", () => {
      const opts = chokidarOptionsForPath(
        "/Users/me/reck/projects/proj/notes.md",
        "/Users/me/reck/projects",
      );
      expect(opts.usePolling).toBe(true);
      expect(opts.interval).toBe(1500);
      expect(opts.binaryInterval).toBe(3000);
    });

    it("uses native fsevents (no polling) for paths outside the mount", () => {
      const opts = chokidarOptionsForPath(
        "/Users/me/dev/local-project/file.ts",
        "/Users/me/reck/projects",
      );
      expect(opts.usePolling).toBeFalsy();
    });

    it("does not match paths that merely share a prefix with the mount", () => {
      // /Users/me/reck/projects-other/x is NOT inside /Users/me/reck/projects.
      const opts = chokidarOptionsForPath(
        "/Users/me/reck/projects-other/x.md",
        "/Users/me/reck/projects",
      );
      expect(opts.usePolling).toBeFalsy();
    });
  });

  describe("geometry constants and computeViewerGeometry()", () => {
    it("exposes the fractions and minimums so they're tweakable", () => {
      expect(FILE_VIEWER_WIDTH_FRACTION).toBeGreaterThan(0);
      expect(FILE_VIEWER_WIDTH_FRACTION).toBeLessThanOrEqual(1);
      expect(FILE_VIEWER_HEIGHT_FRACTION).toBeGreaterThan(0);
      expect(FILE_VIEWER_HEIGHT_FRACTION).toBeLessThanOrEqual(1);
      expect(FILE_VIEWER_MIN_WIDTH).toBeGreaterThan(0);
      expect(FILE_VIEWER_MIN_HEIGHT).toBeGreaterThan(0);
    });

    it("computes width/height from work area × fraction, centered", () => {
      const geo = computeViewerGeometry({ workAreaSize: { width: 1920, height: 1080 } });
      expect(geo.width).toBe(Math.round(1920 * FILE_VIEWER_WIDTH_FRACTION));
      expect(geo.height).toBe(Math.round(1080 * FILE_VIEWER_HEIGHT_FRACTION));
      // Roughly centered on the primary display.
      expect(geo.x).toBe(Math.round((1920 - geo.width) / 2));
      expect(geo.y).toBe(Math.round((1080 - geo.height) / 2));
    });

    it("clamps width and height to the minimums on tiny displays", () => {
      const geo = computeViewerGeometry({ workAreaSize: { width: 200, height: 200 } });
      expect(geo.width).toBeGreaterThanOrEqual(FILE_VIEWER_MIN_WIDTH);
      expect(geo.height).toBeGreaterThanOrEqual(FILE_VIEWER_MIN_HEIGHT);
    });

    it("honours explicit width/height overrides", () => {
      const geo = computeViewerGeometry(
        { workAreaSize: { width: 1920, height: 1080 } },
        { width: 700, height: 500 },
      );
      expect(geo.width).toBe(700);
      expect(geo.height).toBe(500);
    });

    it("honours explicit x/y overrides", () => {
      const geo = computeViewerGeometry(
        { workAreaSize: { width: 1920, height: 1080 } },
        { x: 100, y: 50 },
      );
      expect(geo.x).toBe(100);
      expect(geo.y).toBe(50);
    });

    it("clamps overrides that would fall below the minimums", () => {
      const geo = computeViewerGeometry(
        { workAreaSize: { width: 1920, height: 1080 } },
        { width: 100, height: 100 },
      );
      expect(geo.width).toBeGreaterThanOrEqual(FILE_VIEWER_MIN_WIDTH);
      expect(geo.height).toBeGreaterThanOrEqual(FILE_VIEWER_MIN_HEIGHT);
    });
  });

  // Phase 2 of linkifier-followups — regression for the
  // "Uncaught Exception: TypeError: Object has been destroyed" crash
  // observed on popup close. The cleanup helper used to read
  // `win.webContents.id` AFTER the `closed` event fired, but webContents
  // is already torn down by then. The fix: capture the id at window
  // creation time and pass the integer through.
  describe("cleanupWindowResources() — does not touch destroyed webContents", () => {
    it("uses a captured windowId and never crashes when webContents is destroyed", () => {
      const winSentinel = {}; // identity check only
      const windowsRegistry = new Map<string, unknown>();
      windowsRegistry.set("/a/b/c.md", winSentinel);
      const closedWatchers: string[] = [];
      const watchersRegistry = new Map<
        string,
        { watcher: { close(): void }; windowId: number }
      >();
      watchersRegistry.set("99:/a/b/c.md", {
        watcher: { close: () => closedWatchers.push("c.md") },
        windowId: 99,
      });
      watchersRegistry.set("99:/x/y.txt", {
        watcher: { close: () => closedWatchers.push("y.txt") },
        windowId: 99,
      });
      watchersRegistry.set("17:/other.md", {
        watcher: { close: () => closedWatchers.push("other.md") },
        windowId: 17,
      });

      expect(() =>
        cleanupWindowResources({
          resolvedPath: "/a/b/c.md",
          windowId: 99,
          win: winSentinel,
          windowsRegistry,
          watchersRegistry,
        }),
      ).not.toThrow();

      // Window's entry is dropped, only this window's watchers are closed.
      expect(windowsRegistry.has("/a/b/c.md")).toBe(false);
      expect(closedWatchers.sort()).toEqual(["c.md", "y.txt"]);
      expect(watchersRegistry.has("17:/other.md")).toBe(true);
    });

    it("is a no-op when another window has taken over the resolved path", () => {
      // Race scenario: second open of the same file replaced the registry
      // entry; the original window's deferred close should NOT delete the
      // new window's entry.
      const originalWin = {};
      const replacementWin = {};
      const windowsRegistry = new Map<string, unknown>();
      windowsRegistry.set("/p.md", replacementWin);
      const watchersRegistry = new Map<
        string,
        { watcher: { close(): void }; windowId: number }
      >();
      watchersRegistry.set("5:/p.md", {
        watcher: { close: () => undefined },
        windowId: 5, // belongs to replacementWin
      });
      cleanupWindowResources({
        resolvedPath: "/p.md",
        windowId: 99, // originalWin's captured id
        win: originalWin,
        windowsRegistry,
        watchersRegistry,
      });
      expect(windowsRegistry.get("/p.md")).toBe(replacementWin);
      expect(watchersRegistry.has("5:/p.md")).toBe(true);
    });

    // Phase 3 of linkifier-followups — station vs local path resolution.
    // `~/` in a station pane refers to the Pi's home, not the Mac's. Only
    // station paths UNDER the projects-mount are reachable via sshfs.
    it("local sourceHost expands tilde against local home", () => {
      const result = expandTildeForHost("~/x/y.md", {
        sourceHost: "local",
        localHome: "/Users/me",
        mountPoint: "/Users/me/reck/projects",
      });
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.path).toBe("/Users/me/x/y.md");
      }
    });

    it("station sourceHost — path inside station projects root — translates to mount", () => {
      const result = expandTildeForHost("~/projects/alpha/file.md", {
        sourceHost: "station",
        localHome: "/Users/me",
        stationHome: "/home/pi",
        stationRoot: "/home/pi/projects",
        mountPoint: "/Users/me/reck/projects",
      });
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.path).toBe("/Users/me/reck/projects/alpha/file.md");
      }
    });

    it("station sourceHost — absolute station path inside projects — translates", () => {
      const result = expandTildeForHost(
        "/home/pi/projects/alpha/file.md",
        {
          sourceHost: "station",
          localHome: "/Users/me",
          stationHome: "/home/pi",
          stationRoot: "/home/pi/projects",
          mountPoint: "/Users/me/reck/projects",
        },
      );
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.path).toBe("/Users/me/reck/projects/alpha/file.md");
      }
    });

    it("station sourceHost — outside-projects station path is station-remote (SSH-backed)", () => {
      // Phase 8 of linkifier-followups: paths outside the sshfs projects
      // mount are NO LONGER "unreachable" — they route through SSH via
      // `readStationFile`. The returned shape carries the absolute Pi
      // path so the SSH read can target it directly.
      const result = expandTildeForHost("~/.claude/plans/x.md", {
        sourceHost: "station",
        localHome: "/Users/me",
        stationHome: "/home/pi",
        stationRoot: "/home/pi/projects",
        mountPoint: "/Users/me/reck/projects",
      });
      expect(result.kind).toBe("station-remote");
      if (result.kind === "station-remote") {
        expect(result.path).toBe("/home/pi/.claude/plans/x.md");
      }
    });

    it("station sourceHost — non-tilde path NOT under projects is station-remote", () => {
      const result = expandTildeForHost("/etc/passwd", {
        sourceHost: "station",
        localHome: "/Users/me",
        stationHome: "/home/pi",
        stationRoot: "/home/pi/projects",
        mountPoint: "/Users/me/reck/projects",
      });
      expect(result.kind).toBe("station-remote");
      if (result.kind === "station-remote") {
        expect(result.path).toBe("/etc/passwd");
      }
    });

    it("local sourceHost passes absolute paths through unchanged", () => {
      const result = expandTildeForHost("/tmp/foo.md", {
        sourceHost: "local",
        localHome: "/Users/me",
        mountPoint: "/Users/me/reck/projects",
      });
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.path).toBe("/tmp/foo.md");
      }
    });

    // Round 8.6 — project-relative paths from station-pane clicks.
    //
    // Before this fix, a relative path like `services/foo/bar.py` clicked
    // in a station pane was left unchanged, failed the stationRoot prefix
    // check, and was misrouted to `station-remote`. The downstream popup
    // showed "no matches" + a misleading "create file?" banner even when
    // the file existed on the local sshfs mirror.
    //
    // Fix: when sourceHost=="station" + relative path + projectCwd set,
    // join projectCwd + raw into an absolute Pi path, then translate
    // through the mount mirror like any other inside-projects path.
    it("station sourceHost — relative path + projectCwd anchors against project", () => {
      const result = expandTildeForHost(
        "services/gpu-poller/providers/hyperbolic.py",
        {
          sourceHost: "station",
          localHome: "/Users/me",
          stationHome: "/home/pi",
          stationRoot: "/home/pi/projects",
          mountPoint: "/Users/me/reck/projects",
          projectCwd: "/home/pi/projects/MyProject",
        },
      );
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.path).toBe(
          "/Users/me/reck/projects/MyProject/services/gpu-poller/providers/hyperbolic.py",
        );
      }
    });

    it("station sourceHost — relative path WITHOUT projectCwd preserves legacy behavior", () => {
      const result = expandTildeForHost(
        "services/gpu-poller/providers/hyperbolic.py",
        {
          sourceHost: "station",
          localHome: "/Users/me",
          stationHome: "/home/pi",
          stationRoot: "/home/pi/projects",
          mountPoint: "/Users/me/reck/projects",
          // no projectCwd
        },
      );
      // Falls back to station-remote with the bare relative path so the
      // SSH-read path can attempt it (matches pre-Round 8.6 behavior).
      expect(result.kind).toBe("station-remote");
      if (result.kind === "station-remote") {
        expect(result.path).toBe(
          "services/gpu-poller/providers/hyperbolic.py",
        );
      }
    });

    it("station sourceHost — relative path + projectCwd OUTSIDE stationRoot is station-remote", () => {
      // Defensive: a projectCwd that isn't under stationRoot must NOT
      // produce a local mount path. Falls back to station-remote with
      // the joined absolute path so SSH-read can still attempt it.
      const result = expandTildeForHost("notes/x.md", {
        sourceHost: "station",
        localHome: "/Users/me",
        stationHome: "/home/pi",
        stationRoot: "/home/pi/projects",
        mountPoint: "/Users/me/reck/projects",
        projectCwd: "/home/pi/scratch", // outside stationRoot
      });
      expect(result.kind).toBe("station-remote");
      if (result.kind === "station-remote") {
        expect(result.path).toBe("/home/pi/scratch/notes/x.md");
      }
    });

    it("station sourceHost — projectCwd does NOT override absolute paths", () => {
      // An absolute station path takes precedence; projectCwd is only
      // used as the anchor for genuinely relative input.
      const result = expandTildeForHost(
        "/home/pi/projects/other/file.md",
        {
          sourceHost: "station",
          localHome: "/Users/me",
          stationHome: "/home/pi",
          stationRoot: "/home/pi/projects",
          mountPoint: "/Users/me/reck/projects",
          projectCwd: "/home/pi/projects/MyProject",
        },
      );
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.path).toBe("/Users/me/reck/projects/other/file.md");
      }
    });

    it("station sourceHost — projectCwd does NOT override tilde paths", () => {
      const result = expandTildeForHost("~/notes/y.md", {
        sourceHost: "station",
        localHome: "/Users/me",
        stationHome: "/home/pi",
        stationRoot: "/home/pi/projects",
        mountPoint: "/Users/me/reck/projects",
        projectCwd: "/home/pi/projects/MyProject",
      });
      expect(result.kind).toBe("station-remote");
      if (result.kind === "station-remote") {
        expect(result.path).toBe("/home/pi/notes/y.md");
      }
    });

    it("local sourceHost — projectCwd is ignored", () => {
      // For local-pane clicks projectCwd has no meaning; relative paths
      // continue to pass through unchanged.
      const result = expandTildeForHost("services/x.ts", {
        sourceHost: "local",
        localHome: "/Users/me",
        mountPoint: "/Users/me/reck/projects",
        projectCwd: "/Users/me/some/project",
      });
      expect(result.kind).toBe("local");
      if (result.kind === "local") {
        expect(result.path).toBe("services/x.ts");
      }
    });
  });

  describe("cleanupWindowResources — watcher.close exceptions", () => {
    it("swallows watcher.close() exceptions instead of crashing main", () => {
      const winSentinel = {};
      const windowsRegistry = new Map<string, unknown>();
      windowsRegistry.set("/q.md", winSentinel);
      const watchersRegistry = new Map<
        string,
        { watcher: { close(): void }; windowId: number }
      >();
      watchersRegistry.set("42:/q.md", {
        watcher: {
          close: () => {
            throw new Error("already closed");
          },
        },
        windowId: 42,
      });
      expect(() =>
        cleanupWindowResources({
          resolvedPath: "/q.md",
          windowId: 42,
          win: winSentinel,
          windowsRegistry,
          watchersRegistry,
        }),
      ).not.toThrow();
      // The registry entry is still removed even though close() threw.
      expect(watchersRegistry.has("42:/q.md")).toBe(false);
    });
  });

  // Round 8.7 follow-up — regression test for the auto-close bug.
  //
  // Background: streaming-search popups are registered in
  // fileViewerWindows under the suffix-anchored mount path they
  // were spawned for (e.g. /Users/.../mount/services/foo.py). When
  // the search finds a match and the renderer cascades via
  // openInViewer for that EXACT path, the registry dedupe used to
  // focus+return the streaming popup itself — and the renderer's
  // subsequent window.close() then closed the focused window,
  // leaving the user with no popup at all. (Same dedupe lived in
  // BOTH the file:openInViewer handler AND createFileViewerWindow;
  // commit b4550da fixed the first, commit 7120ae1 fixed the
  // second and extracted shouldFocusExistingViewer to share the
  // check across both call sites.)
  describe("shouldFocusExistingViewer() — Round 8.7 follow-up", () => {
    it("returns false when there is no existing window", () => {
      const streamingMap = new Map<{ isDestroyed(): boolean }, unknown>();
      expect(shouldFocusExistingViewer(undefined, streamingMap)).toBe(false);
    });

    it("returns false when the existing window is destroyed", () => {
      const existing = { isDestroyed: () => true };
      const streamingMap = new Map<{ isDestroyed(): boolean }, unknown>();
      expect(shouldFocusExistingViewer(existing, streamingMap)).toBe(false);
    });

    it("returns false when the existing window is a streaming-search popup", () => {
      // THE BUG: pre-fix, this returned true. The cascade would focus
      // the streaming popup, then the renderer's window.close() would
      // close it. User sees popup briefly then it disappears.
      const streamingPopup = { isDestroyed: () => false };
      const streamingMap = new Map<{ isDestroyed(): boolean }, unknown>([
        [streamingPopup, "search-id-42"],
      ]);
      expect(shouldFocusExistingViewer(streamingPopup, streamingMap)).toBe(
        false,
      );
    });

    it("returns true for a regular (non-streaming) existing file viewer", () => {
      const regularViewer = { isDestroyed: () => false };
      const streamingMap = new Map<{ isDestroyed(): boolean }, unknown>();
      expect(shouldFocusExistingViewer(regularViewer, streamingMap)).toBe(
        true,
      );
    });

    it("distinguishes between a streaming popup and a regular viewer in the same map", () => {
      const streamingPopup = { isDestroyed: () => false };
      const regularViewer = { isDestroyed: () => false };
      const streamingMap = new Map<{ isDestroyed(): boolean }, unknown>([
        [streamingPopup, "search-id-99"],
      ]);
      expect(shouldFocusExistingViewer(streamingPopup, streamingMap)).toBe(
        false,
      );
      expect(shouldFocusExistingViewer(regularViewer, streamingMap)).toBe(
        true,
      );
    });
  });
});

// Round 5 Phase U — find-by-suffix path resolution. When the user
// Cmd-clicks a relative path printed in a pane (e.g. `providers/ovh.py`
// from a sub-directory cwd), the resolved-against-project-root path
// may not exist. searchProjectTreeBySuffix walks the project tree to
// find files whose path ends with the same suffix and surfaces them
// as candidates for a picker.
describe("searchProjectTreeBySuffix() — Round 5 Phase U", () => {
  let tmpRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reck-fv-suffix-"));
    projectRoot = path.join(tmpRoot, "project");
    fs.mkdirSync(projectRoot);
    // Fixture tree mirrors the bug's shape: a service nested two dirs
    // deep where the real file lives.
    fs.mkdirSync(path.join(projectRoot, "services"));
    fs.mkdirSync(path.join(projectRoot, "services", "gpu-poller"));
    fs.mkdirSync(path.join(projectRoot, "services", "gpu-poller", "providers"));
    fs.writeFileSync(
      path.join(projectRoot, "services", "gpu-poller", "providers", "ovh.py"),
      "# ovh adapter",
    );
    // A blocklisted dir with a same-suffix decoy (must be skipped).
    fs.mkdirSync(path.join(projectRoot, "node_modules"));
    fs.mkdirSync(path.join(projectRoot, "node_modules", "providers"));
    fs.writeFileSync(
      path.join(projectRoot, "node_modules", "providers", "ovh.py"),
      "# decoy",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("finds a file matching the suffix nested under the project root", async () => {
    const matches = await searchProjectTreeBySuffix(
      [projectRoot],
      "providers/ovh.py",
    );
    expect(matches).toEqual([
      path.join(projectRoot, "services", "gpu-poller", "providers", "ovh.py"),
    ]);
  });

  it("skips blocklisted directories (node_modules, .git, …)", async () => {
    const matches = await searchProjectTreeBySuffix(
      [projectRoot],
      "providers/ovh.py",
    );
    // The decoy under node_modules/ must NOT appear.
    expect(matches.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("returns an empty array when the suffix matches nothing", async () => {
    const matches = await searchProjectTreeBySuffix(
      [projectRoot],
      "providers/does-not-exist.py",
    );
    expect(matches).toEqual([]);
  });

  it("returns multiple matches when the suffix is ambiguous", async () => {
    fs.mkdirSync(path.join(projectRoot, "legacy"));
    fs.mkdirSync(path.join(projectRoot, "legacy", "providers"));
    fs.writeFileSync(
      path.join(projectRoot, "legacy", "providers", "ovh.py"),
      "# legacy adapter",
    );
    const matches = await searchProjectTreeBySuffix(
      [projectRoot],
      "providers/ovh.py",
    );
    expect(matches.length).toBe(2);
    // Both candidates present.
    expect(
      matches.some((p) =>
        p.endsWith(path.join("services", "gpu-poller", "providers", "ovh.py")),
      ),
    ).toBe(true);
    expect(
      matches.some((p) => p.endsWith(path.join("legacy", "providers", "ovh.py"))),
    ).toBe(true);
  });

  it("respects the maxMatches cap and stops walking once reached", async () => {
    // Create 5 matching files in different dirs.
    for (let i = 0; i < 5; i++) {
      const d = path.join(projectRoot, `dir${i}`, "providers");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "ovh.py"), "");
    }
    const matches = await searchProjectTreeBySuffix(
      [projectRoot],
      "providers/ovh.py",
      { maxMatches: 3 },
    );
    expect(matches.length).toBe(3);
  });

  it("respects the maxDepth cap", async () => {
    // Bury a match 9 levels deep — default depth is 8.
    let d = projectRoot;
    for (let i = 0; i < 9; i++) {
      d = path.join(d, `lvl${i}`);
      fs.mkdirSync(d);
    }
    d = path.join(d, "providers");
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "buried.py"), "");
    const matches = await searchProjectTreeBySuffix(
      [projectRoot],
      "providers/buried.py",
    );
    // Should NOT include the over-deep match.
    expect(matches.some((p) => p.includes("buried.py"))).toBe(false);
  });

  it("returns an empty array for absolute or home-anchored input (no fallback needed)", async () => {
    const a = await searchProjectTreeBySuffix(
      [projectRoot],
      "/etc/hosts",
    );
    expect(a).toEqual([]);
    const b = await searchProjectTreeBySuffix(
      [projectRoot],
      "~/foo.md",
    );
    expect(b).toEqual([]);
  });
});

// Round 8 Phase NN — pure helpers for multi-root suffix search.

describe("composeSuffixSearchRoots", () => {
  let tmpRoot: string;
  let dirA: string;
  let dirB: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reck-rt-"));
    dirA = path.join(tmpRoot, "a");
    dirB = path.join(tmpRoot, "b");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns [searchBase, projectCwd] when both exist and differ", async () => {
    const out = await composeSuffixSearchRoots(dirA, dirB);
    expect(out).toEqual([dirA, dirB]);
  });

  it("dedupes when projectCwd === searchBase", async () => {
    const out = await composeSuffixSearchRoots(dirA, dirA);
    expect(out).toEqual([dirA]);
  });

  it("returns just searchBase when projectCwd is undefined", async () => {
    const out = await composeSuffixSearchRoots(dirA, undefined);
    expect(out).toEqual([dirA]);
  });

  it("returns just searchBase when projectCwd is empty string", async () => {
    const out = await composeSuffixSearchRoots(dirA, "");
    expect(out).toEqual([dirA]);
  });

  it("drops projectCwd when it doesn't exist on disk", async () => {
    const stale = path.join(tmpRoot, "ghost");
    const out = await composeSuffixSearchRoots(dirA, stale);
    expect(out).toEqual([dirA]);
  });

  it("returns just projectCwd when searchBase is null", async () => {
    const out = await composeSuffixSearchRoots(null, dirB);
    expect(out).toEqual([dirB]);
  });

  it("returns [] when both are missing", async () => {
    const stale1 = path.join(tmpRoot, "ghost1");
    const stale2 = path.join(tmpRoot, "ghost2");
    const out = await composeSuffixSearchRoots(stale1, stale2);
    expect(out).toEqual([]);
  });

  it("drops projectCwd when it points at a file, not a directory", async () => {
    const filePath = path.join(tmpRoot, "regular.txt");
    fs.writeFileSync(filePath, "x", "utf8");
    const out = await composeSuffixSearchRoots(dirA, filePath);
    expect(out).toEqual([dirA]);
  });
});

describe("translateStationCwdToMount", () => {
  it("rewrites a Pi-managed cwd to its mount-mirror path", () => {
    expect(
      translateStationCwdToMount(
        "/home/pi/projects/gpu-poller_v2",
        "/Users/me/reck/projects",
        "/home/pi/projects",
      ),
    ).toBe("/Users/me/reck/projects/gpu-poller_v2");
  });

  it("returns null for paths outside the managed root", () => {
    expect(
      translateStationCwdToMount(
        "/home/pi/.claude/plans",
        "/Users/me/reck/projects",
        "/home/pi/projects",
      ),
    ).toBeNull();
  });

  it("tolerates trailing slashes on either prefix", () => {
    expect(
      translateStationCwdToMount(
        "/home/pi/projects/foo",
        "/Users/me/reck/projects/",
        "/home/pi/projects/",
      ),
    ).toBe("/Users/me/reck/projects/foo");
  });

  it("rejects an exact prefix match (no project segment)", () => {
    expect(
      translateStationCwdToMount(
        "/home/pi/projects",
        "/Users/me/reck/projects",
        "/home/pi/projects",
      ),
    ).toBeNull();
  });

  it("rejects when stationCwd looks like a prefix-match but isn't segmented", () => {
    expect(
      translateStationCwdToMount(
        "/home/pi/projects-evil/foo",
        "/Users/me/reck/projects",
        "/home/pi/projects",
      ),
    ).toBeNull();
  });

  it("returns null when any argument is empty", () => {
    expect(translateStationCwdToMount("", "/m", "/r")).toBeNull();
    expect(translateStationCwdToMount("/p", "", "/r")).toBeNull();
    expect(translateStationCwdToMount("/p", "/m", "")).toBeNull();
  });
});

// mirror-roots → station-roots for the ssh fallback.
describe("translateSearchRootsToStation", () => {
  const MOUNT = "/Users/me/reck/projects";
  const ROOT = "/home/pi/projects";

  it("translates mount-rooted entries and preserves order", () => {
    expect(
      translateSearchRootsToStation(
        [`${MOUNT}/Foo/.claude/plans`, `${MOUNT}/Foo`],
        MOUNT,
        ROOT,
      ),
    ).toEqual([`${ROOT}/Foo/.claude/plans`, `${ROOT}/Foo`]);
  });

  it("drops roots outside the mount (no Pi-side equivalent)", () => {
    expect(
      translateSearchRootsToStation(
        ["/Users/me/dev/localproj", `${MOUNT}/Foo`],
        MOUNT,
        ROOT,
      ),
    ).toEqual([`${ROOT}/Foo`]);
  });

  it("returns [] when stationRoot is unknown", () => {
    expect(
      translateSearchRootsToStation([`${MOUNT}/Foo`], MOUNT, null),
    ).toEqual([]);
  });

  it("segment-strict: a mount-prefixed sibling dir is not translated", () => {
    expect(
      translateSearchRootsToStation([`${MOUNT}extra/Foo`], MOUNT, ROOT),
    ).toEqual([]);
  });
});
