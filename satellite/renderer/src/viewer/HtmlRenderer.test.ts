// @vitest-environment jsdom
// satellite/renderer/src/viewer/HtmlRenderer.test.ts
import { describe, it, expect } from "vitest";
import { createHtmlRenderer } from "./HtmlRenderer";

const parse = (html: string): Document =>
  new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");

describe("createHtmlRenderer.render", () => {
  it("keeps structural tags and inline styles", () => {
    const r = createHtmlRenderer();
    const doc = parse(
      r.render('<div class="card"><section style="color:red">hi</section></div>'),
    );
    expect(doc.querySelector("div.card")).not.toBeNull();
    const section = doc.querySelector("section");
    expect(section).not.toBeNull();
    expect(section?.getAttribute("style")).toContain("color");
  });

  it("keeps <style> blocks", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render("<style>.a{color:red}</style><div class='a'>x</div>"));
    expect(doc.querySelector("style")).not.toBeNull();
    expect(doc.querySelector("style")?.textContent).toContain(".a");
  });

  it("strips <script> but keeps sibling content", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render("<script>alert(1)</script><h1>Title</h1>"));
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(doc.querySelectorAll("h1").length).toBe(1);
  });

  it("strips on* event-handler attributes", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render('<img src="x" onerror="alert(1)">'));
    doc.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
      }
    });
  });

  it("strips <iframe>, <object>, <embed>, and <form>", () => {
    const r = createHtmlRenderer();
    const doc = parse(
      r.render(
        "<iframe src='e'></iframe><object></object><embed><form action='/x'><input></form>",
      ),
    );
    expect(doc.querySelectorAll("iframe,object,embed,form").length).toBe(0);
  });

  it("drops javascript: hrefs", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render('<a href="javascript:alert(1)">x</a>'));
    doc.querySelectorAll("a[href]").forEach((a) => {
      expect((a.getAttribute("href") ?? "").toLowerCase().startsWith("javascript:")).toBe(
        false,
      );
    });
  });

  it("strips <base>", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render('<base href="https://evil/">'));
    expect(doc.querySelectorAll("base").length).toBe(0);
  });

  it("strips <meta http-equiv=refresh>", () => {
    const r = createHtmlRenderer();
    const doc = parse(
      r.render('<meta http-equiv="refresh" content="0;url=https://evil">'),
    );
    expect(doc.querySelectorAll("meta").length).toBe(0);
  });

  it("strips target and ping from <a>", () => {
    const r = createHtmlRenderer();
    const doc = parse(
      r.render('<a href="./x" target="_blank" ping="https://evil">x</a>'),
    );
    const a = doc.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.hasAttribute("target")).toBe(false);
    expect(a?.hasAttribute("ping")).toBe(false);
  });

  it("strips formaction from <button>", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render('<button formaction="https://evil">b</button>'));
    const button = doc.querySelector("button");
    if (button) {
      expect(button.hasAttribute("formaction")).toBe(false);
    }
  });

  it("strips srcdoc", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render('<div srcdoc="x">y</div>'));
    const el = doc.querySelector("div");
    expect(el).not.toBeNull();
    expect(el?.hasAttribute("srcdoc")).toBe(false);
  });

  it("neutralizes an external <img src> (no live src, parked instead)", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render("<img src='https://tracker.example/y.png'>"));
    const img = doc.querySelector("img");
    expect(img).not.toBeNull();
    // The live src must NOT survive — nothing fetches until consent.
    expect(img?.hasAttribute("src")).toBe(false);
    expect(img?.getAttribute("data-reck-blocked-src")).toBe(
      "https://tracker.example/y.png",
    );
  });

  it("keeps a relative <img src> live (only external refs are gated)", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render("<img src='./a.png'>"));
    const img = doc.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("./a.png");
    expect(img?.hasAttribute("data-reck-blocked-src")).toBe(false);
  });
});
