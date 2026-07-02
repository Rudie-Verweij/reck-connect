import { describe, it, expect, vi } from "vitest";

// `electron` is imported transitively by main wiring — defensive mock so
// the pure-helper imports below stay side-effect-free.
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn(),
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  app: { on: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

const {
  isStationPathSafe,
  parseStatOutput,
  buildRemoteTmpPath,
  buildCreateStationCmd,
  translateMountToStationPath,
} = await import("./station-ssh");

describe("isStationPathSafe", () => {
  it("accepts absolute paths under /home/<user>/", () => {
    expect(isStationPathSafe("/home/pi/.claude/foo.md")).toEqual({ ok: true });
    expect(isStationPathSafe("/home/pi/projects/x/y.ts")).toEqual({ ok: true });
  });

  it("rejects relative paths with a clear reason", () => {
    const a = isStationPathSafe("../etc/passwd");
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toMatch(/absolute POSIX path/i);
    const b = isStationPathSafe("foo.md");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toMatch(/absolute POSIX path/i);
  });

  it("rejects paths containing `..` segments with a clear reason", () => {
    const a = isStationPathSafe("/home/pi/../etc/passwd");
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toMatch(/'\.\.' segment/i);
    const b = isStationPathSafe("/home/pi/foo/../../etc");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toMatch(/'\.\.' segment/i);
  });

  it("rejects paths with shell metacharacters with the offending character in the reason", () => {
    const a = isStationPathSafe("/home/pi/foo;ls");
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.reason).toMatch(/forbidden character/i);
      expect(a.reason).toContain(";");
    }
    const cases: Array<[string, string]> = [
      ["/home/pi/$(rm -rf /)", "$"],
      ["/home/pi/foo`whoami`", "`"],
      ["/home/pi/foo|ls", "|"],
      ['/home/pi/foo"bar', '"'],
      ["/home/pi/foo'bar", "'"],
    ];
    for (const [input, char] of cases) {
      const res = isStationPathSafe(input);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toMatch(/forbidden character/i);
        expect(res.reason).toContain(char);
      }
    }
  });

  it("rejects empty / whitespace-only paths with a clear reason", () => {
    const a = isStationPathSafe("");
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toMatch(/empty/i);
    const b = isStationPathSafe("   ");
    expect(b.ok).toBe(false);
    if (!b.ok) {
      // The trim check matches before the absolute-path check so the
      // reason is about leading/trailing whitespace, not absoluteness.
      expect(b.reason).toMatch(/whitespace|empty/i);
    }
  });

  it("rejects paths with newlines or control characters", () => {
    const a = isStationPathSafe("/home/pi/foo\nbar");
    expect(a.ok).toBe(false);
    const b = isStationPathSafe("/home/pi/foo\x00bar");
    expect(b.ok).toBe(false);
  });

  it("rejects non-string inputs with a clear reason", () => {
    // @ts-expect-error testing runtime safety for callers passing non-strings
    const a = isStationPathSafe(null);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toMatch(/string/i);
  });
});

describe("parseStatOutput", () => {
  it("parses `<mtime-sec> <size> <mode>` from GNU stat --format='%Y %s %a'", () => {
    expect(parseStatOutput("1735776000 1234 644\n")).toEqual({
      mtimeMs: 1735776000_000,
      size: 1234,
      modeOctal: "644",
    });
  });

  it("still accepts the legacy 2-field `<mtime> <size>` for backwards compat", () => {
    // Older callers / station daemons might emit only two fields. The
    // parser returns modeOctal=null in that case rather than failing.
    expect(parseStatOutput("1735776000 1234\n")).toEqual({
      mtimeMs: 1735776000_000,
      size: 1234,
      modeOctal: null,
    });
  });

  it("returns null on malformed output", () => {
    expect(parseStatOutput("garbage")).toBeNull();
    expect(parseStatOutput("")).toBeNull();
    expect(parseStatOutput("abc def")).toBeNull();
  });

  it("trims trailing whitespace", () => {
    expect(parseStatOutput("100 50 644  \n")).toEqual({
      mtimeMs: 100_000,
      size: 50,
      modeOctal: "644",
    });
  });
});

// Round 5 Phase V — owner-writable derivation from POSIX mode bits.
describe("isOwnerWritable", () => {
  it("returns true when owner-write bit is set (mode 644)", async () => {
    const { isOwnerWritable } = await import("./station-ssh");
    expect(isOwnerWritable("644")).toBe(true);
  });
  it("returns false when owner has no write (mode 444)", async () => {
    const { isOwnerWritable } = await import("./station-ssh");
    expect(isOwnerWritable("444")).toBe(false);
  });
  it("returns true for mode 755 (owner rwx)", async () => {
    const { isOwnerWritable } = await import("./station-ssh");
    expect(isOwnerWritable("755")).toBe(true);
  });
  it("returns false for mode 000", async () => {
    const { isOwnerWritable } = await import("./station-ssh");
    expect(isOwnerWritable("000")).toBe(false);
  });
  it("returns true for 4-digit modes (with setuid prefix, mode 4755)", async () => {
    const { isOwnerWritable } = await import("./station-ssh");
    expect(isOwnerWritable("4755")).toBe(true);
  });
  it("returns false for null (no mode info available)", async () => {
    const { isOwnerWritable } = await import("./station-ssh");
    expect(isOwnerWritable(null)).toBe(false);
  });
});

