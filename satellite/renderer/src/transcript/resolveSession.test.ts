import { describe, it, expect, vi } from "vitest";
import { resolveTranscriptSession } from "./resolveSession";
import type { SessionsListResponse } from "@proto/proto";

function sessions(list: SessionsListResponse["sessions"]): () => Promise<SessionsListResponse> {
  return async () => ({ sessions: list });
}

describe("resolveTranscriptSession", () => {
  it("prefers the tab's own sessionId without hitting the API", async () => {
    const listSessions = vi.fn(sessions([]));
    const sid = await resolveTranscriptSession({
      tabSessionId: "tab-session",
      paneId: "p_1",
      listSessions,
    });
    expect(sid).toBe("tab-session");
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("falls back to the session whose last_pane_id matches the pane", async () => {
    const sid = await resolveTranscriptSession({
      paneId: "p_2",
      listSessions: sessions([
        { session_id: "s-other", name: "a", cwd: "/", created_at: "", last_active_at: "", last_pane_id: "p_9" },
        { session_id: "s-mine", name: "b", cwd: "/", created_at: "", last_active_at: "", last_pane_id: "p_2" },
      ]),
    });
    expect(sid).toBe("s-mine");
  });

  it("prefers a was_live match when several sessions point at the pane", async () => {
    // A respawned pane can leave an older dead entry with the same
    // last_pane_id; the live one is the current transcript.
    const sid = await resolveTranscriptSession({
      paneId: "p_3",
      listSessions: sessions([
        { session_id: "s-dead", name: "a", cwd: "/", created_at: "", last_active_at: "", last_pane_id: "p_3" },
        { session_id: "s-live", name: "b", cwd: "/", created_at: "", last_active_at: "", last_pane_id: "p_3", was_live: true },
      ]),
    });
    expect(sid).toBe("s-live");
  });

  it("returns null when nothing matches", async () => {
    const sid = await resolveTranscriptSession({
      paneId: "p_4",
      listSessions: sessions([
        { session_id: "s1", name: "a", cwd: "/", created_at: "", last_active_at: "", last_pane_id: "p_9" },
      ]),
    });
    expect(sid).toBeNull();
  });

  it("returns null when the sessions call fails", async () => {
    const sid = await resolveTranscriptSession({
      paneId: "p_5",
      listSessions: async () => {
        throw new Error("offline");
      },
    });
    expect(sid).toBeNull();
  });
});
