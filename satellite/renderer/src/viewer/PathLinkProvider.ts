// Install an xterm linkifier that underlines file-path tokens in a pane's
// scrollback and routes Cmd+click to a host-provided activate handler.
//
// xterm's link-provider contract is hover-driven: `provideLinks` fires
// only when the cursor moves into a line. That keeps the per-line cost
// bounded — even on a 200-line `git log -p` paste we only run the regex
// for the lines the user actually inspects, and we cache the resolve
// result on the buffer line itself so a second hover doesn't re-IPC.
//
// Visual state:
//   - All emitted links use xterm's default link decoration (hover-state
//     underline). The popup decides what to do based on the existence /
//     parent-existence flags returned by `file:resolve` — existing paths
//     open straight into the viewer, intended paths land in create-mode.

import { detectPathsInLine } from "./LinkDetector";

export interface ResolvedPath {
  /** The canonical absolute path (post-allowlist) returned by main. */
  path: string;
  exists: boolean;
  isDirectory: boolean;
  parentExists: boolean;
}

export interface XtermBufferLineLike {
  translateToString(trimRight?: boolean): string;
  /** xterm's `IBufferLine.isWrapped` — true when this line is a wrap
   *  continuation of the previous physical line. Phase 5 of
   *  linkifier-followups uses this to detect paths that span line
   *  boundaries so each half doesn't register as a broken filename.
   *  Optional in the interface for back-compat with test fakes. */
  isWrapped?: boolean;
}

export interface XtermLinkProvider {
  provideLinks(
    bufferLineNumber: number,
    callback: (
      links:
        | Array<{
            text: string;
            range: {
              start: { x: number; y: number };
              end: { x: number; y: number };
            };
            activate: (event: MouseEvent, text: string) => void;
          }>
        | undefined,
    ) => void,
  ): void;
}

/** Round 8.3 Phase AAA — marker / decoration shapes structurally
 *  satisfied by real xterm `IMarker` / `IDecoration`. Round 8.3 uses
 *  them to paint a soft tint on the SIBLING segments of a multi-line
 *  ILink while one segment is xterm-hovered. */
export interface XtermLinkProviderMarker {
  dispose(): void;
}
export interface XtermLinkProviderDecoration {
  dispose(): void;
  /** xterm's `IDecoration.onRender`. Fires with a real overlay HTMLElement
   *  (the `xterm-decoration` div appended to the screen overlay layer)
   *  regardless of which renderer is active — confirmed in
   *  `BufferDecorationRenderer.ts:72-114`. Round 8.4 Bug A uses this to
   *  paint a `border-bottom` underline that visually matches xterm's
   *  native link hover style. Optional for back-compat with fakes that
   *  don't exercise the underline path. */
  onRender?: (cb: (el: HTMLElement) => void) => void;
}

export interface XtermLinkProviderTerminal {
  registerLinkProvider(provider: XtermLinkProvider): { dispose: () => void };
  buffer: {
    active: {
      getLine(idx: number): XtermBufferLineLike | undefined;
      /** Round 8.3 — needed for the buffer-y → cursor-relative offset
       *  math when registering hover decorations on sibling lines.
       *  Optional in this contract for back-compat with test fakes
       *  that don't exercise hover. */
      baseY?: number;
      cursorY?: number;
    };
  };
  /** Round 8.3 — line anchor for decorations. Optional so single-line
   *  test fakes don't have to implement; absence at runtime is treated
   *  as "no hover unification" and the link still works. */
  registerMarker?(cursorYOffset?: number): XtermLinkProviderMarker | undefined;
  /** Round 8.3 — paint a styled overlay on a marker's line/column
   *  span. The Satellite uses xterm's WebGL renderer so we paint via
   *  backgroundColor (the only field rendered identically across
   *  canvas + WebGL + DOM). Optional for the same reason as
   *  registerMarker. */
  registerDecoration?(opts: {
    marker: XtermLinkProviderMarker;
    x?: number;
    width?: number;
    backgroundColor?: string;
    layer?: "bottom" | "top";
  }): XtermLinkProviderDecoration | undefined;
}

