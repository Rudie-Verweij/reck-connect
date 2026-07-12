// Pure, side-effect-free validators used by the main-process IPC handlers.
//
// These helpers exist as a separate module so they can be unit-tested without
// pulling in Electron. Keep this file free of `electron`, `fs`, `child_process`
// etc. imports — anything that needs I/O should happen in the caller and pass
// the stat result in (see `validateRsyncLocalPath` for the pattern).

import path from "node:path";

// --- shell:openPath path-traversal guard -------------------------------------

/**
 * Resolve `slug` against `mountPoint` and return the absolute path only if it
 * stays strictly inside `mountPoint`. Returns `null` for any attempt to escape
 * (`../../Applications`, absolute paths, symlink-free traversal via `.`), so
 * the caller can reject without trying to interpret why.
 *
 * This is intentionally stricter than the rsync slug regex: it accepts any
 * non-traversing string so callers can still use it for slugs that contain
 * uppercase or unusual characters that the rsync pipeline rejects. If the
 * caller wants the tighter format, they should validate the slug shape
 * separately before calling this.
 */
export function resolveInsideMountPoint(
  mountPoint: string,
  slug: string,
): string | null {
  if (typeof slug !== "string" || slug.length === 0) return null;
  // Reject absolute paths outright — `path.resolve(mount, "/etc/passwd")`
  // silently drops the mount prefix.
  if (path.isAbsolute(slug)) return null;
  const normalizedMount = path.resolve(mountPoint);
  const target = path.resolve(normalizedMount, slug);
  const rel = path.relative(normalizedMount, target);
  // `rel === ""` means slug resolved to the mount root itself (e.g. `"."` or
  // `""`); we treat that as invalid because the handler is supposed to open a
  // specific project, not the mount root.
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

// --- rsync:toStation option-injection guard ---------------------------------

export type RsyncPathValidationResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Validate a renderer-supplied `localPath` before it's handed to rsync as the
 * source operand. The caller is expected to have already `fs.stat`ed the path
 * and pass the result in. We keep the stat out of this function so the
 * validator stays pure and testable.
 *
 * Rules:
 *   1. Must be a non-empty string.
 *   2. Must not start with `-` (rsync would parse it as a flag — even with
 *      `--` before the operands, defense-in-depth is cheap).
 *   3. Must be absolute (rsync is spawned without a cwd contract; relative
 *      paths would depend on the daemon process cwd).
 *   4. Must not contain NUL.
 *   5. The caller-provided stat must report an existing directory.
 */
export function validateRsyncLocalPath(
  localPath: unknown,
  stat: { exists: boolean; isDirectory: boolean } | null,
): RsyncPathValidationResult {
  if (typeof localPath !== "string" || localPath.length === 0) {
    return { ok: false, error: "localPath must be a non-empty string" };
  }
  if (localPath.startsWith("-")) {
    return { ok: false, error: "localPath must not start with '-'" };
  }
  if (localPath.includes("\0")) {
    return { ok: false, error: "localPath must not contain NUL" };
  }
  if (!path.isAbsolute(localPath)) {
    return { ok: false, error: "localPath must be absolute" };
  }
  if (!stat || !stat.exists) {
    return { ok: false, error: "localPath does not exist" };
  }
  if (!stat.isDirectory) {
    return { ok: false, error: "localPath must be a directory" };
  }
  // Canonicalize (collapse `.` / `..` / trailing slashes). The caller also
  // does realpath resolution via fs.stat, but the textual form is what we
  // pass to rsync.
  return { ok: true, path: path.resolve(localPath) };
}

// --- window.open scheme allowlist -------------------------------------------

/**
 * Schemes we allow to reach `shell.openExternal`. `https:` and `http:`
 * cover clickable web URLs in terminal/source text (the URL linkifier).
 * Everything else — `mailto:`, `file:`, `javascript:`, custom app
 * schemes — stays rejected. Keep this list minimal; widen only after a
 * real caller shows up.
 */
export const ALLOWED_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(["https:", "http:"]);

export type UrlSchemeCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Parse the URL from a renderer `window.open(...)` request and allowlist its
 * scheme. Rejects malformed URLs, `javascript:`, `file:`, `mailto:`, custom
 * handlers, and anything else not explicitly in `ALLOWED_EXTERNAL_SCHEMES`.
 */
export function checkExternalUrl(raw: unknown): UrlSchemeCheck {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "url must be a non-empty string" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "url is not parseable" };
  }
  if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: `scheme ${parsed.protocol} not allowed` };
  }
  return { ok: true, url: parsed.toString() };
}
