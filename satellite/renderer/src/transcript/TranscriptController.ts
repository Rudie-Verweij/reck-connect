// `TranscriptController` — owns the full History-overlay lifecycle for
// every pane in a window: open → resolve session → tail → render →
// close. Extracted from boot.ts so the whole flow (including every
// failure path) is integration-testable with injected deps.
//
// Design rule learned the hard way: the overlay must NEVER silently do
// nothing. Session resolution failures, fetch errors, and empty
// transcripts all render a visible status banner, and every decision
// is logged with a `[transcript]` prefix (DevTools-filterable). Set
// `localStorage["reck-transcript-debug"] = "1"` for verbose per-poll
// and per-render logging.

import { HttpError, type TranscriptChunk } from "@client-core/api/client";
import type { SessionsListResponse } from "@proto/proto";
import type { HostRef } from "../host";
import { setHistoryButtonActive } from "../ui/paneControls";
import { createTranscriptView, type TranscriptViewHandle } from "./TranscriptView";
import { createTranscriptTail, type TranscriptTail } from "./TranscriptTail";
import { TranscriptParser } from "./parseTranscript";
import { resolveTranscriptSession } from "./resolveSession";

export interface TranscriptPaneRef {
  /** Positioned pane wrapper the overlay covers. */
  wrapper: HTMLElement;
  /** Pane kind — only "claude" panes have a transcript. */
  kind: string;
  host: HostRef;
  title: string;
  /** The layout Tab's sessionId, when the poll has filled it in. */
  sessionId?: string;
}

export interface TranscriptApi {
  listSessions(projectId: string): Promise<SessionsListResponse>;
  getTranscript(projectId: string, sessionId: string, offset: number): Promise<TranscriptChunk>;
}

/** ⌘+click handlers for path links inside a transcript, built per host by the
 *  owner (boot/popout) so this controller stays free of reckAPI + cwd knowledge. */
export interface TranscriptLinkHandlers {
  onLinkActivate?(href: string, ev: MouseEvent): void;
  onExternalActivate?(href: string, ev: MouseEvent): void;
}

export interface TranscriptControllerDeps {
  /** Resolve a pane's wrapper/kind/host/session by pane id, or null. */
  resolvePane(paneId: string): TranscriptPaneRef | null;
  /** The active project (null when none is selected). */
  projectId(): string | null;
  api(host: HostRef): TranscriptApi;
  /** ⌘+click path-link handlers for a pane's host (optional). */
  linkHandlers?(host: HostRef): TranscriptLinkHandlers;
  /** Tail poll interval; default 1500ms. */
  intervalMs?: number;
  /** Log sink; defaults to console.info with a `[transcript]` prefix. */
  log?(msg: string, data?: unknown): void;
}

export interface TranscriptController {
  /** Open the overlay for a pane, or close it if already open. */
  toggle(paneId: string): Promise<void>;
  isOpen(paneId: string): boolean;
  /** The open overlay's view (search subsystem wiring), or null. */
  get(paneId: string): { view: TranscriptViewHandle } | null;
  /** Close every open overlay (window teardown). */
  closeAll(): void;
}

interface OpenEntry {
  view: TranscriptViewHandle;
  tail: TranscriptTail | null;
  /** Pane wrapper hosting the clock button — its lit state mirrors ours. */
  wrapper: HTMLElement;
}