export interface PathLinkProviderDeps {
  /**
   * Resolve a batch of candidate absolute-or-relative paths. Out-of-roots
   * paths must be filtered out (not returned with `exists: false`) so the
   * renderer can't infer the existence of files outside accessible
   * projects. Used to skip rendering links for unauthorised paths.
   */
  resolveBatch(paths: string[]): Promise<ResolvedPath[]>;
  /**
   * Fires when the user Cmd+clicks an emitted link. The host typically
   * calls `reckAPI.files.openInViewer(path)` here, which routes through
   * the existing-or-create branches on the main side.
   */
  onActivate(path: string, event: MouseEvent): void;
}

interface CachedLine {
  /** Map from a detected path token (as it appeared in the line) to its
   *  resolve entry. Null means "filtered out by allowlist — no link". */
  resolved: Map<string, ResolvedPath | null>;
}

/**
 * Install the path linkifier on the given terminal. Returns a disposable
 * that tears down the registration when called (mirroring xterm's own
 * disposable contract). The returned object also re-exposes xterm's own
 * dispose() under the same name so callers don't need to track both.
 */
export function installPathLinkProvider(
  term: XtermLinkProviderTerminal,
  deps: PathLinkProviderDeps,
): { dispose: () => void } {
  const cache = new WeakMap<XtermBufferLineLike, CachedLine>();

  const provider: XtermLinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      // bufferLineNumber is 1-INDEXED per the xterm public API.
      // buffer.active.getLine(idx) is 0-indexed → subtract one.
      const hovered0 = bufferLineNumber - 1;
      const wrapRun = collectWrapRun(term, hovered0);
      if (!wrapRun || wrapRun.lines.length === 0) {
        callback(undefined);
        return;
      }
      const candidates = detectPathsInLine(wrapRun.joinedText);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }
      // Emit links SYNCHRONOUSLY. xterm's `provideLinks` has a strict
      // internal deadline; awaiting an IPC roundtrip blew past it (26ms
      // over budget) and xterm discarded the result, so the underline
      // never painted. The activate handler routes through
      // `files.openInViewer` → main's allowlist + create-mode, so
      // out-of-roots and not-exists paths land in the right UI without
      // us pre-checking here.
      callback(buildLinksFromWrapRun(candidates, wrapRun, deps, term));
    },
  };

  const disposable = term.registerLinkProvider(provider);
  return {
    dispose() {
      disposable.dispose();
    },
  };
}

/**
 * Phase 5 of the linkifier-followups plan: wrap-run aware buffer scan.
 *
 * xterm wraps long output lines onto subsequent physical lines and
 * marks each continuation with `IBufferLine.isWrapped`. The path-detect
 * regex sees one physical line at a time, so a path that spills onto a
 * second line registers as two broken halves. To handle wrapping, we
 * find the start of the wrap run containing `hovered0`, collect all the
 * continuation lines, and concatenate them into one joined string. The
 * regex then runs against the unwrapped logical line.
 *
 * Returns `null` when the hovered index is out of bounds.
 */
export interface WrapRun {
  /** 0-indexed physical line where the run starts. */
  startLine0: number;
  /**
   * Per-physical-line segments, in order. Each carries:
   *   - `text`: the contribution to `joinedText` (with leading whitespace
   *     stripped for Phase-8 heuristic continuations; raw for normal
   *     soft-wrapped lines).
   *   - `length`: byte-length of `text`. Same as `text.length`.
   *   - `xtermColOffset`: column in xterm's BUFFER where `text` starts.
   *     0 for normal soft-wrapped lines, `indent-length` for heuristic
   *     continuations whose leading whitespace was dropped.
   */
  lines: ReadonlyArray<{ text: string; length: number; xtermColOffset: number }>;
  /** All segments joined with no separator. */
  joinedText: string;
}

