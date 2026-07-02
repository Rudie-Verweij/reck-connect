import path from "node:path";

// defect 3 — root-relative retry for the file-viewer's
// ambiguous-miss path. A reference written relative to the PROJECT
// ROOT but clicked inside a popup showing a subfolder file resolves
// via resolveAgainst(currentFile, href) to a doubled path
// (…/subfolder/subfolder/x.md). Joining the raw click text onto the
// project cwd gives a deterministic second candidate to stat before
// falling back to the streaming suffix-search.

/**
 * Join `originalText` (the raw click text, BEFORE any base-dir
 * resolution) onto `projectCwd`. Returns the normalized absolute
 * candidate, or `null` when the inputs can't produce one:
 * already-anchored text (`/abs`, `~/…`), missing/relative cwd, empty
 * text, or a `../` chain that escapes the cwd (an escape is not a
 * "root-relative" reference; the allowed-roots gate downstream would
 * reject it anyway, refusing here keeps the contract crisp).
 */
export function rootRelativeCandidate(
  originalText: string | undefined,
  projectCwd: string | null | undefined,
): string | null {
  if (!originalText || !projectCwd) return null;
  const text = originalText.trim();
  if (text.length === 0) return null;
  // Already-anchored forms know what they're relative to — a second
  // base would change their meaning, not rescue them.
  if (text.startsWith("/") || text === "~" || text.startsWith("~/")) {
    return null;
  }
  const base = projectCwd.replace(/\/+$/, "");
  if (!base.startsWith("/")) return null;
  const joined = path.posix.normalize(base + "/" + text);
  // A `../` chain that escapes the cwd is not a root-relative
  // reference (see doc comment).
  if (!joined.startsWith(base + "/")) return null;
  return joined;
}
