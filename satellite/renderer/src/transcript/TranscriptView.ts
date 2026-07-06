// `TranscriptView` — the "History" overlay for a Claude pane. Renders
// the parsed session transcript in a DOM scroll container mounted over
// the pane's terminal (the xterm keeps running underneath), which is
// what makes the scrollbar *exact*: the browser lays the turns out at
// the pane's real width, so scrollHeight/clientHeight are true at any
// size and the truthful OverlayScrollbar mode (thumb, drag-to-seek,
// resize) works unchanged — no estimation anywhere. Shell is a
// positioned root → status banner + scrollable body (no header bar —
// the pane's history clock toggles the overlay, Escape closes it).
//
// Rendering is incremental: one container element per turn, and
// `render(turns, firstChanged)` only (re)paints from `firstChanged`,
// so a live tail appends without re-rendering the whole chat. Assistant
// text goes through the shared MarkdownRenderer (sanitized); user text
// is rendered as plain text (people type text, not markup). Thinking /
// tool_use / tool_result blocks fold into collapsed <details>.

import {
  createMarkdownRenderer,
  type MarkdownRenderer,
} from "../viewer/MarkdownRenderer";
import { wrapFreeTextPaths } from "../viewer/renderedDom";
import { createOverlayScrollbar, type OverlayScrollbar } from "../search/OverlayScrollbar";
import { domScrollSurface } from "../search/scrollSurfaces";
import { MarkdownSurfaceAdapter } from "../tts/MarkdownSurfaceAdapter";
import type { SpeakSurfaceAdapter } from "../tts/SpeakSurfaceAdapter";
import { ensurePaneControls } from "../ui/paneControls";
import type { TranscriptTurn, TranscriptBlock } from "./parseTranscript";

export interface TranscriptViewOptions {
  /** Positioned pane wrapper the overlay covers. */
  host: HTMLElement;
  /** Session UUID — shown (shortened) in the start-of-session divider. */
  sessionId?: string;
  /** Invoked on Escape (or the pane's history-clock toggle). Owner unmounts
   *  via dispose(). */
  onClose(): void;
  /** ⌘+click on an internal file-path link (relative/absolute/`~`). Same
   *  contract as the markdown renderer's onLinkActivate: `(href, event)`. */
  onLinkActivate?(href: string, ev: MouseEvent): void;
  /** ⌘+click on an external link (http/mailto/…). */
  onExternalActivate?(href: string, ev: MouseEvent): void;
}

/** Visible overlay state. The overlay must never look silently dead:
 *  loading/empty/error render a banner under the header; `live` hides it. */
export type TranscriptStatus =
  | { kind: "loading" | "empty" | "error"; message: string }
  | { kind: "live" };

export interface TranscriptViewHandle {
  /** `.transcript-view` — the positioned overlay root. */
  root: HTMLElement;
  /** `.transcript-body` — the scroll container (search adapters target this). */
  body: HTMLElement;
  /** (Re)render turns from `firstChanged` onward. */
  render(turns: readonly TranscriptTurn[], firstChanged: number): void;
  /** Show/replace/hide the status banner. */
  setStatus(status: TranscriptStatus): void;
  /** Route search-match fractions to the overlay scrollbar's ticks. */
  setMatches(fractions: readonly number[]): void;
  /** The TTS speak surface over the transcript body (lazily built + cached).
   *  The window's single TtsController returns this when the overlay is the
   *  focused surface — same MarkdownSurfaceAdapter the file viewer speaks. */
  getSpeakSurface(): SpeakSurfaceAdapter;
  dispose(): void;
}

/** How close to the bottom (px) still counts as "following the tail". */
const FOLLOW_THRESHOLD_PX = 40;

/** A href with a URL scheme (`https:`, `mailto:`, …) is external; relative,
 *  absolute (`/x`), and `~/x` paths are internal file references. Mirrors the
 *  markdown renderer's isInternalLinkHref classification. */
function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** Threshold for clamping a user message behind "Show more" — a proxy for
 *  "taller than a screenful" that's deterministic (jsdom has no layout). */
