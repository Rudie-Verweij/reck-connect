// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { installUrlLinkProvider } from "./UrlLinkProvider";

interface FakeLink {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  activate: (event: MouseEvent, text: string) => void;
  hover?: (event: MouseEvent, text: string) => void;
  leave?: () => void;
}

function makeLine(text: string, isWrapped = false) {
  return { text, isWrapped, translateToString: () => text };
}

// Minimal fake xterm terminal — just what installUrlLinkProvider +
// collectWrapRun/projectMatchOntoLines read.
function makeFakeTerminal(lines: Array<string | { text: string; isWrapped: boolean }>) {
  const buf = lines.map((l) =>
    typeof l === "string" ? makeLine(l) : makeLine(l.text, l.isWrapped),
  );
  let registered: {
    provideLinks: (line: number, cb: (links: unknown[] | undefined) => void) => void;
  } | null = null;
  const term = {
    registerLinkProvider(p: unknown) {
      registered = p as typeof registered;
      return { dispose: vi.fn() };
    },
    buffer: { active: { getLine: (i: number) => buf[i], baseY: 0, cursorY: 0 } },
  };
  return { term, getRegistered: () => registered };
}

/** Drive provideLinks for a 1-indexed buffer line and return the links. */
function linksFor(
  getRegistered: () => { provideLinks: (n: number, cb: (l: unknown[] | undefined) => void) => void } | null,
  line1: number,
): FakeLink[] {
  let out: FakeLink[] = [];
  getRegistered()!.provideLinks(line1, (links) => {
    out = (links ?? []) as FakeLink[];
  });
  return out;
}

describe("installUrlLinkProvider", () => {
  it("emits a link for an http/https URL in the line", () => {
    const { term, getRegistered } = makeFakeTerminal(["open https://example.com/docs now"]);
    installUrlLinkProvider(term as never, { onActivateUrl: vi.fn() });
    const links = linksFor(getRegistered, 1);
    expect(links.length).toBe(1);
    expect(links[0].text).toBe("https://example.com/docs");
  });

  it("⌘-click activates onActivateUrl with the URL; plain click does not", () => {
    const onActivateUrl = vi.fn();
    const { term, getRegistered } = makeFakeTerminal(["see https://a.com/x"]);
    installUrlLinkProvider(term as never, { onActivateUrl });
    const link = linksFor(getRegistered, 1)[0];

    link.activate({ metaKey: false } as MouseEvent, link.text);
    expect(onActivateUrl).not.toHaveBeenCalled();

    link.activate({ metaKey: true } as MouseEvent, link.text);
    expect(onActivateUrl).toHaveBeenCalledTimes(1);
    expect(onActivateUrl.mock.calls[0][0]).toBe("https://a.com/x");
  });

  it("emits no links for a line without URLs", () => {
    const { term, getRegistered } = makeFakeTerminal(["just some ./path/file.ts text"]);
    installUrlLinkProvider(term as never, { onActivateUrl: vi.fn() });
    expect(linksFor(getRegistered, 1)).toEqual([]);
  });

  it("hover shows a '⌘+click to open in browser' tooltip; leave hides it", () => {
    document.body.innerHTML = "";
    const { term, getRegistered } = makeFakeTerminal(["see https://a.com/x"]);
    installUrlLinkProvider(term as never, { onActivateUrl: vi.fn() });
    const link = linksFor(getRegistered, 1)[0];

    link.hover!({ clientX: 10, clientY: 10 } as MouseEvent, link.text);
    const tip = document.querySelector(".reck-link-tooltip") as HTMLElement | null;
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toBe("⌘+click to open in browser");
    expect(tip!.style.display).toBe("block");

    link.leave!();
    expect((document.querySelector(".reck-link-tooltip") as HTMLElement).style.display).toBe("none");
  });

  it("disposes the registered provider", () => {
    const { term } = makeFakeTerminal(["https://x.com"]);
    const handle = installUrlLinkProvider(term as never, { onActivateUrl: vi.fn() });
    expect(() => handle.dispose()).not.toThrow();
  });
});
