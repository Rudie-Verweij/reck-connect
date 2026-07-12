// Path-detection for terminal scrollback and inline text.
//
// Two responsibilities:
//   - `isPathLike(s)` — given an already-tokenised candidate, decide whether
//     it should be treated as a path (vs. arbitrary text). Used by the xterm
//     link provider on hovered tokens.
//   - `detectPathsInLine(line)` — scan a full line of text for path-shaped
//     substrings, returning {text, start, end} positions. Used to underline
//     paths in xterm scrollback and to classify embedded references.
//
// Heuristics, not a parser. We accept absolute paths anywhere
// (/etc/hosts, /usr/local/bin/foo), home-relative paths (~/notes.md),
// dot-relative paths with extensions (./foo.ts, ../sibling/x.tsx), and
// multi-segment subdir paths with extensions (satellite/main/main.ts).
// We deliberately reject bare filenames (foo.md), URLs, and slash-only
// fragments without an extension or anchor.

export interface PathMatch {
  text: string;
  start: number;
  end: number;
}

const TRAILING_PUNCT = /[.,;:!?)\]>"'`]/;

/**
 * Phase 6 of the linkifier-followups plan: bare filenames with a
 * recognised extension are clickable even without `/`, `~/`, or `./`
 * prefix. Claude Code messages and many tool outputs reference files
 * by their basename (e.g. "update CLAUDE.md") — without this allowlist,
 * those tokens never underline.
 *
 * The allowlist is intentionally narrow: extensions that are almost
 * always files (markdown, source code, config). Wider matches would
 * register `e.g.` and `pkg.json` as paths and spam the underlines.
 */
export const BARE_FILENAME_EXTENSIONS = new Set([
  "md", "markdown",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "json", "yaml", "yml", "toml",
  "py", "go", "rs", "java", "rb",
  "html", "htm", "css", "scss", "sass",
  "sh", "bash", "zsh", "fish",
  "conf", "cfg", "ini",
  "txt", "log",
]);

/**
 * Round 8 Phase LL — extensionless filenames that are still real files
 * we'd want to open. Without this list, the files-only contract (every
 * linkified path must end in `\.\w{1,8}$`) would reject `/etc/hosts`,
 * `path/to/Makefile`, `~/.bashrc`, etc. The list is seeded at first run
 * into the persisted config; thereafter the persisted config IS the
 * effective list. Users edit it via Preferences (see Phase PP).
 *
 * Editing rule: case-sensitive (`README` ≠ `readme`).
 */
export const SEEDED_EXTENSIONLESS_FILENAMES: readonly string[] = [
  "Makefile",
  "Dockerfile",
  "README",
  "LICENSE",
  "CHANGELOG",
  "hosts",
  "passwd",
  ".bashrc",
  ".zshrc",
  ".profile",
  ".vimrc",
  ".gitignore",
  ".gitconfig",
  ".env",
  ".envrc",
];

let extensionlessAllowlist: ReadonlySet<string> = new Set(
  SEEDED_EXTENSIONLESS_FILENAMES,
);

/**
 * Replace the in-memory allowlist. Called at boot from the persisted
 * config and after a successful Preferences save. Accepts any iterable
 * so callers can pass arrays, Sets, or other collections without
 * pre-conversion.
 */
export function setExtensionlessAllowlist(names: Iterable<string>): void {
  extensionlessAllowlist = new Set(names);
}

/**
 * Inspect the current allowlist. Returned snapshot is a defensive copy
 * so callers cannot mutate the internal Set.
 */
export function getExtensionlessAllowlist(): ReadonlySet<string> {
  return new Set(extensionlessAllowlist);
}

/**
 * Round 8 Phase LL — files-only contract: every accepted path must
 * either end in `\.\w{1,8}$` OR have a basename in the extensionless
 * allowlist. Folders, route-shaped strings (`/v2/marketplace`), and
 * home-rooted directories (`~/Downloads`) all reject.
 */
function endsLikeFile(t: string): boolean {
  if (/\.\w{1,8}$/.test(t)) return true;
  const lastSlash = t.lastIndexOf("/");
  const basename = lastSlash >= 0 ? t.slice(lastSlash + 1) : t;
  return extensionlessAllowlist.has(basename);
}

/**
 * Classify an already-isolated token. Returns true iff the token looks
 * like a filesystem path we should treat as clickable.
 *
 * Rules:
 *   - URLs (anything matching `scheme://`) → false.
 *   - `/abs/...` → true iff ends like a file (extension OR allowlisted
 *     basename).
 *   - `~/...` → true iff ends like a file.
 *   - `./...` or `../...` → true iff ends like a file.
 *   - `<word>/.../<file>` (no anchor) → true iff has at least one `/`
 *     and ends like a file.
 *   - Everything else → false.
 */
