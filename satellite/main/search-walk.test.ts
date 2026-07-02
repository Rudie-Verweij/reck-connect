// Round 6 Phase CC1 — streaming search walk extracted from
// searchProjectTreeBySuffix.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  searchTreeBySuffix,
  isDeterministicInput,
  SUFFIX_SEARCH_BLOCKLIST,
} from "./search-walk";

describe("isDeterministicInput", () => {
  it("returns true for absolute paths", () => {
    expect(isDeterministicInput("/etc/hosts")).toBe(true);
    expect(isDeterministicInput("/Users/me/code/main.ts")).toBe(true);
  });

  it("returns true for home-anchored paths", () => {
    expect(isDeterministicInput("~/notes.md")).toBe(true);
    expect(isDeterministicInput("~")).toBe(true);
  });

  it("returns false for relative paths", () => {
    expect(isDeterministicInput("providers/ovh.py")).toBe(false);
    expect(isDeterministicInput("./foo.ts")).toBe(false);
    expect(isDeterministicInput("../sibling/x.md")).toBe(false);
    expect(isDeterministicInput("services/foo/bar.ts")).toBe(false);
  });

  it("returns false for bare filenames", () => {
    expect(isDeterministicInput("main.ts")).toBe(false);
    expect(isDeterministicInput("CLAUDE.md")).toBe(false);
  });

  it("returns false for empty / non-string input", () => {
    expect(isDeterministicInput("")).toBe(false);
    expect(isDeterministicInput("   ")).toBe(false);
    expect(isDeterministicInput(undefined as unknown as string)).toBe(false);
  });
});

