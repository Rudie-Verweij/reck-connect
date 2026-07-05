import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApiClient, HttpContentTypeError } from "./client";

describe("ApiClient", () => {
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = origFetch;
  });

  it("attaches bearer token when present", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315", token: "sek" });
    let capturedHeaders: Record<string, string> = {};
    global.fetch = vi.fn(async (_u, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ status: "ok", version: "1", uptime_sec: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.health();
    expect(capturedHeaders["Authorization"]).toBe("Bearer sek");
  });

  it("throws on non-2xx", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    global.fetch = vi.fn(
      async () => new Response("nope", { status: 500, statusText: "Server Error" }),
    ) as unknown as typeof fetch;
    await expect(c.health()).rejects.toThrow(/500/);
  });

  it("builds ws url without token in query string (bearer goes via subprotocol)", () => {
    const c = new ApiClient({ baseUrl: "http://host:7315", token: "abc" });
    expect(c.wsUrl("p1", "p_123")).toBe("ws://host:7315/ws/p1/p_123");
    // Belt-and-braces: the URL itself must never include the secret.
    // Query strings leak into access logs, devtools, referrers.
    expect(c.wsUrl("p1", "p_123")).not.toContain("token=");
    expect(c.wsUrl("p1", "p_123")).not.toContain("abc");
  });

  it("builds ws url without token when missing", () => {
    const c = new ApiClient({ baseUrl: "https://host:7315" });
    expect(c.wsUrl("p1", "p_123")).toBe("wss://host:7315/ws/p1/p_123");
  });

  it("wsSubprotocols returns reck-bearer.<token> when token is set", () => {
    const c = new ApiClient({ baseUrl: "http://host:7315", token: "abc" });
    expect(c.wsSubprotocols()).toEqual(["reck-bearer.abc"]);
  });

  it("wsSubprotocols returns empty array when token missing", () => {
    const c = new ApiClient({ baseUrl: "http://host:7315" });
    expect(c.wsSubprotocols()).toEqual([]);
  });

  it("missionControlWsUrl has no token in the URL either", () => {
    const c = new ApiClient({ baseUrl: "http://host:7315", token: "abc" });
    expect(c.missionControlWsUrl()).toBe("ws://host:7315/ws/mission-control");
    expect(c.missionControlWsUrl()).not.toContain("token=");
    expect(c.missionControlWsUrl()).not.toContain("abc");
  });

  it("POSTs to /projects for createProject", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let captured = { url: "", method: "", body: "" };
    global.fetch = vi.fn(async (u, init) => {
      captured = {
        url: String(u),
        method: String(init?.method ?? "GET"),
        body: String(init?.body ?? ""),
      };
      return new Response(
        JSON.stringify({
          project: { id: "foo", name: "Foo", cwd: "/", stoplight: "gray", pane_count: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const resp = await c.createProject({ name: "Foo", cwd: "/" });
    expect(captured.url).toBe("http://x:7315/projects");
    expect(captured.method).toBe("POST");
    expect(JSON.parse(captured.body)).toEqual({ name: "Foo", cwd: "/" });
    expect(resp.project.id).toBe("foo");
  });

  it("createProject accepts name-only body (no cwd)", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let captured = { url: "", method: "", body: "" };
    global.fetch = vi.fn(async (u, init) => {
      captured = {
        url: String(u),
        method: String(init?.method ?? "GET"),
        body: String(init?.body ?? ""),
      };
      return new Response(
        JSON.stringify({
          project: {
            id: "demo",
            name: "Demo",
            cwd: "/Users/reck-connect/projects/demo",
            stoplight: "gray",
            pane_count: 0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const resp = await c.createProject({ name: "Demo" });
    expect(captured.url).toBe("http://x:7315/projects");
    expect(captured.method).toBe("POST");
    expect(JSON.parse(captured.body)).toEqual({ name: "Demo" });
    expect(resp.project.id).toBe("demo");
  });

  it("DELETEs /projects/:id for deleteProject", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let captured = { url: "", method: "" };
    global.fetch = vi.fn(async (u, init) => {
      captured = { url: String(u), method: String(init?.method ?? "GET") };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.deleteProject("foo");
    expect(captured.url).toBe("http://x:7315/projects/foo");
    expect(captured.method).toBe("DELETE");
  });

  it("GETs /projects/:id/sessions for listSessions", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let captured = { url: "", method: "" };
    global.fetch = vi.fn(async (u, init) => {
      captured = { url: String(u), method: String(init?.method ?? "GET") };
      return new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.listSessions("foo");
    expect(captured.url).toBe("http://x:7315/projects/foo/sessions");
    expect(captured.method).toBe("GET");
  });

  it("GETs the transcript with offset and parses tail headers", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315", token: "sek" });
    let captured = { url: "", method: "", auth: "" };
    global.fetch = vi.fn(async (u, init) => {
      captured = {
        url: String(u),
        method: String(init?.method ?? "GET"),
        auth: ((init?.headers as Record<string, string>) ?? {})["Authorization"] ?? "",
      };
      return new Response('{"type":"user"}\n', {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Reck-Transcript-Offset": "1234",
          "X-Reck-Transcript-More": "1",
        },
      });
    }) as unknown as typeof fetch;
    const resp = await c.getTranscript("foo", "sid-1", 42);
    expect(captured.url).toBe(
      "http://x:7315/projects/foo/sessions/sid-1/transcript?offset=42",
    );
    expect(captured.method).toBe("GET");
    expect(captured.auth).toBe("Bearer sek");
    expect(resp).toEqual({ chunk: '{"type":"user"}\n', nextOffset: 1234, hasMore: true });
  });

  it("getTranscript defaults offset to 0 and hasMore to false", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let captured = { url: "" };
    global.fetch = vi.fn(async (u) => {
      captured = { url: String(u) };
      return new Response("", {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Reck-Transcript-Offset": "0",
        },
      });
    }) as unknown as typeof fetch;
    const resp = await c.getTranscript("foo", "sid-1");
    expect(captured.url).toBe(
      "http://x:7315/projects/foo/sessions/sid-1/transcript?offset=0",
    );
    expect(resp).toEqual({ chunk: "", nextOffset: 0, hasMore: false });
  });

  it("getTranscript throws on non-2xx", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    global.fetch = vi.fn(
      async () => new Response("gone", { status: 404, statusText: "Not Found" }),
    ) as unknown as typeof fetch;
    await expect(c.getTranscript("foo", "sid-1")).rejects.toThrow(/404/);
  });

  it("getTranscript throws when the offset header is missing (intercepted response)", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    global.fetch = vi.fn(
      async () =>
        new Response("<html>portal</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    await expect(c.getTranscript("foo", "sid-1")).rejects.toThrow(HttpContentTypeError);
  });

  it("getTranscript uses a generous timeout (not the 5s JSON default) for bulk chunks", async () => {
    // A 4MB transcript chunk over a station/Tailscale link can't arrive
    // in the 5s tuned for small JSON calls — that produced
    // 'TimeoutError: signal timed out' on large transcripts. Bulk
    // fetches get their own long default, overridable per call.
    const c = new ApiClient({ baseUrl: "http://x:7315", timeoutMs: 5000 });
    const spy = vi.spyOn(AbortSignal, "timeout");
    global.fetch = vi.fn(
      async () =>
        new Response("", {
          status: 200,
          headers: {
            "Content-Type": "application/x-ndjson",
            "X-Reck-Transcript-Offset": "0",
          },
        }),
    ) as unknown as typeof fetch;

    await c.getTranscript("foo", "sid-1");
    expect(spy).toHaveBeenLastCalledWith(60000);

    await c.getTranscript("foo", "sid-1", 0, 12345);
    expect(spy).toHaveBeenLastCalledWith(12345);
    spy.mockRestore();
  });

  it("getTranscript URL-encodes project and session ids", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let captured = { url: "" };
    global.fetch = vi.fn(async (u) => {
      captured = { url: String(u) };
      return new Response("", {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-Reck-Transcript-Offset": "0",
        },
      });
    }) as unknown as typeof fetch;
    await c.getTranscript("a/b", "s#1");
    expect(captured.url).toBe(
      "http://x:7315/projects/a%2Fb/sessions/s%231/transcript?offset=0",
    );
  });

  it("forwards resume_session_id on createPane when given", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let body = "";
    global.fetch = vi.fn(async (_u, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ pane_id: "p_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.createPane("foo", "claude", { resumeSessionId: "abc-def" });
    expect(JSON.parse(body)).toEqual({ kind: "claude", resume_session_id: "abc-def" });
  });

  it("omits resume_session_id on createPane when not given", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let body = "";
    global.fetch = vi.fn(async (_u, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ pane_id: "p_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.createPane("foo", "claude");
    expect(JSON.parse(body)).toEqual({ kind: "claude" });
  });

  it("forwards restore_slot_id on createPane when given (Scope B)", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let body = "";
    global.fetch = vi.fn(async (_u, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ pane_id: "p_abc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.createPane("foo", "shell", { restoreSlotId: "slot-42" });
    expect(JSON.parse(body)).toEqual({ kind: "shell", restore_slot_id: "slot-42" });
  });

  it("forwards global_preamble on createPane when given", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let body = "";
    global.fetch = vi.fn(async (_u, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ pane_id: "p_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.createPane("foo", "claude", { globalPreamble: "RECK_GLOBAL_RULE" });
    expect(JSON.parse(body)).toEqual({ kind: "claude", global_preamble: "RECK_GLOBAL_RULE" });
  });

  it("omits global_preamble on createPane when empty string (explicit opt-out)", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let body = "";
    global.fetch = vi.fn(async (_u, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ pane_id: "p_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.createPane("foo", "claude", { globalPreamble: "" });
    expect(JSON.parse(body)).toEqual({ kind: "claude" });
  });

  it("GETs /restore-candidates for restoreCandidates", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let captured = { url: "", method: "" };
    global.fetch = vi.fn(async (u, init) => {
      captured = { url: String(u), method: String(init?.method ?? "GET") };
      return new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.restoreCandidates();
    // No kinds param when caller omits — post-review default stays
    // "legacy Claude-only" on the wire so old daemons behave too.
    expect(captured.url).toBe("http://x:7315/restore-candidates");
    expect(captured.method).toBe("GET");
  });

  it("appends ?kinds= when restoreCandidates is given kinds (Scope B)", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let capturedUrl = "";
    global.fetch = vi.fn(async (u) => {
      capturedUrl = String(u);
      return new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.restoreCandidates(["claude", "shell"]);
    expect(capturedUrl).toBe("http://x:7315/restore-candidates?kinds=claude%2Cshell");
  });

  it("omits ?kinds= when the provided kinds list is empty", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let capturedUrl = "";
    global.fetch = vi.fn(async (u) => {
      capturedUrl = String(u);
      return new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.restoreCandidates([]);
    expect(capturedUrl).toBe("http://x:7315/restore-candidates");
  });

  // an earlier release content-type guard — before the fix, res.json() was called on
  // ANY 2xx body, which crashed with a raw SyntaxError when a proxy
  // returned HTML or a 204. Now a typed HttpContentTypeError propagates.

  it("rejects 2xx responses that lack application/json content-type", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    global.fetch = vi.fn(
      async () =>
        new Response("<html><body>portal login</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    await expect(c.health()).rejects.toBeInstanceOf(HttpContentTypeError);
  });

  it("rejects 2xx responses with no content-type header at all", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    global.fetch = vi.fn(
      async () => new Response("mystery body", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(c.health()).rejects.toBeInstanceOf(HttpContentTypeError);
  });

  it("accepts application/json with a charset parameter", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "ok", version: "1", uptime_sec: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
    ) as unknown as typeof fetch;
    const res = await c.health();
    expect(res.status).toBe("ok");
  });

  it("treats 204 No Content as success without attempting to parse JSON", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    global.fetch = vi.fn(
      async () =>
        // Node's Response rejects a body on 204; use an empty body.
        new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    // The typed return is null, which surfaces at the caller's field
    // access — but crucially NO SyntaxError bubbles out of res.json().
    const res = (await c.health()) as unknown as null;
    expect(res).toBeNull();
  });

  it("PUTs wholesale projects payload for putProjects (hybrid phase 9)", async () => {
    const c = new ApiClient({ baseUrl: "http://127.0.0.1:7315", token: "tok" });
    let captured = { url: "", method: "", body: "", auth: "" };
    global.fetch = vi.fn(async (u, init) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      captured = {
        url: String(u),
        method: String(init?.method ?? "GET"),
        body: String(init?.body ?? ""),
        auth: headers["Authorization"] ?? "",
      };
      return new Response(JSON.stringify({ ok: true, count: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const resp = await c.putProjects([
      { id: "alpha", cwd: "/Users/me/reck/projects/alpha" },
      { id: "beta", cwd: "/Users/me/reck/projects/beta" },
    ]);
    expect(captured.url).toBe("http://127.0.0.1:7315/projects");
    expect(captured.method).toBe("PUT");
    expect(captured.auth).toBe("Bearer tok");
    expect(JSON.parse(captured.body)).toEqual({
      projects: [
        { id: "alpha", cwd: "/Users/me/reck/projects/alpha" },
        { id: "beta", cwd: "/Users/me/reck/projects/beta" },
      ],
    });
    expect(resp).toEqual({ ok: true, count: 2 });
  });

  it("putProjects with an empty list PUTs {projects: []} (wholesale clear)", async () => {
    const c = new ApiClient({ baseUrl: "http://127.0.0.1:7315" });
    let body = "";
    global.fetch = vi.fn(async (_u, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true, count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.putProjects([]);
    expect(JSON.parse(body)).toEqual({ projects: [] });
  });

  it("POSTs session_ids for dismissSessions", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let captured = { url: "", method: "", body: "" };
    global.fetch = vi.fn(async (u, init) => {
      captured = {
        url: String(u),
        method: String(init?.method ?? "GET"),
        body: String(init?.body ?? ""),
      };
      return new Response(JSON.stringify({ dismissed: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await c.dismissSessions("p1", ["a", "b"]);
    expect(captured.url).toBe("http://x:7315/projects/p1/sessions/dismiss");
    expect(captured.method).toBe("POST");
    expect(JSON.parse(captured.body)).toEqual({ session_ids: ["a", "b"] });
  });

  // pasteImage — phase 2 → phase 2. Sends raw
  // image bytes to /panes/:id/clipboard-image; returns true on 2xx,
  // false on any 5xx (NSPasteboard write failed in-daemon, or legacy
  // sidecar 503 mid-migration), throws on 4xx (caller bugs).
  it("pasteImage POSTs raw bytes with declared Content-Type", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315", token: "secret" });
    let captured = { url: "", method: "", ctype: "" };
    global.fetch = vi.fn(async (u, init) => {
      captured = {
        url: String(u),
        method: String(init?.method ?? "GET"),
        ctype: String((init?.headers as Record<string, string>)["Content-Type"] ?? ""),
      };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const ok = await c.pasteImage("p_abc", blob, "image/png");
    expect(ok).toBe(true);
    expect(captured.url).toBe("http://x:7315/panes/p_abc/clipboard-image");
    expect(captured.method).toBe("POST");
    expect(captured.ctype).toBe("image/png");
  });

  it("pasteImage returns false on 500 (NSPasteboard write failed)", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    global.fetch = vi.fn(
      async () =>
        new Response("clipboard write: NSPasteboard rejected image/png payload", {
          status: 500,
        }),
    ) as unknown as typeof fetch;
    const blob = new Blob([new Uint8Array([0])], { type: "image/png" });
    const ok = await c.pasteImage("p_abc", blob, "image/png");
    expect(ok).toBe(false);
  });

  it("pasteImage returns false on legacy 503 (back-compat with mid-migration daemon)", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, reason: "sidecar_socket_missing" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const blob = new Blob([new Uint8Array([0])], { type: "image/png" });
    const ok = await c.pasteImage("p_abc", blob, "image/png");
    expect(ok).toBe(false);
  });

  it("pasteImage throws on 4xx (caller bug — bad MIME, pane gone, oversize)", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    global.fetch = vi.fn(
      async () => new Response("pane not found", { status: 404, statusText: "Not Found" }),
    ) as unknown as typeof fetch;
    const blob = new Blob([new Uint8Array([0])], { type: "image/png" });
    await expect(c.pasteImage("p_abc", blob, "image/png")).rejects.toThrow(/404/);
  });

  // an earlier release — `getProject` autoSpawn opt-out. The default omits the
  // query param so the daemon's pre-existing new-project starter-pane UX
  // keeps working on primary-host calls; passing `autoSpawn: false`
  // surfaces `?autospawn=false`, which the daemon treats as "skip the
  // empty-project auto-spawn". Used by hybrid satellite to read pane
  // state from the secondary host without provoking a phantom spawn.
  describe("getProject autoSpawn opt-out ", () => {
    function projectDetailResponse() {
      return new Response(
        JSON.stringify({ id: "p1", name: "P1", cwd: "/", panes: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    it("default getProject does not append autospawn query param", async () => {
      const c = new ApiClient({ baseUrl: "http://x:7315" });
      let capturedUrl = "";
      global.fetch = vi.fn(async (u) => {
        capturedUrl = String(u);
        return projectDetailResponse();
      }) as unknown as typeof fetch;
      await c.getProject("p1");
      expect(capturedUrl).toBe("http://x:7315/projects/p1");
      expect(capturedUrl).not.toContain("autospawn");
    });

    it("autoSpawn=false appends ?autospawn=false to the URL", async () => {
      const c = new ApiClient({ baseUrl: "http://x:7315" });
      let capturedUrl = "";
      global.fetch = vi.fn(async (u) => {
        capturedUrl = String(u);
        return projectDetailResponse();
      }) as unknown as typeof fetch;
      await c.getProject("p1", { autoSpawn: false });
      expect(capturedUrl).toBe("http://x:7315/projects/p1?autospawn=false");
    });

    // Pin the contract (review L2): explicit `autoSpawn: true` should NOT
    // emit `?autospawn=true`. The daemon already defaults to true when
    // the param is omitted, so adding the redundant query string would
    // bloat request logs and — worse — expose callers to the strict
    // 400-on-malformed-value surface that the opt-out path needs.
    // Bare URL is the canonical "I want auto-spawn" wire shape.
    it("autoSpawn=true does NOT append the query param (relies on daemon default)", async () => {
      const c = new ApiClient({ baseUrl: "http://x:7315" });
      let capturedUrl = "";
      global.fetch = vi.fn(async (u) => {
        capturedUrl = String(u);
        return projectDetailResponse();
      }) as unknown as typeof fetch;
      await c.getProject("p1", { autoSpawn: true });
      expect(capturedUrl).toBe("http://x:7315/projects/p1");
      expect(capturedUrl).not.toContain("autospawn");
    });

    it("autoSpawn=false strips the option before passing init to fetch", async () => {
      // Belt-and-braces: if `autoSpawn` leaked into RequestInit, fetch
      // would silently ignore unknown keys but typed callers might
      // construct a polluted init. Verify we hand a clean init off.
      const c = new ApiClient({ baseUrl: "http://x:7315" });
      let capturedInitKeys: string[] = [];
      global.fetch = vi.fn(async (_u, init) => {
        capturedInitKeys = init ? Object.keys(init) : [];
        return projectDetailResponse();
      }) as unknown as typeof fetch;
      const ctrl = new AbortController();
      await c.getProject("p1", { autoSpawn: false, signal: ctrl.signal });
      expect(capturedInitKeys).not.toContain("autoSpawn");
      expect(capturedInitKeys).toContain("signal");
    });

    it("autoSpawn=true also strips the option before passing init to fetch", async () => {
      // Symmetric strip: autoSpawn is our private extension, never a
      // valid RequestInit key. Pass it through `true` and confirm fetch
      // doesn't see it either.
      const c = new ApiClient({ baseUrl: "http://x:7315" });
      let capturedInitKeys: string[] = [];
      global.fetch = vi.fn(async (_u, init) => {
        capturedInitKeys = init ? Object.keys(init) : [];
        return projectDetailResponse();
      }) as unknown as typeof fetch;
      const ctrl = new AbortController();
      await c.getProject("p1", { autoSpawn: true, signal: ctrl.signal });
      expect(capturedInitKeys).not.toContain("autoSpawn");
      expect(capturedInitKeys).toContain("signal");
    });
  });
});