export function isPathLike(s: string): boolean {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  if (t.startsWith("/")) {
    if (t.length < 2) return false;
    return endsLikeFile(t);
  }
  if (t.startsWith("~/")) {
    if (t.length <= 2) return false;
    return endsLikeFile(t);
  }
  if (t.startsWith("./") || t.startsWith("../")) {
    return endsLikeFile(t);
  }
  if (t.includes("/")) {
    return endsLikeFile(t);
  }
  return false;
}

/**
 * Detect path-shaped substrings inside `line`. Returns matches sorted by
 * starting column, each with the text and column boundaries. Empty for
 * lines with no plausible references.
 *
 * Strategy:
 *   1. Find URL spans first so their internal `/path` fragments don't
 *      register as separate matches.
 *   2. Run a combined token regex for the three anchor forms (absolute,
 *      home, dot-relative) plus the multi-segment-with-extension case.
 *   3. Strip a single trailing sentence-punctuation char (`. , ; : ! ? ) ] > " ' \``)
 *      if removing it still leaves a path-like token.
 *   4. Validate via `isPathLike` and skip anything inside a URL span.
 */
export function detectPathsInLine(line: string): PathMatch[] {
  if (typeof line !== "string" || line.length === 0) return [];

  // Pass 1: collect URL spans to skip path-matches that sit inside them.
  const urlSpans: Array<[number, number]> = [];
  const urlRe = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRe.exec(line)) !== null) {
    urlSpans.push([urlMatch.index, urlMatch.index + urlMatch[0].length]);
  }

  // Pass 2: candidate paths. Combined alternation:
  //   ~/<chars>            home-relative
  //   ./<chars> ../<chars> dot-relative (post-classify requires extension)
  //   /<chars>             absolute
  //   <word>/<chars>       subdir with extension (post-classify checks)
  //   .<word>/<chars>      leading dot-folder (.claude/x.json) —
  //                        The sub-dir alternative starts on a word char,
  //                        so without this branch the leading dot was
  //                        silently dropped (`claude/x.json`). The
  //                        lookbehind rejects ellipsis (`...done/x`) and
  //                        sentence dots glued to the next word
  //                        (`here.Then/x`); `/`-preceded dots are interior
  //                        to an earlier match and never reach this branch.
  // Char class for path bodies: word chars, dot, slash, dash, underscore,
  // tilde, @. Excludes whitespace, quotes, parens, brackets, angle brackets.
  const pathRe =
    /(?:~\/|\.{1,2}\/|\/)[\w@~./_-]+|\b[\w][\w_.-]*\/[\w@~./_-]+|(?<![\w./~-])\.[A-Za-z0-9][\w.-]*\/[\w@~./_-]+/g;
  const out: PathMatch[] = [];
  const seenStarts = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(line)) !== null) {
    const startRaw = m.index;
    let text = m[0];
    // Reject if this token starts immediately after `://` — that's a URL
    // path-fragment the URL regex should have eaten, but we keep this as
    // belt-and-braces in case the URL regex got tripped up.
    if (startRaw >= 3 && line.slice(startRaw - 3, startRaw) === "://") continue;
    // Skip when starting inside a URL span.
    if (urlSpans.some(([s, e]) => startRaw >= s && startRaw < e)) continue;
    // Strip a single trailing sentence-punct char if doing so still leaves
    // the token path-like. We don't loop — one strip handles the common
    // "see ./foo.md." case.
    const last = text[text.length - 1];
    if (TRAILING_PUNCT.test(last)) {
      const candidate = text.slice(0, -1);
      if (isPathLike(candidate)) text = candidate;
    }
    if (!isPathLike(text)) continue;
    if (seenStarts.has(startRaw)) continue;
    seenStarts.add(startRaw);
    out.push({ text, start: startRaw, end: startRaw + text.length });
  }
  // Pass 3 (Phase 6 of linkifier-followups): bare filenames with
  // allow-listed extensions. Matches strings of `[\w-]+\.<ext>` only
  // when neither anchored (no leading `/`, `~/`, `./`, `../`) nor part
  // of a larger path token (no preceding `/`). The negative-lookbehind
  // for `/` keeps `satellite/main/main.ts` from emitting a duplicate
  // `main.ts` bare hit; the negative-lookbehind for `.` rejects
  // `e.g.`/`i.e.` (where the apparent "ext" is actually a single-char
  // word that follows another dot).
  const bareRe = /(?<![./\w-])([A-Za-z0-9][\w-]*\.([A-Za-z][A-Za-z0-9]*))\b/g;
  let bm: RegExpExecArray | null;
  while ((bm = bareRe.exec(line)) !== null) {
    const startRaw = bm.index;
    const text = bm[1];
    const ext = bm[2].toLowerCase();
    if (!BARE_FILENAME_EXTENSIONS.has(ext)) continue;
    if (seenStarts.has(startRaw)) continue;
    // Skip when starting inside a URL span.
    if (urlSpans.some(([s, e]) => startRaw >= s && startRaw < e)) continue;
    // Skip when this position is already covered by an anchored-path
    // match — out[] is the anchored-pass result. The trailing leaf of
    // `satellite/main/main.ts` would otherwise re-emit as `main.ts`.
    const inAnchored = out.some(
      (p) => startRaw >= p.start && startRaw < p.end,
    );
    if (inAnchored) continue;
    seenStarts.add(startRaw);
    out.push({ text, start: startRaw, end: startRaw + text.length });
  }

  // Pass 4: bare dotfiles. Pass 3's first char class
  // excludes `.` and its lookbehind rejects a preceding dot, so
  // allow-listed dotfiles (.env, .gitignore, …) never underlined when
  // mentioned bare. Keyed off the same extensionless allowlist as
  // `endsLikeFile`, so Preferences edits steer this pass too. The
  // lookbehind rejects ellipsis (`wait...env`) and interior-of-path
  // positions (`path/to/.env` — already covered by the anchored pass).
  // Exact-token matching: `.env.local` is one token and only matches
  // if the allowlist contains it verbatim — no prefix emit.
  const dotfileRe = /(?<![\w./~-])\.[\w][\w.-]*/g;
  let dm: RegExpExecArray | null;
  while ((dm = dotfileRe.exec(line)) !== null) {
    const startRaw = dm.index;
    let text = dm[0];
    // Strip a single trailing sentence-punct char (same rule as the
    // anchored pass) when the stripped form is the allow-listed token.
    const last = text[text.length - 1];
    if (
      TRAILING_PUNCT.test(last) &&
      extensionlessAllowlist.has(text.slice(0, -1))
    ) {
      text = text.slice(0, -1);
    }
    if (!extensionlessAllowlist.has(text)) continue;
    if (seenStarts.has(startRaw)) continue;
    if (urlSpans.some(([s, e]) => startRaw >= s && startRaw < e)) continue;
    const inAnchored = out.some(
      (p) => startRaw >= p.start && startRaw < p.end,
    );
    if (inAnchored) continue;
    seenStarts.add(startRaw);
    out.push({ text, start: startRaw, end: startRaw + text.length });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

export interface UrlMatch {
  text: string;
  start: number;
  end: number;
}

// Clickable web URLs: http/https only. These are the schemes we open in
// the OS browser (see ALLOWED_EXTERNAL_SCHEMES in ipc-validation.ts);
// other `scheme://` runs are deliberately not linkified. The character
// class stops at whitespace, quotes, and angle brackets, matching the
// path detector's own URL-span regex.
const URL_RE = /\bhttps?:\/\/[^\s'"`<>]+/gi;

/**
 * Scan a line for http/https URLs, returning `{text,start,end}` spans.
 * Trailing sentence punctuation is trimmed (so `(see https://x.com).`
 * links `https://x.com`), while a closing paren is kept when the URL has
 * a matching open paren (wiki-style `…/Foo_(bar)`). Used by the xterm
 * URL link provider and the CodeMirror URL linkifier.
 */
export function detectUrlsInLine(line: string): UrlMatch[] {
  if (typeof line !== "string" || line.length === 0) return [];
  const out: UrlMatch[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(line)) !== null) {
    let text = m[0];
    const start = m.index;
    let trimmed = true;
    while (trimmed && text.length > 0) {
      trimmed = false;
      const last = text[text.length - 1];
      if (last === ")") {
        const opens = (text.match(/\(/g) ?? []).length;
        const closes = (text.match(/\)/g) ?? []).length;
        if (closes > opens) {
          text = text.slice(0, -1);
          trimmed = true;
        }
      } else if (TRAILING_PUNCT.test(last)) {
        text = text.slice(0, -1);
        trimmed = true;
      }
    }
    if (text.length === 0) continue;
    out.push({ text, start, end: start + text.length });
  }
  return out;
}
