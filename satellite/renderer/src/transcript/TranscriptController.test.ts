// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import {
  createTranscriptController,
  type TranscriptController,
  type TranscriptApi,
} from "./TranscriptController";
import { HttpError, type TranscriptChunk } from "@client-core/api/client";
import type { SessionsListResponse } from "@proto/proto";

// Integration tests for the FULL open → resolve → tail → render flow,
// including every failure path a live session hit silently before:
// no session resolvable, stale tab sessionId (404), fetch errors.
// The controller must always leave something visible in the overlay.

const SID = "aeeea9b7-d60c-4f33-9254-b834bebc2d76";
const SID2 = "bbbbbbbb-1111-4222-8333-444444444444";

const userLine = (text: string) =>
  JSON.stringify({
    isSidechain: false,
    type: "user",
    message: { role: "user", content: text },
    uuid: "u1",
  }) + "\n";

function chunk(c: string, next: number, more = false): TranscriptChunk {
  return { chunk: c, nextOffset: next, hasMore: more };
}

interface FakeDeps {
  wrapper: HTMLElement;
  kind: string;
  sessionId?: string;
  listSessions: TranscriptApi["listSessions"] & Mock;
  getTranscript: TranscriptApi["getTranscript"] & Mock;
  log: Mock;
}

function makeDeps(over: Partial<FakeDeps> = {}): FakeDeps {
  const wrapper = document.createElement("div");
  document.body.appendChild(wrapper);
  return {
    wrapper,
    kind: "claude",
    sessionId: undefined,
    listSessions: vi.fn(async (): Promise<SessionsListResponse> => ({ sessions: [] })),
    getTranscript: vi.fn(async () => chunk("", 0)),
    log: vi.fn(),
    ...over,
  };
}

function makeController(d: FakeDeps): TranscriptController {
  return createTranscriptController({
    resolvePane: (paneId) =>
      paneId === "p_1"
        ? { wrapper: d.wrapper, kind: d.kind, host: "station", title: "my-pane", sessionId: d.sessionId }
        : null,
    projectId: () => "proj",
    api: () => ({
      listSessions: d.listSessions,
      getTranscript: d.getTranscript,
    }),
    intervalMs: 1000,
    log: d.log,
  });
}

const overlay = (d: FakeDeps) => d.wrapper.querySelector(".transcript-view");
const statusText = (d: FakeDeps) =>
  (d.wrapper.querySelector(".transcript-status") as HTMLElement | null)?.textContent ?? "";

