// Project-cwd form normalization for the file-viewer pipeline.
//
// A `projectCwd` threaded through openInViewer / popup URLs arrives in
// whichever form the click's surface knew: Pi form (station panes send
// `/home/<user>/projects/<id>`) or Mac mount-mirror form
// (`<mount>/<id>`). The 2026-07-10 obsidian-brain field failure: a
// cascaded popup click forwarded a Pi-form cwd WITHOUT
// `sourceHost:"station"`, so the handler's flag-gated translation
// skipped it, the truthy-but-Mac-nonexistent path shadowed the
// deriveProjectAnchor fallback, and every rescue (root-relative retry,
// anchored stat, suffix-search roots) collapsed to the popup file's own
// folder. Normalize by FORM — which root prefix the path is under — not
// by flag, so callers can trust both forms regardless of who sent them.

import { translateMountToStationPath } from "./station-ssh";

/**
 * Pi-path → Mac mount-mirror translator (Round 8 Phase NN; relocated
 * here from file-viewer.ts so form normalization owns both directions).
 * Pure mirror of `translateStationCwd` from renderer/src/project-push.ts
 * (kept in main so main doesn't reach into renderer modules). Returns
 * null when the Pi path isn't under the station's managed root (e.g.
 * paths under `~/.claude/`).
 */
export function translateStationCwdToMount(
  stationCwd: string,
  localMount: string,
  stationRoot: string,
): string | null {
  if (!stationCwd || !localMount || !stationRoot) return null;
  const root = stationRoot.replace(/\/+$/, "");
  const mount = localMount.replace(/\/+$/, "");
  if (!stationCwd.startsWith(root)) return null;
  const suffix = stationCwd.slice(root.length);
  if (!suffix.startsWith("/")) return null;
  if (suffix === "/") return null;
  return mount + suffix;
}

/** Both forms of a project cwd; either may be absent when untranslatable. */
export interface ProjectCwdForms {
  /** Mac-side form: mount-mirror path for station projects, or the raw
   *  path for Mac-local projects. Usable for local fs stats/search. */
  local?: string;
  /** Pi-side form, when the cwd maps under the station root. Usable for
   *  station-remote anchoring (expandTildeForHost, SSH search). */
  station?: string;
}

export interface NormalizeProjectCwdOpts {
  /** The sshfs/NFS mount-mirror root on the Mac. */
  mountPoint: string;
  /** The station's managed projects root (Pi side); null when not configured. */
  stationRoot: string | null;
}

/**
 * Classify `raw` by which root prefix it sits under and return both forms.
 *
 *   - under `stationRoot` → `{station: raw, local: <mount mirror>}`
 *   - under `mountPoint`  → `{local: raw, station: <Pi form>}`
 *   - other absolute path → `{local: raw}` (a Mac-local project)
 *   - relative / empty    → `{}`
 *
 * A BARE root (the projects dir itself, not a project inside it) never
 * yields a `local` form: `local` is consumed as a project-scoped anchor
 * (mirror search, suffix-search roots, root-relative retry), and the
 * bare mount root would widen those from one project to EVERY mounted
 * project. The station branch inherits this from
 * translateStationCwdToMount's bare-root refusal; the mount branch
 * enforces it explicitly.
 */
export function normalizeProjectCwd(
  raw: string | null | undefined,
  opts: NormalizeProjectCwdOpts,
): ProjectCwdForms {
  if (!raw || !raw.startsWith("/")) return {};
  const mount = opts.mountPoint.replace(/\/+$/, "");
  const root = opts.stationRoot?.replace(/\/+$/, "") ?? null;
  if (root && (raw === root || raw.startsWith(root + "/"))) {
    return {
      station: raw,
      local: translateStationCwdToMount(raw, mount, root) ?? undefined,
    };
  }
  if (mount && (raw === mount || raw.startsWith(mount + "/"))) {
    return {
      local: raw === mount ? undefined : raw,
      station: root ? translateMountToStationPath(raw, mount, root) : undefined,
    };
  }
  return { local: raw };
}
