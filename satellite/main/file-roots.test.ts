import { describe, it, expect } from "vitest";
import { composeFileViewerRoots } from "./file-roots";

describe("composeFileViewerRoots", () => {
  const builtIns = ["/Users/me/reck/projects", "/Users/me", "/tmp"];

  it("returns the built-ins when no extras are persisted", () => {
    expect(composeFileViewerRoots(builtIns, undefined)).toEqual(builtIns);
    expect(composeFileViewerRoots(builtIns, null)).toEqual(builtIns);
    expect(composeFileViewerRoots(builtIns, [])).toEqual(builtIns);
  });

  it("appends valid extras to the built-ins", () => {
    expect(
      composeFileViewerRoots(builtIns, ["/Volumes/External", "/opt/work"]),
    ).toEqual([...builtIns, "/Volumes/External", "/opt/work"]);
  });

  it("silently drops non-string entries", () => {
    expect(
      composeFileViewerRoots(builtIns, [
        "/Volumes/External",
        42 as unknown as string,
        null as unknown as string,
      ]),
    ).toEqual([...builtIns, "/Volumes/External"]);
  });

  it("silently drops empty strings", () => {
    expect(
      composeFileViewerRoots(builtIns, ["", "/work"]),
    ).toEqual([...builtIns, "/work"]);
  });

  it("silently drops non-absolute paths", () => {
    expect(
      composeFileViewerRoots(builtIns, ["relative/path", "~/dev", "/abs"]),
    ).toEqual([...builtIns, "/abs"]);
  });

  it("de-duplicates an extra that equals a built-in", () => {
    expect(composeFileViewerRoots(builtIns, ["/tmp", "/work"])).toEqual([
      ...builtIns,
      "/work",
    ]);
  });

  it("de-duplicates duplicate extras", () => {
    expect(
      composeFileViewerRoots(builtIns, ["/work", "/work", "/work2"]),
    ).toEqual([...builtIns, "/work", "/work2"]);
  });

  it("treats a non-array `extras` value defensively", () => {
    expect(
      composeFileViewerRoots(builtIns, "not-an-array" as unknown as string[]),
    ).toEqual(builtIns);
    expect(
      composeFileViewerRoots(builtIns, { length: 2 } as unknown as string[]),
    ).toEqual(builtIns);
  });
});
