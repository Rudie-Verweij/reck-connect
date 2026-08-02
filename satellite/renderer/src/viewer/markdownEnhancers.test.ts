// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import {
  MERMAID_SELECTOR,
  MERMAID_HOST_CLASS,
  hasMermaidBlocks,
  hasMathDelimiters,
  enhanceMermaid,
  enhanceMath,
  type MermaidLike,
} from "./markdownEnhancers";

// jsdom has no layout engine, so these tests deliberately do NOT assert that a
// diagram or an equation *looks* right — they assert the contract around the
// libraries: when we bother loading them, that we never load them otherwise,
// what config we hand them, and that a stale container is left alone. The
// visual half is proved by e2e/markdown-viewer.spec.ts in a real browser.

function mount(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const MERMAID_FENCE =
  '<pre><code class="language-mermaid">flowchart TD\nA--&gt;B\n</code></pre>';

function fakeMermaid(): MermaidLike & {
  initialize: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
} {
  return {
    initialize: vi.fn(),
    run: vi.fn().mockResolvedValue(undefined),
  };
}

describe("hasMermaidBlocks", () => {
  it("is true for a rendered mermaid fence", () => {
    expect(hasMermaidBlocks(mount(MERMAID_FENCE))).toBe(true);
  });

  it("is false for a fence in another language", () => {
    const el = mount(
      '<pre class="hljs"><code class="hljs language-typescript">const x = 1;</code></pre>',
    );
    expect(hasMermaidBlocks(el)).toBe(false);
  });

  it("is false for prose that merely mentions mermaid", () => {
    expect(hasMermaidBlocks(mount("<p>we use mermaid for diagrams</p>"))).toBe(
      false,
    );
  });
});

describe("hasMathDelimiters", () => {
  it.each([
    ["inline dollars", "<p>energy is $E=mc^2$ exactly</p>"],
    ["display dollars", "<p>$$\\int_0^\\infty f(x)dx$$</p>"],
    ["inline parens", "<p>\\(a+b\\)</p>"],
    ["display brackets", "<p>\\[a+b\\]</p>"],
  ])("is true for %s", (_label, html) => {
    expect(hasMathDelimiters(mount(html))).toBe(true);
  });

  it("is false for plain prose", () => {
    expect(hasMathDelimiters(mount("<p>no math here at all</p>"))).toBe(false);
  });
});

describe("enhanceMermaid", () => {
  it("does not load the library when there are no mermaid fences", async () => {
    const loadMermaid = vi.fn();
    await enhanceMermaid(mount("<p>just prose</p>"), { loadMermaid });
    expect(loadMermaid).not.toHaveBeenCalled();
  });

  it("runs mermaid scoped to the container's fences, not the whole document", async () => {
    const mermaid = fakeMermaid();
    const container = mount(MERMAID_FENCE);
    // A second fence OUTSIDE the container must not be picked up — the file
    // viewer is a popup and other UI must never be walked.
    const other = mount(MERMAID_FENCE);

    await enhanceMermaid(container, { loadMermaid: async () => mermaid });

    expect(mermaid.run).toHaveBeenCalledTimes(1);
    const nodes = mermaid.run.mock.calls[0][0].nodes as ArrayLike<HTMLElement>;
    expect(nodes.length).toBe(1);
    expect(nodes[0]).toBe(container.querySelector(`.${MERMAID_HOST_CLASS}`));
    expect(other.querySelector(`.${MERMAID_HOST_CLASS}`)).toBeNull();
  });

  it("unwraps the fence so the diagram isn't rendered inside a code block", async () => {
    // mermaid.run() replaces a node's CONTENTS. Handing it the <code> element
    // would leave the finished SVG inheriting monospace + the code-block
    // background, so the fence is swapped for a plain container first.
    const container = mount(MERMAID_FENCE);
    await enhanceMermaid(container, { loadMermaid: async () => fakeMermaid() });

    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector(MERMAID_SELECTOR)).toBeNull();
    const host = container.querySelector(`.${MERMAID_HOST_CLASS}`);
    expect(host).not.toBeNull();
    // Source text is carried over, so an unparseable diagram degrades to
    // readable text instead of an empty gap.
    expect(host!.textContent).toContain("flowchart TD");
  });

  it("suppresses mermaid errors so one bad diagram can't break the render", async () => {
    const mermaid = fakeMermaid();
    await enhanceMermaid(mount(MERMAID_FENCE), {
      loadMermaid: async () => mermaid,
    });
    expect(mermaid.run.mock.calls[0][0].suppressErrors).toBe(true);
  });

  it("initializes with securityLevel strict and startOnLoad off", async () => {
    const mermaid = fakeMermaid();
    await enhanceMermaid(mount(MERMAID_FENCE), {
      loadMermaid: async () => mermaid,
    });
    const cfg = mermaid.initialize.mock.calls[0][0];
    // Mermaid writes SVG past DOMPurify; "strict" is the thing that makes that
    // safe. A regression here is a real XSS hole, not a style nit.
    expect(cfg.securityLevel).toBe("strict");
    expect(cfg.startOnLoad).toBe(false);
  });

  it.each([
    ["dark" as const, "dark"],
    ["default" as const, "default"],
  ])("passes the %s app theme through to mermaid", async (theme, expected) => {
    const mermaid = fakeMermaid();
    await enhanceMermaid(mount(MERMAID_FENCE), {
      theme,
      loadMermaid: async () => mermaid,
    });
    expect(mermaid.initialize.mock.calls[0][0].theme).toBe(expected);
  });

  it("abandons the pass when the container went stale mid-import", async () => {
    const mermaid = fakeMermaid();
    const container = mount(MERMAID_FENCE);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const pass = enhanceMermaid(container, {
      stillCurrent: () => false,
      loadMermaid: async () => {
        await gate;
        return mermaid;
      },
    });
    release();
    await pass;

    expect(mermaid.run).not.toHaveBeenCalled();
  });

  it("does not reject when mermaid itself throws", async () => {
    const mermaid = fakeMermaid();
    mermaid.run.mockRejectedValue(new Error("parse error"));
    await expect(
      enhanceMermaid(mount(MERMAID_FENCE), { loadMermaid: async () => mermaid }),
    ).resolves.toBeUndefined();
  });
});

