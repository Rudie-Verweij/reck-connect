// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { mountFileViewer } from "./FileViewerHost";

interface FilesApiStub {
  read: ReturnType<typeof vi.fn>;
  readStation?: ReturnType<typeof vi.fn>;
  writeStation?: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  openInViewer: ReturnType<typeof vi.fn>;
  resolve?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  // Round 6 Phase DD2 — station-remote SSH-backed create.
  createStation?: ReturnType<typeof vi.fn>;
  write?: ReturnType<typeof vi.fn>;
  watchSubscribe?: ReturnType<typeof vi.fn>;
  watchUnsubscribe?: ReturnType<typeof vi.fn>;
  onWatchEvent?: ReturnType<typeof vi.fn>;
  // Round 6 Phase CC — streaming suffix-search bridge. The default stub
  // is a no-op subscription set whose handlers are captured by the
  // tests so they can fire fake events at the renderer.
  suffixSearch?: {
    onMatch: ReturnType<typeof vi.fn>;
    onProgress: ReturnType<typeof vi.fn>;
    onDone: ReturnType<typeof vi.fn>;
    onCancelled: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
}

interface ConfigStub {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function installReckApi(filesStub: FilesApiStub, configStub?: ConfigStub) {
  (window as unknown as { reckAPI: unknown }).reckAPI = {
    files: filesStub,
    config: configStub ?? {
      // Phase 7 of linkifier-followups added `fileViewerModePerPath`
      // reads/writes from FileViewerHost; stub returns undefined so the
      // default "rendered" mode is used unless a test installs its own.
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    },
    paths: {
      // posix.resolve replacement so relative links can be resolved without
      // exposing Node's `path` module to the renderer. Mirror's preload
      // semantics: absolute (`/x`) and home-anchored (`~/x`, `~`) rels
      // pass through unchanged; everything else gets joined to dirname(base).
      resolveAgainst: (base: string, rel: string): string => {
        if (rel === "~" || rel.startsWith("~/")) return rel;
        const slash = base.lastIndexOf("/");
        const dir = slash >= 0 ? base.slice(0, slash) : "";
        const segs = (dir + "/" + rel).split("/");
        const out: string[] = [];
        for (const s of segs) {
          if (s === "" || s === ".") continue;
          if (s === "..") {
            out.pop();
          } else {
            out.push(s);
          }
        }
        return "/" + out.join("/");
      },
      // Round 3 Issue B — viewer derives STATION vs SATELLITE badge from
      // whether the resolved path lives under the sshfs mount root. Tests
      // set this stub per-suite when they need a specific mount.
      localMountPoint: vi.fn().mockResolvedValue("/mount/projects"),
    },
  };
}

describe("mountFileViewer", () => {
  let root: HTMLElement;
  let files: FilesApiStub;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    root.id = "viewer-root";
    document.body.appendChild(root);
    files = {
      read: vi.fn(),
      stat: vi.fn(),
      openInViewer: vi.fn().mockResolvedValue({ ok: true }),
      write: vi.fn(),
      watchSubscribe: vi.fn().mockResolvedValue({ ok: true, resolvedPath: "" }),
      watchUnsubscribe: vi.fn().mockResolvedValue({ ok: true }),
      onWatchEvent: vi.fn().mockReturnValue(() => {}),
      suffixSearch: {
        onMatch: vi.fn().mockReturnValue(() => {}),
        onProgress: vi.fn().mockReturnValue(() => {}),
        onDone: vi.fn().mockReturnValue(() => {}),
        onCancelled: vi.fn().mockReturnValue(() => {}),
        cancel: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    installReckApi(files);
  });

  it("renders an error when the path query param is missing", async () => {
    await mountFileViewer({ root, params: new URLSearchParams() });
    expect(root.textContent).toMatch(/path/i);
    expect(files.read).not.toHaveBeenCalled();
  });

  it("calls files.read with the path from query string and renders markdown", async () => {
    files.read.mockResolvedValue({
      ok: true,
      resolvedPath: "/safe/notes.md",
      content: "# Title\n\nbody",
      baseline: { mtimeMs: 1, sha256: "abc", size: 11 },
    });
    await mountFileViewer({
      root,
      params: new URLSearchParams("path=/safe/notes.md"),
    });
    expect(files.read).toHaveBeenCalledWith("/safe/notes.md");
    expect(root.querySelector("h1")).not.toBeNull();
    expect(root.textContent).toContain("body");
  });

  it("renders code in a CodeMirror surface for non-markdown extensions", async () => {
    files.read.mockResolvedValue({
      ok: true,
      resolvedPath: "/safe/script.ts",
      content: 'const x = "hi";',
      baseline: { mtimeMs: 1, sha256: "abc", size: 15 },
    });
    await mountFileViewer({
      root,
      params: new URLSearchParams("path=/safe/script.ts"),
    });
    expect(files.read).toHaveBeenCalledWith("/safe/script.ts");
    const editor = root.querySelector(".file-viewer-code-editor .cm-editor");
    expect(editor).not.toBeNull();
    // CodeMirror renders content into .cm-content. Asserting on the
    // wrapper text is sufficient to confirm the doc landed in the view.
    expect(root.querySelector(".file-viewer-code-editor")!.textContent).toContain(
      "const x",
    );
  });

  it("renders a sanitized static preview (no CodeMirror) for .html files", async () => {
    files.read.mockResolvedValue({
      ok: true,
      resolvedPath: "/safe/page.html",
      content: '<div class="card">hello <script>alert(1)</script></div>',
      baseline: { mtimeMs: 1, sha256: "abc", size: 40 },
    });
    await mountFileViewer({
      root,
      params: new URLSearchParams("path=/safe/page.html"),
    });
    expect(files.read).toHaveBeenCalledWith("/safe/page.html");
    expect(root.querySelector(".file-viewer-code-editor")).toBeNull();
    expect(root.querySelector("div.card")).not.toBeNull();
    expect(root.textContent).toContain("hello");
    // DOMPurify strips <script> — confirms the sanitized renderer mounted,
    // not raw content.
    expect(root.querySelector("script")).toBeNull();
  });

  it("renders an error banner when files.read fails", async () => {
    files.read.mockResolvedValue({
      ok: false,
      code: "out-of-roots",
      error: "path is not inside any accessible project",
    });
    await mountFileViewer({
      root,
      params: new URLSearchParams("path=/forbidden/secret"),
    });
    expect(root.textContent).toMatch(/not inside/i);
  });

  it("renders a header bar with a slot for the loading spinner in top-right", async () => {
    files.read.mockResolvedValue({
      ok: true,
      resolvedPath: "/safe/notes.md",
      content: "body",
      baseline: { mtimeMs: 1, sha256: "abc", size: 4 },
    });
    await mountFileViewer({
      root,
      params: new URLSearchParams("path=/safe/notes.md"),
    });
    const header = root.querySelector(".file-viewer-header");
    expect(header).not.toBeNull();
    const spinnerSlot = root.querySelector(".file-viewer-spinner-slot");
    expect(spinnerSlot).not.toBeNull();
    // The spinner slot must live inside the header so it sits in the
    // top-right corner of the popup chrome.
    expect(header!.contains(spinnerSlot!)).toBe(true);
  });

  describe("intended-path create flow", () => {
    it("renders a Create banner when the file does not exist yet", async () => {
      files.read.mockResolvedValue({
        ok: false,
        code: "not-found",
        error: "file not found",
      });
      files.create = vi.fn().mockResolvedValue({
        ok: true,
        resolvedPath: "/safe/draft.md",
        baseline: { mtimeMs: 1, sha256: "abc", size: 0 },
      });
      await mountFileViewer({
        root,
        params: new URLSearchParams("path=/safe/draft.md"),
      });
      const banner = root.querySelector(".file-viewer-create-banner");
      expect(banner).not.toBeNull();
      const btn = root.querySelector(
        ".file-viewer-create-banner button.file-viewer-create-action",
      ) as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.textContent).toMatch(/create/i);
    });

    it("Create button calls files.create and re-renders with the new content", async () => {
      files.read
        .mockResolvedValueOnce({
          ok: false,
          code: "not-found",
          error: "file not found",
        })
        .mockResolvedValueOnce({
          ok: true,
          resolvedPath: "/safe/draft.md",
          content: "",
          baseline: { mtimeMs: 2, sha256: "abc", size: 0 },
        });
      files.create = vi.fn().mockResolvedValue({
        ok: true,
        resolvedPath: "/safe/draft.md",
        baseline: { mtimeMs: 2, sha256: "abc", size: 0 },
      });
      await mountFileViewer({
        root,
        params: new URLSearchParams("path=/safe/draft.md"),
      });
      const btn = root.querySelector(
        ".file-viewer-create-banner button.file-viewer-create-action",
      ) as HTMLButtonElement;
      btn.click();
      // Allow the await chain in the click handler to flush.
      await new Promise((r) => setTimeout(r, 0));
      expect(files.create).toHaveBeenCalledWith("/safe/draft.md");
      expect(files.read).toHaveBeenCalledTimes(2);
      // The Create banner is replaced by the now-empty body.
      expect(root.querySelector(".file-viewer-create-banner")).toBeNull();
    });

    it("renders an error toast when files.create fails", async () => {
      files.read.mockResolvedValue({
        ok: false,
        code: "not-found",
        error: "file not found",
      });
      files.create = vi.fn().mockResolvedValue({
        ok: false,
        code: "io-error",
        error: "permission denied",
      });
      await mountFileViewer({
        root,
        params: new URLSearchParams("path=/safe/draft.md"),
      });
      const btn = root.querySelector(
        ".file-viewer-create-banner button.file-viewer-create-action",
      ) as HTMLButtonElement;
      btn.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(root.textContent?.toLowerCase()).toContain("permission denied");
    });
  });

  it("Cmd+click on an internal markdown link calls files.openInViewer with a resolved path", async () => {
    files.read.mockResolvedValue({
      ok: true,
      resolvedPath: "/safe/notes.md",
      content: "[neighbor](./sibling.md)",
      baseline: { mtimeMs: 1, sha256: "abc", size: 22 },
    });
    await mountFileViewer({
      root,
      params: new URLSearchParams("path=/safe/notes.md"),
    });
    const a = root.querySelector("a.reck-internal-link") as HTMLAnchorElement;
    expect(a).not.toBeNull();
    a.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    // Allow microtasks to flush so the dispatched handler can await
    // reckAPI.files.openInViewer.
    await Promise.resolve();
    // Phase 3 of linkifier-followups migrated the second arg from a
    // string `opener` to an options object so callers can also pass
    // `sourceHost` for host-aware tilde expansion in main.
    // Round 6 Phase CC3 added `originalText` so main can decide whether
    // to run the streaming suffix-fallback search.
    expect(files.openInViewer).toHaveBeenCalledWith(
      "/safe/sibling.md",
      {
        opener: "/safe/notes.md",
        originalText: "./sibling.md",
        // Round 8 Phase MM — projectCwd is forwarded even when this
        // popup was opened without one (undefined → undefined).
        projectCwd: undefined,
      },
    );
  });

  it("forwards projectCwd from URL params onto cascaded openInViewer calls", async () => {
    // Round 8 Phase MM — when the popup boots with ?projectCwd=<x>,
    // every cascaded click (markdown internal-link in this case) must
    // re-attach the same projectCwd so main keeps walking the
    // originating project tree.
    files.read.mockResolvedValue({
      ok: true,
      resolvedPath: "/safe/notes.md",
      content: "[neighbor](./sibling.md)",
      baseline: { mtimeMs: 1, sha256: "abc", size: 22 },
    });
    await mountFileViewer({
      root,
      params: new URLSearchParams(
        "path=/safe/notes.md&projectCwd=/safe/proj",
      ),
    });
    const a = root.querySelector("a.reck-internal-link") as HTMLAnchorElement;
    expect(a).not.toBeNull();
    a.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      }),
    );
    await Promise.resolve();
    expect(files.openInViewer).toHaveBeenCalledWith("/safe/sibling.md", {
      opener: "/safe/notes.md",
      originalText: "./sibling.md",
      projectCwd: "/safe/proj",
    });
  });

  // Phase 7 of linkifier-followups — markdown source-mode toggle.
  describe("markdown source-mode toggle", () => {
    it("mounts the toggle button for markdown files, with default text 'Edit source'", async () => {
      files.read.mockResolvedValue({
        ok: true,
        resolvedPath: "/safe/notes.md",
        content: "# Title",
        baseline: { mtimeMs: 1, sha256: "abc", size: 7 },
      });
      await mountFileViewer({
        root,
        params: new URLSearchParams("path=/safe/notes.md"),
      });
      const btn = root.querySelector(".file-viewer-mode-toggle") as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.textContent).toBe("Edit source");
    });

    it("does NOT mount the toggle for non-markdown files", async () => {
      files.read.mockResolvedValue({
        ok: true,
        resolvedPath: "/safe/code.ts",
        content: "const x = 1;",
        baseline: { mtimeMs: 1, sha256: "abc", size: 12 },
      });
      await mountFileViewer({
        root,
        params: new URLSearchParams("path=/safe/code.ts"),
      });
      const btn = root.querySelector(".file-viewer-mode-toggle");
      expect(btn).toBeNull();
    });

    it("reads the persisted mode and shows 'View rendered' when it's 'source'", async () => {
      files.read.mockResolvedValue({
        ok: true,
        resolvedPath: "/safe/notes.md",
        content: "# Title",
        baseline: { mtimeMs: 1, sha256: "abc", size: 7 },
      });
      const configStub: ConfigStub = {
        get: vi.fn().mockResolvedValue({ "/safe/notes.md": "source" }),
        set: vi.fn().mockResolvedValue(undefined),
      };
      installReckApi(files, configStub);
      await mountFileViewer({
        root,
        params: new URLSearchParams("path=/safe/notes.md"),
      });
      const btn = root.querySelector(".file-viewer-mode-toggle") as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.textContent).toBe("View rendered");
    });

    // Round 3 Issue D3 — when an external watch event fires and the
    // disk contents match what the editor already shows, the auto-reload
    // path must skip the editor swap and the "Reloaded from disk" toast.
    // Without this guard, the popup self-reloads after every save (the
    // post-write fs.watch event re-reads the file, content matches what
    // we just wrote, and the editor.setContent re-fires the auto-save
    // pipeline → the ~50ms flicker reported in production).
    it("D3 guard: skips reload when reread sha equals session baseline sha", async () => {
      files.read.mockResolvedValueOnce({
        ok: true,
        resolvedPath: "/safe/script.ts",
        content: "hello world",
        baseline: { mtimeMs: 1, sha256: "sha-original", size: 11 },
      });
      await mountFileViewer({
        root,
        params: new URLSearchParams("path=/safe/script.ts"),
      });
      const handler = files.onWatchEvent!.mock.calls[0][0] as (ev: {
        path: string;
        kind: "change" | "unlink";
      }) => void;
      expect(typeof handler).toBe("function");
      // The watcher fired but the disk content is byte-identical to what
      // the session already holds (mtime drifted from a touch / rewrite-
      // in-place, but sha didn't). The guard checks SHA against
      // session.baseline.sha256 and skips the editor swap + toast.
      files.read.mockResolvedValueOnce({
        ok: true,
        resolvedPath: "/safe/script.ts",
        content: "hello world",
        baseline: { mtimeMs: 2, sha256: "sha-original", size: 11 },
      });
      handler({ path: "/safe/script.ts", kind: "change" });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(
        root.querySelector(".file-viewer-code-editor")!.textContent,
      ).toContain("hello world");
      expect(document.body.textContent ?? "").not.toMatch(/Reloaded from disk/);
    });

    it("D3 control: DOES reload when reread sha differs from session baseline", async () => {
      files.read.mockResolvedValueOnce({
        ok: true,
        resolvedPath: "/safe/script.ts",
        content: "hello world",
        baseline: { mtimeMs: 1, sha256: "sha-original", size: 11 },
      });
      await mountFileViewer({
        root,
        params: new URLSearchParams("path=/safe/script.ts"),
      });
      const handler = files.onWatchEvent!.mock.calls[0][0] as (ev: {
        path: string;
        kind: "change" | "unlink";
      }) => void;
      files.read.mockResolvedValueOnce({
        ok: true,
        resolvedPath: "/safe/script.ts",
        content: "DIFFERENT content",
        baseline: { mtimeMs: 2, sha256: "sha-new", size: 17 },
      });
      handler({ path: "/safe/script.ts", kind: "change" });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(
        root.querySelector(".file-viewer-code-editor")!.textContent,
      ).toContain("DIFFERENT content");
    });

    // Round 3 Issue B — popup chrome shows the parent folder and a
    // STATION/SATELLITE host chip so the user can tell at a glance
    // whether the file lives on the Pi (read via sshfs mount) or on
    // the Mac satellite. Without this, every popup showed only the
    // basename, leaving ambiguous which side they were editing.
    describe("title and host badge (Round 3 Issue B)", () => {
      it("title shows parent-folder/basename, not just basename", async () => {
        files.read.mockResolvedValue({
          ok: true,
          resolvedPath: "/safe/sub/file.md",
          content: "# x",
          baseline: { mtimeMs: 1, sha256: "abc", size: 3 },
        });
        await mountFileViewer({
          root,
          params: new URLSearchParams("path=/safe/sub/file.md"),
        });
        const title = root.querySelector(".file-viewer-title");
        expect(title).not.toBeNull();
        expect(title!.textContent).toContain("sub/file.md");
      });

      it("renders a SATELLITE badge for a local file outside the mount", async () => {
        files.read.mockResolvedValue({
          ok: true,
          resolvedPath: "/tmp/local-file.md",
          content: "# x",
          baseline: { mtimeMs: 1, sha256: "abc", size: 3 },
        });
        await mountFileViewer({
          root,
          params: new URLSearchParams("path=/tmp/local-file.md"),
        });
        const badge = root.querySelector(".file-viewer-host-badge");
        expect(badge).not.toBeNull();
        expect(badge!.textContent).toBe("SATELLITE");
      });

      it("renders a STATION badge for a file under the local sshfs mount", async () => {
        files.read.mockResolvedValue({
          ok: true,
          resolvedPath: "/mount/projects/proj/notes.md",
          content: "# x",
          baseline: { mtimeMs: 1, sha256: "abc", size: 3 },
        });
        await mountFileViewer({
          root,
          params: new URLSearchParams("path=/mount/projects/proj/notes.md"),
        });
        const badge = root.querySelector(".file-viewer-host-badge");
        expect(badge).not.toBeNull();
        expect(badge!.textContent).toBe("STATION");
      });

      it("renders a STATION badge for station-remote (SSH-backed) files", async () => {
        files.readStation = vi.fn().mockResolvedValue({
          ok: true,
          content: "# x",
          baseline: { mtimeMs: 1, sha256: "abc", size: 3 },
        });
        installReckApi(files);
        await mountFileViewer({
          root,
          params: new URLSearchParams(
            "path=/home/pi/.claude/plans/foo.md&host=station-remote",
          ),
        });
        const badge = root.querySelector(".file-viewer-host-badge");
        expect(badge).not.toBeNull();
        expect(badge!.textContent).toBe("STATION");
      });

      // Cmd+click on a `~/...` link inside a station-remote markdown
      // popup must NOT produce a path with a literal `~` segment.
      // `paths.resolveAgainst` (in `preload.ts`) short-circuits home-
      // anchored rels and passes them through unchanged; main's
      // `expandTildeForHost` then expands against the right home
      // (`/home/pi` for station-sourced clicks).
      it("Cmd+click on a `~/...` link passes the unmangled href to openInViewer", async () => {
        files.readStation = vi.fn().mockResolvedValue({
          ok: true,
          content: "see [foo](~/.claude/plans/foo.md)\n",
          baseline: { mtimeMs: 1, sha256: "abc", size: 30 },
        });
        installReckApi(files);
        await mountFileViewer({
          root,
          params: new URLSearchParams(
            "path=/home/pi/.claude/plans/parent.md&host=station-remote",
          ),
        });
        const a = root.querySelector(
          'a.reck-internal-link[href="~/.claude/plans/foo.md"]',
        ) as HTMLAnchorElement | null;
        expect(a).not.toBeNull();
        a!.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            metaKey: true,
          }),
        );
        expect(files.openInViewer).toHaveBeenCalledTimes(1);
        const [target, opts] = files.openInViewer.mock.calls[0];
        // The path passed to openInViewer is the RAW href, not the
        // mangled `/home/pi/.claude/plans/~/.claude/plans/foo.md`.
        expect(target).toBe("~/.claude/plans/foo.md");
        expect(opts.sourceHost).toBe("station");
        expect(opts.originalText).toBe("~/.claude/plans/foo.md");
      });
    });

    it("persists the new mode when the toggle is clicked", async () => {
      files.read.mockResolvedValue({
        ok: true,
        resolvedPath: "/safe/notes.md",
        content: "# Title",
        baseline: { mtimeMs: 1, sha256: "abc", size: 7 },
      });
      const configStub: ConfigStub = {
        get: vi.fn().mockResolvedValue(undefined), // default mode
        set: vi.fn().mockResolvedValue(undefined),
      };
      installReckApi(files, configStub);
      await mountFileViewer({
        root,
        params: new URLSearchParams("path=/safe/notes.md"),
      });
      const btn = root.querySelector(".file-viewer-mode-toggle") as HTMLButtonElement;
      btn.click();
      // Allow microtasks to flush so the await chain in the click handler
      // completes its config.set call. The chain is: enter async →
      // config.get → spread/merge → config.set, which is roughly 6
      // microtasks deep. A small loop is more reliable than counting.
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(configStub.set).toHaveBeenCalledWith(
        "fileViewerModePerPath",
        expect.objectContaining({ "/safe/notes.md": "source" }),
      );
    });
  });

  // Round 4 Phase O — phantom conflict banner. The Round 3 D3 guard
  // ran sha-equality only inside the clean branch of handleExternalChange.
  // When the user was actively typing (autoSave non-idle), a sshfs
  // polling watcher tick after a self-write would slip past the 500ms
  // time window and hit the dirty branch, showing a bogus "file changed
  // on disk" banner even though the disk content was byte-identical to
  // the session's baseline (our own echo). Phase O moves the sha check
  // ABOVE the clean/dirty branching so echoes are suppressed regardless
  // of autoSave state.
  describe("Phase O — sha echo detection (Round 4)", () => {
    it("emits `[file-viewer] echo-suppressed` when watch event sha matches session baseline", async () => {
      files.read.mockResolvedValueOnce({
        ok: true,
        resolvedPath: "/safe/notes.txt",
        content: "alpha",
        baseline: { mtimeMs: 1, sha256: "sha-A", size: 5 },
      });
      await mountFileViewer({
        root,
        params: new URLSearchParams("path=/safe/notes.txt"),
      });
      const handler = files.onWatchEvent!.mock.calls[0][0] as (ev: {
        path: string;
        kind: "change" | "unlink";
      }) => void;
      // Disk reread returns identical sha — pure echo of our own write.
      files.read.mockResolvedValueOnce({
        ok: true,
        resolvedPath: "/safe/notes.txt",
        content: "alpha",
        baseline: { mtimeMs: 2, sha256: "sha-A", size: 5 },
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        handler({ path: "/safe/notes.txt", kind: "change" });
        for (let i = 0; i < 20; i++) await Promise.resolve();
        const echoLogs = logSpy.mock.calls
          .map((c) => (typeof c[0] === "string" ? c[0] : ""))
          .filter((s) => s.includes("echo-suppressed"));
        expect(echoLogs.length).toBeGreaterThan(0);
        // Behavioral guarantees: no toast, no banner, no setContent.
        expect(document.body.textContent ?? "").not.toMatch(/Reloaded from disk/);
        expect(root.querySelector(".file-viewer-conflict-banner")).toBeNull();
      } finally {
        logSpy.mockRestore();
      }
    });

    it("Phase S — station-remote popup is editable in source mode (no Read-only banner, CodeMirror editable)", async () => {
      // Mock config so the file opens in source (CodeMirror) mode, not
      // rendered — that's the branch that previously mounted the
      // "Read-only — station file:" banner.
      const configStub: ConfigStub = {
        get: vi.fn().mockResolvedValue({
          "/home/pi/.claude/plans/foo.md": "source",
        }),
        set: vi.fn().mockResolvedValue(undefined),
      };
      files.readStation = vi.fn().mockResolvedValue({
        ok: true,
        content: "# Plan content",
        baseline: { mtimeMs: 1, sha256: "sha-A", size: 14 },
      });
      files.writeStation = vi.fn().mockResolvedValue({
        ok: true,
        baseline: { mtimeMs: 2, sha256: "sha-B", size: 14 },
      });
      installReckApi(files, configStub);
      await mountFileViewer({
        root,
        params: new URLSearchParams(
          "path=/home/pi/.claude/plans/foo.md&host=station-remote",
        ),
      });
      // The pre-Phase-S "Read-only — station file:" banner is gone.
      expect(root.querySelector(".file-viewer-station-banner")).toBeNull();
      // STATION badge in the title remains as the host indicator.
      const badge = root.querySelector(".file-viewer-host-badge");
      expect(badge?.textContent).toBe("STATION");
      // The CodeMirror surface is mounted but the wrapper class is
      // no longer the read-only variant (pre-Phase-S used
      // .file-viewer-code-readonly; Phase S unifies on .file-viewer-code-editor).
      expect(root.querySelector(".file-viewer-code-readonly")).toBeNull();
      expect(root.querySelector(".file-viewer-code-editor")).not.toBeNull();
    });

    it("does NOT show conflict banner when watch fires with matching sha (dirty-branch echo suppression)", async () => {
      // Same shape as the D3 sha-equality test, but instead of relying
      // on the autoSave being idle (clean branch), this verifies the
      // suppression also short-circuits before the clean/dirty branch
      // even has a chance to run. The proof is the new echo-suppressed
      // log line + zero side-effects below.
      files.read.mockResolvedValueOnce({
        ok: true,
        resolvedPath: "/safe/notes.txt",
        content: "hello",
        baseline: { mtimeMs: 1, sha256: "echo-sha", size: 5 },
      });
      await mountFileViewer({
        root,
        params: new URLSearchParams("path=/safe/notes.txt"),
      });
      const handler = files.onWatchEvent!.mock.calls[0][0] as (ev: {
        path: string;
        kind: "change" | "unlink";
      }) => void;
      files.read.mockResolvedValueOnce({
        ok: true,
        resolvedPath: "/safe/notes.txt",
        content: "hello",
        baseline: { mtimeMs: 99, sha256: "echo-sha", size: 5 },
      });
      handler({ path: "/safe/notes.txt", kind: "change" });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      // No conflict banner, no reload toast, no probe-read for theirs.
      expect(root.querySelector(".file-viewer-conflict-banner")).toBeNull();
      expect(document.body.textContent ?? "").not.toMatch(/Reloaded from disk/);
    });
  });
});

