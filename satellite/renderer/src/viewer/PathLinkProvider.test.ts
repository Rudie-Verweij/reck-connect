// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  installPathLinkProvider,
  collectWrapRun,
  projectMatchOntoLines,
  isHeuristicContinuationOf,
  type ResolvedPath,
} from "./PathLinkProvider";

interface FakeBufferLine {
  text: string;
  isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
}

function makeLine(text: string, isWrapped = false): FakeBufferLine {
  return { text, isWrapped, translateToString: () => text };
}

interface FakeMarker {
  disposed: boolean;
  dispose(): void;
}

interface FakeDecoration {
  disposed: boolean;
  dispose(): void;
  opts: {
    marker: FakeMarker;
    x?: number;
    width?: number;
    backgroundColor?: string;
    layer?: "bottom" | "top";
  };
  // Round 8.4 — xterm fires `onRender` with a real DOM element (a
  // `xterm-decoration` div appended to the screen-element overlay). The
  // fake invokes the callback synchronously with a fresh detached div so
  // tests can assert post-render element styling without scheduling.
  element: HTMLElement | null;
  onRender(cb: (el: HTMLElement) => void): void;
}

function makeFakeTerminal(
  // Either plain strings (no wrapping) or {text, isWrapped} for Phase-5
  // wrap-run tests.
  lines: Array<string | { text: string; isWrapped: boolean }>,
) {
  const buf = lines.map((l) =>
    typeof l === "string" ? makeLine(l) : makeLine(l.text, l.isWrapped),
  );
  let registered:
    | {
        provideLinks: (line: number, cb: (links: unknown[] | undefined) => void) => void;
      }
    | null = null;
  // Round 8.3 Phase ZZ — registerMarker / registerDecoration spies so
  // tests can assert hover paints decorations on sibling ILinks. The
  // returned sentinels track `disposed` so leave-time cleanup is
  // assertable. baseY / cursorY default to 0; tests that exercise the
  // y conversion math can override.
  const markerCalls: Array<{ offset: number | undefined; marker: FakeMarker }> =
    [];
  const decorationCalls: FakeDecoration[] = [];
  const term = {
    registerLinkProvider(p: unknown) {
      registered = p as typeof registered;
      return { dispose: vi.fn() };
    },
    buffer: {
      active: { getLine: (i: number) => buf[i], baseY: 0, cursorY: 0 },
    },
    registerMarker(offset?: number): FakeMarker | undefined {
      const m: FakeMarker = {
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      };
      markerCalls.push({ offset, marker: m });
      return m;
    },
    registerDecoration(opts: FakeDecoration["opts"]): FakeDecoration | undefined {
      const d: FakeDecoration = {
        disposed: false,
        opts,
        element: null,
        dispose() {
          this.disposed = true;
        },
        onRender(cb: (el: HTMLElement) => void): void {
          const el = document.createElement("div");
          this.element = el;
          cb(el);
        },
      };
      decorationCalls.push(d);
      return d;
    },
  };
  return {
    term,
    getRegistered: () => registered,
    markerCalls,
    decorationCalls,
  };
}

interface ProviderCalls {
  onActivate: ReturnType<typeof vi.fn>;
  resolveBatch: (paths: string[]) => Promise<ResolvedPath[]>;
  // Spy handle so tests can introspect call count without losing the
  // strict resolveBatch signature needed by PathLinkProviderDeps.
  _resolveSpy: ReturnType<typeof vi.fn>;
}

function defaultDeps(
  resolveResults: ResolvedPath[] = [],
): ProviderCalls {
  const spy = vi.fn().mockResolvedValue(resolveResults);
  return {
    onActivate: vi.fn(),
    resolveBatch: (paths: string[]) => spy(paths),
    _resolveSpy: spy,
  };
}

