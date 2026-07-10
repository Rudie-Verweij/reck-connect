import { describe, it, expect } from "vitest";
import { normalizeProjectCwd, translateStationCwdToMount } from "./project-cwd";

const MOUNT = "/Users/me/reck/projects";
const STATION = "/home/pi/projects";

describe("normalizeProjectCwd", () => {
  const opts = { mountPoint: MOUNT, stationRoot: STATION };

  it("station-form cwd → both forms", () => {
    expect(normalizeProjectCwd(`${STATION}/obsidian-brain`, opts)).toEqual({
      station: `${STATION}/obsidian-brain`,
      local: `${MOUNT}/obsidian-brain`,
    });
  });

  it("mount-form cwd → both forms", () => {
    expect(normalizeProjectCwd(`${MOUNT}/obsidian-brain`, opts)).toEqual({
      local: `${MOUNT}/obsidian-brain`,
      station: `${STATION}/obsidian-brain`,
    });
  });

  it("Mac-local (non-mount, non-station) cwd → local only", () => {
    expect(normalizeProjectCwd("/Users/me/dev/proj", opts)).toEqual({
      local: "/Users/me/dev/proj",
    });
  });

  it("relative / empty / undefined → {}", () => {
    expect(normalizeProjectCwd("proj/dir", opts)).toEqual({});
    expect(normalizeProjectCwd("", opts)).toEqual({});
    expect(normalizeProjectCwd(undefined, opts)).toEqual({});
    expect(normalizeProjectCwd(null, opts)).toEqual({});
  });

  it("tolerates trailing slashes on the roots", () => {
    expect(
      normalizeProjectCwd(`${STATION}/p`, {
        mountPoint: MOUNT + "/",
        stationRoot: STATION + "//",
      }),
    ).toEqual({ station: `${STATION}/p`, local: `${MOUNT}/p` });
  });

  it("the station root ITSELF (projects dir, not a project) → station form only", () => {
    // translateStationCwdToMount refuses the bare root (suffix === "/").
    expect(normalizeProjectCwd(STATION, opts)).toEqual({
      station: STATION,
      local: undefined,
    });
  });

  it("the mount root ITSELF (projects dir, not a project) → no local form", () => {
    // `local` is a project-scoped anchor; handing out the bare mount
    // root would widen mirror/suffix searches to EVERY mounted project.
    expect(normalizeProjectCwd(MOUNT, opts)).toEqual({
      local: undefined,
      station: STATION,
    });
  });

  it("null stationRoot: mount-form → local only; station-form treated as Mac-local", () => {
    const noStation = { mountPoint: MOUNT, stationRoot: null };
    expect(normalizeProjectCwd(`${MOUNT}/p`, noStation)).toEqual({
      local: `${MOUNT}/p`,
      station: undefined,
    });
    // Without a stationRoot the Pi form isn't recognizable — falls to
    // the Mac-local branch (harmless: pathExists gates use downstream).
    expect(normalizeProjectCwd(`${STATION}/p`, noStation)).toEqual({
      local: `${STATION}/p`,
    });
  });

  it("prefix guard: station-root lookalike dir does not match", () => {
    expect(normalizeProjectCwd(`${STATION}-evil/p`, opts)).toEqual({
      local: `${STATION}-evil/p`,
    });
  });
});

describe("translateStationCwdToMount (relocated)", () => {
  it("translates a station project path to its mount mirror", () => {
    expect(translateStationCwdToMount(`${STATION}/p`, MOUNT, STATION)).toBe(
      `${MOUNT}/p`,
    );
  });
  it("refuses the bare root and non-station paths", () => {
    expect(translateStationCwdToMount(STATION, MOUNT, STATION)).toBeNull();
    expect(translateStationCwdToMount("/etc/passwd", MOUNT, STATION)).toBeNull();
  });
});