describe("searchTreeBySuffix", () => {
  let tmpRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reck-search-walk-"));
    projectRoot = path.join(tmpRoot, "project");
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(path.join(projectRoot, "services", "gpu-poller", "providers"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectRoot, "services", "gpu-poller", "providers", "ovh.py"),
      "# ovh",
    );
    fs.mkdirSync(path.join(projectRoot, "node_modules", "providers"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectRoot, "node_modules", "providers", "ovh.py"),
      "# decoy",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("finds the unique nested match and skips blocklisted dirs", async () => {
    const seen: string[] = [];
    const result = await searchTreeBySuffix(
      [projectRoot],
      "providers/ovh.py",
      { onMatch: (p) => seen.push(p) },
    );
    expect(result.done).toBe(true);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]).toBe(
      path.join(projectRoot, "services", "gpu-poller", "providers", "ovh.py"),
    );
    expect(seen).toEqual(result.matches);
    // The decoy under node_modules MUST be skipped.
    expect(
      result.matches.some((p) => p.includes("node_modules")),
    ).toBe(false);
  });

  it("emits matches incrementally via onMatch as they're found", async () => {
    // Build a tree with several matches in different subtrees.
    for (const dir of ["a", "b", "c"]) {
      const d = path.join(projectRoot, dir, "providers");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "x.py"), "");
    }
    const matchOrder: string[] = [];
    await searchTreeBySuffix([projectRoot], "providers/x.py", {
      onMatch: (p) => matchOrder.push(p),
    });
    expect(matchOrder.length).toBe(3);
    // Each match is the absolute path.
    for (const m of matchOrder) expect(path.isAbsolute(m)).toBe(true);
  });

  it("emits progress events at least once for a non-trivial walk", async () => {
    // Build a tree with enough dirs to trip the 50-dir threshold.
    for (let i = 0; i < 60; i++) {
      fs.mkdirSync(path.join(projectRoot, `dir${i}`));
    }
    const events: { scannedDirs: number; foundCount: number }[] = [];
    await searchTreeBySuffix([projectRoot], "providers/ovh.py", {
      onProgress: (info) => events.push(info),
    });
    expect(events.length).toBeGreaterThan(0);
    // The last event's scannedDirs should be the final total — we walked
    // ALL 60 + the root + the original 4-deep tree.
    const last = events[events.length - 1];
    expect(last.scannedDirs).toBeGreaterThan(50);
  });

  it("aborts early when isCancelled() returns true (done=false)", async () => {
    // Make the tree large enough that cancellation kicks before completion.
    for (let i = 0; i < 200; i++) {
      const d = path.join(projectRoot, `dir${i}`, "nested");
      fs.mkdirSync(d, { recursive: true });
    }
    let cancelled = false;
    const matches: string[] = [];
    const result = await searchTreeBySuffix(
      [projectRoot],
      "providers/ovh.py",
      {
        onMatch: (p) => matches.push(p),
        onProgress: () => {
          // Cancel as soon as we get the first progress event.
          if (!cancelled) cancelled = true;
        },
        isCancelled: () => cancelled,
      },
    );
    expect(result.done).toBe(false);
  });

  it("rejects absolute or home-anchored input (no fallback path)", async () => {
    const a = await searchTreeBySuffix([projectRoot], "/etc/hosts");
    expect(a).toEqual({ done: true, matches: [], scannedDirs: 0 });
    const b = await searchTreeBySuffix([projectRoot], "~/foo.md");
    expect(b).toEqual({ done: true, matches: [], scannedDirs: 0 });
  });

  it("respects maxMatches cap", async () => {
    for (let i = 0; i < 5; i++) {
      const d = path.join(projectRoot, `bucket${i}`, "providers");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "y.py"), "");
    }
    const result = await searchTreeBySuffix(
      [projectRoot],
      "providers/y.py",
      { maxMatches: 3 },
    );
    expect(result.matches.length).toBe(3);
  });

  it("SUFFIX_SEARCH_BLOCKLIST contains expected entries", () => {
    expect(SUFFIX_SEARCH_BLOCKLIST.has("node_modules")).toBe(true);
    expect(SUFFIX_SEARCH_BLOCKLIST.has(".git")).toBe(true);
    expect(SUFFIX_SEARCH_BLOCKLIST.has("dist")).toBe(true);
  });

  // Round 7 Phase GG — distinguish "ran out of budget" from "user
  // cancelled". The walker returns `done` true when the user did NOT
  // cancel — even if the deadline elapsed. The deadline is a safety
  // net; user cancellation is the only thing that should surface as a
  // "cancelled" outcome to the renderer.
  it("returns done=true on timeout (deadline exhausted but not cancelled)", async () => {
    // Build a tree large enough to blow past a 1ms deadline.
    for (let i = 0; i < 60; i++) {
      const d = path.join(projectRoot, `dir${i}`, "deep");
      fs.mkdirSync(d, { recursive: true });
    }
    const result = await searchTreeBySuffix(
      [projectRoot],
      "providers/ovh.py",
      { timeoutMs: 1 },
    );
    // Timeout fired (the walker bailed out) but the USER did not cancel,
    // so the result is reported as done.
    expect(result.done).toBe(true);
  });

  // Round 8.1 Phase QQ — per-readdir timeout defends against stalled
  // sshfs mounts. Without this guard, a single hung `fsp.readdir` call
  // wedges the walker forever (the 30s budget check sits between
  // iterations, never inside the awaited readdir).
  it("treats roots whose readdir exceeds perReaddirTimeoutMs as unreadable", async () => {
    const spy = vi.spyOn(fsp, "readdir").mockImplementation(((
      ..._args: unknown[]
    ) =>
      new Promise((resolve) => {
        // Resolves in 200ms — longer than the 50ms per-readdir timeout
        // the test passes in. The walker must treat this as a failure
        // and continue / finalize.
        setTimeout(() => resolve([] as never), 200);
      })) as unknown as typeof fsp.readdir);
    try {
      const start = Date.now();
      const result = await searchTreeBySuffix(
        [projectRoot],
        "providers/ovh.py",
        { perReaddirTimeoutMs: 50 },
      );
      const elapsed = Date.now() - start;
      expect(result.done).toBe(true);
      expect(result.matches).toEqual([]);
      expect(result.scannedDirs).toBe(0);
      // The timeout must trip well before the 200ms readdir resolves.
      expect(elapsed).toBeLessThan(180);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns done=false ONLY when isCancelled() goes true", async () => {
    let cancelled = false;
    for (let i = 0; i < 200; i++) {
      const d = path.join(projectRoot, `dir${i}`, "deep");
      fs.mkdirSync(d, { recursive: true });
    }
    const result = await searchTreeBySuffix(
      [projectRoot],
      "providers/ovh.py",
      {
        onProgress: () => {
          cancelled = true;
        },
        isCancelled: () => cancelled,
      },
    );
    expect(result.done).toBe(false);
  });
});
