import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveInsideAllowedRoots } from "./file-allowlist";

describe("resolveInsideAllowedRoots", () => {
  let tmpRoot: string;
  let allowed1: string;
  let allowed2: string;
  let outside: string;
  let escapingSymlink: string;
  let internalSymlink: string;
  let leafInside: string;
  let nestedLeaf: string;

  beforeAll(() => {
    // Build an on-disk fixture so realpath-based checks are exercised
    // against actual symlinks, not just string normalisation.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reck-allowlist-"));
    allowed1 = path.join(tmpRoot, "root-a");
    allowed2 = path.join(tmpRoot, "root-b");
    outside = path.join(tmpRoot, "outside");
    fs.mkdirSync(allowed1, { recursive: true });
    fs.mkdirSync(allowed2, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    leafInside = path.join(allowed1, "notes.md");
    fs.writeFileSync(leafInside, "hello");

    const nestedDir = path.join(allowed2, "sub", "deeper");
    fs.mkdirSync(nestedDir, { recursive: true });
    nestedLeaf = path.join(nestedDir, "file.ts");
    fs.writeFileSync(nestedLeaf, "ok");

    // A symlink at `root-a/evil` pointing OUTSIDE the root. A naive
    // string-relative check would accept it; realpath catches the escape.
    escapingSymlink = path.join(allowed1, "evil");
    fs.symlinkSync(outside, escapingSymlink);

    // A symlink that stays inside the same root — must be allowed.
    internalSymlink = path.join(allowed1, "ok-link");
    fs.symlinkSync(leafInside, internalSymlink);
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("happy paths", () => {
    it("accepts a file directly inside a single root", () => {
      expect(resolveInsideAllowedRoots([allowed1], leafInside)).toBe(
        fs.realpathSync(leafInside),
      );
    });

    it("accepts a deeply nested file inside a root", () => {
      expect(resolveInsideAllowedRoots([allowed2], nestedLeaf)).toBe(
        fs.realpathSync(nestedLeaf),
      );
    });

    it("accepts a target inside any of multiple roots", () => {
      expect(resolveInsideAllowedRoots([outside, allowed1], leafInside)).toBe(
        fs.realpathSync(leafInside),
      );
      expect(resolveInsideAllowedRoots([allowed1, allowed2], nestedLeaf)).toBe(
        fs.realpathSync(nestedLeaf),
      );
    });

    it("follows internal symlinks (target inside same root)", () => {
      expect(resolveInsideAllowedRoots([allowed1], internalSymlink)).toBe(
        fs.realpathSync(internalSymlink),
      );
    });

    it("accepts a path that does not yet exist if its parent dir is inside a root", () => {
      // Required for the 'intended path' / create-on-click flow: the target
      // file may not exist, but the parent dir does and is inside an allowed
      // root. Returning the canonical absolute target lets the caller decide
      // whether to create it.
      const intended = path.join(allowed1, "subdir-not-existing", "new.md");
      const result = resolveInsideAllowedRoots([allowed1], intended);
      expect(result).not.toBeNull();
      expect(result!.startsWith(fs.realpathSync(allowed1))).toBe(true);
    });

    it("normalises trailing slashes on roots", () => {
      expect(
        resolveInsideAllowedRoots([`${allowed1}/`], leafInside),
      ).toBe(fs.realpathSync(leafInside));
    });
  });

  describe("rejections", () => {
    it("rejects a target outside all roots", () => {
      const outsideFile = path.join(outside, "secret.txt");
      fs.writeFileSync(outsideFile, "no");
      expect(resolveInsideAllowedRoots([allowed1, allowed2], outsideFile)).toBeNull();
    });

    it("rejects a symlink that escapes the root via realpath", () => {
      // Critical: a string-based path.relative check would treat this as
      // inside the root. Only realpath catches the escape.
      const inside = path.join(escapingSymlink, "anything.txt");
      expect(resolveInsideAllowedRoots([allowed1], inside)).toBeNull();
    });

    it("rejects empty target", () => {
      expect(resolveInsideAllowedRoots([allowed1], "")).toBeNull();
    });

    it("rejects relative target (must be absolute)", () => {
      expect(resolveInsideAllowedRoots([allowed1], "notes.md")).toBeNull();
      expect(resolveInsideAllowedRoots([allowed1], "./notes.md")).toBeNull();
    });

    it("rejects target containing NUL", () => {
      expect(
        resolveInsideAllowedRoots([allowed1], `${leafInside}\0.evil`),
      ).toBeNull();
    });

    it("rejects an empty roots list", () => {
      expect(resolveInsideAllowedRoots([], leafInside)).toBeNull();
    });

    it("rejects target equal to a root (must point at something inside, not at the root itself)", () => {
      expect(resolveInsideAllowedRoots([allowed1], allowed1)).toBeNull();
    });

    it("rejects non-string target", () => {
      // @ts-expect-error — purposeful runtime type abuse
      expect(resolveInsideAllowedRoots([allowed1], 42)).toBeNull();
      // @ts-expect-error — purposeful runtime type abuse
      expect(resolveInsideAllowedRoots([allowed1], null)).toBeNull();
    });

    it("rejects a target whose entire ancestry is outside the allowed roots", () => {
      // Even though /var and /etc exist, neither lives under `allowed1`, so
      // the resolved canonical path is not contained.
      expect(resolveInsideAllowedRoots([allowed1], "/etc/passwd")).toBeNull();
      expect(resolveInsideAllowedRoots([allowed1], "/var/log/syslog")).toBeNull();
    });

    it("accepts deep targets under an allowed root even if intermediates don't exist", () => {
      // The validator's job is the security boundary, not policy on whether
      // to mkdir-p. The `file:create` handler decides whether to create
      // intermediates; the validator just confirms the resolved path is
      // inside an allowed root.
      const deep = path.join(allowed1, "ghosts", "nowhere", "x.md");
      const result = resolveInsideAllowedRoots([allowed1], deep);
      expect(result).not.toBeNull();
      expect(result!.startsWith(fs.realpathSync(allowed1))).toBe(true);
    });

    it("rejects when an existing intermediate is a symlink escaping the root", () => {
      // Subtle: leaf doesn't exist, but its parent is a symlink that points
      // outside the root. Walking up to the existing ancestor and realpathing
      // it catches the escape.
      const escape = path.join(escapingSymlink, "passwd");
      expect(resolveInsideAllowedRoots([allowed1], escape)).toBeNull();
    });
  });
});
