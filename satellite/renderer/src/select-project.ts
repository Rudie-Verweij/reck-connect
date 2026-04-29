// selectProject sequencing: per-call AbortController + monotonic token
// ensures rapid project switches (A → B → C) can never paint an older
// response into a newer slot. See boot.ts for the caller; this module
// is extracted so the sequencing logic can be unit-tested without
// standing up the full UI.
//
// Background (an earlier release Section 3): the original `selectProject()`
// mutated `currentProjectId`, awaited I/O, then applied the response
// unconditionally. Two back-to-back calls `selectProject(A)` →
// `selectProject(B)` with a delayed A response could leave B
// highlighted but A's tree rendered; `onTreeChange` would then
// persist A's layout under B's key — a persistent data corruption
// until the user manually fixed it.

import type { ProjectDetail } from "@proto/proto";

/**
 * Sequenced fetcher. Each call increments the sequence counter and
 * opens a fresh AbortController; any still-running prior call is
 * aborted. The resolved promise carries the sequence number so the
 * caller can redundantly verify it hasn't been superseded before
 * applying state (belt-and-braces against a fetch that resolves
 * before the abort signal lands).
 *
 * Typical usage in boot.ts:
 *
 *   const seq = selectSeq.next();
 *   const detail = await selectSeq.fetch(projectId, (signal) =>
 *     client.getProject(projectId, { signal })
 *   );
 *   if (seq !== selectSeq.current()) return;  // superseded
 *   applyTree(detail);
 */
export class SelectSequence {
  private seq = 0;
  private ctrl: AbortController | null = null;

  /** Cancel the currently in-flight fetch (if any) and reserve a new
   * sequence number. Returns the new sequence number. */
  next(): number {
    this.ctrl?.abort();
    this.ctrl = new AbortController();
    this.seq++;
    return this.seq;
  }

  /** The current (most recently issued) sequence number. */
  current(): number {
    return this.seq;
  }

  /** The current AbortSignal, or null when no selection is in flight. */
  signal(): AbortSignal | null {
    return this.ctrl?.signal ?? null;
  }

  /** Clear the current in-flight state without aborting (used when the
   * current fetch is done and state has been applied). Safe to call
   * after a successful apply; subsequent `next()` calls will install a
   * fresh controller. */
  settle(): void {
    this.ctrl = null;
  }
}

/**
 * Awaits `fetcher` with the sequence's AbortSignal. Returns
 *
 *   { detail }             — the response, caller should check seq
 *   { aborted: true }      — fetch was cancelled by a newer selection
 *   { error: Error }       — other failure (network, 5xx, etc.)
 *
 * Keeps the call site linear: no try/catch boilerplate around the
 * signal-abort case, which is the common "newer call superseded this"
 * path rather than a bug.
 */
export async function fetchSequenced(
  seq: SelectSequence,
  mySeq: number,
  fetcher: (signal: AbortSignal) => Promise<ProjectDetail>,
): Promise<
  | { ok: true; detail: ProjectDetail }
  | { ok: false; aborted: true }
  | { ok: false; aborted: false; error: unknown }
> {
  const signal = seq.signal();
  if (!signal) {
    // Caller should always `next()` before fetchSequenced; guard just
    // in case to surface the programmer error without crashing.
    return { ok: false, aborted: false, error: new Error("fetchSequenced: no in-flight sequence") };
  }
  try {
    const detail = await fetcher(signal);
    // Redundant: if our sequence was superseded between the fetch
    // resolving and now, drop the response.
    if (mySeq !== seq.current()) return { ok: false, aborted: true };
    return { ok: true, detail };
  } catch (err) {
    if (signal.aborted || mySeq !== seq.current()) return { ok: false, aborted: true };
    return { ok: false, aborted: false, error: err };
  }
}