export function collectWrapRun(
  term: XtermLinkProviderTerminal,
  hovered0: number,
): WrapRun | null {
  const buf = term.buffer.active;
  let start = hovered0;
  // Walk backward while THIS line is a wrap continuation of the previous.
  // Handles xterm's soft-wrap (auto-wrap on right margin) ONLY.
  while (start > 0) {
    const cur = buf.getLine(start);
    if (!cur || !cur.isWrapped) break;
    start -= 1;
  }
  // Round 3 + Round 8.2 Phase XX — symmetric BACKWARD heuristic walk
  // for hard-wrapped paths.
  //
  // The forward walk alone handles hovering on the FIRST half of a
  // hard-wrapped path. Hovering on the CONTINUATION line used to leave
  // `start` anchored there, so the run captured only the truncated
  // tail (e.g. just `ractional-bucketing.md`) and LinkDetector matched
  // that fragment as a bare filename — clicking it routed to a
  // non-existent file.
  //
  // The unified `isHeuristicContinuationOf` helper covers two cases:
  //   (Phase 8)    indent-continuation: current line starts with
  //                whitespace AND its first non-whitespace char is
  //                not a new-item marker.
  //   (Round 8.2)  mid-token continuation: current line starts with
  //                a path-body char (no whitespace) AND the prior
  //                line ends mid-path-token (path anchor present,
  //                no completed extension or sentence terminator).
  // When either case holds for line[start-1] → line[start], step back.
  while (start > 0) {
    const cur = buf.getLine(start);
    if (!cur) break;
    const curRaw = cur.translateToString(false);
    if (curRaw.length === 0) break;
    const prev = buf.getLine(start - 1);
    if (!prev) break;
    const prevRaw = prev.translateToString(false);
    if (!isHeuristicContinuationOf(prevRaw, curRaw)) break;
    start -= 1;
  }
  // Walk forward collecting the start line plus any soft-wrap continuations.
  //
  // Round 8.4 Bug B — strip trailing whitespace from each pushed line.
  // xterm pads buffer lines with trailing whitespace to terminal width,
  // and that padding contaminated the joined text so a wrapped path
  // (`~/.claude/plans` | `/foo.md`) read as two separate tokens
  // separated by spaces. Trimming `text` AND `length` here keeps the
  // joined text contiguous AND preserves `projectMatchOntoLines`'s
  // line-boundary math (path matches sit in the non-padded prefix of
  // each line, so the trimmed length is the right boundary).
  const lines: Array<{ text: string; length: number; xtermColOffset: number }> = [];
  const first = buf.getLine(start);
  if (!first) return null;
  const firstText = first.translateToString(false);
  const firstTrimmed = firstText.replace(/\s+$/, "");
  lines.push({
    text: firstTrimmed,
    length: firstTrimmed.length,
    xtermColOffset: 0,
  });
  let prevRaw = firstText;
  let i = start + 1;
  for (; ; i++) {
    const ln = buf.getLine(i);
    if (!ln || !ln.isWrapped) break;
    const t = ln.translateToString(false);
    const tTrimmed = t.replace(/\s+$/, "");
    lines.push({ text: tTrimmed, length: tTrimmed.length, xtermColOffset: 0 });
    prevRaw = t;
  }
  // Phase 8 + Round 8.2 Phase XX — HEURISTIC hard-wrap continuation.
  //   - Indent-continuation (Phase 8): line starts with whitespace and
  //     the first non-whitespace char is not a new-item marker. Leading
  //     whitespace is dropped from the joined text so the path regex
  //     sees one continuous token. `xtermColOffset` preserves the
  //     original column so projectMatchOntoLines maps back correctly.
  //   - Mid-token continuation (Round 8.2): line starts with a
  //     path-body char (no leading whitespace) AND the prior line ends
  //     mid-path-token (has a path anchor like `~/` or `/`, no
  //     complete extension yet, no sentence-end punctuation). Whole
  //     line is appended verbatim (`xtermColOffset=0`).
  for (; ; i++) {
    const ln = buf.getLine(i);
    if (!ln) break;
    const raw = ln.translateToString(false);
    if (!isHeuristicContinuationOf(prevRaw, raw)) break;
    if (/^\s/.test(raw)) {
      // Strip BOTH leading whitespace (Phase 8 indent-continuation)
      // and trailing padding (Round 8.4 Bug B).
      const trimmed = raw.replace(/^\s+/, "").replace(/\s+$/, "");
      const indent = raw.length - raw.replace(/^\s+/, "").length;
      lines.push({
        text: trimmed,
        length: trimmed.length,
        xtermColOffset: indent,
      });
    } else {
      // Round 8.2 mid-token continuation — strip trailing padding so
      // the joined text doesn't carry xterm's terminal-width padding
      // from this line into any subsequent continuation.
      const trimmed = raw.replace(/\s+$/, "");
      lines.push({ text: trimmed, length: trimmed.length, xtermColOffset: 0 });
    }
    prevRaw = raw;
  }
  return {
    startLine0: start,
    lines,
    joinedText: lines.map((l) => l.text).join(""),
  };
}