describe("enhanceMath", () => {
  it("does not load the library when there are no delimiters", async () => {
    const loadKatex = vi.fn();
    await enhanceMath(mount("<p>just prose</p>"), { loadKatex });
    expect(loadKatex).not.toHaveBeenCalled();
  });

  it("renders math in the container with throwOnError off", async () => {
    const renderMathInElement = vi.fn();
    const container = mount("<p>$E=mc^2$</p>");

    await enhanceMath(container, { loadKatex: async () => renderMathInElement });

    expect(renderMathInElement).toHaveBeenCalledTimes(1);
    const [el, cfg] = renderMathInElement.mock.calls[0];
    expect(el).toBe(container);
    // A single malformed equation must degrade to red inline text, not blow up
    // the whole document render.
    expect(cfg.throwOnError).toBe(false);
  });

  it("emits HTML-only output so no duplicate MathML pollutes search and TTS", async () => {
    const renderMathInElement = vi.fn();
    await enhanceMath(mount("<p>$E=mc^2$</p>"), {
      loadKatex: async () => renderMathInElement,
    });
    expect(renderMathInElement.mock.calls[0][1].output).toBe("html");
  });

  it("covers inline and display delimiters in both notations", async () => {
    const renderMathInElement = vi.fn();
    await enhanceMath(mount("<p>$E=mc^2$</p>"), {
      loadKatex: async () => renderMathInElement,
    });
    const delimiters = renderMathInElement.mock.calls[0][1].delimiters as {
      left: string;
      right: string;
      display: boolean;
    }[];
    expect(delimiters).toEqual(
      expect.arrayContaining([
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ]),
    );
  });

  it("abandons the pass when the container went stale mid-import", async () => {
    const renderMathInElement = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const pass = enhanceMath(mount("<p>$E=mc^2$</p>"), {
      stillCurrent: () => false,
      loadKatex: async () => {
        await gate;
        return renderMathInElement;
      },
    });
    release();
    await pass;

    expect(renderMathInElement).not.toHaveBeenCalled();
  });

  it("does not reject when KaTeX itself throws", async () => {
    const renderMathInElement = vi.fn(() => {
      throw new Error("katex exploded");
    });
    await expect(
      enhanceMath(mount("<p>$E=mc^2$</p>"), {
        loadKatex: async () => renderMathInElement,
      }),
    ).resolves.toBeUndefined();
  });
});
