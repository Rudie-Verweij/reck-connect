// `TranscriptView` — the "History" overlay for a Claude pane. Renders
// the parsed session transcript in a DOM scroll container mounted over
// the pane's terminal (the xterm keeps running underneath), which is
// what makes the scrollbar *exact*: the browser lays the turns out at
// the pane's real width, so scrollHeight/clientHeight are true at any
// size and the truthful OverlayScrollbar mode (thumb, drag-to-seek,
// resize) works unchanged — no estimation anywhere. Shell mirrors the
// file viewer's buildShell: positioned root → header + scrollable body.
//
// Rendering is incremental: one container element per turn, and
// `render(turns, firstChanged)` only (re)paints from `firstChanged`,
// so a live tail appends without re-rendering the whole chat. Assistant
// text goes through the shared MarkdownRenderer (sanitized); user text
// is rendered as plain text (people type text, not markup). Thinking /
// tool_use / tool_result blocks fold into collapsed <details>.

import { createMarkdownRenderer, type MarkdownRenderer } from "../viewer/MarkdownRenderer";
import { createOverlayScrollbar, type OverlayScrollbar } from "../search/OverlayScrollbar";
import { domScrollSurface } from "../search/scrollSurfaces";
import type { TranscriptTurn, TranscriptBlock } from "./parseTranscript";

export interface TranscriptViewOptions {
  /** Positioned pane wrapper the overlay covers. */
  host: HTMLElement;
  /** Header label — typically the pane title. */
  title: string;
  /** Invoked on the close button or Escape. Owner unmounts via dispose(). */
  onClose(): void;
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
  dispose(): void;
}

/** How close to the bottom (px) still counts as "following the tail". */
const FOLLOW_THRESHOLD_PX = 40;

export function createTranscriptView(opts: TranscriptViewOptions): TranscriptViewHandle {
  // `reck-native-scroll` opts the overlay out of the pane wrapper's
  // TUI wheel→PgUp/PgDn remap (OverlayScrollbar capture listener) so
  // the transcript body scrolls natively.
  const root = document.createElement("div");
  root.className = "transcript-view reck-native-scroll";

  const header = document.createElement("div");
  header.className = "transcript-header";
  const title = document.createElement("div");
  title.className = "transcript-title";
  title.textContent = opts.title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "transcript-close";
  close.title = "Back to live terminal (Esc)";
  close.textContent = "✕";
  close.addEventListener("click", () => opts.onClose());
  header.appendChild(title);
  header.appendChild(close);

  const status = document.createElement("div");
  status.className = "transcript-status transcript-status--hidden";

  const body = document.createElement("div");
  body.className = "transcript-body";

  root.appendChild(header);
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

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    opts.onClose();
  }
  document.addEventListener("keydown", onKeyDown);

  function renderBlock(turnRole: TranscriptTurn["role"], block: TranscriptBlock): HTMLElement {
    switch (block.kind) {
      case "text": {
        if (turnRole === "assistant") {
          const el = document.createElement("div");
          el.className = "transcript-md";
          md.mount(el, md.render(block.text));
          return el;
        }
        const el = document.createElement("div");
        el.className = "transcript-text";
        el.textContent = block.text;
        return el;
      }
      case "thinking":
        return foldedBlock("transcript-thinking", "Thinking", block.text);
      case "tool_use":
        return foldedBlock("transcript-tool", `Tool: ${block.name}`, block.input);
      case "tool_result":
        return foldedBlock("transcript-tool-result", "Result", block.text);
    }
  }

  function foldedBlock(className: string, label: string, text: string): HTMLElement {
    const details = document.createElement("details");
    details.className = className;
    const summary = document.createElement("summary");
    summary.textContent = label;
    const pre = document.createElement("pre");
    pre.textContent = text;
    details.appendChild(summary);
    details.appendChild(pre);
    return details;
  }

  function renderTurn(el: HTMLElement, turn: TranscriptTurn): void {
    el.className = `transcript-turn transcript-turn--${turn.role}`;
    el.replaceChildren();
    const label = document.createElement("div");
    label.className = "transcript-role";
    label.textContent = turn.role === "user" ? "You" : "Claude";
    el.appendChild(label);
    for (const block of turn.blocks) {
      el.appendChild(renderBlock(turn.role, block));
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
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("keydown", onKeyDown);
      scrollbar.dispose();
      md.dispose();
      root.remove();
    },
  };
}
