import { describe, it, expect } from "vitest";
import { tokenizeClaudeArgs } from "./tokenize";

describe("tokenizeClaudeArgs", () => {
  it("splits on whitespace", () => {
    expect(tokenizeClaudeArgs("--a --b --c")).toEqual(["--a", "--b", "--c"]);
  });
  it("collapses repeated whitespace", () => {
    expect(tokenizeClaudeArgs("  --a    --b\t--c\n--d")).toEqual([
      "--a",
      "--b",
      "--c",
      "--d",
    ]);
  });
  it("handles --flag=value as one token", () => {
    expect(tokenizeClaudeArgs("--model=claude-opus-4-7")).toEqual(["--model=claude-opus-4-7"]);
  });
  it("supports double-quoted strings with spaces", () => {
    expect(tokenizeClaudeArgs(`--append-system-prompt "be terse"`)).toEqual([
      "--append-system-prompt",
      "be terse",
    ]);
  });
  it("supports single-quoted strings", () => {
    expect(tokenizeClaudeArgs(`--x 'a b'`)).toEqual(["--x", "a b"]);
  });
  it("supports backslash-escapes in double quotes", () => {
    expect(tokenizeClaudeArgs(`--x "a\\"b"`)).toEqual(["--x", `a"b`]);
  });
  it("rejects unclosed double quote", () => {
    expect(() => tokenizeClaudeArgs(`--x "oops`)).toThrow(/unclosed double quote/);
  });
  it("rejects unclosed single quote", () => {
    expect(() => tokenizeClaudeArgs(`--x 'oops`)).toThrow(/unclosed single quote/);
  });
  it("treats empty string as no tokens", () => {
    expect(tokenizeClaudeArgs("")).toEqual([]);
    expect(tokenizeClaudeArgs("   \t  ")).toEqual([]);
  });
});
