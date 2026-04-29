import { describe, it, expect } from "vitest";
import { MountHint } from "./mount-hint";

describe("MountHint arming", () => {
  it("arms on a tailnet-down CONN failure while mount reports green", () => {
    const h = new MountHint("station");
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.isArmed()).toBe(true);
    expect(h.apply("green")).toBe("yellow");
  });

  it("also arms on 'Timed out' (abort on tailnet hang)", () => {
    const h = new MountHint("station");
    h.onConn("reconnecting", "Timed out", "green");
    expect(h.isArmed()).toBe(true);
  });

  it("never arms in local mode — no tailnet to go down", () => {
    const h = new MountHint("local");
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.isArmed()).toBe(false);
    expect(h.apply("green")).toBe("green");
  });

  it("does not arm when main already reports yellow — no stale green to mask", () => {
    const h = new MountHint("station");
    h.onConn("reconnecting", "Network unreachable", "yellow");
    expect(h.isArmed()).toBe(false);
  });

  it("does not arm on 401 — auth failure, tailnet is fine", () => {
    const h = new MountHint("station");
    h.onConn("reconnecting", "Unauthorized", "green");
    expect(h.isArmed()).toBe(false);
  });

  it("does not arm on app-level onPollSuccess failures", () => {
    const h = new MountHint("station");
    h.onConn("reconnecting", "projects fetch failed", "green");
    expect(h.isArmed()).toBe(false);
  });

  it("does not arm on user-initiated refresh (lastError cleared to null)", () => {
    const h = new MountHint("station");
    h.onConn("reconnecting", null, "green");
    expect(h.isArmed()).toBe(false);
  });

  it("does not arm while CONN is still 'connecting' on first boot", () => {
    const h = new MountHint("station");
    h.onConn("connecting", null, "green");
    expect(h.isArmed()).toBe(false);
  });
});

describe("MountHint disarming", () => {
  it("disarms on CONN recovery to connected", () => {
    const h = new MountHint("station");
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.isArmed()).toBe(true);
    h.onConn("connected", null, "green");
    expect(h.isArmed()).toBe(false);
  });

  it("disarms when CONN transitions to a non-tailnet reconnect reason", () => {
    // Started as tailnet drop → now an auth 401 reclassifies the reason.
    const h = new MountHint("station");
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.isArmed()).toBe(true);
    h.onConn("reconnecting", "Unauthorized", "green");
    expect(h.isArmed()).toBe(false);
  });

  it("disarms on user-initiated refresh (lastError cleared) even if previously armed", () => {
    const h = new MountHint("station");
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.isArmed()).toBe(true);
    h.onConn("reconnecting", null, "green");
    expect(h.isArmed()).toBe(false);
  });
});

describe("MountHint.apply", () => {
  it("only downgrades green; yellow and gray pass through", () => {
    const h = new MountHint("station");
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.apply("green")).toBe("yellow");
    expect(h.apply("yellow")).toBe("yellow");
    expect(h.apply("gray")).toBe("gray");
  });

  it("is a no-op when disarmed", () => {
    const h = new MountHint("station");
    expect(h.apply("green")).toBe("green");
    expect(h.apply("yellow")).toBe("yellow");
    expect(h.apply("gray")).toBe("gray");
  });
});

describe("MountHint sustained outage", () => {
  it("stays armed across repeated CONN failure polls during a real outage", () => {
    // This is the crucial property: during an ongoing tailnet outage,
    // CONN polls every 2 s keep failing and the hint must stay armed
    // the whole time. It does NOT get re-cleared on each new poll.
    const h = new MountHint("station");
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.isArmed()).toBe(true);
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.isArmed()).toBe(true);
    h.onConn("reconnecting", "Timed out", "green");
    expect(h.isArmed()).toBe(true);
  });

  it("only CONN recovery can disarm during sustained outage — not anything else", () => {
    const h = new MountHint("station");
    h.onConn("reconnecting", "Network unreachable", "green");
    // Several more reconnect ticks with mount still showing green
    // (cached sshfs attrs). Hint must stay armed.
    h.onConn("reconnecting", "Network unreachable", "green");
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.isArmed()).toBe(true);
    // Tailnet recovers, CONN polls succeed.
    h.onConn("connected", null, "green");
    expect(h.isArmed()).toBe(false);
  });

  it("is sticky through a green → yellow → cached-green mount sequence during outage", () => {
    // Without stickiness, a mid-outage authoritative yellow would
    // disarm the hint, and the next cached-green mount tick would
    // show up as false-green in the status bar (the scenario Codex
    // flagged in the 6th review pass).
    const h = new MountHint("station");
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.isArmed()).toBe(true);

    // Real stat times out → main pushes yellow. Hint stays armed;
    // apply() passes yellow through unchanged so UI shows yellow.
    h.onConn("reconnecting", "Network unreachable", "yellow");
    expect(h.isArmed()).toBe(true);
    expect(h.apply("yellow")).toBe("yellow");

    // Next tick: sshfs kernel cache refreshes, stat returns cached
    // green. Hint must still be armed so UI continues showing yellow.
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.isArmed()).toBe(true);
    expect(h.apply("green")).toBe("yellow");
  });

  it("does not arm for the first time if main is already yellow — no stale green", () => {
    // If we missed the stale-green window (e.g. renderer reloaded
    // during an ongoing outage), arming the hint adds nothing because
    // main's yellow is already authoritative truth.
    const h = new MountHint("station");
    h.onConn("reconnecting", "Network unreachable", "yellow");
    expect(h.isArmed()).toBe(false);
    // ...but if mount then flips to cached-green, we DO arm.
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.isArmed()).toBe(true);
  });
});

describe("MountHint.onConn change detection", () => {
  it("returns true only on actual armed-state transitions", () => {
    const h = new MountHint("station");
    // connecting → no change
    expect(h.onConn("connecting", null, "green")).toBe(false);
    // first tailnet-down arms → true
    expect(h.onConn("reconnecting", "Network unreachable", "green")).toBe(true);
    // same event again → no change
    expect(h.onConn("reconnecting", "Network unreachable", "green")).toBe(false);
    // recovery → true
    expect(h.onConn("connected", null, "green")).toBe(true);
    // already disarmed → no change
    expect(h.onConn("connected", null, "green")).toBe(false);
  });
});

describe("MountHint full #42 flow", () => {
  it("Tailnet drop → stat still cached-green → hint masks → outage persists → recovery", () => {
    const h = new MountHint("station");
    // Boot: connecting, mount unseen
    h.onConn("connecting", null, "gray");
    expect(h.apply("gray")).toBe("gray");

    // First connect + mount confirmed green
    h.onConn("connected", null, "gray");
    expect(h.apply("green")).toBe("green");

    // Tailnet drops: CONN poll fails with Network unreachable. Mount
    // main-state is still green (kernel attr cache). Hint arms.
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.apply("green")).toBe("yellow");

    // More CONN poll failures over the next several ticks. Hint
    // stays armed regardless of what main reports about the mount.
    h.onConn("reconnecting", "Network unreachable", "green");
    expect(h.apply("green")).toBe("yellow");

    // Tailnet recovers. Next CONN poll succeeds. Hint disarms, UI
    // reflects main's authoritative green again.
    h.onConn("connected", null, "green");
    expect(h.apply("green")).toBe("green");
  });
});
