import { describe, expect, it } from "vitest";
import { slugify } from "./add-project-dialog";

describe("slugify", () => {
  it("lowercases letters", () => {
    expect(slugify("Demo")).toBe("demo");
  });

  it("collapses non-alphanumeric runs to a single dash", () => {
    expect(slugify("My  Cool   Project!!!")).toBe("my-cool-project");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  --hello--  ")).toBe("hello");
  });

  it("returns empty string for names with no alphanumerics", () => {
    expect(slugify("   ")).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("preserves digits", () => {
    expect(slugify("Project 42")).toBe("project-42");
  });

  it("matches the daemon's derivation for common cases", () => {
    // These mirror cases from daemon/internal/config/slugify_test.go.
    expect(slugify("Reck Connect")).toBe("reck-connect");
    expect(slugify("CLV5")).toBe("clv5");
    expect(slugify("my/cool/repo")).toBe("my-cool-repo");
  });
});
