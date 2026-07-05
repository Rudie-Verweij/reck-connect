// Resolve which Claude session a pane's transcript view should tail.
//
// Two sources, in preference order:
//   1. The layout Tab's own `sessionId` — reconciled from the daemon's
//      `/projects` detail on every poll, so it's the freshest mapping
//      and needs no extra round-trip.
//   2. `GET /projects/:id/sessions` — match `last_pane_id` to the pane.
//      A respawned pane can leave an older dead entry pointing at the
//      same pane id, so a `was_live` entry wins over a dead one.

import type { SessionsListResponse } from "@proto/proto";

export interface ResolveTranscriptSessionOptions {
  /** The layout Tab's sessionId, when the poll has filled it in. */
  tabSessionId?: string;
  paneId: string;
  listSessions(): Promise<SessionsListResponse>;
}

export async function resolveTranscriptSession(
  opts: ResolveTranscriptSessionOptions,
): Promise<string | null> {
  if (opts.tabSessionId) return opts.tabSessionId;
  try {
    const res = await opts.listSessions();
    const matches = (res.sessions ?? []).filter(
      (s) => s.last_pane_id === opts.paneId && !!s.session_id,
    );
    if (matches.length === 0) return null;
    const live = matches.find((s) => s.was_live === true);
    return (live ?? matches[0]).session_id ?? null;
  } catch {
    // Offline / auth trouble — the caller shows its "no transcript"
    // state; the connection banner covers the underlying problem.
    return null;
  }
}
