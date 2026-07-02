import { describe, it, expect, vi } from "vitest";
import { installOscFilter, type OscParserLike } from "./osc-filter";

// Lightweight mock of xterm's parser — captures every registerOscHandler
// call so tests can inspect the installed handlers and invoke the
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

// base64("hello") === "aGVsbG8="; base64("café" as UTF-8) === "Y2Fmw6k=".
describe("installOscFilter", () => {
  it("registers handlers for OSC 52 (clipboard) and OSC 9 (notification)", () => {
    const { parser, handlers } = mockParser();
    installOscFilter(parser);
    expect(handlers.has(52)).toBe(true);
    expect(handlers.has(9)).toBe(true);
  });

  it("OSC 52 WRITE: copies the decoded payload to the clipboard and consumes the sequence", async () => {
    const writeClipboard = vi.fn();
    const { parser, handlers } = mockParser();
    installOscFilter(parser, { writeClipboard });
    // OSC 52 "Pc;Pd" → "c;<base64('hello')>"
    const result = await handlers.get(52)!("c;aGVsbG8=");
    expect(result).toBe(true);
    expect(writeClipboard).toHaveBeenCalledWith("hello");
  });

  it("OSC 52 WRITE: tolerates a leading-empty selection and decodes UTF-8", async () => {
    const writeClipboard = vi.fn();
    const { parser, handlers } = mockParser();
    installOscFilter(parser, { writeClipboard });
    await handlers.get(52)!(";c;Y2Fmw6k=");
    expect(writeClipboard).toHaveBeenCalledWith("café");
  });

  it("OSC 52 READ query (Pd === '?') is blocked and never touches the clipboard", async () => {
    const writeClipboard = vi.fn();
    const { parser, handlers } = mockParser();
    installOscFilter(parser, { writeClipboard });
    // A read response would hand the pane the user's clipboard — exfil.
    const result = await handlers.get(52)!("c;?");
    expect(result).toBe(true); // consumed → nothing leaves the terminal
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("OSC 52 oversized write is blocked (bounds abuse)", async () => {
    const writeClipboard = vi.fn();
    const { parser, handlers } = mockParser();
    installOscFilter(parser, { writeClipboard, maxClipboardBytes: 8 });
    const result = await handlers.get(52)!("c;aGVsbG8gd29ybGQ="); // > 8 chars
    expect(result).toBe(true);
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("OSC 52 malformed base64 is swallowed without throwing", () => {
    const writeClipboard = vi.fn();
    const { parser, handlers } = mockParser();
    installOscFilter(parser, { writeClipboard });
    // "%%%" is not valid base64; the handler must not throw out of xterm's
    // parser loop, and must not write garbage.
    let result: boolean | Promise<boolean> = false;
    expect(() => {
      result = handlers.get(52)!("c;%%%");
    }).not.toThrow();
    expect(result).toBe(true);
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("OSC 9 (notification) is blocked", async () => {
    const { parser, handlers } = mockParser();
    installOscFilter(parser);
    expect(await handlers.get(9)!(";alert!")).toBe(true);
  });

  it("does NOT register handlers for common benign OSC codes", () => {
    const { parser, handlers } = mockParser();
    installOscFilter(parser);
    // OSC 0/2 (title), 8 (hyperlink), 10/11/12/104 (colours) are ubiquitous
    // in normal TUI apps and must fall through to xterm's defaults.
    for (const code of [0, 2, 8, 10, 11, 12, 104]) {
      expect(handlers.has(code)).toBe(false);
    }
  });

  it("returns disposables for every installed handler", () => {
    const { parser, handlers } = mockParser();
    const disposables = installOscFilter(parser);
    expect(disposables.length).toBeGreaterThanOrEqual(2);
    const before = new Set(handlers.keys());
    for (const d of disposables) d.dispose();
    for (const code of before) expect(handlers.has(code)).toBe(false);
  });

  it("registers exactly the OSC 9 + 52 idents", () => {
    const { parser } = mockParser();
    const spy = vi.spyOn(parser, "registerOscHandler");
    installOscFilter(parser);
    const idents = spy.mock.calls.map((c) => c[0] as number).sort((a, b) => a - b);
    expect(idents).toEqual([9, 52]);
  });
});
