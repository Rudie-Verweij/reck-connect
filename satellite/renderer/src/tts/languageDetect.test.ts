import { describe, it, expect } from "vitest";
import { detectLanguage } from "./languageDetect";

describe("detectLanguage", () => {
  it("detects Dutch prose", () => {
    expect(
      detectLanguage(
        "welke knoppen heb je? dat is een gewoon script dat via de server het resultaat terug geeft",
      ),
    ).toBe("nl");
  });

  it("detects English prose", () => {
    expect(
      detectLanguage(
        "the script sends a request to the server and prints the result that you asked for",
      ),
    ).toBe("en");
  });

  it("detects German prose", () => {
    expect(
      detectLanguage(
        "das ist ein einfaches Skript und es schickt die Anfrage an den Server, aber nicht mehr",
      ),
    ).toBe("de");
  });

  it("returns null for very short text", () => {
    expect(detectLanguage("hello world")).toBeNull();
  });

  it("returns null for code-like text with no clear language", () => {
    expect(
      detectLanguage("const foo = bar(); myFunc(x, y); return foo.baz[2];"),
    ).toBeNull();
  });
});