// Round 4 Phase S — pure helper for the SSH-backed write path.
describe("buildRemoteTmpPath", () => {
  it("appends .reck-tmp-<uuid> to the target path", () => {
    expect(
      buildRemoteTmpPath("/home/pi/.claude/plans/foo.md", "abc-123"),
    ).toBe("/home/pi/.claude/plans/foo.md.reck-tmp-abc-123");
  });

  it("keeps the tmp on the same filesystem as the target (POSIX rename atomicity)", () => {
    // The tmp is a sibling of the target so rename(2) is atomic.
    const target = "/home/pi/.claude/plans/foo.md";
    const tmp = buildRemoteTmpPath(target, "deadbeef");
    const parentTarget = target.slice(0, target.lastIndexOf("/"));
    const parentTmp = tmp.slice(0, tmp.lastIndexOf("/"));
    expect(parentTmp).toBe(parentTarget);
  });
});

// Round 6 Phase DD2 — station-remote create flow. The remote command
// runs `mkdir -p <dir>` then `touch <path>`. Single-quoting protects
// against any path that slipped past isStationPathSafe (defence in
// depth — the validator already rejects shell metacharacters).
describe("buildCreateStationCmd", () => {
  it("builds `mkdir -p ... && touch ...` for a nested path", () => {
    const cmd = buildCreateStationCmd(
      "/home/pi/.claude/plans/new-plan.md",
    );
    expect(cmd).toContain(
      "mkdir -p '/home/pi/.claude/plans' && touch '/home/pi/.claude/plans/new-plan.md'",
    );
  });

  it("handles a top-level path (dir = /home/<user>)", () => {
    const cmd = buildCreateStationCmd("/home/pi/foo.md");
    expect(cmd).toContain("mkdir -p '/home/pi'");
    expect(cmd).toContain("touch '/home/pi/foo.md'");
  });

  it("single-quotes the path components to defang metacharacters", () => {
    // The command MUST single-quote both the dir and target paths.
    const cmd = buildCreateStationCmd(
      "/home/pi/projects/repo/file.txt",
    );
    expect(cmd.includes("'/home/pi/projects/repo'")).toBe(true);
    expect(cmd.includes("'/home/pi/projects/repo/file.txt'")).toBe(true);
  });
});

// Round 6 Phase DD1 — display path translation for the create banner.
// When a station-pane click resolves to a Mac mount-mirror path that
// doesn't exist, the create banner currently shows the /Users/... path;
// the user expects to see the /home/pi/... path because that's
// where the file actually lives. The translation is a string-replace:
// if `localPath` starts with `mountPoint`, swap the prefix for
// `stationRoot`; otherwise return the path unchanged.
describe("translateMountToStationPath", () => {
  const mountPoint = "/Users/me/reck/projects";
  const stationRoot = "/home/pi/projects";

  it("translates a mount-mirror path to the Pi path", () => {
    expect(
      translateMountToStationPath(
        "/Users/me/reck/projects/MyProject/foo.py",
        mountPoint,
        stationRoot,
      ),
    ).toBe("/home/pi/projects/MyProject/foo.py");
  });

  it("handles the mount-root itself (no extra path)", () => {
    expect(
      translateMountToStationPath(mountPoint, mountPoint, stationRoot),
    ).toBe(stationRoot);
  });

  it("returns the path unchanged when it's NOT under the mount", () => {
    expect(
      translateMountToStationPath(
        "/Users/me/other/place/x.py",
        mountPoint,
        stationRoot,
      ),
    ).toBe("/Users/me/other/place/x.py");
  });

  it("tolerates trailing slashes on the mount / station root", () => {
    expect(
      translateMountToStationPath(
        "/Users/me/reck/projects/x/y.ts",
        "/Users/me/reck/projects/",
        "/home/pi/projects/",
      ),
    ).toBe("/home/pi/projects/x/y.ts");
  });

  it("does NOT translate a path whose prefix is a sibling of the mount (no false positives)", () => {
    // `/Users/me/reck/projectsfoo/...` is NOT under `/Users/me/reck/projects`.
    expect(
      translateMountToStationPath(
        "/Users/me/reck/projectsfoo/bar.py",
        mountPoint,
        stationRoot,
      ),
    ).toBe("/Users/me/reck/projectsfoo/bar.py");
  });
});
