// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTranscriptView, type TranscriptViewHandle } from "./TranscriptView";
import type { TranscriptTurn } from "./parseTranscript";

function turn(role: "user" | "assistant", text: string): TranscriptTurn {
  return { role, blocks: [{ kind: "text", text }] };
}

describe("TranscriptView", () => {
  let host: HTMLElement;
  let onClose: ReturnType<typeof vi.fn>;
  let view: TranscriptViewHandle;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    onClose = vi.fn();
    view = createTranscriptView({ host, title: "my-pane", onClose });
  });

  it("mounts an overlay with header title and scrollable body", () => {
    expect(host.querySelector(".transcript-view")).toBe(view.root);
    expect(view.root.querySelector(".transcript-title")?.textContent).toContain("my-pane");
    expect(view.body.classList.contains("transcript-body")).toBe(true);
  });

  it("renders user turns as escaped text and assistant turns as markdown", () => {
    view.render([turn("user", "<script>alert(1)</script> plain"), turn("assistant", "**bold** move")], 0);
    const turns = view.body.querySelectorAll(".transcript-turn");
    expect(turns).toHaveLength(2);
    // User content must be text, never parsed as HTML.
    expect(turns[0].querySelector("script")).toBeNull();
    expect(turns[0].textContent).toContain("<script>alert(1)</script> plain");
    // Assistant content is rendered markdown.
    expect(turns[1].querySelector("strong")?.textContent).toBe("bold");
  });

  it("appends incrementally without touching earlier turn elements", () => {
    view.render([turn("user", "one")], 0);
    const first = view.body.querySelector(".transcript-turn");
    view.render([turn("user", "one"), turn("assistant", "two")], 1);
    const after = view.body.querySelectorAll(".transcript-turn");
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(first); // same node — no full re-render
  });

  it("re-renders a merged turn in place", () => {
    view.render([turn("assistant", "partial")], 0);
    view.render(
      [{ role: "assistant", blocks: [{ kind: "text", text: "partial" }, { kind: "text", text: "more" }] }],
      0,
    );
    const turns = view.body.querySelectorAll(".transcript-turn");
    expect(turns).toHaveLength(1);
    expect(turns[0].textContent).toContain("more");
  });

  it("groups thinking/tool_use/tool_result into ONE collapsed group after the text", () => {
    view.render(
      [
        {
          role: "assistant",
          blocks: [
            { kind: "text", text: "Working on it." },
            { kind: "thinking", text: "hmm" },
            { kind: "tool_use", name: "Bash", input: '{"cmd":"ls"}' },
            { kind: "tool_result", text: "out" },
            { kind: "tool_use", name: "Read", input: "{}" },
            { kind: "tool_result", text: "file" },
          ],
        },
      ],
      0,
    );
    const turn = view.body.querySelector(".transcript-turn") as HTMLElement;
    // The text renders inline; the tool activity collapses into ONE group.
    expect(turn.querySelector(".transcript-md")?.textContent).toContain("Working on it.");
    const groups = turn.querySelectorAll("details.transcript-tools");
    expect(groups).toHaveLength(1);
    const group = groups[0] as HTMLDetailsElement;
    expect(group.open).toBe(false);
    // Summary counts the tool_use blocks (2), not results/thinking.
    expect(group.querySelector("summary")?.textContent).toContain("2 tool calls");
    expect(group.textContent).toContain("Bash");
    expect(group.textContent).toContain("Read");
    // The text block is NOT inside the collapsed group.
    expect(group.querySelector(".transcript-md")).toBeNull();
  });

  it("renders a user turn as plain text with no tool group", () => {
    view.render([{ role: "user", blocks: [{ kind: "text", text: "hello" }] }], 0);
    const turn = view.body.querySelector(".transcript-turn") as HTMLElement;
    expect(turn.classList.contains("transcript-turn--user")).toBe(true);
    expect(turn.querySelector("details")).toBeNull();
    expect(turn.textContent).toContain("hello");
  });

  it("follows the bottom only when already near it", () => {
    Object.defineProperty(view.body, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(view.body, "clientHeight", { value: 200, configurable: true });

    view.body.scrollTop = 790; // within follow threshold of the bottom
    view.render([turn("user", "new")], 0);
    expect(view.body.scrollTop).toBe(1000);

    view.body.scrollTop = 100; // reader scrolled up — do not yank
    view.render([turn("user", "new"), turn("assistant", "later")], 1);
    expect(view.body.scrollTop).toBe(100);
  });

  it("closes via the close button and via Escape", () => {
    (view.root.querySelector(".transcript-close") as HTMLElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows search match ticks via setMatches", () => {
    view.setMatches([0.25, 0.75]);
    expect(view.root.querySelectorAll(".reck-scrollbar-tick")).toHaveLength(2);
  });

  it("dispose removes the overlay and the Escape listener", () => {
    view.dispose();
    expect(host.querySelector(".transcript-view")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("setStatus shows loading/empty/error messages and 'live' hides the banner", () => {
    const status = () => view.root.querySelector(".transcript-status") as HTMLElement;

    view.setStatus({ kind: "loading", message: "Loading transcript…" });
    expect(status().textContent).toContain("Loading transcript…");
    expect(status().classList.contains("transcript-status--hidden")).toBe(false);

    view.setStatus({ kind: "error", message: "fetch failed (404) — retrying…" });
    expect(status().textContent).toContain("404");
    expect(status().classList.contains("transcript-status--error")).toBe(true);

    view.setStatus({ kind: "empty", message: "No transcript session found." });
    expect(status().textContent).toContain("No transcript session");
    expect(status().classList.contains("transcript-status--error")).toBe(false);

    view.setStatus({ kind: "live" });
    expect(status().classList.contains("transcript-status--hidden")).toBe(true);
  });
});