/**
 * Round 8.2 Phase XX — unified continuation test. Returns true when
 * `curRaw` should be joined with `prevRaw` as part of a wrap-run.
 * Handles both Phase-8 indent-continuation and Round-8.2 mid-token
 * continuation (no-indent, prior tail looks mid-path).
 *
 * Exported for unit testing of the boundary rules.
 */
export function isHeuristicContinuationOf(
  prevRaw: string,
  curRaw: string,
): boolean {
  if (curRaw.length === 0) return false;

  // Case A — Phase-8 indent-continuation. Line starts with whitespace
  // and the first non-whitespace char is NEITHER a new-item marker NOR
  // a path anchor (path anchors break to preserve "two separate paths"
  // semantics). The prior line must end mid-path-token (same guard as
  // Case B) to prevent indented command output (ls, git status, etc.)
  // from being joined with the prompt above.
  if (/^\s/.test(curRaw)) {
    const trimmed = curRaw.replace(/^\s+/, "");
    if (trimmed.length === 0) return false;
    const first = trimmed[0];
    if (
      first === "-" || first === "*" || first === "+" ||
      first === ">" || first === "#" ||
      first === "/" || first === "~" || first === "."
    ) {
      return false;
    }
    const tailMatch = prevRaw.match(/(\S+)\s*$/);
    if (!tailMatch) return false;
    const tail = tailMatch[1];
    if (!/[~/]/.test(tail)) return false;
    if (/\.\w{1,8}$/.test(tail)) return false;
    if (/[.,;:!?)\]>"'`]$/.test(tail)) return false;
    return true;
  }

  // Case B — Round 8.2 mid-token soft-wrap continuation (no indent).
  // Defensive: require the prior line to end mid-path-token AND the
  // current line to start with a path-body character. Two complete
  // paths on consecutive lines (each ending in a recognized extension)
  // are NOT joined.
  const first = curRaw[0];
  if (
    first === "-" || first === "*" || first === "+" ||
    first === ">" || first === "#"
  ) {
    return false;
  }
  if (!/^[\w./~_@-]/.test(curRaw)) return false;
  // Prior line tail: must look like a partial path (has anchor, no
  // complete extension, no sentence-ending punctuation). xterm pads
  // each buffer line with trailing whitespace to terminal width via
  // IBufferLine.translateToString(false), so `(\S+)$` (Round 8.2)
  // missed the tail in production. Round 8.4 tolerates the padding.
  const tailMatch = prevRaw.match(/(\S+)\s*$/);
  if (!tailMatch) return false;
  const tail = tailMatch[1];
  if (!/[~/]/.test(tail)) return false;
  if (/\.\w{1,8}$/.test(tail)) return false;
  if (/[.,;:!?)\]>"'`]$/.test(tail)) return false;
  return true;
}

interface LinkRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/**
 * Project a [joinStart, joinEnd) range in the wrap run's joined text
 * back onto its source physical lines, yielding one xterm range per
 * physical line the match overlaps. xterm uses 1-INDEXED columns and
 * 1-INDEXED rows for IBufferRange; the helper returns ranges in that
 * coordinate space. The `startLine1` arg is the wrap run's start line
 * in xterm's 1-indexed coordinate.
 */
