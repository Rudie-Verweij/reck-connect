import type {
  HealthResponse,
  ProjectsListResponse,
  ProjectDetail,
  CreatePaneRequest,
  CreatePaneResponse,
  DeletePaneResponse,
  PaneKind,
  AddProjectRequest,
  AddProjectResponse,
  PutProjectsEntry,
  PutProjectsRequest,
  PutProjectsResponse,
  SessionsListResponse,
  RestoreCandidatesResponse,
  DismissSessionsRequest,
  DismissSessionsResponse,
  DockProjectResponse,
  MissionControlStateResponse,
  MissionControlHistoryResponse,
  MissionControlChatRequest,
  PaneUploadResponse,
  RenameRequest,
} from "@proto/proto";

export interface ClientConfig {
  baseUrl: string; // e.g. http://127.0.0.1:7315 (local) or http://100.x.y.z:7315 (Tailscale CGNAT)
  token?: string;
  /**
   * Per-request timeout in ms. Without this, the OS TCP-connect timeout
   * (~75 s on macOS) strands the poll loop when the station is
   * unreachable — the CONN dot stays green for over a minute while the
   * fetch hangs. Defaults to 5000 ms; override via init.signal to bypass.
   */
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(public status: number, public statusText: string, public body: string) {
    super(`${status} ${statusText}: ${body}`);
    this.name = "HttpError";
  }
}

/**
 * Raised when the daemon returns a 2xx response but the body doesn't
 * look like JSON — typically a proxy/CDN intercepting the request
 * and returning HTML, or an endpoint that legitimately responded with
 * 204 No Content (which res.json() would reject as a SyntaxError
 * from outside the typed error surface).
 *
 * Callers can distinguish this from HttpError (non-2xx) and handle
 * it without a generic try/catch. The status and content-type are
 * attached for diagnostics.
 */
export class HttpContentTypeError extends Error {
  constructor(public status: number, public contentType: string | null, public bodyPreview: string) {
    super(
      `unexpected content-type ${contentType ?? "(missing)"} on ${status}: ${bodyPreview.slice(0, 120)}`,
    );
    this.name = "HttpContentTypeError";
  }
}

export class ApiClient {
  constructor(public config: ClientConfig) {}

  /**
   * Replace the bearer token used for HTTP + WS auth. Used by the
   * 1008-close → token-rotate path in the Satellite renderer (and by
   * the per-host registry that owns these instances under hybrid mode,
   * an earlier release Phase 3): the daemon rejected the current token on the
   * WS upgrade, the user pasted a fresh one, and every subsequent
   * `fetch()` / `wsSubprotocols()` call needs to pick it up without
   * re-creating the client.
   *
   * Pass `undefined` to clear the token (e.g. local-loopback daemon
   * running with an empty `DAEMON_TOKEN`). The HTTP path then drops
   * the `Authorization` header; `wsSubprotocols()` returns `[]`.
   */
  setToken(token: string | undefined): void {
    this.config.token = token;
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (this.config.token) {
      headers["Authorization"] = "Bearer " + this.config.token;
    }
    const signal = init?.signal ?? AbortSignal.timeout(this.config.timeoutMs ?? 5000);
    const res = await fetch(this.config.baseUrl + path, {
      ...init,
      headers,
      signal,
    });
    if (!res.ok) {
      throw new HttpError(res.status, res.statusText, await res.text());
    }
    // Content-type guard: a 2xx from a proxy/CDN intercepting the
    // request can legitimately return HTML ("portal page") or an empty
    // 204. Both would crash res.json() with an unhandled SyntaxError
    // outside the typed error path. Check the content-type header
    // explicitly before parsing, and surface a typed error otherwise.
    if (res.status === 204) {
      // No Content: some endpoints return this legitimately. Treat as
      // an empty response; callers that expect a typed body will blow
      // up at the `as T` cast on field access, which is the same
      // behaviour as before — just without the mystery SyntaxError.
      return null as unknown as T;
    }
    const ct = res.headers.get("content-type");
    if (!ct || !ct.toLowerCase().includes("application/json")) {
      const body = await res.text();
      throw new HttpContentTypeError(res.status, ct, body);
    }
    return (await res.json()) as T;
  }

  health(init?: RequestInit) {
    return this.fetch<HealthResponse>("/health", init);
  }

  listProjects() {
    return this.fetch<ProjectsListResponse>("/projects");
  }