export function createTranscriptController(
  deps: TranscriptControllerDeps,
): TranscriptController {
  const open = new Map<string, OpenEntry>();
  const log =
    deps.log ??
    ((msg: string, data?: unknown) =>
      data === undefined ? console.info("[transcript]", msg) : console.info("[transcript]", msg, data));

  function debug(): boolean {
    try {
      return globalThis.localStorage?.getItem("reck-transcript-debug") === "1";
    } catch {
      return false;
    }
  }

  function close(paneId: string, reason: string): void {
    const entry = open.get(paneId);
    if (!entry) return;
    open.delete(paneId);
    entry.tail?.stop();
    entry.view.dispose();
    setHistoryButtonActive(entry.wrapper, false);
    log(`closed pane=${paneId} reason=${reason}`);
  }

  async function toggle(paneId: string): Promise<void> {
    if (open.has(paneId)) {
      close(paneId, "toggle");
      return;
    }
    const pane = deps.resolvePane(paneId);
    if (!pane) {
      log(`open aborted pane=${paneId}: pane not found in layout`);
      return;
    }
    if (pane.kind !== "claude") {
      log(`open aborted pane=${paneId}: kind=${pane.kind} has no transcript`);
      return;
    }
    const projectId = deps.projectId();
    if (!projectId) {
      log(`open aborted pane=${paneId}: no active project`);
      return;
    }
    log(
      `open pane=${paneId} project=${projectId} host=${pane.host} tabSession=${
        pane.sessionId ? pane.sessionId.slice(0, 8) : "none"
      }`,
    );
    const api = deps.api(pane.host);

    // Mount immediately with a loading banner — the click must produce
    // visible feedback even when resolution needs a round-trip or fails.
    const view = createTranscriptView({
      host: pane.wrapper,
      sessionId: pane.sessionId,
      onClose: () => close(paneId, "user"),
      ...(deps.linkHandlers ? deps.linkHandlers(pane.host) : {}),
    });
    view.setStatus({ kind: "loading", message: "Loading transcript…" });
    const entry: OpenEntry = { view, tail: null, wrapper: pane.wrapper };
    open.set(paneId, entry);
    setHistoryButtonActive(pane.wrapper, true);

    const via = pane.sessionId ? "tab" : "list";
    const sessionId = await resolveTranscriptSession({
      tabSessionId: pane.sessionId,
      paneId,
      listSessions: () => api.listSessions(projectId),
    });
    if (open.get(paneId) !== entry) return; // closed while resolving
    if (!sessionId) {
      log(`no session found pane=${paneId} (tab had none, list had no match)`);
      view.setStatus({
        kind: "empty",
        message:
          "No transcript session found for this pane yet — send a message in the chat first, then reopen History.",
      });
      return;
    }
    log(`session resolved pane=${paneId} via=${via} session=${sessionId.slice(0, 8)}`);
    startTail(paneId, entry, api, projectId, sessionId, via === "tab");
  }

  /**
   * Start (or restart, after a stale-session 404) the tail for an open
   * entry. `canFallback` is true only for a tab-provided session id —
   * one 404 there means the pane respawned since the tab was stamped,
   * so we re-resolve once from the session list.
   */
  function startTail(
    paneId: string,
    entry: OpenEntry,
    api: TranscriptApi,
    projectId: string,
    sessionId: string,
    canFallback: boolean,
  ): void {
    const parser = new TranscriptParser();
    let firstChunk = true;
    let sawTurns = false;
    let showedError = false;

    const tail = createTranscriptTail({
      intervalMs: deps.intervalMs,
      fetchChunk: (offset) => {
        // Layout rebuilds (project switch, pane close) replace the
        // wrapper; a disconnected root means the overlay is a ghost.
        if (!entry.view.root.isConnected) {
          close(paneId, "wrapper left the DOM");
          return Promise.resolve({ chunk: "", nextOffset: offset, hasMore: false });
        }
        if (debug()) log(`poll pane=${paneId} offset=${offset}`);
        return api.getTranscript(projectId, sessionId, offset);
      },
      onChunk: (chunk) => {
        const update = parser.push(chunk);
        if (firstChunk) {
          firstChunk = false;
          log(
            `first chunk pane=${paneId} bytes=${chunk.length} turns=${parser.turns.length}`,
          );
        }
        if (showedError) {
          showedError = false;
          entry.view.setStatus(sawTurns ? { kind: "live" } : { kind: "loading", message: "Loading transcript…" });
        }
        if (update) {
          if (!sawTurns) {
            sawTurns = true;
            entry.view.setStatus({ kind: "live" });
          }
          entry.view.render(parser.turns, update.firstChanged);
          if (debug()) {
            const b = entry.view.body;
            log(
              `render pane=${paneId} turns=${parser.turns.length} firstChanged=${update.firstChanged} scrollHeight=${b.scrollHeight} clientHeight=${b.clientHeight} scrollTop=${b.scrollTop}`,
            );
          }
        } else if (!sawTurns) {
          entry.view.setStatus({
            kind: "empty",
            message: "Transcript has no chat turns yet.",
          });
        }
      },
      onError: (err) => {
        const status = err instanceof HttpError ? err.status : undefined;
        log(`tail error pane=${paneId} status=${status ?? "?"}: ${String(err)}`);
        if (status === 404 && canFallback && firstChunk) {
          // Stale tab session id (pane respawned) — re-resolve once.
          log(`stale tab session pane=${paneId} — re-resolving via session list`);
          entry.tail?.stop();
          void (async () => {
            const fresh = await resolveTranscriptSession({
              paneId,
              listSessions: () => api.listSessions(projectId),
            });
            if (open.get(paneId) !== entry) return;
            if (!fresh || fresh === sessionId) {
              log(`re-resolve failed pane=${paneId} fresh=${fresh ?? "none"}`);
              entry.view.setStatus({
                kind: "error",
                message: "Transcript not found on the station (404).",
              });
              return;
            }
            log(`re-resolved pane=${paneId} session=${fresh.slice(0, 8)}`);
            startTail(paneId, entry, api, projectId, fresh, false);
          })();
          return;
        }
        showedError = true;
        entry.view.setStatus({
          kind: "error",
          message: `Transcript fetch failed${status ? ` (${status})` : ""} — retrying…`,
        });
      },
    });
    entry.tail = tail;
    tail.start();
  }

  return {
    toggle,
    isOpen: (paneId) => open.has(paneId),
    get: (paneId) => {
      const entry = open.get(paneId);
      return entry ? { view: entry.view } : null;
    },
    closeAll: () => {
      for (const paneId of [...open.keys()]) close(paneId, "close-all");
    },
  };
}