export function projectMatchOntoLines(
  match: { start: number; end: number },
  lines: ReadonlyArray<{ length: number; xtermColOffset?: number }>,
  startLine1: number,
): LinkRange[] {
  const out: LinkRange[] = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length;
    const lineStart = cursor;
    const lineEnd = cursor + lineLen;
    cursor = lineEnd;
    // No overlap with this physical line.
    if (match.end <= lineStart || match.start >= lineEnd) continue;
    // `xtermColOffset` shifts the joined-relative offsets back into
    // xterm-buffer-column space for Phase-8 indent-continuation lines.
    // Soft-wrapped continuations have offset=0 so the math is identical
    // to the pre-Phase-8 behaviour.
    const colOff = lines[i].xtermColOffset ?? 0;
    const segStart = Math.max(match.start, lineStart) - lineStart + colOff;
    const segEnd = Math.min(match.end, lineEnd) - lineStart + colOff;
    out.push({
      start: { x: segStart + 1, y: startLine1 + i },
      end: { x: segEnd, y: startLine1 + i },
    });
  }
  return out;
}

/**
 * Build xterm `ILink` entries for every candidate detected in the wrap
 * run's joined text. A candidate that spans multiple physical lines
 * emits one ILink per physical line — xterm supports this composition,
 * the entries share `text` and `activate` so hover/click treat them as
 * the same logical link.
 *
 * Round 8.3 Phase AAA — multi-segment groups also wire `hover` /
 * `leave` callbacks that paint a soft cornflower-blue background on
 * the SIBLING segments. xterm's built-in hover underline is per-ILink;
 * the sibling tint makes the wrap-run read as one logical link
 * instead of two unrelated underlines. Single-segment matches have
 * no siblings → hover/leave are free no-ops.
 */
interface BuiltLink {
  text: string;
  range: LinkRange;
  activate: (event: MouseEvent, text: string) => void;
  hover?: (event: MouseEvent, text: string) => void;
  leave?: (event: MouseEvent, text: string) => void;
}

function buildLinksFromWrapRun(
  candidates: ReturnType<typeof detectPathsInLine>,
  wrap: WrapRun,
  deps: PathLinkProviderDeps,
  term: XtermLinkProviderTerminal,
): BuiltLink[] {
  const out: BuiltLink[] = [];
  // xterm passes 1-indexed line numbers; collectWrapRun is 0-indexed.
  const startLine1 = wrap.startLine0 + 1;
  // Round 8.3 — per-`provideLinks`-call decoration registry. Each call
  // creates a fresh registry; xterm discards the previous batch of
  // ILinks so stale state can't leak across calls.
  const groupDecorations = new Map<number, XtermLinkProviderDecoration[]>();
  let nextGroupId = 0;
  for (const cand of candidates) {
    const segments = projectMatchOntoLines(cand, wrap.lines, startLine1);
    const groupId = nextGroupId++;
    const groupLinks: BuiltLink[] = [];
    for (const range of segments) {
      const link: BuiltLink = {
        text: cand.text,
        range,
        activate(ev, textArg) {
          if (!ev.metaKey) {
            console.debug("[click:pane] ignored (no metaKey)", {
              text: textArg,
            });
            return;
          }
          console.log("[click:pane] activate", {
            text: textArg,
            metaKey: ev.metaKey,
          });
          deps.onActivate(textArg, ev);
        },
        hover() {
          paintHoverSiblings(term, groupLinks, range, groupId, groupDecorations);
        },
        leave() {
          disposeGroupDecorations(groupId, groupDecorations);
        },
      };
      groupLinks.push(link);
      out.push(link);
    }
  }
  return out;
}

/**
 * Round 8.3 Phase AAA — paint an overlay on every sibling segment of
 * the hovered ILink so the user sees both halves of a wrapped path as
 * one logical link. Idempotent: if the group already has decorations
 * registered (rapid hover→leave→hover flutter), early-return.
 *
 * Round 8.4 Bug A — switched from `backgroundColor` (a thick coloured
 * rectangle) to an `onRender`-applied `border-bottom: 1px solid
 * currentColor` so the sibling reads as a thin underline, symmetric
 * with xterm's native link hover style on the hovered segment. The
 * Round 8.3 LEARNINGS note assumed `IDecoration.element` was
 * unavailable under xterm's WebGL renderer; reading
 * `BufferDecorationRenderer.ts:72-114` proved that wrong — the
 * decoration overlay is a parallel DOM layer that renders for every
 * renderer, so `onRender` fires with a real, styleable HTMLElement.
 *
 * The y conversion: ILink range.y is 1-indexed buffer line. xterm's
 * `registerMarker(offset)` creates a marker at `cursor.y + offset`
 * (cursor position = baseY + cursorY, both 0-indexed). So
 * `offset = (range.y - 1) - (baseY + cursorY)`. Same pattern as
 * `XtermHighlighter` (TTS), proven in production.
 *
 * The x conversion: ILink range.x is 1-indexed cell; xterm
 * `registerDecoration({ x })` uses 0-indexed cell → `range.x - 1`.
 */