/**
 * Round 6 Phase DD — station-aware create banner.
 *
 * DD1: when a station-pane click resolves to a Mac mount-mirror path
 * that doesn't exist, the create banner should display the Pi-side
 * path. The URL carries a `displayPath` query param with the
 * translated path; the actual create still uses the Mac path (sshfs
 * handles the through-write).
 *
 * DD2: when the popup opens for a station-remote file (`host=station-remote`)
 * and `readStation` returns not-found, mount a create banner that
 * calls `reckAPI.files.createStation` (new SSH-backed mkdir + touch).
 */
describe("Round 6 Phase DD — station-aware create banner", () => {
  let root: HTMLElement;
  let files: FilesApiStub & { createStation?: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    files = {
      read: vi.fn(),
      stat: vi.fn(),
      openInViewer: vi.fn().mockResolvedValue({ ok: true }),
      readStation: vi.fn(),
      writeStation: vi.fn(),
      write: vi.fn(),
      create: vi.fn().mockResolvedValue({
        ok: true,
        resolvedPath: "/Users/me/reck/projects/MyProject/foo.py",
        baseline: { mtimeMs: 1, sha256: "x", size: 0 },
      }),
      createStation: vi.fn().mockResolvedValue({
        ok: true,
        resolvedPath: "/home/pi/.claude/plans/new-plan.md",
      }),
      watchSubscribe: vi.fn().mockResolvedValue({ ok: true, resolvedPath: "" }),
      watchUnsubscribe: vi.fn().mockResolvedValue({ ok: true }),
      onWatchEvent: vi.fn().mockReturnValue(() => {}),
      suffixSearch: {
        onMatch: vi.fn().mockReturnValue(() => {}),
        onProgress: vi.fn().mockReturnValue(() => {}),
        onDone: vi.fn().mockReturnValue(() => {}),
        onCancelled: vi.fn().mockReturnValue(() => {}),
        cancel: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    installReckApi(files);
  });

  it("DD1 — create banner shows displayPath (Pi path) when the URL carries it", async () => {
    files.read.mockResolvedValueOnce({
      ok: false,
      code: "not-found",
      error: "file does not exist",
    });
    await mountFileViewer({
      root,
      params: new URLSearchParams(
        "path=/Users/me/reck/projects/MyProject/foo.py&displayPath=/home/pi/projects/MyProject/foo.py",
      ),
    });
    const msg = root.querySelector(".file-viewer-create-message");
    expect(msg).not.toBeNull();
    expect(msg!.textContent).toMatch(
      /\/home\/pi\/projects\/MyProject\/foo\.py/,
    );
    // The Mac path must NOT appear in the banner text.
    expect(msg!.textContent).not.toMatch(/\/Users\/me\/reck\/projects/);
  });

  it("DD1 — create button still calls files.create with the REAL (Mac) path", async () => {
    files.read
      .mockResolvedValueOnce({
        ok: false,
        code: "not-found",
        error: "file does not exist",
      })
      // Second read (after create) succeeds so the re-entry doesn't
      // hit an unhandled rejection on undefined.
      .mockResolvedValue({
        ok: true,
        resolvedPath: "/Users/me/reck/projects/MyProject/foo.py",
        content: "",
        baseline: { mtimeMs: 1, sha256: "empty", size: 0 },
      });
    await mountFileViewer({
      root,
      params: new URLSearchParams(
        "path=/Users/me/reck/projects/MyProject/foo.py&displayPath=/home/pi/projects/MyProject/foo.py",
      ),
    });
    const btn = root.querySelector(
      ".file-viewer-create-action",
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    // Allow the create promise + re-render to settle.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // The Mac path is what main needs for the sshfs-backed write.
    expect(files.create).toHaveBeenCalledWith(
      "/Users/me/reck/projects/MyProject/foo.py",
    );
  });

  it("DD1 — without displayPath in the URL, the create banner shows the resolved (local) path", async () => {
    files.read.mockResolvedValueOnce({
      ok: false,
      code: "not-found",
      error: "file does not exist",
    });
    await mountFileViewer({
      root,
      params: new URLSearchParams("path=/safe/local/missing.py"),
    });
    const msg = root.querySelector(".file-viewer-create-message");
    expect(msg!.textContent).toContain("/safe/local/missing.py");
  });

  it("DD2 — renderStationRemote shows a create banner on not-found and calls createStation", async () => {
    files.readStation!.mockResolvedValueOnce({
      ok: false,
      code: "not-found",
      error: "no such file",
    });
    await mountFileViewer({
      root,
      params: new URLSearchParams(
        "path=/home/pi/.claude/plans/new-plan.md&host=station-remote",
      ),
    });
    // Wait for the spinner-hide + render cycle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const banner = root.querySelector(".file-viewer-create-banner");
    expect(banner).not.toBeNull();
    const msg = root.querySelector(".file-viewer-create-message");
    expect(msg!.textContent).toContain(
      "/home/pi/.claude/plans/new-plan.md",
    );
    const btn = root.querySelector(
      ".file-viewer-create-action",
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    // After clicking, the second readStation succeeds so the popup
    // re-renders into the editable view.
    files.readStation!.mockResolvedValueOnce({
      ok: true,
      content: "",
      baseline: { mtimeMs: 1, sha256: "empty", size: 0 },
    });
    btn.click();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(files.createStation).toHaveBeenCalledWith(
      "/home/pi/.claude/plans/new-plan.md",
    );
  });
});

/**
 * Round 6 Phase CC4 — streaming suffix-search picker.
 *
 * When the popup URL carries `suffixSearchPending=1`, the renderer mounts
 * a spinner + counter + live list + Stop Searching button. Matches stream
 * in via `reckAPI.files.suffixSearch.onMatch`; progress updates via
 * `onProgress`. On `onDone` (>= 1 match) the list freezes with "found N
 * matches"; on `onDone` (0 matches) the body swaps to a "no matches /
 * create file" UI; on `onCancelled` the list freezes with "Cancelled …".
 */
describe("Round 6 Phase CC4 — streaming suffix-search picker", () => {
  let root: HTMLElement;
  let files: FilesApiStub;
  // Capture the subscription callbacks so each test can fire fake events.
  let onMatchCb: ((ev: { searchId: string; path: string }) => void) | null;
  let onProgressCb:
    | ((ev: {
        searchId: string;
        scannedDirs: number;
        foundCount: number;
      }) => void)
    | null;
  let onDoneCb:
    | ((ev: {
        searchId: string;
        totalFound: number;
        searchedRoots?: string[];
      }) => void)
    | null;
  let onCancelledCb:
    | ((ev: { searchId: string; totalFound: number }) => void)
    | null;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    onMatchCb = null;
    onProgressCb = null;
    onDoneCb = null;
    onCancelledCb = null;
    files = {
      read: vi.fn(),
      stat: vi.fn(),
      openInViewer: vi.fn().mockResolvedValue({ ok: true }),
      write: vi.fn(),
      watchSubscribe: vi.fn().mockResolvedValue({ ok: true, resolvedPath: "" }),
      watchUnsubscribe: vi.fn().mockResolvedValue({ ok: true }),
      onWatchEvent: vi.fn().mockReturnValue(() => {}),
      create: vi.fn().mockResolvedValue({
        ok: true,
        resolvedPath: "/safe/created.py",
        baseline: { mtimeMs: 1, sha256: "x", size: 0 },
      }),
      suffixSearch: {
        onMatch: vi.fn().mockImplementation((cb) => {
          onMatchCb = cb;
          return () => {};
        }),
        onProgress: vi.fn().mockImplementation((cb) => {
          onProgressCb = cb;
          return () => {};
        }),
        onDone: vi.fn().mockImplementation((cb) => {
          onDoneCb = cb;
          return () => {};
        }),
        onCancelled: vi.fn().mockImplementation((cb) => {
          onCancelledCb = cb;
          return () => {};
        }),
        cancel: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    installReckApi(files);
  });

  const mountWithPendingSearch = async (searchId = "sx-1") => {
    await mountFileViewer({
      root,
      params: new URLSearchParams(
        `path=/safe/providers/ovh.py&suffixSearchPending=1&searchId=${searchId}&suffix=providers/ovh.py`,
      ),
    });
  };

  it("sets document.title to the file basename so macOS Mission Control can tell popups apart", async () => {
    // file-viewer.html ships a static <title>Reck — File Viewer</title>
    // which overwrites the per-file BrowserWindow title on load
    // (Electron's page-title-updated default) — so every popup looked
    // identical at macOS zoom-out. Basename only, no path.
    await mountWithPendingSearch("sx-title");
    expect(document.title).toBe("Reck — File [ovh.py]");
  });

  it("mounts a spinner + 'Searching project tree…' label + Stop button when suffixSearchPending=1", async () => {
    await mountWithPendingSearch();
    expect(root.querySelector(".file-viewer-suffix-streaming")).not.toBeNull();
    expect(
      root.querySelector(".file-viewer-suffix-streaming-heading")?.textContent,
    ).toMatch(/Looking for "providers\/ovh\.py"/);
    // Round 8.7 — the dir-counter ("scanned N dirs") was removed because
    // the rg backend (commit a3b843f) doesn't emit per-readdir progress.
    // Replaced with a spinner element + "Searching project tree…" label.
    expect(
      root.querySelector(".file-viewer-suffix-streaming-spinner"),
    ).not.toBeNull();
    expect(
      root.querySelector(".file-viewer-suffix-streaming-status")?.textContent,
    ).toMatch(/Searching project tree…/);
    expect(
      root.querySelector(".file-viewer-suffix-streaming-status")?.textContent,
    ).not.toMatch(/scanned/);
    expect(root.querySelector(".file-viewer-suffix-streaming-stop")).not.toBeNull();
  });

  it("does NOT call files.read when suffixSearchPending=1", async () => {
    await mountWithPendingSearch();
    expect(files.read).not.toHaveBeenCalled();
  });

  it("appends a list item when a `match` event arrives for this search", async () => {
    await mountWithPendingSearch("sx-2");
    onMatchCb!({
      searchId: "sx-2",
      path: "/safe/services/providers/ovh.py",
    });
    const items = root.querySelectorAll(
      ".file-viewer-suffix-streaming-list .file-viewer-suffix-picker-item",
    );
    expect(items.length).toBe(1);
    expect(items[0].textContent).toBe("/safe/services/providers/ovh.py");
  });

  it("ignores `match` events for a different searchId", async () => {
    await mountWithPendingSearch("sx-3");
    onMatchCb!({
      searchId: "other-search",
      path: "/safe/wrong.py",
    });
    expect(
      root.querySelectorAll(
        ".file-viewer-suffix-streaming-list .file-viewer-suffix-picker-item",
      ).length,
    ).toBe(0);
  });

  // Round 8.7 — the dir-counter was removed. The renderer still receives
  // onProgress events (used internally to track scannedDirs for the
  // "couldn't read root" unreadable-mount diagnostic at freeze time), but
  // it no longer renders a dir count. The visible status stays
  // "Searching project tree…" until matches arrive.
  it("does not surface dir-counter text on progress events", async () => {
    await mountWithPendingSearch("sx-4");
    onProgressCb!({ searchId: "sx-4", scannedDirs: 123, foundCount: 0 });
    const status = root.querySelector(
      ".file-viewer-suffix-streaming-status",
    )?.textContent ?? "";
    expect(status).toMatch(/Searching project tree…/);
    expect(status).not.toMatch(/scanned/);
    expect(status).not.toMatch(/123/);
  });

  it("appends ' · found N' to the label as matches stream in", async () => {
    await mountWithPendingSearch("sx-4b");
    onMatchCb!({ searchId: "sx-4b", path: "/safe/services/providers/ovh.py" });
    const status = root.querySelector(
      ".file-viewer-suffix-streaming-status",
    )?.textContent ?? "";
    expect(status).toMatch(/Searching project tree… · found 1/);
  });

  it("on done with >=1 match freezes the list and hides Stop button", async () => {
    await mountWithPendingSearch("sx-5");
    onMatchCb!({ searchId: "sx-5", path: "/safe/a/x.py" });
    onMatchCb!({ searchId: "sx-5", path: "/safe/b/x.py" });
    onDoneCb!({ searchId: "sx-5", totalFound: 2 });
    expect(
      root.querySelector(".file-viewer-suffix-streaming-status")?.textContent,
    ).toMatch(/found 2 matches/);
    const stopBtn = root.querySelector(
      ".file-viewer-suffix-streaming-stop",
    ) as HTMLElement;
    expect(stopBtn.style.display).toBe("none");
  });

  it("on done with 0 matches swaps to no-matches + create UI", async () => {
    await mountWithPendingSearch("sx-6");
    // At least one progress event so scannedDirs > 0 — distinguishes
    // "walked but no hits" from "couldn't read any root" (Phase RR).
    onProgressCb!({ searchId: "sx-6", scannedDirs: 42, foundCount: 0 });
    onDoneCb!({ searchId: "sx-6", totalFound: 0 });
    const text = root.textContent ?? "";
    expect(text).toMatch(/No matches for "providers\/ovh\.py"/);
    expect(text).toMatch(/Create empty file at \/safe\/providers\/ovh\.py/);
  });

  // Round 8.1 Phase RR — when freeze("done") fires with scannedDirs === 0
  // the picker swaps to a different banner that names sshfs stall as the
  // likely cause. The Create button is still offered.
  it("on done with 0 dirs scanned shows the 'couldn't read root' banner", async () => {
    await mountWithPendingSearch("sx-stall");
    // No progress events arrive — scannedDirs stays at 0.
    onDoneCb!({ searchId: "sx-stall", totalFound: 0 });
    const text = root.textContent ?? "";
    expect(text).toMatch(/Couldn't read any search root/);
    expect(text).toMatch(/sshfs mount may be stalled/);
    // The Create button stays — the user can still try writing the file.
    expect(text).toMatch(/Create empty file at \/safe\/providers\/ovh\.py/);
    // The generic "no matches" copy is NOT present.
    expect(text).not.toMatch(/No matches for "providers\/ovh\.py"/);
  });

  // the rg backend never emits per-readdir
  // progress, so scannedDirs is permanently 0 even when the search
  // walked everything. The old freeze("done") branch keyed ONLY off
  // scannedDirs === 0 and blamed the sshfs mount for every rg-backed
  // 0-match search. Main now tags the popup URL with
  // searchProgressCapable; an explicit "0" means scannedDirs carries
  // no signal and the plain no-matches banner must render instead.
  it("rg backend (searchProgressCapable=0): done with 0 matches shows plain no-matches, NOT the sshfs-stall banner", async () => {
    await mountFileViewer({
      root,
      params: new URLSearchParams(
        "path=/safe/providers/ovh.py&suffixSearchPending=1&searchId=sx-rg0&suffix=providers/ovh.py&searchProgressCapable=0",
      ),
    });
    onDoneCb!({ searchId: "sx-rg0", totalFound: 0 });
    const text = root.textContent ?? "";
    expect(text).toMatch(/No matches for "providers\/ovh\.py"/);
    expect(text).not.toMatch(/sshfs mount may be stalled/);
    expect(text).not.toMatch(/Couldn't read any search root/);
    expect(text).toMatch(/Create empty file at \/safe\/providers\/ovh\.py/);
  });

  // the no-match banner names the roots the search
  // actually walked. The 2026-06-06 failure (search silently confined
  // to …/.claude/plans) would have been a five-second diagnosis with
  // this line on screen.
  it("no-match banner lists the searched roots from the done payload", async () => {
    await mountWithPendingSearch("sx-roots");
    onProgressCb!({ searchId: "sx-roots", scannedDirs: 7, foundCount: 0 });
    onDoneCb!({
      searchId: "sx-roots",
      totalFound: 0,
      searchedRoots: ["/safe/proj/.claude/plans", "/safe/proj"],
    });
    const text = root.textContent ?? "";
    expect(text).toMatch(/No matches for "providers\/ovh\.py"/);
    expect(text).toMatch(/Searched: \/safe\/proj\/\.claude\/plans · \/safe\/proj/);
  });

  it("searched roots render in Pi form when displayTranslation is present", async () => {
    await mountFileViewer({
      root,
      params: new URLSearchParams(
        "path=/safe/providers/ovh.py&suffixSearchPending=1&searchId=sx-roots-pi&suffix=providers/ovh.py" +
          "&displayMountRoot=/safe&displayStationRoot=/home/pi/projects",
      ),
    });
    onProgressCb!({ searchId: "sx-roots-pi", scannedDirs: 7, foundCount: 0 });
    onDoneCb!({
      searchId: "sx-roots-pi",
      totalFound: 0,
      searchedRoots: ["/safe/TotoScopeBeta"],
    });
    const text = root.textContent ?? "";
    expect(text).toMatch(/Searched: \/home\/pi\/projects\/TotoScopeBeta/);
    expect(text).not.toMatch(/Searched: \/safe\/TotoScopeBeta/);
  });

  it("no Searched line when the payload carries no roots (old-main tolerance)", async () => {
    await mountWithPendingSearch("sx-noroots");
    onProgressCb!({ searchId: "sx-noroots", scannedDirs: 7, foundCount: 0 });
    onDoneCb!({ searchId: "sx-noroots", totalFound: 0 });
    expect(root.textContent ?? "").not.toMatch(/Searched:/);
  });

  it("walker backend (searchProgressCapable=1): 0 dirs scanned keeps the sshfs-stall banner", async () => {
    await mountFileViewer({
      root,
      params: new URLSearchParams(
        "path=/safe/providers/ovh.py&suffixSearchPending=1&searchId=sx-walk0&suffix=providers/ovh.py&searchProgressCapable=1",
      ),
    });
    onDoneCb!({ searchId: "sx-walk0", totalFound: 0 });
    const text = root.textContent ?? "";
    expect(text).toMatch(/Couldn't read any search root/);
    expect(text).toMatch(/sshfs mount may be stalled/);
  });

  it("Stop button calls reckAPI.files.suffixSearch.cancel(searchId)", async () => {
    await mountWithPendingSearch("sx-7");
    const stopBtn = root.querySelector(
      ".file-viewer-suffix-streaming-stop",
    ) as HTMLElement;
    stopBtn.click();
    expect(files.suffixSearch!.cancel).toHaveBeenCalledWith("sx-7");
  });

  it("cancelled event displays 'Cancelled · found N so far'", async () => {
    await mountWithPendingSearch("sx-8");
    onMatchCb!({ searchId: "sx-8", path: "/safe/a/x.py" });
    onCancelledCb!({ searchId: "sx-8", totalFound: 1 });
    expect(
      root.querySelector(".file-viewer-suffix-streaming-status")?.textContent,
    ).toMatch(/Cancelled · found 1 match so far/);
  });

  // Round 8.7 — auto-open when streaming search resolves to a single
  // match. Replicates the row-click code path (openInViewer +
  // window.close). Guarded against (a) double-open when the user clicks
  // the row before `done` fires (openedManually flag) and (b)
  // open-on-cancel (only fires for kind === "done").
  it("auto-opens when done fires with exactly 1 match", async () => {
    await mountWithPendingSearch("sx-auto-1");
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    onMatchCb!({ searchId: "sx-auto-1", path: "/safe/only/match.py" });
    onDoneCb!({ searchId: "sx-auto-1", totalFound: 1 });
    expect(files.openInViewer).toHaveBeenCalledWith(
      "/safe/only/match.py",
      { projectCwd: undefined },
    );
    // openMatchAndClose awaits openInViewer before close — flush the
    // microtask queue so the post-await window.close() runs.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(closeSpy).toHaveBeenCalled();
  });

  it("does NOT auto-open when done fires with 2 matches", async () => {
    await mountWithPendingSearch("sx-auto-2");
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    onMatchCb!({ searchId: "sx-auto-2", path: "/safe/a/match.py" });
    onMatchCb!({ searchId: "sx-auto-2", path: "/safe/b/match.py" });
    onDoneCb!({ searchId: "sx-auto-2", totalFound: 2 });
    expect(files.openInViewer).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("does NOT auto-open when cancelled with 1 match found so far", async () => {
    await mountWithPendingSearch("sx-auto-3");
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    onMatchCb!({ searchId: "sx-auto-3", path: "/safe/only/match.py" });
    onCancelledCb!({ searchId: "sx-auto-3", totalFound: 1 });
    expect(files.openInViewer).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  // Round 8.7 follow-up — the fire-and-forget pattern (void openInViewer
  // + sync window.close()) raced: the renderer started tearing down
  // before main finished spawning the new BrowserWindow, and the new
  // window briefly appeared then closed. Awaiting the IPC roundtrip
  // before closing fixes it. This test pins the contract.
  it("awaits openInViewer before closing the popup (no race on auto-open)", async () => {
    await mountWithPendingSearch("sx-await");
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    let resolveOpen!: (v: unknown) => void;
    files.openInViewer.mockReturnValueOnce(
      new Promise((r) => {
        resolveOpen = r;
      }),
    );
    onMatchCb!({ searchId: "sx-await", path: "/safe/only/match.py" });
    onDoneCb!({ searchId: "sx-await", totalFound: 1 });
    // openInViewer fired, but close MUST NOT have fired yet — the IPC
    // hasn't resolved, so main hasn't confirmed the new window exists.
    expect(files.openInViewer).toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
    resolveOpen({ ok: true });
    // Flush microtasks so the post-await window.close() runs.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(closeSpy).toHaveBeenCalled();
  });

  it("does NOT double-open when the user clicked the row before done fires", async () => {
    await mountWithPendingSearch("sx-auto-4");
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    onMatchCb!({ searchId: "sx-auto-4", path: "/safe/only/match.py" });
    // User clicks the row before onDone arrives.
    const item = root.querySelector(
      ".file-viewer-suffix-streaming-list .file-viewer-suffix-picker-item",
    ) as HTMLElement;
    item.click();
    onDoneCb!({ searchId: "sx-auto-4", totalFound: 1 });
    // openMatchAndClose awaits openInViewer — flush before asserting on close.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // openInViewer should be called exactly once — by the click, not
    // again by the auto-open path.
    expect(files.openInViewer).toHaveBeenCalledTimes(1);
    // window.close also called only once (by the row click).
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("clicking a streamed match item opens it via openInViewer and closes the popup", async () => {
    await mountWithPendingSearch("sx-9");
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    onMatchCb!({ searchId: "sx-9", path: "/safe/services/providers/ovh.py" });
    const item = root.querySelector(
      ".file-viewer-suffix-streaming-list .file-viewer-suffix-picker-item",
    ) as HTMLElement;
    item.click();
    expect(files.openInViewer).toHaveBeenCalledWith(
      "/safe/services/providers/ovh.py",
      // Round 8 Phase MM — the streaming picker re-attaches the
      // popup's projectCwd onto every cascaded click. The test
      // mounts without a projectCwd URL param, so the value is
      // undefined here; the shape of the second arg still changed
      // from `undefined` to `{ projectCwd: undefined }`.
      { projectCwd: undefined },
    );
    // openMatchAndClose awaits openInViewer — flush before asserting on close.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(closeSpy).toHaveBeenCalled();
  });
});

/**
 * Round 6 Phase AA — sticky banners. The popup body (`.file-viewer-body`)
 * is the scroll container (`overflow: auto`). Banners appended at the top
 * of that container scroll out of view when the editor grows long. The
 * lock banner, read-only banner, conflict banner, and (legacy) station
 * banner must stay pinned at the top of the body via `position: sticky`.
 *
 * We assert the CSS rules statically (jsdom doesn't surface external
 * stylesheet pseudo-styles). Pattern follows
 * pane-layout.test.ts:980-991 — read styles.css from disk, regex-match.
 */
describe("Round 6 Phase AA — sticky banner CSS", () => {
  let css: string;
  beforeAll(async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    css = await fs.readFile(
      path.join(here, "..", "styles.css"),
      "utf8",
    );
  });

  const stickyBanners = [
    ".file-viewer-lock-banner",
    ".file-viewer-readonly-banner",
    ".file-viewer-conflict-banner",
    ".file-viewer-station-banner",
  ] as const;

  it.each(stickyBanners)(
    "%s rule sets position: sticky with top: 0",
    (selector) => {
      const escaped = selector.replace(/[.[\]/\\^$*+?(){}|]/g, "\\$&");
      // The selector may appear in multiple rule blocks (e.g. variant
      // selectors like `[data-locked="true"]`). We match a block that
      // contains BOTH position: sticky AND top: 0 within the same
      // declaration list following the bare selector.
      const re = new RegExp(
        String.raw`${escaped}\s*(?:,[^{]*)?{[^}]*?position:\s*sticky[^}]*?top:\s*0[^}]*?}`,
        "s",
      );
      const altRe = new RegExp(
        String.raw`${escaped}\s*(?:,[^{]*)?{[^}]*?top:\s*0[^}]*?position:\s*sticky[^}]*?}`,
        "s",
      );
      expect(re.test(css) || altRe.test(css)).toBe(true);
    },
  );

  it("declares a non-trivial z-index so banners cover editor content", () => {
    // The sticky banner needs to layer above the editor (whose lines
    // scroll behind it). Any z-index >= 1 satisfies the contract.
    const block = css.match(
      /\.file-viewer-lock-banner\s*\{[^}]*\}/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block).toMatch(/z-index:\s*[1-9]/);
  });
});

/**
 * Round 8.4 Bug D — the file-viewer popup window was painting BOTH
 * an outer scrollbar (on the popup HTML) AND the inner
 * `.file-viewer-body` scrollbar. Only the inner one is desired by
 * design. Banner top spacing was also slightly too tall.
 *
 * Same disk-read-css pattern as the Round 6 Phase AA tests above.
 */
describe("Round 8.4 Bug D — popup root scroll clamp + banner spacing", () => {
  let css: string;
  beforeAll(async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    css = await fs.readFile(
      path.join(here, "..", "styles.css"),
      "utf8",
    );
  });

  it("#viewer-root clamps overflow so only the inner body scrolls", () => {
    // Either an explicit `#viewer-root` rule with overflow: hidden OR a
    // selector that matches the popup root (`.file-viewer-shell`,
    // `.file-viewer-root`) and clamps overflow. The phase GGG fix
    // chooses ONE of these — assertion tolerates both forms.
    const reIdRoot = /#viewer-root[^{]*\{[^}]*overflow:\s*hidden[^}]*\}/s;
    const reClassRoot =
      /\.file-viewer-(?:shell|root)[^{]*\{[^}]*overflow:\s*hidden[^}]*\}/s;
    expect(reIdRoot.test(css) || reClassRoot.test(css)).toBe(true);
  });

  it("lock banner has reduced top padding (≤ 7px from the 9px baseline)", () => {
    // The Round 5 Phase W lock-banner shipped with `padding: 9px 14px`.
    // Phase GGG tightens the vertical padding by 2-4px (≤ 7px).
    // The match captures the FIRST `.file-viewer-lock-banner { ... }`
    // block (not the `[data-locked=...]` variants).
    const block = css.match(
      /\.file-viewer-lock-banner\s*\{[^}]*\}/,
    )?.[0];
    expect(block).toBeTruthy();
    // Either `padding: <Npx> <whatever>` OR `padding-block-start: <Npx>`
    // must specify N ≤ 7.
    const paddingShorthand = block!.match(/padding:\s*(\d+)px\s+\d+px/);
    const paddingBlock = block!.match(/padding-block-start:\s*(\d+)px/);
    const verticalPx = paddingShorthand
      ? Number(paddingShorthand[1])
      : paddingBlock
        ? Number(paddingBlock[1])
        : NaN;
    expect(Number.isFinite(verticalPx)).toBe(true);
    expect(verticalPx).toBeLessThanOrEqual(7);
  });
});
