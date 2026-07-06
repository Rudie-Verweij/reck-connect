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
    view = createTranscriptView({ host, onClose });
  });

  it("mounts an overlay with a scrollable body and no header bar", () => {
    expect(host.querySelector(".transcript-view")).toBe(view.root);
    expect(view.root.querySelector(".transcript-header")).toBeNull();
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

  it("closes via Escape", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
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

  it("renders a command block as a slim pill, not prose or a tool group", () => {
    view.render([{ role: "user", blocks: [{ kind: "command", name: "/clear" }] }], 0);
    const t = view.body.querySelector(".transcript-turn") as HTMLElement;
    const pill = t.querySelector(".transcript-command");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain("/clear");
    // A command is not tool activity — never folded into the tool group.
    expect(t.querySelector("details.transcript-tools")).toBeNull();
  });

  it("linkifies file paths in user plain-text turns as reck-internal-link anchors", () => {
    view.render([{ role: "user", blocks: [{ kind: "text", text: "look at services/gpu/ovh.py please" }] }], 0);
    const t = view.body.querySelector(".transcript-turn--user") as HTMLElement;
    const link = t.querySelector("a.reck-internal-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("services/gpu/ovh.py");
    // Still plain text around the link (user prose is never parsed as markdown).
    expect(t.textContent).toContain("look at");
    expect(t.textContent).toContain("please");
  });

  it("shows a start-of-session divider as the first body element with the short session id", () => {
    const v = createTranscriptView({
      host,
      onClose,
      sessionId: "abcd1234-5678-90ab-cdef-000000000000",
    });
    v.render([turn("user", "hi")], 0);
    const first = v.body.firstElementChild as HTMLElement;
    expect(first.classList.contains("transcript-session-start")).toBe(true);
    expect(first.textContent?.toLowerCase()).toContain("start of session");
    expect(first.textContent).toContain("abcd1234");
    v.dispose();
  });

  it("opens an internal path on ⌘+click and prevents navigation on plain click", () => {
    const onLinkActivate = vi.fn();
    const onExternalActivate = vi.fn();
    const v = createTranscriptView({ host, onClose, onLinkActivate, onExternalActivate });
    v.render([{ role: "user", blocks: [{ kind: "text", text: "see services/gpu/ovh.py" }] }], 0);
    const link = v.body.querySelector("a.reck-internal-link") as HTMLAnchorElement;
    expect(link).not.toBeNull();

    // Plain click never opens, but navigation to the file href is prevented.
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(plain);
    expect(onLinkActivate).not.toHaveBeenCalled();
    expect(plain.defaultPrevented).toBe(true);

    // ⌘+click opens the internal path.
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    expect(onLinkActivate).toHaveBeenCalledWith("services/gpu/ovh.py", expect.any(MouseEvent));
    expect(onExternalActivate).not.toHaveBeenCalled();
    v.dispose();
  });

  it("renders a plan block as a compact card: clickable path + collapsed full text", () => {
    view.render(
      [{ role: "assistant", blocks: [{ kind: "plan", text: "# Big Plan\n\nlots of detail", path: ".claude/plans/x.md" }] }],
      0,
    );
    const t = view.body.querySelector(".transcript-turn") as HTMLElement;
    const card = t.querySelector(".transcript-plan") as HTMLElement;
    expect(card).not.toBeNull();
    // The plan path is a ⌘-clickable internal link.
    const link = card.querySelector("a.reck-internal-link");
    expect(link?.getAttribute("href")).toBe(".claude/plans/x.md");
    // The full plan text is collapsed (not shown "extensively"), but present.
    const details = card.querySelector("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("lots of detail");
    // Never folded into the generic tool group.
    expect(t.querySelector("details.transcript-tools")).toBeNull();
  });

  it("renders a question block with the question text and its options", () => {
    view.render(
      [
        {
          role: "assistant",
          blocks: [
            {
              kind: "question",
              questions: [
                { question: "Which approach?", header: "Approach", options: [{ label: "A", description: "first" }, { label: "B" }] },
              ],
            },
          ],
        },
      ],
      0,
    );
    const card = view.body.querySelector(".transcript-question") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Which approach?");
    expect(card.textContent).toContain("A");
    expect(card.textContent).toContain("first");
    expect(card.textContent).toContain("B");
    expect(view.body.querySelector("details.transcript-tools")).toBeNull();
  });

  it("renders a plan_approved block as a slim chip", () => {
    view.render([{ role: "assistant", blocks: [{ kind: "plan_approved" }] }], 0);
    const chip = view.body.querySelector(".transcript-plan-approved");
    expect(chip).not.toBeNull();
    expect(chip?.textContent?.toLowerCase()).toContain("approved");
  });

  it("clamps a long user turn behind Show more, keeping the full text in the DOM (searchable)", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    view.render([{ role: "user", blocks: [{ kind: "text", text: long }] }], 0);
    const t = view.body.querySelector(".transcript-turn--user") as HTMLElement;
    const clampable = t.querySelector(".transcript-clampable") as HTMLElement;
    expect(clampable).not.toBeNull();
    expect(clampable.classList.contains("transcript-clampable--clamped")).toBe(true);
    // Full text stays in the DOM (clipped, not display:none) so search finds it.
    expect(t.textContent).toContain("line 29");
    const btn = t.querySelector(".transcript-clamp-toggle") as HTMLButtonElement;
    expect(btn.textContent).toBe("Show more");
    btn.click();
    expect(clampable.classList.contains("transcript-clampable--clamped")).toBe(false);
    expect(btn.textContent).toBe("Show less");
  });

  it("does not clamp a short user turn", () => {
    view.render([{ role: "user", blocks: [{ kind: "text", text: "just a short message" }] }], 0);
    const t = view.body.querySelector(".transcript-turn--user") as HTMLElement;
    expect(t.querySelector(".transcript-clampable")).toBeNull();
  });

  it("exposes a cached markdown speak surface over the body, disposed with the view", () => {
    const surface = view.getSpeakSurface();
    expect(surface.kind).toBe("markdown");
    // The control bar mounts into the overlay's shared top-right stack.
    const stack = view.root.querySelector(".pane-controls");
    expect(stack).not.toBeNull();
    expect(surface.getContainerEl()).toBe(stack);
    // Same instance on repeat calls (one highlight overlay, not N).
    expect(view.getSpeakSurface()).toBe(surface);
    const disposeSpy = vi.spyOn(surface, "dispose");
    view.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("routes external links to onExternalActivate on ⌘+click", () => {
    const onLinkActivate = vi.fn();
    const onExternalActivate = vi.fn();
    const v = createTranscriptView({ host, onClose, onLinkActivate, onExternalActivate });
    v.render([{ role: "assistant", blocks: [{ kind: "text", text: "[docs](https://example.com/x)" }] }], 0);
    // External markdown links render as a bare <a> (no reck-internal-link class).
    const link = v.body.querySelector('a[href="https://example.com/x"]') as HTMLAnchorElement;
    expect(link?.getAttribute("href")).toBe("https://example.com/x");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    expect(onExternalActivate).toHaveBeenCalledWith("https://example.com/x", expect.any(MouseEvent));
    expect(onLinkActivate).not.toHaveBeenCalled();
    v.dispose();
  });
});
