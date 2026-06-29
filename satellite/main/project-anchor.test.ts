// unit tests for deriveProjectAnchor.
//
// The anchor is the lexical "project root" recoverable from a resolved
// path when the renderer didn't thread projectCwd. Pure string logic —
// existence filtering stays the caller's job (composeSuffixSearchRoots
// stat-checks; rootRelativeCandidate's join is verified with pathExists).

import { describe, it, expect } from "vitest";
import { deriveProjectAnchor } from "./project-anchor";

const MOUNT = "/Users/me/reck/projects";

describe("deriveProjectAnchor", () => {
  it("path under the mount → mount + first segment", () => {
    expect(
      deriveProjectAnchor(
        `${MOUNT}/TotoScopeBeta/.claude/plans/frontend/next-env.d.ts`,
        { roots: [MOUNT], mountPoint: MOUNT },
      ),
    ).toBe(`${MOUNT}/TotoScopeBeta`);
  });

  it("path one level under the mount → that entry itself", () => {
    expect(
      deriveProjectAnchor(`${MOUNT}/TotoScopeBeta`, {
        roots: [MOUNT],
        mountPoint: MOUNT,
      }),
    ).toBe(`${MOUNT}/TotoScopeBeta`);
  });

  it("path equal to the mount → null (no project segment)", () => {
    expect(
      deriveProjectAnchor(MOUNT, { roots: [MOUNT], mountPoint: MOUNT }),
    ).toBeNull();
  });

  it("path under a non-mount root → that root", () => {
    expect(
      deriveProjectAnchor("/Users/me/dev/proj/sub/file.ts", {
        roots: ["/Users/me/dev/proj", MOUNT],
        mountPoint: MOUNT,
      }),
    ).toBe("/Users/me/dev/proj");
  });

  it("nested roots → the most specific (longest) containing root", () => {
    expect(
      deriveProjectAnchor("/Users/me/dev/proj/packages/app/x.ts", {
        roots: ["/Users/me/dev", "/Users/me/dev/proj/packages/app", MOUNT],
        mountPoint: MOUNT,
      }),
    ).toBe("/Users/me/dev/proj/packages/app");
  });

  it("path outside every root → null", () => {
    expect(
      deriveProjectAnchor("/etc/passwd", {
        roots: ["/Users/me/dev/proj", MOUNT],
        mountPoint: MOUNT,
      }),
    ).toBeNull();
  });

  it("segment-strict prefixes: /a/bc is not under root /a/b", () => {
    expect(
      deriveProjectAnchor("/Users/me/dev/projector/x.ts", {
        roots: ["/Users/me/dev/proj", MOUNT],
        mountPoint: MOUNT,
      }),
    ).toBeNull();
    expect(
      deriveProjectAnchor(`${MOUNT}extra/Foo/x.ts`, {
        roots: [MOUNT],
        mountPoint: MOUNT,
      }),
    ).toBeNull();
  });

  it("tolerates trailing slashes on mount and roots", () => {
    expect(
      deriveProjectAnchor(`${MOUNT}/Foo/bar/baz.md`, {
        roots: [`${MOUNT}/`],
        mountPoint: `${MOUNT}/`,
      }),
    ).toBe(`${MOUNT}/Foo`);
  });

  it("mount wins over a root that IS the mount (no double-derivation)", () => {
    // The mount appears in roots in production; the project segment
    // must still be appended rather than returning the bare mount.
    expect(
      deriveProjectAnchor(`${MOUNT}/Foo/docs/x.md`, {
        roots: [MOUNT, "/Users/me/dev/proj"],
        mountPoint: MOUNT,
      }),
    ).toBe(`${MOUNT}/Foo`);
  });

  it("empty/relative input → null", () => {
    expect(
      deriveProjectAnchor("", { roots: [MOUNT], mountPoint: MOUNT }),
    ).toBeNull();
    expect(
      deriveProjectAnchor("relative/path.md", {
        roots: [MOUNT],
        mountPoint: MOUNT,
      }),
    ).toBeNull();
  });
});
