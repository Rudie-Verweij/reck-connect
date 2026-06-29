import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectPathsInLine,
  isPathLike,
  setExtensionlessAllowlist,
  SEEDED_EXTENSIONLESS_FILENAMES,
} from "./LinkDetector";

// Round 8 Phase LL — the allowlist is module-level state. Reset to the
// seeded defaults before each test so case-specific overrides don't bleed
// into neighbouring assertions.
beforeEach(() => {
  setExtensionlessAllowlist(SEEDED_EXTENSIONLESS_FILENAMES);
});
afterEach(() => {
  setExtensionlessAllowlist(SEEDED_EXTENSIONLESS_FILENAMES);
});

describe("isPathLike", () => {
  it.each([
    ["/abs/path.md", true],
    ["/usr/local/bin/foo", false], // Round 8 Phase LL — no ext, "foo" not allowlisted
    ["/usr/local/bin/foo.bin", true],
    ["~/notes.md", true],
    ["~/dev/x/y.ts", true],
    ["./rel.ts", true],
    ["../sibling/file.tsx", true],
    ["pkg/sub/file.tsx", true],
    ["satellite/main/main.ts", true],
    ["foo.md", false], // bare filename — no slash, ambiguous
    ["foo", false],
    ["not/path", false], // slash but no extension and no anchor
    ["http://x.com/y", false],
    ["https://example.com/path/to/page.html", false],
    ["file:///etc/passwd", false],
    ["", false],
    [" ", false],
    ["just some words", false],
    // Round 8 Phase LL — files-only contract
    ["/v2/marketplace", false], // multi-segment abs, no ext, basename not allowlisted
    ["/v2/marketplace/orders", false],
    ["~/Downloads", false], // home-rooted, no ext, basename not allowlisted
    ["~/projects", false],
    ["foo/bar", false], // multi-segment, no ext, basename not allowlisted
    // Round 8 Phase LL — seeded allowlist members accept
    ["/etc/hosts", true], // basename "hosts" allowlisted
    ["/Users/me/code/Makefile", true],
    ["path/to/Makefile", true],
    ["path/to/Dockerfile", true],
    ["~/.bashrc", true],
    ["path/to/.env", true],
    ["path/to/.envrc", true],
    ["path/to/.gitignore", true],
  ])("classifies %j as %s", (input, expected) => {
    expect(isPathLike(input)).toBe(expected);
  });
});

describe("extensionless allowlist", () => {
  it("exports a seeded constant with the documented defaults", () => {
    const seeded = new Set(SEEDED_EXTENSIONLESS_FILENAMES);
    for (const expected of [
      "Makefile",
      "Dockerfile",
      "README",
      "LICENSE",
      "CHANGELOG",
      "hosts",
      "passwd",
      ".bashrc",
      ".zshrc",
      ".profile",
      ".vimrc",
      ".gitignore",
      ".gitconfig",
      ".env",
      ".envrc",
    ]) {
      expect(seeded.has(expected)).toBe(true);
    }
  });

  it("setExtensionlessAllowlist swaps the active set", () => {
    setExtensionlessAllowlist(new Set(["Procfile"]));
    expect(isPathLike("path/to/Procfile")).toBe(true);
    expect(isPathLike("path/to/Makefile")).toBe(false);
  });

  it("setExtensionlessAllowlist accepts any iterable", () => {
    setExtensionlessAllowlist(["Brewfile"]);
    expect(isPathLike("/etc/Brewfile")).toBe(true);
    expect(isPathLike("/etc/hosts")).toBe(false);
  });

  it("empty allowlist still accepts extensioned paths", () => {
    setExtensionlessAllowlist([]);
    expect(isPathLike("path/to/file.ts")).toBe(true);
    expect(isPathLike("path/to/Makefile")).toBe(false);
  });
});

