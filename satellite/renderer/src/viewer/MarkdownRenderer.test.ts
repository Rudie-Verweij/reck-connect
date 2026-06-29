// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMarkdownRenderer } from "./MarkdownRenderer";

describe("createMarkdownRenderer", () => {
  describe("render()", () => {
    it("renders headings", () => {
      const r = createMarkdownRenderer();
      const html = r.render("# Hello\n\nworld");
      expect(html).toContain("<h1");
      expect(html).toContain("Hello");
      expect(html).toContain("<p>world</p>");
    });

    it("renders unordered lists", () => {
      const r = createMarkdownRenderer();
      const html = r.render("- one\n- two\n- three");
      expect(html).toContain("<ul>");
      expect(html).toContain("<li>one</li>");
      expect(html).toContain("<li>two</li>");
    });

    it("renders ordered lists", () => {
      const r = createMarkdownRenderer();
      const html = r.render("1. first\n2. second");
      expect(html).toContain("<ol>");
      expect(html).toContain("<li>first</li>");
    });

    it("renders fenced code blocks with hljs classes when language is specified", () => {
      const r = createMarkdownRenderer();
      const html = r.render("```typescript\nconst x = 1;\n```");
      expect(html).toContain("hljs");
      expect(html).toContain("language-typescript");
    });

    it("renders fenced code blocks without a language as plain pre/code", () => {
      const r = createMarkdownRenderer();
      const html = r.render("```\nplain text\n```");
      expect(html).toContain("<pre");
      expect(html).toContain("<code");
      expect(html).toContain("plain text");
    });

    it("renders inline code with `code` tags", () => {
      const r = createMarkdownRenderer();
      const html = r.render("Use `npm install` to set up.");
      expect(html).toContain("<code>npm install</code>");
    });

    it("renders bold and italic", () => {
      const r = createMarkdownRenderer();
      const html = r.render("**bold** and *italic*");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<em>italic</em>");
    });

    it("renders task list items as checkboxes", () => {
      const r = createMarkdownRenderer();
      const html = r.render("- [ ] todo\n- [x] done");
      expect(html).toContain('type="checkbox"');
      // markdown-it-task-lists renders both checked and unchecked
      expect(html).toMatch(/checked/);
    });

    it("renders heading anchors via markdown-it-anchor", () => {
      const r = createMarkdownRenderer();
      const html = r.render("## A Section");
      // markdown-it-anchor adds an id derived from the heading text
      expect(html).toMatch(/id="a-section"/);
    });
  });

  describe("security", () => {
    /**
     * Parse rendered HTML into a real DOM tree and assert against the
     * parsed structure rather than substring-matching. Substring checks
     * give false positives on HTML-entity-encoded text like
     * `&lt;script&gt;` (which is harmless plain text, not a script tag).
     */
    const parse = (html: string): Document =>
      new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");

    it("emits no executable <script> element even when source contains one", () => {
      const r = createMarkdownRenderer();
      const html = r.render("<script>alert(1)</script>\n\n# Title");
      const doc = parse(html);
      expect(doc.querySelectorAll("script").length).toBe(0);
      // The heading should still be there.
      expect(doc.querySelectorAll("h1").length).toBe(1);
    });

    it("emits no element with on* event-handler attributes", () => {
      const r = createMarkdownRenderer();
      const html = r.render('![x](x" onerror="alert(1))');
      const doc = parse(html);
      doc.querySelectorAll("*").forEach((el) => {
        for (const attr of Array.from(el.attributes)) {
          expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
        }
      });
    });

    it("emits no <iframe> when markdown source contains one (html: false)", () => {
      const r = createMarkdownRenderer();
      const html = r.render("<iframe src='evil.com'></iframe>\n\nbody");
      const doc = parse(html);
      expect(doc.querySelectorAll("iframe").length).toBe(0);
    });

    it("emits no anchor whose href is a javascript: URL", () => {
      const r = createMarkdownRenderer();
      const html = r.render("[evil](javascript:alert(1))");
      const doc = parse(html);
      doc.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href") ?? "";
        expect(href.toLowerCase().startsWith("javascript:")).toBe(false);
      });
    });
  });

  describe("link annotation", () => {
    it("marks relative-path links with a reck-internal-link class", () => {
      const r = createMarkdownRenderer();
      const html = r.render("[neighbor](./neighbor.md)");
      expect(html).toContain('class="reck-internal-link"');
      expect(html).toContain('href="./neighbor.md"');
    });

    it("marks absolute filesystem links with reck-internal-link", () => {
      const r = createMarkdownRenderer();
      const html = r.render("[abs](/tmp/x.md)");
      expect(html).toContain('class="reck-internal-link"');
    });

    it("leaves external http(s) URLs without the internal-link class", () => {
      const r = createMarkdownRenderer();
      const html = r.render("[ext](https://example.com)");
      expect(html).not.toContain("reck-internal-link");
      expect(html).toContain('href="https://example.com"');
    });
  });

  describe("mount() click interception", () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
    });

    it("fires onLinkActivate for Cmd+click on internal links", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      const html = r.render("[neighbor](./neighbor.md)");
      r.mount(container, html);

      const a = container.querySelector("a.reck-internal-link") as HTMLAnchorElement;
      expect(a).not.toBeNull();
      const ev = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      });
      a.dispatchEvent(ev);
      expect(onLinkActivate).toHaveBeenCalledTimes(1);
      expect(onLinkActivate.mock.calls[0][0]).toBe("./neighbor.md");
    });

    it("does NOT fire onLinkActivate for a plain click", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      const html = r.render("[neighbor](./neighbor.md)");
      r.mount(container, html);

      const a = container.querySelector("a.reck-internal-link") as HTMLAnchorElement;
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      a.dispatchEvent(ev);
      expect(onLinkActivate).not.toHaveBeenCalled();
    });

    // Round 8.4 Bug C — popup HTML view must require Cmd+click to activate
    // any link. Plain click must NEVER navigate the popup. Previously the
    // handler returned without preventDefault on non-metaKey clicks, so
    // browser-native anchor navigation fired for external URLs and in-page
    // `#fragment` jumps. These tests pin the new contract.
    it("plain click on an internal link calls preventDefault (Bug C)", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      const html = r.render("[neighbor](./neighbor.md)");
      r.mount(container, html);

      const a = container.querySelector("a.reck-internal-link") as HTMLAnchorElement;
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      a.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(onLinkActivate).not.toHaveBeenCalled();
    });

    it("plain click on an external link calls preventDefault and fires no callback (Bug C)", () => {
      const onLinkActivate = vi.fn();
      const onExternalActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate, onExternalActivate });
      const html = r.render("[ext](https://example.com)");
      r.mount(container, html);

      const a = container.querySelector('a[href="https://example.com"]') as
        | HTMLAnchorElement
        | null;
      expect(a).not.toBeNull();
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      a!.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(onLinkActivate).not.toHaveBeenCalled();
      expect(onExternalActivate).not.toHaveBeenCalled();
    });

    it("Cmd+click on an external link fires onExternalActivate (Bug C)", () => {
      const onLinkActivate = vi.fn();
      const onExternalActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate, onExternalActivate });
      const html = r.render("[ext](https://example.com)");
      r.mount(container, html);

      const a = container.querySelector('a[href="https://example.com"]') as
        | HTMLAnchorElement
        | null;
      expect(a).not.toBeNull();
      const ev = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      });
      a!.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(onExternalActivate).toHaveBeenCalledTimes(1);
      expect(onExternalActivate.mock.calls[0][0]).toBe("https://example.com");
      expect(onLinkActivate).not.toHaveBeenCalled();
    });

    it("plain click on an in-page #fragment calls preventDefault and fires no callback (Bug C)", () => {
      const onLinkActivate = vi.fn();
      const onExternalActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate, onExternalActivate });
      // markdown-it-anchor adds id attributes to headings; a manual
      // markdown link to a fragment renders as <a href="#section">.
      const html = r.render("[jump](#section)");
      r.mount(container, html);

      const a = container.querySelector('a[href="#section"]') as
        | HTMLAnchorElement
        | null;
      expect(a).not.toBeNull();
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      a!.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(onLinkActivate).not.toHaveBeenCalled();
      expect(onExternalActivate).not.toHaveBeenCalled();
    });

    it("Cmd+click on an in-page #fragment is a no-op (Bug C — no same-page navigation)", () => {
      const onLinkActivate = vi.fn();
      const onExternalActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate, onExternalActivate });
      const html = r.render("[jump](#section)");
      r.mount(container, html);

      const a = container.querySelector('a[href="#section"]') as
        | HTMLAnchorElement
        | null;
      expect(a).not.toBeNull();
      const ev = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      });
      a!.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(onLinkActivate).not.toHaveBeenCalled();
      expect(onExternalActivate).not.toHaveBeenCalled();
    });

    it("prevents default navigation on Cmd+click", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      const html = r.render("[neighbor](./neighbor.md)");
      r.mount(container, html);

      const a = container.querySelector("a.reck-internal-link") as HTMLAnchorElement;
      const ev = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      });
      a.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    });

    it("dispose() removes the click handler", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      const html = r.render("[n](./n.md)");
      r.mount(container, html);
      r.dispose();

      const a = container.querySelector("a.reck-internal-link") as HTMLAnchorElement;
      a.dispatchEvent(new MouseEvent("click", { metaKey: true, bubbles: true }));
      expect(onLinkActivate).not.toHaveBeenCalled();
    });

    it("works with multiple mounts (replaces content cleanly)", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      r.mount(container, r.render("[a](./a.md)"));
      r.mount(container, r.render("[b](./b.md)"));

      const links = container.querySelectorAll("a.reck-internal-link");
      expect(links.length).toBe(1);
      (links[0] as HTMLAnchorElement).dispatchEvent(
        new MouseEvent("click", { metaKey: true, bubbles: true }),
      );
      expect(onLinkActivate).toHaveBeenCalledWith(
        "./b.md",
        expect.any(MouseEvent),
      );
    });
  });

  /**
   * Round 6 Phase BB2 — free-text path linkifier in rendered markdown.
   *
   * Cmd-clicking a path printed in a pane works (xterm linkifier from
   * Round 2), but once a `.md` is rendered inside the popup, paths in
   * free text (`services/foo.ts`) are not underlined and not Cmd-clickable.
   * Extending `mount()` to walk text nodes, scan with detectPathsInLine,
   * and wrap matches in `<a class="reck-internal-link">` adds recursive
   * navigation: a path in the popup body opens a new popup.
   *
   * Skip text nodes inside `<code>`, `<pre>`, and existing `<a>` to avoid
   * double-wrapping. The existing Cmd-click handler already catches the
   * `.reck-internal-link` class.
   */
  describe("Round 6 Phase BB2 — mount() free-text linkifier", () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
    });

    it("wraps free-text path matches in <a class='reck-internal-link'>", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      // Note: `services/foo.ts` is a bare multi-segment path with
      // extension — detectPathsInLine matches it via the subdir-with-ext
      // branch (LinkDetector.ts:118).
      const html = r.render("Check the file at services/foo.ts please.");
      r.mount(container, html);

      const a = container.querySelector("a.reck-internal-link") as HTMLAnchorElement | null;
      expect(a).not.toBeNull();
      expect(a!.getAttribute("href")).toBe("services/foo.ts");
      expect(a!.textContent).toBe("services/foo.ts");
    });

    // Round 7 Phase HH — backticked paths in markdown are now linkified.
    // Claude tools and humans routinely wrap paths in backticks
    // (`services/foo.ts`), which renders to inline <code>. The Phase BB2
    // walker used to skip <code> ancestors, leaving the dominant case
    // un-linkified. Round 7 drops that skip; the path keeps its
    // inline-code styling AND becomes Cmd-clickable.
    it("DOES wrap paths inside <code> spans (Round 7 Phase HH)", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      const html = r.render("See `services/foo.ts` for details.");
      r.mount(container, html);

      const links = container.querySelectorAll("a.reck-internal-link");
      expect(links.length).toBe(1);
      const link = links[0] as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("services/foo.ts");
      // The link sits INSIDE the inline-code element so the gray box
      // styling is preserved.
      expect(link.closest("code")).not.toBeNull();
    });

    it("does NOT wrap paths inside <pre> code blocks", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      const html = r.render("```\nservices/foo.ts has the bug\n```");
      r.mount(container, html);

      const links = container.querySelectorAll("a.reck-internal-link");
      expect(links.length).toBe(0);
    });

    it("does NOT re-wrap text that's already inside an existing internal link", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      // The markdown link `[label](./neighbor.md)` already gets
      // class="reck-internal-link" via the renderer rule; the free-text
      // walker must skip text inside any <a>.
      const html = r.render("see [services/foo.ts](./neighbor.md) note");
      r.mount(container, html);

      const links = container.querySelectorAll("a.reck-internal-link");
      // One link (the markdown one), not two (would happen if the walker
      // wrapped the link's text node too).
      expect(links.length).toBe(1);
      expect(links[0].getAttribute("href")).toBe("./neighbor.md");
    });

    it("Cmd-click on a wrapped free-text path fires onLinkActivate with the raw path", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      const html = r.render("path: services/foo.ts");
      r.mount(container, html);

      const a = container.querySelector("a.reck-internal-link") as HTMLAnchorElement;
      expect(a).not.toBeNull();
      a.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      );
      expect(onLinkActivate).toHaveBeenCalledTimes(1);
      expect(onLinkActivate.mock.calls[0][0]).toBe("services/foo.ts");
    });

    it("handles multiple matches in the same paragraph", () => {
      const onLinkActivate = vi.fn();
      const r = createMarkdownRenderer({ onLinkActivate });
      const html = r.render("see services/foo.ts and ~/notes.md for context");
      r.mount(container, html);

      const links = container.querySelectorAll("a.reck-internal-link");
      expect(links.length).toBe(2);
      const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
      expect(hrefs).toEqual(["services/foo.ts", "~/notes.md"]);
    });
  });

  /**
   * Round 7 Phase FF — native hover tooltip on path links.
   *
   * The user discovered Cmd-click by trial. Now every path-link
   * element carries a `title="⌘+click to open"` attribute so the OS
   * surfaces the hint after ~1s of hover. Same string for both the
   * free-text wrapped anchors (Phase BB2) and markdown native links
   * (`[label](./x.md)` rendered by markdown-it's link_open rule).
   */
  describe("Round 7 Phase FF — native title tooltip", () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
    });

    it("sets title='⌘+click to open' on free-text wrapped path anchors", () => {
      const r = createMarkdownRenderer({ onLinkActivate: vi.fn() });
      const html = r.render("see services/foo.ts for the adapter");
      r.mount(container, html);
      const a = container.querySelector(
        "a.reck-internal-link",
      ) as HTMLAnchorElement | null;
      expect(a).not.toBeNull();
      expect(a!.getAttribute("title")).toBe("⌘+click to open");
    });

    it("sets title='⌘+click to open' on markdown native internal links", () => {
      const r = createMarkdownRenderer({ onLinkActivate: vi.fn() });
      const html = r.render("[label](./neighbor.md)");
      r.mount(container, html);
      const a = container.querySelector(
        "a.reck-internal-link",
      ) as HTMLAnchorElement | null;
      expect(a).not.toBeNull();
      expect(a!.getAttribute("title")).toBe("⌘+click to open");
    });
  });
});
