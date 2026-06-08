import { describe, expect, it } from "vitest";
import {
  askPaneKind,
  pickSession,
  relativeTime,
} from "./new-pane-dialog";
import type { SessionInfo } from "@proto/proto";
import type { HostRef } from "../host";

describe("relativeTime", () => {
  const now = new Date("2026-04-20T12:00:00Z");
  it("returns just now for sub-minute deltas", () => {
    expect(relativeTime("2026-04-20T11:59:45Z", now)).toBe("just now");
  });
  it("uses minutes under an hour", () => {
    expect(relativeTime("2026-04-20T11:25:00Z", now)).toBe("35m ago");
  });
  it("uses hours under a day", () => {
    expect(relativeTime("2026-04-20T04:00:00Z", now)).toBe("8h ago");
  });
  it("uses days under a month", () => {
    expect(relativeTime("2026-04-17T12:00:00Z", now)).toBe("3d ago");
  });
  it("handles malformed input", () => {
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});

describe("pickSession", () => {
  function mount() {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return root;
  }
  function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
    return {
      session_id: id,
      name: `name-${id}`,
      cwd: "/x",
      created_at: "2026-04-20T10:00:00Z",
      last_active_at: "2026-04-20T11:00:00Z",
      ...overrides,
    };
  }

  it("renders each session as a clickable row", () => {
    const root = mount();
    const sessions = [session("a"), session("b"), session("c")];
    void pickSession(root, sessions);
    const rows = root.querySelectorAll(".session-row");
    expect(rows.length).toBe(3);
    expect(rows[0].querySelector(".session-name")?.textContent).toBe("name-a");
    // Cleanup: fire cancel.
    root.querySelector<HTMLButtonElement>('button[data-action="cancel"]')?.click();
  });

  it("resolves with the clicked session", async () => {
    const root = mount();
    const sessions = [session("first"), session("second")];
    const p = pickSession(root, sessions);
    root.querySelectorAll<HTMLButtonElement>(".session-row")[1].click();
    await expect(p).resolves.toEqual(sessions[1]);
  });

  it("resolves null on cancel", async () => {
    const root = mount();
    const p = pickSession(root, [session("only")]);
    root.querySelector<HTMLButtonElement>('button[data-action="cancel"]')?.click();
    await expect(p).resolves.toBeNull();
  });

  it("renders empty-state message when no sessions", () => {
    const root = mount();
    void pickSession(root, []);
    expect(root.querySelector(".session-list")).toBeNull();
    expect(root.querySelector(".dialog-body")?.textContent ?? "").toContain("No past sessions");
    root.querySelector<HTMLButtonElement>('button[data-action="cancel"]')?.click();
  });

  it("escapes HTML in session name", () => {
    const root = mount();
    const evil = session("x", { name: "<script>bad</script>" });
    void pickSession(root, [evil]);
    const nameEl = root.querySelector(".session-name");
    expect(nameEl?.textContent).toBe("<script>bad</script>");
    expect(nameEl?.querySelector("script")).toBeNull();
    root.querySelector<HTMLButtonElement>('button[data-action="cancel"]')?.click();
  });
});

describe("askPaneKind — host picker (hybrid mode, phase 10)", () => {
  function mount() {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return root;
  }

  function cleanup(root: HTMLElement) {
    root.remove();
  }

  it("suppresses the host row in a station-only setup", async () => {
    const root = mount();
    const p = askPaneKind(root, {
      enabledHosts: { station: true, local: false },
      isHostReady: () => true,
    });
    expect(root.querySelector(".dialog-host-row")).toBeNull();
    root.querySelector<HTMLButtonElement>("button[data-kind='claude']")?.click();
    await expect(p).resolves.toEqual({ kind: "claude", host: "station" });
    cleanup(root);
  });

  it("suppresses the host row in a station-disabled setup (only local enabled)", async () => {
    const root = mount();
    const p = askPaneKind(root, {
      enabledHosts: { station: false, local: true },
      isHostReady: () => true,
    });
    expect(root.querySelector(".dialog-host-row")).toBeNull();
    root.querySelector<HTMLButtonElement>("button[data-kind='shell']")?.click();
    await expect(p).resolves.toEqual({ kind: "shell", host: "local" });
    cleanup(root);
  });

  it("renders both host chips in a hybrid setup, defaulting to station selected", async () => {
    const root = mount();
    const p = askPaneKind(root, {
      enabledHosts: { station: true, local: true },
      isHostReady: () => true,
    });
    const chips = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".host-chip"),
    );
    expect(chips.length).toBe(2);
    expect(chips[0].getAttribute("data-host")).toBe("station");
    expect(chips[0].classList.contains("selected")).toBe(true);
    expect(chips[1].classList.contains("selected")).toBe(false);
    root.querySelector<HTMLButtonElement>("button[data-kind='claude']")?.click();
    await expect(p).resolves.toEqual({ kind: "claude", host: "station" });
    cleanup(root);
  });

  it("clicking the local chip selects local and routes the choice", async () => {
    const root = mount();
    const p = askPaneKind(root, {
      enabledHosts: { station: true, local: true },
      isHostReady: () => true,
    });
    root.querySelector<HTMLButtonElement>(".host-chip[data-host='local']")?.click();
    const chips = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".host-chip"),
    );
    expect(chips.find((c) => c.getAttribute("data-host") === "local")?.classList.contains("selected")).toBe(true);
    expect(chips.find((c) => c.getAttribute("data-host") === "station")?.classList.contains("selected")).toBe(false);
    root.querySelector<HTMLButtonElement>("button[data-kind='shell']")?.click();
    await expect(p).resolves.toEqual({ kind: "shell", host: "local" });
    cleanup(root);
  });

  it("disables the local chip when local isn't ready; action buttons stay live for ready station", async () => {
    const root = mount();
    askPaneKind(root, {
      enabledHosts: { station: true, local: true },
      isHostReady: (h) => h === "station",
    });
    const localChip = root.querySelector<HTMLButtonElement>(
      ".host-chip[data-host='local']",
    );
    expect(localChip?.disabled).toBe(true);
    expect(localChip?.classList.contains("disabled")).toBe(true);
    const actionBtn = root.querySelector<HTMLButtonElement>(
      "button[data-kind='claude']",
    );
    // Default selection was station (ready) so actions must be enabled.
    expect(actionBtn?.disabled).toBe(false);
    // Cleanup
    root.querySelector<HTMLButtonElement>(".host-chip[data-host='station']")?.click();
    root.remove();
  });

  it("disables the action buttons when the selected host is not ready", async () => {
    const root = mount();
    askPaneKind(root, {
      enabledHosts: { station: false, local: true },
      isHostReady: () => false,
    });
    const actionBtns = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".dialog-buttons button"),
    );
    for (const b of actionBtns) expect(b.disabled).toBe(true);
    root.remove();
  });

  it("live-updates when a host's ready flag flips via subscribeReady", async () => {
    const root = mount();
    const subCbHolder: { fn: ((h: HostRef, r: boolean) => void) | null } = { fn: null };
    let localReady = false;
    askPaneKind(root, {
      enabledHosts: { station: true, local: true },
      isHostReady: (h) => (h === "station" ? true : localReady),
      subscribeReady: (cb) => {
        subCbHolder.fn = cb;
        return () => {};
      },
    });
    const localChip = root.querySelector<HTMLButtonElement>(
      ".host-chip[data-host='local']",
    );
    expect(localChip?.disabled).toBe(true);
    // Flip ready flag and notify subscriber.
    localReady = true;
    subCbHolder.fn?.("local", true);
    expect(localChip?.disabled).toBe(false);
    expect(localChip?.classList.contains("disabled")).toBe(false);
    root.remove();
  });

  it("auto-switches selection if the selected host becomes not-ready and another host is ready", () => {
    const root = mount();
    const subCbHolder: { fn: ((h: HostRef, r: boolean) => void) | null } = { fn: null };
    let stationReady = true;
    askPaneKind(root, {
      enabledHosts: { station: true, local: true },
      isHostReady: (h) => (h === "station" ? stationReady : true),
      subscribeReady: (cb) => {
        subCbHolder.fn = cb;
        return () => {};
      },
    });
    // Station was default-selected; flip it off.
    stationReady = false;
    subCbHolder.fn?.("station", false);
    const chips = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".host-chip"),
    );
    const localChip = chips.find((c) => c.getAttribute("data-host") === "local");
    expect(localChip?.classList.contains("selected")).toBe(true);
    // Actions should be enabled because the auto-selected host (local) is ready.
    const actionBtn = root.querySelector<HTMLButtonElement>(
      "button[data-kind='claude']",
    );
    expect(actionBtn?.disabled).toBe(false);
    root.remove();
  });

  it("toggles host via the 'h' keyboard shortcut in hybrid mode", () => {
    const root = mount();
    askPaneKind(root, {
      enabledHosts: { station: true, local: true },
      isHostReady: () => true,
    });
    // Default: station selected.
    const beforeChips = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".host-chip"),
    );
    expect(beforeChips.find((c) => c.getAttribute("data-host") === "station")?.classList.contains("selected")).toBe(true);
    // Fire the 'h' keydown and expect local to be selected.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "h" }));
    const afterChips = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".host-chip"),
    );
    expect(afterChips.find((c) => c.getAttribute("data-host") === "local")?.classList.contains("selected")).toBe(true);
    root.remove();
  });

  it("resolves null on Escape", async () => {
    const root = mount();
    const p = askPaneKind(root, {
      enabledHosts: { station: true, local: true },
      isHostReady: () => true,
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).resolves.toBeNull();
    root.remove();
  });

  it("ignores kind keyboard shortcuts when the selected host is not ready", async () => {
    const root = mount();
    const p = askPaneKind(root, {
      enabledHosts: { station: false, local: true },
      isHostReady: () => false,
    });
    // "c" would normally fire Claude — but local is not ready.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
    // Give the event loop a tick to ensure the promise isn't resolving.
    let resolved = false;
    void p.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    // Now cancel cleanly.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).resolves.toBeNull();
    root.remove();
  });
});