function paintHoverSiblings(
  term: XtermLinkProviderTerminal,
  groupLinks: ReadonlyArray<BuiltLink>,
  selfRange: LinkRange,
  groupId: number,
  groupDecorations: Map<number, XtermLinkProviderDecoration[]>,
): void {
  if (groupDecorations.has(groupId)) return; // idempotent
  if (!term.registerMarker || !term.registerDecoration) return;
  const baseY = term.buffer.active.baseY ?? 0;
  const cursorY = term.buffer.active.cursorY ?? 0;
  const cursorAbs = baseY + cursorY;
  const decos: XtermLinkProviderDecoration[] = [];
  for (const sib of groupLinks) {
    if (sib.range === selfRange) continue; // skip self
    const cursorYOffset = sib.range.start.y - 1 - cursorAbs;
    const marker = term.registerMarker(cursorYOffset);
    if (!marker) continue;
    const deco = term.registerDecoration({
      marker,
      x: sib.range.start.x - 1,
      width: sib.range.end.x - sib.range.start.x + 1,
      layer: "bottom",
    });
    if (!deco) {
      marker.dispose();
      continue;
    }
    deco.onRender?.((el) => {
      el.style.borderBottom = "1px solid currentColor";
      el.style.pointerEvents = "none";
    });
    decos.push(deco);
  }
  if (decos.length > 0) groupDecorations.set(groupId, decos);
}

function disposeGroupDecorations(
  groupId: number,
  groupDecorations: Map<number, XtermLinkProviderDecoration[]>,
): void {
  const decos = groupDecorations.get(groupId);
  if (!decos) return;
  for (const d of decos) d.dispose();
  groupDecorations.delete(groupId);
}

function buildLinks(
  candidates: ReturnType<typeof detectPathsInLine>,
  resolved: Map<string, ResolvedPath | null>,
  lineNumber: number,
  deps: PathLinkProviderDeps,
) {
  const out: Array<{
    text: string;
    range: { start: { x: number; y: number }; end: { x: number; y: number } };
    activate: (event: MouseEvent, text: string) => void;
  }> = [];
  for (const cand of candidates) {
    const entry = resolved.get(cand.text) ?? null;
    if (!entry) continue; // out-of-roots → no link
    // Only emit a link if the path exists OR its parent exists (the
    // create-on-click flow can handle the latter). A path whose entire
    // ancestry is missing leads to no useful click action.
    if (!entry.exists && !entry.parentExists) continue;
    out.push({
      text: cand.text,
      range: {
        // xterm's IBufferRange is 1-indexed for columns AND for rows.
        start: { x: cand.start + 1, y: lineNumber + 1 },
        end: { x: cand.end, y: lineNumber + 1 },
      },
      activate(ev, textArg) {
        if (!ev.metaKey) return;
        deps.onActivate(textArg, ev);
      },
    });
  }
  return out;
}

/**
 * Heuristic check that a candidate token and a main-returned entry refer
 * to the same path. main canonicalises (realpath) which may rewrite the
 * prefix; we accept the pairing when the entry path's basename matches the
 * candidate's last segment.
 */
function pathLooksPaired(candidate: string, canonical: string): boolean {
  if (!candidate || !canonical) return false;
  if (candidate === canonical) return true;
  const candBase = candidate.slice(candidate.lastIndexOf("/") + 1);
  const canonBase = canonical.slice(canonical.lastIndexOf("/") + 1);
  return candBase === canonBase;
}
