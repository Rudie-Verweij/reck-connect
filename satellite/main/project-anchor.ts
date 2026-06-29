// derive a project anchor from a resolved path.
//
// The whole popup rescue pipeline (root-relative retry, multi-root
// suffix search, anchored-stat fast path) was keyed on the renderer
// threading `projectCwd` through the popup URL. That value is nullable
// and silently absent on cascaded popup clicks — and when it's absent
// the search collapses to the popup file's own folder, guaranteeing
// "No matches" for anything outside it (the 2026-06-06 TotoScopeBeta
// field failure).
//
// But the resolved miss path itself almost always identifies the
// project: mount-mirror paths are `<mount>/<project>/…`, and local
// project paths sit under one of the allowed roots. This helper
// recovers that anchor lexically so the rescue pipeline keeps working
// without the threaded cwd.
//
// Pure string logic — no fs access. Existence is the caller's concern
// (composeSuffixSearchRoots stat-filters its roots; the root-relative
// retry verifies its candidate with pathExists).

export interface DeriveProjectAnchorOpts {
  /** Allowed roots (deps.roots()): the mount point plus any built-in /
   *  user-configured local roots. */
  roots: readonly string[];
  /** The sshfs/NFS mount-mirror root; projects are its direct children. */
  mountPoint: string;
}

const stripTrailingSlashes = (p: string): string => p.replace(/\/+$/, "");

const isUnder = (p: string, root: string): boolean =>
  p === root || p.startsWith(root + "/");

/**
 * Returns the anchor directory for `resolvedPath`, or null when none is
 * derivable:
 *   - under the mount point → `<mount>/<first segment>` (the project),
 *   - under another allowed root → the most specific such root,
 *   - equal to the mount, relative, or outside every root → null.
 */
export function deriveProjectAnchor(
  resolvedPath: string,
  opts: DeriveProjectAnchorOpts,
): string | null {
  if (!resolvedPath.startsWith("/")) return null;

  const mount = stripTrailingSlashes(opts.mountPoint);
  if (mount && isUnder(resolvedPath, mount)) {
    const firstSegment = resolvedPath.slice(mount.length + 1).split("/")[0];
    if (!firstSegment) return null; // resolvedPath === mount
    return `${mount}/${firstSegment}`;
  }

  // Most specific (longest) non-mount root containing the path. The
  // mount case above already handled mount-rooted paths, so a root
  // equal to the mount can't shadow the project segment here.
  let best: string | null = null;
  for (const raw of opts.roots) {
    const root = stripTrailingSlashes(raw);
    if (!root || root === mount) continue;
    if (!isUnder(resolvedPath, root)) continue;
    if (best === null || root.length > best.length) best = root;
  }
  return best;
}
