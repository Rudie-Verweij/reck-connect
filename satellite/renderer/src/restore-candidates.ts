// Helpers for the post-reconnect "restore sessions?" flow. Lives
// outside boot.ts so it can be unit-tested without pulling in the
// xterm/DOM module graph boot.ts drags in.
//
// Introduced alongside an earlier release Scope B: the restore prompt now has
// to branch between Claude (resume_session_id) and shell
// (restore_slot_id), and the branching rule deserves a focused test.

import type { PaneKind, SessionInfo } from "@proto/proto";

/**
 * Translate a restore-candidate SessionInfo into the arguments
 * `ApiClient.createPane` expects. Returns null when the row is
 * malformed (missing the identity its kind needs).
 *
 * Pre-Scope-B daemons omitted `kind` from SessionInfo entirely; the
 * only kind that flowed here was Claude. We default missing kind to
 * "claude" so the Satellite stays back-compat with older stations.
 */
export function buildRestoreCreateArgs(
  s: SessionInfo,
): {
  kind: PaneKind;
  opts: { resumeSessionId?: string; restoreSlotId?: string };
} | null {
  const kind: PaneKind = s.kind ?? "claude";
  if (kind === "shell") {
    if (!s.slot_id) return null;
    return { kind: "shell", opts: { restoreSlotId: s.slot_id } };
  }
  if (!s.session_id) return null;
  return { kind: "claude", opts: { resumeSessionId: s.session_id } };
}