describe("detectPathsInLine", () => {
  it("finds an absolute path at the start of a line", () => {
    const result = detectPathsInLine("/etc/hosts is the file");
    expect(result.length).toBeGreaterThanOrEqual(1);
    const first = result[0];
    expect(first.text).toBe("/etc/hosts");
    expect(first.start).toBe(0);
    expect(first.end).toBe(10);
  });

  it("finds a home-relative path", () => {
    const result = detectPathsInLine("see ~/notes.md please");
    expect(result.length).toBe(1);
    expect(result[0].text).toBe("~/notes.md");
    expect(result[0].start).toBe(4);
    expect(result[0].end).toBe(14);
  });

  it("finds a ./ relative path with extension", () => {
    const result = detectPathsInLine("at ./src/foo.ts");
    expect(result.length).toBe(1);
    expect(result[0].text).toBe("./src/foo.ts");
  });

  it("finds a ../ relative path", () => {
    const result = detectPathsInLine("error in ../sibling/file.tsx line 42");
    expect(result.length).toBe(1);
    expect(result[0].text).toBe("../sibling/file.tsx");
  });

  it("finds a multi-segment relative path with extension", () => {
    const result = detectPathsInLine("see satellite/main/main.ts:135 for context");
    expect(result.length).toBe(1);
    expect(result[0].text).toBe("satellite/main/main.ts");
  });

  it("finds multiple paths in a single line", () => {
    const result = detectPathsInLine(
      "moved /a/b.md to ./c/d.md (was ~/old.txt)",
    );
    const texts = result.map((m) => m.text);
    expect(texts).toContain("/a/b.md");
    expect(texts).toContain("./c/d.md");
    expect(texts).toContain("~/old.txt");
  });

  it("does NOT match the path-like fragment inside an http(s) URL", () => {
    const result = detectPathsInLine("Open https://example.com/path/page.html now");
    // The full URL should be ignored, not its trailing fragment.
    for (const match of result) {
      expect(match.text.startsWith("/path")).toBe(false);
      expect(match.text).not.toContain("example.com");
    }
  });

  it("does NOT match a path embedded inside a file:// URL", () => {
    const result = detectPathsInLine("open file:///etc/passwd in browser");
    for (const match of result) {
      expect(match.text).not.toContain("/etc/passwd");
    }
  });

  it("does NOT match bare words or sentence text", () => {
    expect(detectPathsInLine("This is a sentence with no paths.")).toEqual([]);
    expect(detectPathsInLine("foo bar baz")).toEqual([]);
    expect(detectPathsInLine("")).toEqual([]);
  });

  it("does NOT match a slash-pair without an extension (too ambiguous)", () => {
    const result = detectPathsInLine("not/path is ambiguous");
    expect(result.find((m) => m.text === "not/path")).toBeUndefined();
  });

  it("strips trailing punctuation that isn't part of the path", () => {
    const result = detectPathsInLine("See ./foo.md, and also ./bar.ts.");
    expect(result.find((m) => m.text === "./foo.md")).toBeTruthy();
    expect(result.find((m) => m.text === "./bar.ts")).toBeTruthy();
  });

  it("captures column positions correctly with leading whitespace", () => {
    const result = detectPathsInLine("    /a.md");
    expect(result[0].start).toBe(4);
    expect(result[0].end).toBe(9);
  });

  it("recognises a wide range of common code extensions", () => {
    const inputs = [
      "x/y.js",
      "x/y.jsx",
      "x/y.ts",
      "x/y.tsx",
      "x/y.go",
      "x/y.py",
      "x/y.rs",
      "x/y.md",
      "x/y.json",
      "x/y.yaml",
      "x/y.css",
      "x/y.html",
    ];
    for (const path of inputs) {
      const result = detectPathsInLine(`see ${path} now`);
      expect(result.find((m) => m.text === path)).toBeTruthy();
    }
  });

  it("captures paths surrounded by quotes without including the quote chars", () => {
    const result = detectPathsInLine('look at "./x/y.ts" please');
    expect(result.find((m) => m.text === "./x/y.ts")).toBeTruthy();
  });

  // Phase 6 of the linkifier-followups plan: bare filenames with
  // recognised extensions are detected even without a path anchor. The
  // activate handler is responsible for prepending the pane's cwd (so
  // the file viewer's allowlist + create-mode handle missing files).
  describe("bare filenames with allow-listed extensions", () => {
    it("detects CLAUDE.md mentioned bare in a line", () => {
      const result = detectPathsInLine("update CLAUDE.md with the new flow");
      expect(result.find((m) => m.text === "CLAUDE.md")).toBeTruthy();
    });

    it("detects multiple bare filenames in one line", () => {
      const result = detectPathsInLine("see README.md and CHANGELOG.md");
      const texts = result.map((m) => m.text);
      expect(texts).toContain("README.md");
      expect(texts).toContain("CHANGELOG.md");
    });

    it("ignores bare names with un-allowed extensions", () => {
      const result = detectPathsInLine("see picture.unrecognized in folder");
      expect(result.find((m) => m.text === "picture.unrecognized")).toBeFalsy();
    });

    it("ignores word-boundary noise like e.g. and i.e.", () => {
      const result = detectPathsInLine("see e.g. or i.e. somewhere");
      expect(result.find((m) => m.text === "e.g")).toBeFalsy();
      expect(result.find((m) => m.text === "i.e")).toBeFalsy();
    });

    it("includes typescript, python, go, yaml bare filenames", () => {
      const cases = [
        "edit main.ts to fix it",
        "load config.yaml first",
        "see script.py output",
        "main.go has the wiring",
      ];
      for (const line of cases) {
        const result = detectPathsInLine(line);
        const hit = result[0];
        expect(hit).toBeTruthy();
      }
    });

    it("detects bare filenames that start with a digit", () => {
      const cases = [
        ["check 2-config.toml for settings", "2-config.toml"],
        ["see 404.html for the error page", "404.html"],
        ["open 3_setup.py to configure", "3_setup.py"],
      ];
      for (const [line, expected] of cases) {
        const result = detectPathsInLine(line);
        expect(result.find((m) => m.text === expected)).toBeTruthy();
      }
    });

    it("does NOT match bare names that contain a slash (those go through the anchored path)", () => {
      // The anchored-path branch picks these up; the bare branch shouldn't
      // double-emit the trailing leaf.
      const result = detectPathsInLine("see satellite/main/main.ts here");
      const counts: Record<string, number> = {};
      for (const m of result) counts[m.text] = (counts[m.text] ?? 0) + 1;
      expect(counts["satellite/main/main.ts"]).toBe(1);
      expect(counts["main.ts"]).toBeUndefined();
    });
  });

  // defect 1: a path whose FIRST segment is a dot-folder
  // (.claude/settings.json) was detected WITHOUT its leading dot — the
  // anchored alternative only fires on `~/ ./ ../ /`, and the sub-dir
  // alternative starts on a word char, so the match began at `c` and
  // the click resolved a non-existent `claude/` directory.
  describe("leading dot-folder paths", () => {
    it("detects .claude/settings.json WITH the leading dot", () => {
      const result = detectPathsInLine("open .claude/settings.json to edit hooks");
      const hit = result.find((m) => m.text === ".claude/settings.json");
      expect(hit).toBeTruthy();
      expect(hit!.start).toBe(5);
      // The dot-stripped form must NOT be emitted (that's the bug).
      expect(result.find((m) => m.text === "claude/settings.json")).toBeFalsy();
    });

    it("detects a deeper dot-folder path (.github/workflows/ci.yml)", () => {
      const result = detectPathsInLine("edit .github/workflows/ci.yml next");
      expect(
        result.find((m) => m.text === ".github/workflows/ci.yml"),
      ).toBeTruthy();
    });

    it("detects a dot-folder path at line start", () => {
      const result = detectPathsInLine(".vscode/launch.json drives the debugger");
      const hit = result.find((m) => m.text === ".vscode/launch.json");
      expect(hit).toBeTruthy();
      expect(hit!.start).toBe(0);
    });

    it("still detects mid-path dot-folders unchanged (regression guard)", () => {
      const result = detectPathsInLine("see project/.claude/settings.json here");
      expect(
        result.find((m) => m.text === "project/.claude/settings.json"),
      ).toBeTruthy();
    });

    it("still detects ./-anchored dot-folders unchanged (regression guard)", () => {
      const result = detectPathsInLine("at ./.claude/x.json and ../y.md");
      expect(result.find((m) => m.text === "./.claude/x.json")).toBeTruthy();
      expect(result.find((m) => m.text === "../y.md")).toBeTruthy();
    });

    it("does NOT treat sentence ellipsis as a dot-folder anchor", () => {
      const result = detectPathsInLine("loading...done/finished.md elsewhere");
      expect(result.find((m) => m.text === ".done/finished.md")).toBeFalsy();
    });

    it("does NOT treat a sentence dot glued to the next word as a dot-folder", () => {
      const result = detectPathsInLine("ends here.Then/next.md continues");
      expect(result.find((m) => m.text === ".Then/next.md")).toBeFalsy();
    });
  });

  // defect 2: bare dotfiles (.env, .gitignore) were never
  // detected — the bare-filename pass's first char class excludes `.`
  // and its lookbehind rejects a preceding dot. Detection is keyed off
  // the extensionless allowlist so Preferences edits steer this pass
  // exactly like isPathLike's files-only contract.
  describe("bare dotfiles from the extensionless allowlist", () => {
    it("detects .env mentioned bare in a line", () => {
      const result = detectPathsInLine("copy .env before running");
      const hit = result.find((m) => m.text === ".env");
      expect(hit).toBeTruthy();
      expect(hit!.start).toBe(5);
    });

    it("detects .gitignore and .zshrc in one line", () => {
      const result = detectPathsInLine("update .gitignore and .zshrc together");
      const texts = result.map((m) => m.text);
      expect(texts).toContain(".gitignore");
      expect(texts).toContain(".zshrc");
    });

    it("strips a sentence dot after the dotfile", () => {
      const result = detectPathsInLine("now copy .env.");
      expect(result.find((m) => m.text === ".env")).toBeTruthy();
    });

    it("ignores dot-words NOT in the allowlist", () => {
      const result = detectPathsInLine("the .foo and .barbaz tokens stay plain");
      expect(result).toEqual([]);
    });

    it("does NOT emit a prefix match for longer dotfile-ish tokens", () => {
      // `.env.local` is one token; it is not in the allowlist, so no
      // match — emitting `.env` for it would link the wrong file.
      const result = detectPathsInLine("see .env.local for overrides");
      expect(result).toEqual([]);
    });

    it("does NOT double-emit the leaf of an anchored dotfile path", () => {
      const result = detectPathsInLine("see path/to/.env here");
      const counts: Record<string, number> = {};
      for (const m of result) counts[m.text] = (counts[m.text] ?? 0) + 1;
      expect(counts["path/to/.env"]).toBe(1);
      expect(counts[".env"]).toBeUndefined();
    });

    it("does NOT match through an ellipsis", () => {
      expect(detectPathsInLine("wait...env is not a file")).toEqual([]);
    });

    it("respects a runtime allowlist override", () => {
      setExtensionlessAllowlist([".secrets"]);
      const result = detectPathsInLine("read .secrets but not .env now");
      expect(result.find((m) => m.text === ".secrets")).toBeTruthy();
      expect(result.find((m) => m.text === ".env")).toBeFalsy();
    });
  });
});