describe("TranscriptController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("opens, resolves via the tab sessionId, tails, and renders turns", async () => {
    const d = makeDeps({
      sessionId: SID,
      getTranscript: vi.fn(async () => chunk(userLine("hello from the transcript"), 42)),
    });
    const c = makeController(d);
    await c.toggle("p_1");
    await vi.advanceTimersByTimeAsync(0);

    expect(overlay(d)).not.toBeNull();
    expect(d.listSessions).not.toHaveBeenCalled(); // tab id wins, no round-trip
    expect(d.getTranscript).toHaveBeenCalledWith("proj", SID, 0);
    expect(d.wrapper.textContent).toContain("hello from the transcript");
    // live state → banner hidden
    const status = d.wrapper.querySelector(".transcript-status") as HTMLElement;
    expect(status.classList.contains("transcript-status--hidden")).toBe(true);
    expect(c.isOpen("p_1")).toBe(true);
  });

  it("falls back to listSessions when the tab has no sessionId", async () => {
    const d = makeDeps({
      listSessions: vi.fn(async () => ({
        sessions: [
          { session_id: SID, name: "s", cwd: "/", created_at: "", last_active_at: "", last_pane_id: "p_1", was_live: true },
        ],
      })),
      getTranscript: vi.fn(async () => chunk(userLine("via list"), 9)),
    });
    const c = makeController(d);
    await c.toggle("p_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(d.getTranscript).toHaveBeenCalledWith("proj", SID, 0);
    expect(d.wrapper.textContent).toContain("via list");
    expect(c.isOpen("p_1")).toBe(true);
  });

  it("shows a visible 'no session' state instead of silently doing nothing", async () => {
    const d = makeDeps(); // no tab sessionId, empty session list
    const c = makeController(d);
    await c.toggle("p_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(overlay(d)).not.toBeNull(); // the overlay MUST appear
    expect(statusText(d)).toMatch(/no transcript session/i);
    expect(d.getTranscript).not.toHaveBeenCalled();
  });

  it("recovers from a stale tab sessionId: 404 → re-resolve via listSessions", async () => {
    const d = makeDeps({
      sessionId: SID, // stale — the pane respawned since
      listSessions: vi.fn(async () => ({
        sessions: [
          { session_id: SID2, name: "s", cwd: "/", created_at: "", last_active_at: "", last_pane_id: "p_1", was_live: true },
        ],
      })),
      getTranscript: vi.fn(async (_p: string, sid: string) => {
        if (sid === SID) throw new HttpError(404, "Not Found", "transcript not found");
        return chunk(userLine("recovered after respawn"), 7);
      }),
    });
    const c = makeController(d);
    await c.toggle("p_1");
    // Two flushes: the 404 lands on the first tick; the re-resolve
    // chain arms a fresh 0ms tail timer that fires on the second.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(d.getTranscript).toHaveBeenCalledWith("proj", SID2, 0);
    expect(d.wrapper.textContent).toContain("recovered after respawn");
  });

  it("shows a retrying error state on fetch failure and clears it on recovery", async () => {
    const d = makeDeps({
      sessionId: SID,
      getTranscript: vi
        .fn()
        .mockRejectedValueOnce(new HttpError(502, "Bad Gateway", "upstream"))
        .mockResolvedValue(chunk(userLine("back alive"), 5)),
    });
    const c = makeController(d);
    await c.toggle("p_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(statusText(d)).toMatch(/502/);
    expect(statusText(d)).toMatch(/retrying/i);

    await vi.advanceTimersByTimeAsync(1000);
    expect(d.wrapper.textContent).toContain("back alive");
    const status = d.wrapper.querySelector(".transcript-status") as HTMLElement;
    expect(status.classList.contains("transcript-status--hidden")).toBe(true);
  });

  it("shows an empty state when the transcript has no chat turns", async () => {
    const d = makeDeps({
      sessionId: SID,
      getTranscript: vi.fn(async () =>
        chunk('{"type":"custom-title","customTitle":"x"}\n', 40),
      ),
    });
    const c = makeController(d);
    await c.toggle("p_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(statusText(d)).toMatch(/no chat turns/i);
  });

  it("toggle closes an open overlay and stops polling", async () => {
    const d = makeDeps({ sessionId: SID });
    const c = makeController(d);
    await c.toggle("p_1");
    await vi.advanceTimersByTimeAsync(0);
    const callsWhenOpen = d.getTranscript.mock.calls.length;

    await c.toggle("p_1");
    expect(overlay(d)).toBeNull();
    expect(c.isOpen("p_1")).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.getTranscript.mock.calls.length).toBe(callsWhenOpen);
  });

  it("auto-closes when the wrapper leaves the DOM (project switch / pane close)", async () => {
    const d = makeDeps({ sessionId: SID });
    const c = makeController(d);
    await c.toggle("p_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(c.isOpen("p_1")).toBe(true);

    d.wrapper.remove(); // layout rebuild
    await vi.advanceTimersByTimeAsync(1000); // next poll notices
    expect(c.isOpen("p_1")).toBe(false);
  });

  it("is a no-op for non-claude panes and unknown panes", async () => {
    const d = makeDeps({ kind: "shell" });
    const c = makeController(d);
    await c.toggle("p_1");
    expect(overlay(d)).toBeNull();
    await c.toggle("p_unknown");
    expect(c.isOpen("p_unknown")).toBe(false);
  });

  it("logs the lifecycle: open, session resolution, first chunk, close", async () => {
    const d = makeDeps({
      sessionId: SID,
      getTranscript: vi.fn(async () => chunk(userLine("x"), 3)),
    });
    const c = makeController(d);
    await c.toggle("p_1");
    await vi.advanceTimersByTimeAsync(0);
    await c.toggle("p_1");
    const logged = d.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toMatch(/open pane=p_1/);
    expect(logged).toMatch(/session resolved .*via=tab/);
    expect(logged).toMatch(/first chunk/);
    expect(logged).toMatch(/closed pane=p_1 reason=toggle/);
  });

  it("exposes the open view for the search subsystem", async () => {
    const d = makeDeps({ sessionId: SID });
    const c = makeController(d);
    expect(c.get("p_1")).toBeNull();
    await c.toggle("p_1");
    expect(c.get("p_1")?.view.body.classList.contains("transcript-body")).toBe(true);
  });
});
