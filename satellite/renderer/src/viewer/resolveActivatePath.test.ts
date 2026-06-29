// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { resolveActivatePath } from "./resolveActivatePath";

describe("resolveActivatePath (Round 4 Phase Q)", () => {
  const cwd = "/Users/mehdi/projects/MyProject";

  it("absolute path passes through unchanged", () => {
    expect(resolveActivatePath("/etc/hosts", cwd)).toBe("/etc/hosts");
  });

  it("home-anchored path passes through unchanged", () => {
    expect(resolveActivatePath("~/notes.md", cwd)).toBe("~/notes.md");
    expect(resolveActivatePath("~", cwd)).toBe("~");
  });

  it("bare filename prepends projectCwd (Phase 6 behavior)", () => {
    expect(resolveActivatePath("CLAUDE.md", cwd)).toBe(
      "/Users/mehdi/projects/MyProject/CLAUDE.md",
    );
  });

  it("./X resolves against projectCwd (Phase Q fix)", () => {
    expect(resolveActivatePath("./CLAUDE.md", cwd)).toBe(
      "/Users/mehdi/projects/MyProject/CLAUDE.md",
    );
  });

  it("./nested/file.md resolves against projectCwd", () => {
    expect(resolveActivatePath("./services/whisper-worker/CLAUDE.md", cwd)).toBe(
      "/Users/mehdi/projects/MyProject/services/whisper-worker/CLAUDE.md",
    );
  });

  it("../X resolves above projectCwd", () => {
    expect(resolveActivatePath("../OtherProj/README.md", cwd)).toBe(
      "/Users/mehdi/projects/OtherProj/README.md",
    );
  });

  it("returns input unchanged when projectCwd is null and path is relative", () => {
    expect(resolveActivatePath("./CLAUDE.md", null)).toBe("./CLAUDE.md");
    expect(resolveActivatePath("CLAUDE.md", null)).toBe("CLAUDE.md");
  });

  it("collapses redundant slashes and `.` segments after prepend", () => {
    expect(resolveActivatePath("./a/./b/c.md", cwd)).toBe(
      "/Users/mehdi/projects/MyProject/a/b/c.md",
    );
  });

  it("collapses `..` segments after prepend", () => {
    expect(resolveActivatePath("./a/../b/c.md", cwd)).toBe(
      "/Users/mehdi/projects/MyProject/b/c.md",
    );
  });

  it("trailing slash on projectCwd does not produce a double slash", () => {
    expect(resolveActivatePath("./CLAUDE.md", "/Users/x/proj/")).toBe(
      "/Users/x/proj/CLAUDE.md",
    );
    expect(resolveActivatePath("./CLAUDE.md", "/Users/x/proj//")).toBe(
      "/Users/x/proj/CLAUDE.md",
    );
  });
});
