// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { installSearchShortcuts } from "./searchShortcuts";

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function press(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { ...init, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

describe("installSearchShortcuts", () => {
  it("fires onFind on Cmd+F and Ctrl+F and prevents default", () => {
    const onFind = vi.fn();
    cleanup = installSearchShortcuts({ onFind });

    const cmd = press({ key: "f", metaKey: true });
    expect(onFind).toHaveBeenCalledTimes(1);
    expect(cmd.defaultPrevented).toBe(true);

    press({ key: "f", ctrlKey: true });
    expect(onFind).toHaveBeenCalledTimes(2);
  });

  it("ignores plain 'f', Shift+Cmd+F and Alt+Cmd+F", () => {
    const onFind = vi.fn();
    cleanup = installSearchShortcuts({ onFind });
    press({ key: "f" });
    press({ key: "f", metaKey: true, shiftKey: true });
    press({ key: "f", metaKey: true, altKey: true });
    expect(onFind).not.toHaveBeenCalled();
  });

  it("stops firing after the returned cleanup runs", () => {
    const onFind = vi.fn();
    const off = installSearchShortcuts({ onFind });
    off();
    press({ key: "f", metaKey: true });
    expect(onFind).not.toHaveBeenCalled();
  });
});
