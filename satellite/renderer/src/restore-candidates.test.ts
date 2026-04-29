import { describe, it, expect } from "vitest";
import type { SessionInfo } from "@proto/proto";
import { buildRestoreCreateArgs } from "./restore-candidates";

function mkSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    name: "",
    cwd: "",
    created_at: "2026-01-01T00:00:00Z",
    last_active_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildRestoreCreateArgs (Scope B)", () => {
  it("routes a Claude SessionInfo to createPane('claude', { resumeSessionId })", () => {
    const r = buildRestoreCreateArgs(mkSession({ kind: "claude", session_id: "sess-a" }));
    expect(r).toEqual({ kind: "claude", opts: { resumeSessionId: "sess-a" } });
  });

  it("routes a shell SessionInfo to createPane('shell', { restoreSlotId })", () => {
    const r = buildRestoreCreateArgs(mkSession({ kind: "shell", slot_id: "slot-a" }));
    expect(r).toEqual({ kind: "shell", opts: { restoreSlotId: "slot-a" } });
  });

  it("defaults missing kind to claude for back-compat with pre-Scope-B daemons", () => {
    // Older daemon serialisations omitted `kind` from SessionInfo —
    // the client must treat that as claude (the only kind before
    // Scope B) rather than failing.
    const r = buildRestoreCreateArgs(mkSession({ session_id: "sess-a" }));
    expect(r).toEqual({ kind: "claude", opts: { resumeSessionId: "sess-a" } });
  });

  it("returns null for a Claude row with no session_id (malformed)", () => {
    expect(buildRestoreCreateArgs(mkSession({ kind: "claude" }))).toBeNull();
  });

  it("returns null for a shell row with no slot_id (malformed)", () => {
    expect(buildRestoreCreateArgs(mkSession({ kind: "shell" }))).toBeNull();
  });

  it("ignores slot_id on a Claude row (identity = SessionID)", () => {
    // If a row somehow has both set, Claude's identity rule wins —
    // mirrors the daemon's invariant.
    const r = buildRestoreCreateArgs(
      mkSession({ kind: "claude", session_id: "sess-a", slot_id: "ignored" }),
    );
    expect(r).toEqual({ kind: "claude", opts: { resumeSessionId: "sess-a" } });
  });

  it("ignores session_id on a shell row (identity = SlotID)", () => {
    const r = buildRestoreCreateArgs(
      mkSession({ kind: "shell", slot_id: "slot-a", session_id: "stale" }),
    );
    expect(r).toEqual({ kind: "shell", opts: { restoreSlotId: "slot-a" } });
  });
});
