// Composes the file-viewer allowed-roots set.
//
// The file-viewer feature's security boundary is `resolveInsideAllowedRoots`
// in `./file-allowlist.ts`. The validator takes a list of root paths and
// refuses any target that doesn't realpath inside one of them. Where that
// list comes from is a policy decision — which is what this module owns.
//
// Today the policy is "built-ins plus user-managed extras":
//   - Built-ins (hardcoded in main.ts):
//       MOUNT_POINT       — sshfs station mount
//       $HOME             — user's local files
//       /tmp              — scratch space (where AI / dev tools dump
//                           generated paths)
//   - Extras: a `string[]` persisted under the `fileViewerExtraRoots`
//     config key, edited via the Settings UI. Lets the user add e.g.
//     `/Volumes/External/code` without changing source. Per-IPC re-read
//     means edits take effect without restart.
//
// This module is pure (no electron, no fs) so the composition + validation
// logic is unit-testable in isolation.

import path from "node:path";

/**
 * Combine built-in roots with the user-managed extras. Returns a fresh
 * array; safe to call on every IPC.
 *
 * Validates each extra is:
 *   - a non-empty string
 *   - absolute (`/`-rooted on POSIX)
 *
 * De-duplicates against the built-ins and against itself, preserving the
 * first occurrence order: built-ins first, then extras in their original
 * order.
 *
 * Defensive against malformed persistence (`extras` not an array, contains
 * non-string entries) — those are silently dropped, never thrown.
 */
export function composeFileViewerRoots(
  builtIns: readonly string[],
  extras: unknown,
): string[] {
  const safeExtras = Array.isArray(extras) ? extras : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of builtIns) {
    if (typeof r !== "string" || r.length === 0) continue;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  for (const r of safeExtras) {
    if (typeof r !== "string") continue;
    if (r.length === 0) continue;
    if (!path.isAbsolute(r)) continue;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}
