// Round 4 Phase Q — boot's onActivate click handler resolves a
// link-text path into an absolute target before handing it to
// reckAPI.files.openInViewer.
//
// History:
//   - Phase 6 of linkifier-followups: bare filenames (e.g. `CLAUDE.md`)
//     get the active project's cwd prepended so the viewer's
//     allowlist + create-mode handle existence.
//   - Round 4 Q: `./CLAUDE.md` and `./services/whisper-worker/CLAUDE.md`
//     were treated as "already anchored" by isAnchoredPath, so they
//     skipped the projectCwd prepend and reached
//     isStationPathSafe / resolveInsideAllowedRoots as relative paths
//     (which fail). Resolve them against the same projectCwd that
//     bare filenames use.
//
// The fix is intentionally NOT loosening isStationPathSafe — that
// validator legitimately can't accept relative paths because it has
// no context for what they're relative to. The right place to add
// context is here, upstream of the IPC call, where we know the
// project cwd that the click originated from.

/**
 * Resolve `filePath` (as it appears in terminal scrollback) against
 * `projectCwd` (the cwd of the pane the click originated from).
 *
 * Returns the absolute path to pass to openInViewer, or the original
 * input unchanged for absolute (`/abs`) and home-anchored (`~/foo`)
 * forms — those already know what they're relative to.
 *
 * The normalization collapses `./` and `../` segments so the resolved
 * target stays a clean POSIX path. `resolveInsideAllowedRoots` /
 * `isStationPathSafe` will then reject anything that escapes the
 * intended root.
 */
export function resolveActivatePath(
  filePath: string,
  projectCwd: string | null,
): string {
  if (filePath.startsWith("/") || filePath.startsWith("~/") || filePath === "~") {
    return filePath;
  }
  if (!projectCwd) return filePath;
  const base = projectCwd.replace(/\/+$/, "");
  if (filePath.startsWith("./") || filePath.startsWith("../")) {
    return normalizePosix(base + "/" + filePath);
  }
  // Bare filename or relative without anchor — same prepend as the
  // existing Phase 6 behaviour.
  return base + "/" + filePath;
}

/**
 * Pure POSIX path normalizer. Collapses `./` and `../` segments,
 * dedup'd slashes, preserves leading slash. Returns "/" for inputs
 * that collapse to empty. Not a full path.posix.normalize replacement,
 * but covers the cases that surface from terminal-scrollback clicks.
 */
function normalizePosix(p: string): string {
  const isAbs = p.startsWith("/");
  const segs = p.split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbs) {
        out.push("..");
      }
      // Absolute path with `..` at root drops it silently — same as
      // `path.posix.normalize` would do.
      continue;
    }
    out.push(s);
  }
  const joined = out.join("/");
  return isAbs ? "/" + joined : joined || ".";
}