function isLongText(text: string): boolean {
  return text.length > 600 || text.split("\n").length > 12;
}

export function createTranscriptView(opts: TranscriptViewOptions): TranscriptViewHandle {
  // `reck-native-scroll` opts the overlay out of the pane wrapper's
  // TUI wheel→PgUp/PgDn remap (OverlayScrollbar capture listener) so
  // the transcript body scrolls natively.
  const root = document.createElement("div");
  root.className = "transcript-view reck-native-scroll";

  const status = document.createElement("div");
  status.className = "transcript-status transcript-status--hidden";

  const body = document.createElement("div");
  body.className = "transcript-body";

  // The start-of-session divider marks where the conversation opens (Claude
  // Code transcripts have no visible "chat begins here" boundary of their
  // own). It's the first body child; hidden until the first turn renders so a
  // loading/empty overlay doesn't claim a session started.
  const sessionStart = document.createElement("div");
  sessionStart.className = "transcript-session-start transcript-session-start--hidden";
  {
    const label = document.createElement("span");
    label.className = "transcript-session-start-label";
    label.textContent = "Start of session";
    sessionStart.appendChild(label);
    if (opts.sessionId) {
      const idEl = document.createElement("span");
      idEl.className = "transcript-session-start-id";
      idEl.textContent = opts.sessionId.slice(0, 8);
      sessionStart.appendChild(idEl);
    }
  }
  body.appendChild(sessionStart);

  root.appendChild(status);
  root.appendChild(body);
  opts.host.appendChild(root);

  const md: MarkdownRenderer = createMarkdownRenderer();
  const scrollbar: OverlayScrollbar = createOverlayScrollbar({
    host: root,
    surface: domScrollSurface(body),
  });

  // One element per turn, index-aligned with the parser's turn list.
  const turnEls: HTMLElement[] = [];
  let disposed = false;
  // Lazily built so a never-spoken overlay carries no highlight overlay.
  let speakSurface: MarkdownSurfaceAdapter | null = null;

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    opts.onClose();
  }
  document.addEventListener("keydown", onKeyDown);

  // One delegated ⌘+click handler for EVERY path link in the body — assistant
  // markdown, user prose, whichever turn. Delegating on `body` (a) survives
  // incremental appends with no per-turn bookkeeping, and (b) sidesteps the
  // shared markdown renderer's per-mount handler only surviving on the
  // last-mounted turn (mount() detaches the previous listener). We always
  // preventDefault so a file href never navigates the app window; opening
  // requires ⌘, matching the terminal + file-viewer linkifiers.
  function onBodyClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement | null;
    // Match ANY anchor, not just `.reck-internal-link`: external links
    // (http/mailto) render as bare `<a>` with no class, and we must still
    // preventDefault them so a plain click can't navigate the app window.
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    ev.preventDefault();
    if (!ev.metaKey) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href === "" || href.startsWith("#")) return;
    if (isExternalHref(href)) opts.onExternalActivate?.(href, ev);
    else opts.onLinkActivate?.(href, ev);
  }
  body.addEventListener("click", onBodyClick);

  function textBlockEl(role: TranscriptTurn["role"], text: string): HTMLElement {
    if (role === "assistant") {
      const el = document.createElement("div");
      el.className = "transcript-md";
      md.mount(el, md.render(text));
      return el;
    }
    const el = document.createElement("div");
    el.className = "transcript-text";
    el.textContent = text;
    // People type file paths in prose ("look at services/x.py"). Wrap them in
    // the same `a.reck-internal-link` anchors the markdown renderer emits, so
    // the transcript's single delegated Cmd-click handler opens them too.
    wrapFreeTextPaths(el);
    // A long user message (e.g. a pasted plan) is clamped behind "Show more"
    // so it doesn't dominate — via a height clip, NOT display:none, so the
    // search bar still finds the hidden text.
    return isLongText(text) ? clampable(el) : el;
  }

  // A slash command (/clear, /model, …) the user ran — a slim chip, not a
  // prose bubble. Distinct from tool activity, so it renders inline.
  function commandPillEl(name: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "transcript-command";
    el.textContent = `⌘ ${name}`;
    return el;
  }

  // A plan Claude presented via ExitPlanMode. Compact by design: a header,
  // the plan file path as a ⌘-clickable link, and the full markdown tucked in
  // a collapsed <details> so it never dominates the chat.
  function planCardEl(block: Extract<TranscriptBlock, { kind: "plan" }>): HTMLElement {
    const card = document.createElement("div");
    card.className = "transcript-plan";
    const head = document.createElement("div");
    head.className = "transcript-plan-head";
    head.textContent = "📋 Plan";
    card.appendChild(head);
    if (block.path) {
      const link = document.createElement("a");
      link.className = "reck-internal-link transcript-plan-path";
      link.setAttribute("href", block.path);
      link.setAttribute("title", "⌘+click to open");
      link.textContent = block.path;
      card.appendChild(link);
    }
    if (block.text) {
      const details = document.createElement("details");
      details.className = "transcript-plan-detail";
      const summary = document.createElement("summary");
      summary.textContent = "Show plan";
      details.appendChild(summary);
      const bodyEl = document.createElement("div");
      bodyEl.className = "transcript-md";
      md.mount(bodyEl, md.render(block.text));
      details.appendChild(bodyEl);
      card.appendChild(details);
    }
    return card;
  }

  // A question Claude asked via AskUserQuestion — surfaced, not buried in the
  // tool group. Question text + each option (label + description).
  function questionCardEl(block: Extract<TranscriptBlock, { kind: "question" }>): HTMLElement {
    const card = document.createElement("div");
    card.className = "transcript-question";
    for (const q of block.questions) {
      if (q.header) {
        const hd = document.createElement("div");
        hd.className = "transcript-question-header";
        hd.textContent = q.header;
        card.appendChild(hd);
      }
      const qEl = document.createElement("div");
      qEl.className = "transcript-question-text";
      qEl.textContent = `❓ ${q.question}`;
      card.appendChild(qEl);
      if (q.options.length > 0) {
        const list = document.createElement("ul");
        list.className = "transcript-question-options";
        for (const opt of q.options) {
          const li = document.createElement("li");
          const label = document.createElement("span");
          label.className = "transcript-question-option-label";
          label.textContent = opt.label;
          li.appendChild(label);
          if (opt.description) {
            const desc = document.createElement("span");
            desc.className = "transcript-question-option-desc";
            desc.textContent = opt.description;
            li.appendChild(desc);
          }
          list.appendChild(li);
        }
        card.appendChild(list);
      }
    }
    return card;
  }

  function planApprovedEl(): HTMLElement {
    const el = document.createElement("div");
    el.className = "transcript-plan-approved";
    el.textContent = "✓ Plan approved";
    return el;
  }

  // Wrap a tall block in a height-clipped container + "Show more" toggle. The
  // clip is CSS max-height/overflow (text stays in the DOM), so the search
  // subsystem still walks and matches the hidden text.
  function clampable(inner: HTMLElement): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "transcript-clampable transcript-clampable--clamped";
    inner.classList.add("transcript-clamp-body");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "transcript-clamp-toggle";
    btn.textContent = "Show more";
    btn.addEventListener("click", () => {
      const clamped = wrap.classList.toggle("transcript-clampable--clamped");
      btn.textContent = clamped ? "Show more" : "Show less";
    });
    wrap.appendChild(inner);
    wrap.appendChild(btn);
    return wrap;
  }

  // One row inside the collapsed tool group: a labelled <pre> for a
  // thinking / tool_use / tool_result block.
  function toolRow(className: string, label: string, text: string): HTMLElement {
    const row = document.createElement("div");
    row.className = className;
    const head = document.createElement("div");
    head.className = "transcript-tool-label";
    head.textContent = label;
    const pre = document.createElement("pre");
    pre.textContent = text;
    row.appendChild(head);
    row.appendChild(pre);
    return row;
  }

  function toolGroup(blocks: TranscriptBlock[]): HTMLElement {
    const toolCount = blocks.filter((b) => b.kind === "tool_use").length;
    const summaryText =
      toolCount > 0
        ? `🔧 ${toolCount} tool ${toolCount === 1 ? "call" : "calls"}`
        : "Thinking";
    const details = document.createElement("details");
    details.className = "transcript-tools";
    const summary = document.createElement("summary");
    summary.textContent = summaryText;
    details.appendChild(summary);
    for (const b of blocks) {
      if (b.kind === "thinking") details.appendChild(toolRow("transcript-thinking", "Thinking", b.text));
      else if (b.kind === "tool_use") details.appendChild(toolRow("transcript-tool", `Tool: ${b.name}`, b.input));
      else if (b.kind === "tool_result") details.appendChild(toolRow("transcript-tool-result", "Result", b.text));
    }
    return details;
  }

  function renderTurn(el: HTMLElement, turn: TranscriptTurn): void {
    el.className = `transcript-turn transcript-turn--${turn.role}`;
    el.replaceChildren();
    const label = document.createElement("div");
    label.className = "transcript-role";
    label.textContent = turn.role === "user" ? "You" : "Claude";
    el.appendChild(label);

    // Text Claude/you actually said renders inline, in order. All the
    // under-the-hood blocks (thinking / tool_use / tool_result) collapse
    // into a single expandable group after the text, so a turn reads as
    // prose with its tool calls tucked away.
    const toolBlocks: TranscriptBlock[] = [];
    for (const block of turn.blocks) {
      if (block.kind === "text") {
        el.appendChild(textBlockEl(turn.role, block.text));
      } else if (block.kind === "command") {
        el.appendChild(commandPillEl(block.name));
      } else if (block.kind === "plan") {
        el.appendChild(planCardEl(block));
      } else if (block.kind === "question") {
        el.appendChild(questionCardEl(block));
      } else if (block.kind === "plan_approved") {
        el.appendChild(planApprovedEl());
      } else {
        toolBlocks.push(block);
      }
    }
    if (toolBlocks.length > 0) {
      el.appendChild(toolGroup(toolBlocks));
    }
  }

  function render(turns: readonly TranscriptTurn[], firstChanged: number): void {
    if (disposed) return;
    // Capture follow intent BEFORE mutating: were we reading the tail?
    const wasNearBottom =
      body.scrollTop + body.clientHeight >= body.scrollHeight - FOLLOW_THRESHOLD_PX;
    for (let i = firstChanged; i < turns.length; i++) {
      let el = turnEls[i];
      if (!el) {
        el = document.createElement("div");
        turnEls[i] = el;
        body.appendChild(el);
      }
      renderTurn(el, turns[i]);
    }
    while (turnEls.length > turns.length) {
      turnEls.pop()?.remove();
    }
    // Reveal the "Start of session" divider once the conversation has content.
    sessionStart.classList.toggle("transcript-session-start--hidden", turns.length === 0);
    scrollbar.update();
    if (wasNearBottom) {
      body.scrollTop = body.scrollHeight;
    }
  }

  function setStatus(s: TranscriptStatus): void {
    if (s.kind === "live") {
      status.classList.add("transcript-status--hidden");
      status.classList.remove("transcript-status--error");
      status.textContent = "";
      return;
    }
    status.textContent = s.message;
    status.classList.remove("transcript-status--hidden");
    status.classList.toggle("transcript-status--error", s.kind === "error");
  }

  return {
    root,
    body,
    render,
    setStatus,
    setMatches: (fractions) => scrollbar.setMatches(fractions),
    getSpeakSurface(): SpeakSurfaceAdapter {
      // The control bar mounts into the overlay's shared top-right stack
      // (alongside the search bar); `body` is the scrollable markdown root —
      // the (container, body) split the file viewer speaks with.
      if (!speakSurface) {
        speakSurface = new MarkdownSurfaceAdapter({ container: ensurePaneControls(root), body });
      }
      return speakSurface;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("keydown", onKeyDown);
      body.removeEventListener("click", onBodyClick);
      scrollbar.dispose();
      md.dispose();
      speakSurface?.dispose();
      root.remove();
    },
  };
}