  /**
   * Fetch a project's pane list. Daemon-side `GET /projects/:id` has a
   * legacy "auto-spawn a default pane when the project is empty"
   * side-effect — useful as new-project UX on the primary host, but
   * actively wrong for secondary-host fetches in hybrid mode (issue
   * An earlier release: the bare GET on a station-resident project's local row spawns
   * a phantom Claude pane on every Mission Control roundtrip). Pass
   * `autoSpawn: false` for read-only secondary fetches; the default
   * (omitted, server-side `true`) preserves the starter-pane UX.
   *
   * Wire contract: the query string is added only when the caller
   * explicitly opts out (`autoSpawn: false`). Both omitted and
   * `autoSpawn: true` send the bare URL and rely on the daemon's default
   * `true` — that keeps the daemon's request log uncluttered for the
   * common path and avoids the daemon's strict 400-on-malformed-value
   * surface for callers that don't care.
   */
  getProject(
    id: string,
    init?: RequestInit & { autoSpawn?: boolean },
  ) {
    let path = `/projects/${encodeURIComponent(id)}`;
    let fetchInit: RequestInit | undefined = init;
    if (init && "autoSpawn" in init) {
      if (init.autoSpawn === false) path += "?autospawn=false";
      // Strip our extra option before handing init off to fetch — DOM
      // RequestInit rejects unknown keys silently, but typed callers
      // shouldn't see the leak either. Strip on every value (true,
      // false, undefined-via-explicit-key) so `init.autoSpawn` is never
      // visible to fetch regardless of caller pattern.
      const { autoSpawn: _drop, ...rest } = init;
      void _drop;
      fetchInit = rest;
    }
    return this.fetch<ProjectDetail>(path, fetchInit);
  }

