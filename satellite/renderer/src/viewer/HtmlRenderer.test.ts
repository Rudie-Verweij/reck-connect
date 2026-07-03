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
    expect(r.render("<style>.a{color:red}</style><div class='a'>x</div>")).toContain(
      "<style",
    );
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
});