describe("installPathLinkProvider", () => {
  let term: ReturnType<typeof makeFakeTerminal>;

  beforeEach(() => {
    term = makeFakeTerminal([
      "edit /tmp/foo.md and ~/bar.md",
      "not a path here",
      "see satellite/main/file-viewer.ts:42",
    ]);
  });

  it("registers a link provider on the terminal", () => {
    const deps = defaultDeps();
    installPathLinkProvider(term.term, deps);
    expect(term.getRegistered()).not.toBeNull();
  });

  it("emits one link per path-like token in the hovered line", async () => {
    const deps = defaultDeps([
      { path: "/tmp/foo.md", exists: true, isDirectory: false, parentExists: true },
      { path: "/Users/me/bar.md", exists: true, isDirectory: false, parentExists: true },
    ]);
    installPathLinkProvider(term.term, deps);

    const links = await provideAndWait(term, 0);
    // Both detected tokens should produce links (regex finds /tmp/foo.md
    // and ~/bar.md; the resolver returns canonical forms).
    expect(links.length).toBe(2);
    const texts = links.map((l) => l.text);
    expect(texts).toContain("/tmp/foo.md");
    expect(texts).toContain("~/bar.md");
  });

  it("does NOT emit links for a line with no path-like tokens", async () => {
    const deps = defaultDeps();
    installPathLinkProvider(term.term, deps);
    const links = await provideAndWait(term, 1);
    expect(links).toEqual([]);
    expect(deps._resolveSpy).not.toHaveBeenCalled();
  });

  it("calls onActivate only when the click event has metaKey set", async () => {
    const deps = defaultDeps([
      { path: "/tmp/foo.md", exists: true, isDirectory: false, parentExists: true },
    ]);
    installPathLinkProvider(term.term, deps);
    const links = await provideAndWait(term, 0);
    const fooLink = links.find((l) => l.text === "/tmp/foo.md");
    expect(fooLink).toBeTruthy();

    // Plain click → not activated.
    fooLink!.activate(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
      fooLink!.text,
    );
    expect(deps.onActivate).not.toHaveBeenCalled();

    // Cmd+click → activated with the link text.
    fooLink!.activate(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      fooLink!.text,
    );
    expect(deps.onActivate).toHaveBeenCalledTimes(1);
    expect(deps.onActivate.mock.calls[0][0]).toBe("/tmp/foo.md");
  });

  it("emits links for every regex-detected candidate (resolve runs as a side-effect)", async () => {
    // The hover path is synchronous now — we don't await `resolveBatch`
    // before emitting links (xterm's `provideLinks` has a deadline that
    // an IPC roundtrip blows through, see PathLinkProvider deadline
    // warning in the console). Out-of-roots + orphan checks happen at
    // click time via `files.openInViewer` → main's allowlist → toast.
    const deps = defaultDeps([
      { path: "/tmp/foo.md", exists: true, isDirectory: false, parentExists: true },
    ]);
    installPathLinkProvider(term.term, deps);
    const links = await provideAndWait(term, 0);
    expect(links.length).toBe(2); // both regex matches surface
    expect(links.map((l) => l.text).sort()).toEqual(["/tmp/foo.md", "~/bar.md"].sort());
  });

  it("emits a link for an intended path (exists:false, parentExists:true)", async () => {
    const deps = defaultDeps([
      { path: "/tmp/draft.md", exists: false, isDirectory: false, parentExists: true },
    ]);
    const fakeTerm = makeFakeTerminal(["draft at /tmp/draft.md"]);
    installPathLinkProvider(fakeTerm.term, deps);
    const links = await provideAndWait(fakeTerm, 0);
    expect(links.length).toBe(1);
    expect(links[0].text).toBe("/tmp/draft.md");
  });

  it("still emits a link for an orphan path (exists/parentExists both false) — click activation surfaces the error", async () => {
    // Was previously filtered out; the sync hover path can't make the
    // exists check before xterm's deadline, so emit the link and let
    // the activate path (main.openInViewer → toast) handle the dead end.
    const deps = defaultDeps([
      { path: "/tmp/no/where.md", exists: false, isDirectory: false, parentExists: false },
    ]);
    const fakeTerm = makeFakeTerminal(["see /tmp/no/where.md"]);
    installPathLinkProvider(fakeTerm.term, deps);
    const links = await provideAndWait(fakeTerm, 0);
    expect(links.length).toBe(1);
    expect(links[0].text).toBe("/tmp/no/where.md");
  });

  it("never calls resolveBatch on hover — the IPC roundtrip would blow xterm's deadline", async () => {
    // Earlier impl awaited resolveBatch inside provideLinks; xterm's
    // 5ms-ish deadline was busted by the ~25ms IPC round-trip and the
    // underline never rendered. We emit links synchronously now and
    // let the activate handler (Cmd+click) do the existence check via
    // `files.openInViewer` → main allowlist.
    const deps = defaultDeps([
      { path: "/tmp/foo.md", exists: true, isDirectory: false, parentExists: true },
    ]);
    installPathLinkProvider(term.term, deps);
    await provideAndWait(term, 0);
    await provideAndWait(term, 0);
    expect(deps._resolveSpy).not.toHaveBeenCalled();
  });

  it("dispose() removes the link provider", () => {
    const deps = defaultDeps();
    const disposable = installPathLinkProvider(term.term, deps);
    expect(disposable.dispose).toBeTypeOf("function");
    // No assertion that the term forgets — xterm handles that via the
    // returned disposable from registerLinkProvider. We just confirm
    // the dispose surface exists.
    disposable.dispose();
  });
});

