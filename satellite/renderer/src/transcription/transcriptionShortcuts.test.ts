// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTranscriptionShortcuts } from "./transcriptionShortcuts";

function handlers() {
  return { onPressStart: vi.fn(), onPressEnd: vi.fn(), onSubmit: vi.fn() };
}

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
});

function press(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent("keydown", init));
}

describe("installTranscriptionShortcuts — Enter to send", () => {
  it("fires onSubmit for a bare Enter", () => {
    const h = handlers();
    uninstall = installTranscriptionShortcuts(h);
    press({ key: "Enter" });
    expect(h.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("ignores Enter with any modifier (that's a newline, not a send)", () => {
    const h = handlers();
    uninstall = installTranscriptionShortcuts(h);
    press({ key: "Enter", shiftKey: true });
    press({ key: "Enter", metaKey: true });
    press({ key: "Enter", ctrlKey: true });
    press({ key: "Enter", altKey: true });
    expect(h.onSubmit).not.toHaveBeenCalled();
  });

  it("does not preventDefault on Enter (the terminal must still submit)", () => {
    const h = handlers();
    uninstall = installTranscriptionShortcuts(h);
    const ev = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("starts a press on the ⌘⇧V chord", () => {
    const h = handlers();
    uninstall = installTranscriptionShortcuts(h);
    press({ key: "v", metaKey: true, shiftKey: true });
    expect(h.onPressStart).toHaveBeenCalledTimes(1);
  });
});
