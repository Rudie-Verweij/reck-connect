// Pure, surface-agnostic text matcher shared by every search adapter.
//
// The whole point of the search subsystem is that matching happens *once*,
// over a flat string, identically for the terminal, markdown and
// CodeMirror surfaces. Each adapter exposes its content as flat text via
// `getText()`; this module turns (text, query, options) into a list of
// half-open offset ranges. Adapters then map those offsets back to their
// own coordinate systems for highlighting / scrolling.
//
// Implementation note: both substring and regex modes compile to a single
// `RegExp` run against the *original* text. Doing substring search via an
// escaped RegExp with the `i` flag (rather than `text.toLowerCase()`)
// keeps match offsets aligned with the original string — `toLowerCase()`
// can change string length for some Unicode code points and would corrupt
// the offset→surface mapping.

/** Search behaviour toggles, mirroring the search bar's three buttons. */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** A half-open match range in flat-text character offsets:
 *  `start` inclusive, `end` exclusive. */
export interface OffsetRange {
  start: number;
  end: number;
}

export interface MatchResult {
  ranges: OffsetRange[];
  /** Present only when `regex` is on and the pattern failed to compile.
   *  Callers surface this in the match counter instead of throwing. */
  error?: string;
}

/** Hard cap so a pathological pattern on a huge buffer can't lock up the
 *  renderer. Beyond this we stop collecting; the UI still navigates the
 *  matches it has. */
const MAX_MATCHES = 10_000;

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(literal: string): string {
  return literal.replace(REGEX_META, "\\$&");
}

/** Find all matches of `query` in `text`. Never throws — an invalid regex
 *  is reported via `MatchResult.error`. */
export function findMatches(
  text: string,
  query: string,
  options: SearchOptions,
): MatchResult {
  if (query === "") return { ranges: [] };

  let pattern = options.regex ? query : escapeRegExp(query);
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;

  const flags = `g${options.caseSensitive ? "" : "i"}`;

  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (err: unknown) {
    return {
      ranges: [],
      error: err instanceof Error ? err.message : "Invalid regular expression",
    };
  }

  const ranges: OffsetRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    // Skip zero-width matches (e.g. `a*` matching the empty string) — they
    // aren't useful to navigate to and would otherwise loop forever.
    if (end > start) {
      ranges.push({ start, end });
      if (ranges.length >= MAX_MATCHES) break;
    } else {
      // Advance past a zero-width match to guarantee progress.
      re.lastIndex += 1;
    }
  }

  return { ranges };
}