// --- Phase 5 wrap-run helpers ------------------------------------------

describe("collectWrapRun", () => {
  it("returns a single-line run when the hovered line is not wrapped", () => {
    const wrap = makeFakeTerminal(["alpha beta", "gamma"]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      0,
    );
    expect(run).not.toBeNull();
    expect(run!.startLine0).toBe(0);
    expect(run!.lines).toHaveLength(1);
    expect(run!.joinedText).toBe("alpha beta");
  });

  it("walks backward to the start of a wrap run", () => {
    const wrap = makeFakeTerminal([
      "see /tmp/very/long/pa",
      { text: "th/that/wraps.md", isWrapped: true },
      "next line",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      1,
    );
    expect(run!.startLine0).toBe(0);
    expect(run!.lines).toHaveLength(2);
    expect(run!.joinedText).toBe("see /tmp/very/long/path/that/wraps.md");
  });

  it("walks forward through multiple wrap continuations", () => {
    const wrap = makeFakeTerminal([
      "edit /a/very/long/pa",
      { text: "th/that/keeps/on/wr", isWrapped: true },
      { text: "apping/file.md", isWrapped: true },
      "next",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      0,
    );
    expect(run!.lines).toHaveLength(3);
    expect(run!.joinedText).toBe(
      "edit /a/very/long/path/that/keeps/on/wrapping/file.md",
    );
  });

  it("returns null when the hovered line index is out of bounds", () => {
    const wrap = makeFakeTerminal(["x"]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      99,
    );
    expect(run).toBeNull();
  });
});

describe("projectMatchOntoLines", () => {
  it("returns a single range when the match fits on one physical line", () => {
    const lines = [{ length: 20 }, { length: 16 }];
    const segs = projectMatchOntoLines(
      { start: 4, end: 14 },
      lines,
      1, // 1-indexed startLine
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 14, y: 1 },
    });
  });

  it("splits a match that spans two physical lines into two ranges", () => {
    const lines = [{ length: 20 }, { length: 16 }];
    // joined position 4..36 spans both lines: 4..20 on line 1 and 0..16 on line 2.
    const segs = projectMatchOntoLines({ start: 4, end: 36 }, lines, 1);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: { x: 5, y: 1 }, end: { x: 20, y: 1 } });
    expect(segs[1]).toEqual({ start: { x: 1, y: 2 }, end: { x: 16, y: 2 } });
  });

  it("handles a match starting at the line boundary", () => {
    const lines = [{ length: 20 }, { length: 16 }];
    const segs = projectMatchOntoLines({ start: 20, end: 30 }, lines, 1);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ start: { x: 1, y: 2 }, end: { x: 10, y: 2 } });
  });

  it("skips lines with no overlap", () => {
    const lines = [{ length: 5 }, { length: 5 }, { length: 5 }];
    const segs = projectMatchOntoLines({ start: 11, end: 14 }, lines, 1);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ start: { x: 2, y: 3 }, end: { x: 4, y: 3 } });
  });
});

