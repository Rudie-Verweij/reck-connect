import { describe, it, expect, vi } from "vitest";
import { installOscFilter, type OscParserLike } from "./osc-filter";

// Lightweight mock of xterm's parser — captures every registerOscHandler
// call so tests can inspect the installed block list and invoke the
// callbacks as if xterm's parser had hit an OSC in PTY output.
function mockParser() {
  const handlers = new Map<
    number,
    (data: string) => boolean | Promise<boolean>
  >();
  const parser: OscParserLike = {
    registerOscHandler(ident, cb) {
      handlers.set(ident, cb);
      return { dispose: () => handlers.delete(ident) };
    },
  };
  return { parser, handlers };
}

describe("installOscFilter", () => {
  it("registers block handlers for OSC 52 (clipboard write)", () => {
    const { parser, handlers } = mockParser();
    installOscFilter(parser);
    expect(handlers.has(52)).toBe(true);
  });

  it("registers block handlers for OSC 9 (notification)", () => {
    const { parser, handlers } = mockParser();
    installOscFilter(parser);
    expect(handlers.has(9)).toBe(true);
  });

  it("blocked OSC handlers return true so xterm skips default behaviour", async () => {
    const { parser, handlers } = mockParser();
    installOscFilter(parser);

    // OSC 52 ";c;<base64-secret>\x07" — clipboard-write payload.
    const osc52Result = await handlers.get(52)!(";c;aGVsbG8=");
    expect(osc52Result).toBe(true);

    // OSC 9 ";notification text\x07"
    const osc9Result = await handlers.get(9)!(";alert!");
    expect(osc9Result).toBe(true);
  });

  it("does NOT register handlers for common benign OSC codes", () => {
    const { parser, handlers } = mockParser();
    installOscFilter(parser);
    // OSC 0 (icon + title), OSC 2 (title), OSC 8 (hyperlink), OSC 10/11
    // (fg/bg colour) are widely used by normal TUI apps and must fall
    // through to xterm's defaults.
    for (const code of [0, 2, 8, 10, 11, 12, 104]) {
      expect(handlers.has(code)).toBe(false);
    }
  });

  it("returns disposables for every installed handler", () => {
    const { parser, handlers } = mockParser();
    const disposables = installOscFilter(parser);
    expect(disposables.length).toBeGreaterThanOrEqual(2);

    const blockedBefore = new Set(handlers.keys());
    for (const d of disposables) d.dispose();
    for (const code of blockedBefore) {
      expect(handlers.has(code)).toBe(false);
    }
  });

  it("disposables correspond to the block-list — not to every OSC code in the alphabet", () => {
    const { parser } = mockParser();
    const spy = vi.spyOn(parser, "registerOscHandler");
    installOscFilter(parser);
    // Current block list is exactly [52, 9]. If we ever extend it,
    // update the test and call out the change in the commit message
    // so reviewers see the scope expansion.
    const idents = spy.mock.calls.map((c) => c[0] as number).sort((a, b) => a - b);
    expect(idents).toEqual([9, 52]);
  });
});