  createPane(
    projectId: string,
    kind: PaneKind,
    opts?: {
      resumeSessionId?: string;
      restoreSlotId?: string;
      extraArgs?: string[];
      /**
       * Satellite-stored "Reck Connect prompt" — app-wide system-prompt
       * text the user configures in Settings. Forwarded verbatim as
       * `global_preamble` and dropped when empty, so the daemon composes
       * only baseline + project preamble in that case. Subject to the same
       * 16 KiB combined cap the daemon enforces across all preamble layers.
       */
      globalPreamble?: string;
    },
  ) {
    const body: CreatePaneRequest = { kind };
    if (opts?.resumeSessionId) body.resume_session_id = opts.resumeSessionId;
    if (opts?.restoreSlotId) body.restore_slot_id = opts.restoreSlotId;
    if (opts?.extraArgs && opts.extraArgs.length > 0) body.extra_args = opts.extraArgs;
    if (opts?.globalPreamble) body.global_preamble = opts.globalPreamble;
    return this.fetch<CreatePaneResponse>(
      `/projects/${encodeURIComponent(projectId)}/panes`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  listSessions(projectId: string) {
    return this.fetch<SessionsListResponse>(
      `/projects/${encodeURIComponent(projectId)}/sessions`,
    );
  }

  /**
   * Fetch the daemon-computed list of panes to offer for restore.
   *
   * `kinds`, when provided, negotiates which pane kinds the client
   * handles. Omit for the legacy Claude-only shape (old daemons +
   * old renderers both agree on that). Scope-B renderers pass
   * `["claude", "shell"]` to opt into shell restore; unknown kinds
   * sent to an older daemon are silently ignored server-side.
   * (Scope B)
   */
  restoreCandidates(kinds?: PaneKind[]) {
    const qs =
      kinds && kinds.length > 0
        ? `?kinds=${encodeURIComponent(kinds.join(","))}`
        : "";
    return this.fetch<RestoreCandidatesResponse>(`/restore-candidates${qs}`);
  }

  dismissSessions(projectId: string, sessionIds: string[]) {
    const body: DismissSessionsRequest = { session_ids: sessionIds };
    return this.fetch<DismissSessionsResponse>(
      `/projects/${encodeURIComponent(projectId)}/sessions/dismiss`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  deletePane(projectId: string, paneId: string) {
    return this.fetch<DeletePaneResponse>(
      `/projects/${encodeURIComponent(projectId)}/panes/${encodeURIComponent(paneId)}`,
      { method: "DELETE" },
    );
  }

  createProject(req: AddProjectRequest) {
    return this.fetch<AddProjectResponse>("/projects", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  /**
   * Wholesale replace the local-mode daemon's in-memory project map.
   * Hybrid mode rev 3.1, phase 8 + 9: the Satellite owns the station's
   * project catalog and pushes a per-pane local-cwd map down so the
   * local daemon can resolve project IDs to their sshfs-mounted folders
   * when spawning a Claude pane.
   *
   * Only valid against a `--mode=local` daemon — station returns 409.
   * Daemon enforces absolute path + permitted-prefix + no-traversal
   * + no-escaping-symlink cwd validation at receive time; caller should
   * expect `HttpError` with status 400 on malformed payloads and 401
   * when the per-spawn bearer has rotated (fetch a fresh token via the
   * local-token IPC and retry).
   */
  putProjects(entries: PutProjectsEntry[]) {
    const body: PutProjectsRequest = { projects: entries };
    return this.fetch<PutProjectsResponse>("/projects", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  deleteProject(projectId: string) {
    return this.fetch<DeletePaneResponse>(
      `/projects/${encodeURIComponent(projectId)}`,
      { method: "DELETE" },
    );
  }

  /**
   * URL for the pane WebSocket. The token is NEVER appended to the URL —
   * browsers leak query-string secrets through logs, devtools, referrers,
   * and crash reports. Call `wsSubprotocols(...)` to get the subprotocol
   * list to pass as the second arg of `new WebSocket(url, protocols)`.
   */
  wsUrl(projectId: string, paneId: string): string {
    const base = this.config.baseUrl.replace(/^http/, "ws");
    return `${base}/ws/${encodeURIComponent(projectId)}/${encodeURIComponent(paneId)}`;
  }

  dockProject(projectId: string) {
    return this.fetch<DockProjectResponse>(
      `/projects/${encodeURIComponent(projectId)}/dock`,
      { method: "POST" },
    );
  }

  renameProject(projectId: string, displayName: string) {
    const body: RenameRequest = { display_name: displayName };
    return this.fetch<RenameRequest>(
      `/projects/${encodeURIComponent(projectId)}/rename`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  renamePane(projectId: string, paneId: string, displayName: string) {
    const body: RenameRequest = { display_name: displayName };
    return this.fetch<RenameRequest>(
      `/projects/${encodeURIComponent(projectId)}/panes/${encodeURIComponent(paneId)}/rename`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  undockProject(projectId: string) {
    return this.fetch<DockProjectResponse>(
      `/projects/${encodeURIComponent(projectId)}/undock`,
      { method: "POST" },
    );
  }

  /**
   * Upload a pasted image blob to a live pane's per-pane tmpdir
   * (phase 1). The daemon writes the bytes, generates a
   * server-side filename, and returns the absolute path on the station
   * host. The caller (paste handler in TerminalPane) types that path
   * into the PTY so the model can Read() it.
   *
   * Uses native fetch directly rather than the shared `fetch<T>`
   * wrapper for three reasons:
   *   1. Multipart bodies — fetch sets the Content-Type header (with
   *      the right boundary) automatically when body is FormData; the
   *      wrapper's hard-coded `application/json` would break that.
   *   2. Per-call timeout — images can be large on slow links; the
   *      5 s default is too tight. Callers can still pass their own
   *      AbortSignal via init.signal to tighten it.
   *   3. No content-type assertion — the handler returns JSON, but
   *      bailing out to the wrapper for this one small call adds
   *      surface without meaningful payoff.
   *
   * Throws HttpError on non-2xx so call sites can distinguish 404
   * (pane gone), 413 (too big), 415 (unsupported MIME) and show the
   * right toast.
   */
  async uploadFile(
    paneId: string,
    blob: Blob,
    mime: string,
    init?: RequestInit,
  ): Promise<PaneUploadResponse> {
    const form = new FormData();
    // Browser-side File carries a filename; the daemon discards the
    // client-supplied name server-side, but constructing a File with a
    // stable placeholder avoids quirks with some FormData
    // implementations that reject bare Blobs without a filename.
    const ext = mime.split("/")[1] ?? "bin";
    const file = new File([blob], `paste.${ext}`, { type: mime });
    form.append("file", file);
    const headers: Record<string, string> = {
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (this.config.token) {
      headers["Authorization"] = "Bearer " + this.config.token;
    }
    // Explicitly DO NOT set Content-Type — FormData requires the
    // runtime to compute the multipart boundary. Setting it ourselves
    // would produce a malformed header and the daemon's parser would
    // reject the request.
    const res = await fetch(
      this.config.baseUrl + `/panes/${encodeURIComponent(paneId)}/uploads`,
      {
        method: "POST",
        body: form,
        headers,
        signal: init?.signal,
      },
    );
    if (!res.ok) {
      throw new HttpError(res.status, res.statusText, await res.text());
    }
    return (await res.json()) as PaneUploadResponse;
  }

  /**
   * Image-paste path (phase 2 → phase 2). Sends
   * raw image bytes to `POST /panes/:id/clipboard-image`. The daemon
   * writes them to NSPasteboard.general directly (cgo + AppKit, see
   * `internal/macclipboard`) and then writes 0x16 (Ctrl+V) into the
   * pane PTY so Claude Code creates an [Image #N] chip.
   *
   * Returns `true` on success. On a 5xx response — daemon couldn't
   * reach the pasteboard, or the OS-level write failed — returns
   * `false` so the caller can fall back to `uploadFile`. Other non-2xx
   * responses (4xx for bad MIME / pane gone / oversize) throw
   * `HttpError` — they signal caller bugs that shouldn't be silently
   * degraded.
   *
   * Wire change from phase 2: the sidecar-era contract
   * returned 503 with `{"ok":false,"reason":"..."}`. The new in-daemon
   * NSPasteboard path returns plain 500 with a text body. Both are
   * treated as "fall back to /uploads" for back-compat with daemons
   * mid-migration, but only 500 is the live shape.
   *
   * Like `uploadFile` this uses native fetch directly: a raw image body
   * with a single Content-Type header doesn't fit the JSON wrapper.
   */
  async pasteImage(
    paneId: string,
    blob: Blob,
    mime: string,
    init?: RequestInit,
  ): Promise<boolean> {
    const headers: Record<string, string> = {
      "Content-Type": mime,
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (this.config.token) {
      headers["Authorization"] = "Bearer " + this.config.token;
    }
    const res = await fetch(
      this.config.baseUrl + `/panes/${encodeURIComponent(paneId)}/clipboard-image`,
      {
        method: "POST",
        body: blob,
        headers,
        signal: init?.signal,
      },
    );
    if (res.status >= 500 && res.status < 600) {
      // Daemon-side pasteboard write failed (or, on a daemon mid-
      // migration, the legacy sidecar returned 503). Either way, the
      // caller's fallback path runs.
      try {
        const txt = await res.text();
        // eslint-disable-next-line no-console
        console.info("[paste-clipboard] daemon write failed — falling back to /uploads", {
          paneId,
          status: res.status,
          body: txt,
        });
      } catch {
        /* body read errors aren't actionable here */
      }
      return false;
    }
    if (!res.ok) {
      throw new HttpError(res.status, res.statusText, await res.text());
    }
    return true;
  }

  missionControlState() {
    return this.fetch<MissionControlStateResponse>("/mission-control/state");
  }

  missionControlHistory() {
    return this.fetch<MissionControlHistoryResponse>("/mission-control/history");
  }

  missionControlChat(message: string) {
    const body: MissionControlChatRequest = { message };
    return this.fetch<{ ok: boolean; pane_id?: string }>("/mission-control/chat", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  missionControlReset() {
    return this.fetch<{ ok: boolean }>("/mission-control/reset", { method: "POST" });
  }

  /**
   * URL for the Mission Control state WebSocket. See `wsUrl` for the
   * rationale on why the token is not on the URL. Pair with
   * `wsSubprotocols()` at the `new WebSocket(...)` call site.
   */
  missionControlWsUrl(): string {
    const base = this.config.baseUrl.replace(/^http/, "ws");
    return `${base}/ws/mission-control`;
  }

  /**
   * Subprotocol list for authenticating WebSocket upgrades. Browsers
   * can't set Authorization headers on `new WebSocket(...)`, but they
   * can negotiate a subprotocol — so we ferry the bearer through
   * `Sec-WebSocket-Protocol` as `reck-bearer.<token>`. The daemon
   * validates the token and echoes the same subprotocol back in the 101
   * response, which `WebSocket.protocol` then reflects.
   *
   * Returns `[]` when no token is configured (the daemon may be running
   * in unauthenticated mode — e.g. local loopback with an empty
   * DAEMON_TOKEN). Passing `[]` as the second arg to `new WebSocket` is
   * equivalent to omitting it.
   */
  wsSubprotocols(): string[] {
    if (!this.config.token) return [];
    return [`${WS_BEARER_SUBPROTOCOL_PREFIX}${this.config.token}`];
  }
}

/**
 * Subprotocol prefix used for bearer-token WebSocket auth. The daemon's
 * `internal/http.WSBearerSubprotocol` constant must match. The '.' is
 * the delimiter; the bearer string follows verbatim.
 */
export const WS_BEARER_SUBPROTOCOL_PREFIX = "reck-bearer.";