// Phase 8 of linkifier-followups — Claude's bulleted output emits
// `- ~/.claude/plans/long-name` across multiple PHYSICAL lines (hard
// newlines, no xterm soft-wrap). The continuation line is indented by
// two spaces. xterm's `isWrapped` is FALSE on these continuations, so
// the original P5 wrap-run detection didn't help. The heuristic
// continuation logic below joins indent-continued lines too.
describe("collectWrapRun — hard-wrap heuristic (Phase 8)", () => {
  it("joins an indent-continued line when the prior line has no terminator", () => {
    const wrap = makeFakeTerminal([
      "- ~/.claude/plans/gpu-resource-regi",
      "  stry.md",
      "- next item",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      0,
    );
    expect(run).not.toBeNull();
    // The two lines collapse — indent of line 2 is dropped from the
    // joined text so the regex sees one continuous path token.
    expect(run!.joinedText).toContain("~/.claude/plans/gpu-resource-registry.md");
  });

  it("does NOT join when the next line starts a new bullet", () => {
    const wrap = makeFakeTerminal([
      "- ~/.claude/plans/foo.md",
      "- ~/.claude/plans/bar.md",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      0,
    );
    expect(run!.lines).toHaveLength(1);
  });

  it("does NOT join when the next line is empty", () => {
    const wrap = makeFakeTerminal([
      "- ~/.claude/plans/foo.md",
      "",
      "follow-up",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      0,
    );
    expect(run!.lines).toHaveLength(1);
  });

  it("does NOT join when the next line is non-indented", () => {
    const wrap = makeFakeTerminal([
      "edit ~/.claude/plans/foo.md",
      "edit ~/.claude/plans/bar.md",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      0,
    );
    expect(run!.lines).toHaveLength(1);
  });

  it("joins multiple consecutive indent-continued lines", () => {
    const wrap = makeFakeTerminal([
      "- ~/very/long/path/that/keeps/",
      "  going/across/three/",
      "  lines/file.md",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      0,
    );
    expect(run!.lines).toHaveLength(3);
    expect(run!.joinedText).toContain(
      "~/very/long/path/that/keeps/going/across/three/lines/file.md",
    );
  });

  // Round 3: BACKWARD walk — hovering on a continuation line walks back
  // to find the true starter of the wrap-run. Without this, the user
  // sees the truncated continuation fragment matched as a standalone
  // bare-filename, which routes to the wrong file on click.
  it("backward-walks from a continuation line to the true starter", () => {
    const wrap = makeFakeTerminal([
      "Plan file renamed to ~/.claude/plans/gpu-f",
      "  ractional-bucketing.md per CLAUDE.md",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      1, // hover on the continuation
    );
    expect(run).not.toBeNull();
    expect(run!.startLine0).toBe(0);
    expect(run!.lines).toHaveLength(2);
    expect(run!.joinedText).toContain(
      "~/.claude/plans/gpu-fractional-bucketing.md",
    );
  });

  it("backward-walks through multiple continuation lines to the true starter", () => {
    const wrap = makeFakeTerminal([
      "edit ~/a/very/long/path/that/keeps/",
      "  going/across/three/",
      "  lines/file.md ends here",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      2, // hover on the last continuation
    );
    expect(run!.startLine0).toBe(0);
    expect(run!.lines).toHaveLength(3);
    expect(run!.joinedText).toContain(
      "~/a/very/long/path/that/keeps/going/across/three/lines/file.md",
    );
  });

  it("backward walk does NOT join indented line with unrelated prior line", () => {
    const wrap = makeFakeTerminal([
      "first line, totally unrelated",
      "  this line starts indented but isn't a continuation of anything special",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      1,
    );
    expect(run!.startLine0).toBe(1);
  });

  it("does NOT backward-walk over a new-bullet boundary", () => {
    const wrap = makeFakeTerminal([
      "- ~/foo.md",
      "- ~/bar.md", // a new bullet — NOT a continuation of line 0
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      1,
    );
    expect(run!.startLine0).toBe(1); // hovered line is its own start
    expect(run!.lines).toHaveLength(1);
  });

  it("does NOT join indented ls output with prompt line above", () => {
    const wrap = makeFakeTerminal([
      "pi@MyProject:~/projects/MyProject $ ls",
      "  CLAUDE.md  credentials_file_hostname.txt",
      "  requirements.txt  setup.cfg",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      1,
    );
    expect(run!.startLine0).toBe(1);
    expect(run!.joinedText).not.toContain("$ ls");
  });

  it("does NOT join indented ls output lines with each other", () => {
    const wrap = makeFakeTerminal([
      "pi@MyProject:~/projects $ ls",
      "  CLAUDE.md  credentials_file_hostname.txt",
      "  requirements.txt  setup.cfg",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      2,
    );
    expect(run!.startLine0).toBe(2);
    expect(run!.joinedText).not.toContain("credentials_file_hostname.txt");
  });
});

describe("isHeuristicContinuationOf — Case A guard", () => {
  it("rejects indented line when prior line ends with complete command (no path anchor)", () => {
    expect(
      isHeuristicContinuationOf(
        "pi@MyProject:~/projects/MyProject $ ls",
        "  CLAUDE.md  requirements.txt",
      ),
    ).toBe(false);
  });

  it("rejects indented line when prior line ends with complete extension", () => {
    expect(
      isHeuristicContinuationOf(
        "edit ~/.claude/plans/foo.md",
        "  next unrelated line",
      ),
    ).toBe(false);
  });

  it("accepts indented continuation when prior line ends mid-path-token", () => {
    expect(
      isHeuristicContinuationOf(
        "- ~/.claude/plans/gpu-resource-regi",
        "  stry.md",
      ),
    ).toBe(true);
  });

  it("accepts indented continuation when prior line ends with trailing slash", () => {
    expect(
      isHeuristicContinuationOf(
        "edit ~/very/long/path/that/keeps/",
        "  going/across/lines/file.md",
      ),
    ).toBe(true);
  });

  it("rejects indented line when prior line has no path anchor at all", () => {
    expect(
      isHeuristicContinuationOf(
        "first line, totally unrelated",
        "  this line starts indented",
      ),
    ).toBe(false);
  });
});

describe("installPathLinkProvider — wrap-run integration", () => {
  it("emits links for paths that span two physical lines", async () => {
    const wrap = makeFakeTerminal([
      "edit /tmp/very/long",
      { text: "/path/that/wraps.md", isWrapped: true },
    ]);
    const deps = defaultDeps();
    installPathLinkProvider(wrap.term, deps);
    const provider = wrap.getRegistered();
    expect(provider).not.toBeNull();
    const links = await new Promise<
      Array<{
        text: string;
        range: { start: { x: number; y: number }; end: { x: number; y: number } };
        activate: (ev: MouseEvent, text: string) => void;
      }>
    >((resolve) => {
      provider!.provideLinks(1, (out) => resolve((out ?? []) as never));
    });
    // The path "/tmp/very/long/path/that/wraps.md" spans both physical
    // lines, so we expect TWO ILink entries sharing the same text.
    const fullText = "/tmp/very/long/path/that/wraps.md";
    const wrappedHits = links.filter((l) => l.text === fullText);
    expect(wrappedHits.length).toBe(2);
    // Confirm the two ranges land on different rows.
    const rows = wrappedHits.map((l) => l.range.start.y).sort();
    expect(rows).toEqual([1, 2]);
  });
});

// Round 8.2 Phase WW — hard-wrap regression. Some terminal outputs
// produce two physical lines neither of which xterm marks as wrapped
// (isWrapped=false on both) AND the continuation line does NOT begin
// with whitespace — it picks up mid-token from the previous line's
// tail. The user's reported case:
//
//     1. ~/.claude/plans/gpu-poller-v2-phase-4-orchestrat
//     or.md
//
// Without an extended heuristic the wrap-run halts at line 1, the
// truncated `orchestrat` fails `endsLikeFile`, and BOTH physical
// lines emit zero ILinks. Post-fix the joiner recognises that line 1
// ends mid-path-character AND line 2 starts mid-path-character → join.
describe("collectWrapRun — hard-wrap mid-token continuation (Round 8.2 Phase WW)", () => {
  it("joins a non-indented continuation that picks up mid-token from the prior line", () => {
    const wrap = makeFakeTerminal([
      "1. ~/.claude/plans/gpu-poller-v2-phase-4-orchestrat",
      "or.md",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      0,
    );
    expect(run).not.toBeNull();
    expect(run!.lines.length).toBeGreaterThanOrEqual(2);
    expect(run!.joinedText).toContain(
      "~/.claude/plans/gpu-poller-v2-phase-4-orchestrator.md",
    );
  });

  it("backward-walks from a non-indented mid-token continuation to the true starter", () => {
    const wrap = makeFakeTerminal([
      "1. ~/.claude/plans/gpu-poller-v2-phase-4-orchestrat",
      "or.md",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      1, // hover on the continuation
    );
    expect(run).not.toBeNull();
    expect(run!.startLine0).toBe(0);
    expect(run!.lines.length).toBeGreaterThanOrEqual(2);
    expect(run!.joinedText).toContain(
      "~/.claude/plans/gpu-poller-v2-phase-4-orchestrator.md",
    );
  });

  it("does NOT join when the prior line ends with a clear word terminator (space)", () => {
    // Defensive: only mid-token continuations should be joined. Two
    // standalone words on consecutive lines must NOT be merged.
    const wrap = makeFakeTerminal([
      "edit /tmp/foo.md ",
      "also /tmp/bar.md",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      0,
    );
    expect(run!.lines).toHaveLength(1);
  });

  it("does NOT join when the continuation starts with whitespace (still a complete token)", () => {
    // Trailing-no-terminator + leading whitespace on next line is the
    // existing Phase-8 case, which IS joined. Confirm we don't double-
    // join in the new code: if the prior line ends mid-token but the
    // next line starts with whitespace, the EXISTING heuristic owns it
    // (lines.length === 2). The new rule should not duplicate.
    const wrap = makeFakeTerminal([
      "- ~/.claude/plans/gpu-resource-regi",
      "  stry.md",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      0,
    );
    expect(run!.lines).toHaveLength(2);
    expect(run!.joinedText).toContain(
      "~/.claude/plans/gpu-resource-registry.md",
    );
  });
});

describe("installPathLinkProvider — hard-wrap clickability (Round 8.2 Phase WW)", () => {
  it("emits one link per physical line for a hard-wrapped path with no indent", async () => {
    const wrap = makeFakeTerminal([
      "1. ~/.claude/plans/gpu-poller-v2-phase-4-orchestrat",
      "or.md",
    ]);
    const deps = defaultDeps();
    installPathLinkProvider(wrap.term, deps);
    const provider = wrap.getRegistered();
    expect(provider).not.toBeNull();
    const collectAt = (lineIdx0: number) =>
      new Promise<
        Array<{
          text: string;
          range: {
            start: { x: number; y: number };
            end: { x: number; y: number };
          };
          activate: (ev: MouseEvent, text: string) => void;
        }>
      >((resolve) => {
        provider!.provideLinks(lineIdx0 + 1, (out) =>
          resolve((out ?? []) as never),
        );
      });
    const fullText = "~/.claude/plans/gpu-poller-v2-phase-4-orchestrator.md";
    // Hovering EITHER line must yield at least one ILink whose text is
    // the FULL joined path — both halves are clickable handles to the
    // same logical link.
    const linksFromLine0 = await collectAt(0);
    const linksFromLine1 = await collectAt(1);
    expect(linksFromLine0.some((l) => l.text === fullText)).toBe(true);
    expect(linksFromLine1.some((l) => l.text === fullText)).toBe(true);
  });

  it("Cmd+click on the continuation half fires onActivate with the FULL path text", async () => {
    const wrap = makeFakeTerminal([
      "1. ~/.claude/plans/gpu-poller-v2-phase-4-orchestrat",
      "or.md",
    ]);
    const deps = defaultDeps();
    installPathLinkProvider(wrap.term, deps);
    const provider = wrap.getRegistered();
    const links = await new Promise<
      Array<{
        text: string;
        range: {
          start: { x: number; y: number };
          end: { x: number; y: number };
        };
        activate: (ev: MouseEvent, text: string) => void;
      }>
    >((resolve) => {
      provider!.provideLinks(2, (out) => resolve((out ?? []) as never));
    });
    const fullText = "~/.claude/plans/gpu-poller-v2-phase-4-orchestrator.md";
    const continuationLink = links.find(
      (l) => l.text === fullText && l.range.start.y === 2,
    );
    expect(continuationLink).toBeTruthy();
    continuationLink!.activate(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      }),
      continuationLink!.text,
    );
    expect(deps.onActivate).toHaveBeenCalledTimes(1);
    expect(deps.onActivate.mock.calls[0][0]).toBe(fullText);
  });
});

// Round 8.3 Phase ZZ — multi-line ILink hover unification. When a path
// spans two physical lines, xterm emits two ILinks (one per segment)
// sharing the same `text` and `activate`. xterm's built-in hover
// underline is per-ILink, so hovering one half left the other half
// looking like plain text. Round 8.3 wires hover/leave callbacks that
// paint a soft cornflower-blue background decoration on the SIBLING
// segments — both halves visibly belong to the same logical link.
describe("installPathLinkProvider — multi-line hover unification (Round 8.3 Phase ZZ)", () => {
  function getLinks(
    wrap: ReturnType<typeof makeFakeTerminal>,
    line1Indexed: number,
  ) {
    const provider = wrap.getRegistered();
    if (!provider) throw new Error("provider not registered");
    return new Promise<
      Array<{
        text: string;
        range: {
          start: { x: number; y: number };
          end: { x: number; y: number };
        };
        activate: (ev: MouseEvent, text: string) => void;
        hover?: (ev: MouseEvent, text: string) => void;
        leave?: (ev: MouseEvent, text: string) => void;
      }>
    >((resolve) => {
      provider.provideLinks(line1Indexed, (out) =>
        resolve((out ?? []) as never),
      );
    });
  }

  it("hovering one segment of a 2-line ILink paints a decoration on the sibling segment", async () => {
    const wrap = makeFakeTerminal([
      "edit /tmp/very/long",
      { text: "/path/that/wraps.md", isWrapped: true },
    ]);
    const deps = defaultDeps();
    installPathLinkProvider(wrap.term, deps);
    const links = await getLinks(wrap, 1);
    const fullText = "/tmp/very/long/path/that/wraps.md";
    const segments = links.filter((l) => l.text === fullText);
    expect(segments).toHaveLength(2);
    // Sanity — the hover callback must exist after Round 8.3.
    expect(typeof segments[0].hover).toBe("function");
    expect(wrap.decorationCalls.length).toBe(0);
    // Fire hover on segment 1 → one decoration painted on segment 2.
    segments[0].hover!(
      new MouseEvent("mouseover") as MouseEvent,
      segments[0].text,
    );
    expect(wrap.decorationCalls.length).toBe(1);
    // The painted decoration's x/width must align with the SIBLING's
    // (segment 2's) range — start.x is 1-indexed in IBufferRange and
    // registerDecoration's x is 0-indexed (matches existing
    // XtermHighlighter usage), so the painted x is start.x - 1.
    const sibling = segments[1];
    expect(wrap.decorationCalls[0].opts.x).toBe(sibling.range.start.x - 1);
    expect(wrap.decorationCalls[0].opts.width).toBe(
      sibling.range.end.x - sibling.range.start.x + 1,
    );
  });

  it("leave disposes the sibling decoration", async () => {
    const wrap = makeFakeTerminal([
      "edit /tmp/very/long",
      { text: "/path/that/wraps.md", isWrapped: true },
    ]);
    const deps = defaultDeps();
    installPathLinkProvider(wrap.term, deps);
    const links = await getLinks(wrap, 1);
    const fullText = "/tmp/very/long/path/that/wraps.md";
    const segments = links.filter((l) => l.text === fullText);
    segments[0].hover!(
      new MouseEvent("mouseover") as MouseEvent,
      segments[0].text,
    );
    expect(wrap.decorationCalls[0].disposed).toBe(false);
    segments[0].leave!(
      new MouseEvent("mouseout") as MouseEvent,
      segments[0].text,
    );
    expect(wrap.decorationCalls[0].disposed).toBe(true);
  });

  it("hovering a single-line ILink is a no-op (no extra decoration)", async () => {
    const wrap = makeFakeTerminal([
      "edit /tmp/single.md and continue",
    ]);
    const deps = defaultDeps();
    installPathLinkProvider(wrap.term, deps);
    const links = await getLinks(wrap, 1);
    const target = links.find((l) => l.text === "/tmp/single.md");
    expect(target).toBeTruthy();
    expect(typeof target!.hover).toBe("function");
    // A single-segment group has no siblings — hover should not
    // register any decoration.
    target!.hover!(
      new MouseEvent("mouseover") as MouseEvent,
      target!.text,
    );
    expect(wrap.decorationCalls.length).toBe(0);
  });
});

// Round 8.4 Bug A — multi-line hover sibling segment should render an
// UNDERLINE (border-bottom on the decoration element) rather than a
// background-tint. Round 8.3 painted `backgroundColor` on the wrong
// assumption that `IDecoration.element` isn't available under xterm's
// WebGL renderer; reading BufferDecorationRenderer.ts:72-114 proved
// decorations are a parallel DOM overlay layer that runs `onRender`
// with a real HTMLElement regardless of renderer. The Bug A test
// asserts:
//   - no `backgroundColor` is set on the decoration registration
//   - the decoration element receives a non-empty `borderBottom` style
//     after onRender fires (the fake invokes it synchronously)
describe("installPathLinkProvider — Bug A: sibling hover paints an underline (Round 8.4)", () => {
  it("registers no backgroundColor and applies a borderBottom on the sibling element", async () => {
    const wrap = makeFakeTerminal([
      "edit /tmp/very/long",
      { text: "/path/that/wraps.md", isWrapped: true },
    ]);
    const deps = defaultDeps();
    installPathLinkProvider(wrap.term, deps);
    const provider = wrap.getRegistered();
    expect(provider).not.toBeNull();
    const links = await new Promise<
      Array<{
        text: string;
        range: {
          start: { x: number; y: number };
          end: { x: number; y: number };
        };
        activate: (ev: MouseEvent, text: string) => void;
        hover?: (ev: MouseEvent, text: string) => void;
        leave?: (ev: MouseEvent, text: string) => void;
      }>
    >((resolve) => {
      provider!.provideLinks(1, (out) => resolve((out ?? []) as never));
    });
    const fullText = "/tmp/very/long/path/that/wraps.md";
    const segments = links.filter((l) => l.text === fullText);
    expect(segments).toHaveLength(2);
    segments[0].hover!(
      new MouseEvent("mouseover") as MouseEvent,
      segments[0].text,
    );
    expect(wrap.decorationCalls.length).toBe(1);
    const deco = wrap.decorationCalls[0];
    // No background tint — Bug A's core complaint.
    expect(deco.opts.backgroundColor).toBeUndefined();
    // The decoration element exists (onRender fired) and carries an
    // underline-shaped border-bottom.
    expect(deco.element).not.toBeNull();
    expect(deco.element!.style.borderBottom).not.toBe("");
  });
});

// Round 8.4 Bug B — wrap-run detection must tolerate xterm's trailing-
// whitespace padding (IBufferLine.translateToString(false) pads buffer
// lines to terminal width). The Round 8.2 tail regex `(\S+)$` required
// a non-whitespace char immediately before end-of-string and silently
// failed in production. Phase DDD widens the regex AND trims each
// pushed line's trailing whitespace so the JOINED text drops the
// padding gap. The path then surfaces as a single token to the path
// detector. Both walk directions (forward from line 0, backward from
// line 1) hit the same helper.
describe("collectWrapRun — Bug B: padded-line wrap continuation (Round 8.4)", () => {
  it("forward walk: padded prev line joins with `/`-prefixed continuation as one token", () => {
    const wrap = makeFakeTerminal([
      "Plan file renamed to ~/.claude/plans     ", // padded by xterm
      "/gpu-fractional-bucketing.md per the",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      0,
    );
    expect(run).not.toBeNull();
    expect(run!.lines).toHaveLength(2);
    // After Phase DDD the padding is stripped from the joined text so
    // the path detector sees a single contiguous token.
    expect(run!.joinedText).toContain(
      "~/.claude/plans/gpu-fractional-bucketing.md",
    );
  });

  it("backward walk: hovering the continuation walks back to true starter", () => {
    const wrap = makeFakeTerminal([
      "Plan file renamed to ~/.claude/plans     ", // padded
      "/gpu-fractional-bucketing.md per the",
    ]);
    const run = collectWrapRun(
      wrap.term as unknown as Parameters<typeof collectWrapRun>[0],
      1, // hover on the continuation
    );
    expect(run).not.toBeNull();
    expect(run!.startLine0).toBe(0);
    expect(run!.lines).toHaveLength(2);
    expect(run!.joinedText).toContain(
      "~/.claude/plans/gpu-fractional-bucketing.md",
    );
  });
});

// --- helper -------------------------------------------------------------

/**
 * Test helper. xterm calls `provideLinks(bufferLineNumber, cb)` with a
 * 1-INDEXED line number; callers here pass the 0-indexed line as it
 * appears in the fake terminal's `lines` array and we adjust to 1-based
 * before dispatch so the assertions stay readable.
 */
async function provideAndWait(
  termWrap: ReturnType<typeof makeFakeTerminal>,
  lineIndex0Based: number,
): Promise<Array<{
  text: string;
  range: unknown;
  activate: (ev: MouseEvent, text: string) => void;
}>> {
  const provider = termWrap.getRegistered();
  if (!provider) throw new Error("no provider registered");
  return new Promise((resolve) => {
    provider.provideLinks(lineIndex0Based + 1, (links) => {
      resolve((links ?? []) as Array<{
        text: string;
        range: unknown;
        activate: (ev: MouseEvent, text: string) => void;
      }>);
    });
  });
}
