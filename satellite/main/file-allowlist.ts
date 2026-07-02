// Allowed-roots validator for the file-viewer feature.
//
// This is the security boundary for every `file:*` IPC channel. The renderer
// may ask main to read, write, watch, or resolve any absolute path; main
// must check that the path lives under one of the project-derived roots
// (the sshfs mount root plus each known project's cwd) before doing any I/O.
//
// The validator follows the same shape as `ipc-validation.ts`: it accepts
// untrusted input, performs the minimum work to canonicalise it, and returns
// the canonical absolute path on success or `null` on any rejection.
//
// Symlink safety: we `realpath` the deepest existing ancestor of the target
// (and each root) before comparison. A naive `path.relative` check would
// accept `<root>/escape -> /etc`; realpath catches the escape. When the
// target itself doesn't exist, we walk up to its first existing ancestor
// and realpath that, then append the remaining textual suffix. This is safe
// because non-existent path components cannot be symlinks.

import fs from "node:fs";
import path from "node:path";

export type AllowedRoot = string;

/**
 * Resolve `target` against `roots` and return the canonical absolute path
 * iff the resolved location lives strictly inside one of the roots.
 *
 * Returns `null` for:
 *   - non-string / empty / NUL-bearing target
 *   - relative target (caller must give an absolute path)
 *   - empty `roots`
 *   - target equal to a root (must point at something inside the root)
 *   - target outside every root after realpath resolution
 *   - target reaching outside via a symlink in an existing intermediate
 *
 * Accepts targets that don't yet exist as long as the deepest existing
 * ancestor (which may be the root itself) realpaths into one of the
 * allowed roots. This supports the "create on click" / intended-path
 * flow without weakening the security check.
 */
export function resolveInsideAllowedRoots(
  roots: readonly AllowedRoot[],
  target: unknown,
): string | null {
  if (typeof target !== "string" || target.length === 0) return null;
  if (target.includes("\0")) return null;
  if (!path.isAbsolute(target)) return null;
  if (!roots || roots.length === 0) return null;

  const canonicalTarget = canonicaliseTarget(target);
  if (canonicalTarget === null) return null;

  for (const root of roots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync(root);
    } catch {
      // Skip roots that no longer exist on disk (mount unavailable, project
      // cwd deleted underneath us). The validator silently filters; the
      // caller logs at a higher level.
      continue;
    }
    const rel = path.relative(canonicalRoot, canonicalTarget);
    // `rel === ""` means target IS the root; rejected because the file
    // viewer wants a specific file, not the root itself. `rel` starting
    // with `..` or being absolute means target escaped the root.
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    return canonicalTarget;
  }
  return null;
}

/**
 * Walk up `target`'s ancestry until an existing path is found, realpath
 * that existing ancestor, then re-attach the missing textual suffix. This
 * lets the validator accept paths whose leaves (and possibly intermediates)
 * don't yet exist while still catching symlink escapes through any
 * existing intermediate.
 *
 * Returns `null` if the walk reaches the filesystem root without finding
 * an existing ancestor (which would mean the target's whole ancestry is
 * gone — pathological, but we refuse to vouch for it).
 */
function canonicaliseTarget(target: string): string | null {
  const segments: string[] = [];
  let cursor = target;
  // Walk up until we hit a path that exists. `path.dirname("/")` returns
  // "/", so we stop when cursor stops changing.
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    segments.unshift(path.basename(cursor));
    cursor = parent;
  }
  let realAncestor: string;
  try {
    realAncestor = fs.realpathSync(cursor);
  } catch {
    return null;
  }
  return segments.length === 0
    ? realAncestor
    : path.join(realAncestor, ...segments);
}
