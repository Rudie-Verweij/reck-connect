// Per-file auto-save coordinator.
//
// Debounces incoming `markDirty(content)` calls and pushes them to the
// supplied `save(content)` async function. At most one save is in flight
// at a time; if new edits land while a save is pending, the newest
// content wins (older intermediate saves are dropped, not queued).
//
// Visibility into the in-flight state is via `onStateChange` so the host
// can drive the loading spinner without polling.

export type AutoSaveState = "idle" | "scheduled" | "saving";

export interface AutoSaveOptions {
  /**
   * Async save function. Called with the most-recent content captured at
   * the moment the debounce timer fired. Must resolve before the next
   * save can start.
   */
  save: (content: string) => Promise<void>;
  /** Debounce window in milliseconds. Default 400 — matches the plan. */
  debounceMs?: number;
  /**
   * Fires on every transition between idle / scheduled / saving. The host
   * uses this to flip the loading spinner on while saving.
   */
  onStateChange?: (state: AutoSaveState) => void;
  /**
   * Fires when a save's promise rejects. The host can surface a toast
   * or banner — the coordinator itself only flips state back to idle.
   */
  onError?: (err: unknown) => void;
}

export interface AutoSaveHandle {
  /** Mark the document dirty with the latest content. Resets the timer. */
  markDirty(content: string): void;
  /** Force-flush any pending save immediately. Returns when the save
   *  completes (or resolves immediately if nothing is pending). */
  flush(): Promise<void>;
  /** Cancel any pending save and reset to idle. The in-flight save (if
   *  any) is allowed to complete. */
  cancel(): void;
  dispose(): void;
  /** Current state. Mainly for testing. */
  getState(): AutoSaveState;
}

export function createAutoSave(opts: AutoSaveOptions): AutoSaveHandle {
  const debounceMs = opts.debounceMs ?? 400;
  let state: AutoSaveState = "idle";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingContent: string | null = null;
  let inFlight: Promise<void> | null = null;
  // Latest content captured during an in-flight save. If non-null when
  // the save finishes, a follow-up save is scheduled to flush it.
  let queuedContent: string | null = null;

  const setState = (s: AutoSaveState) => {
    if (state === s) return;
    const from = state;
    state = s;
    // Round 4 Phase P — single-line diagnostic so a user reproducing
    // phantom-banner / flicker can grep `[autosave]` in devtools and
    // trace markDirty → scheduled → saving → idle without polling.
    // eslint-disable-next-line no-console
    console.log(`[autosave] transition ${from} -> ${s}`);
    opts.onStateChange?.(s);
  };

  const runSave = (content: string): Promise<void> => {
    setState("saving");
    const promise = opts
      .save(content)
      .catch((err) => {
        opts.onError?.(err);
      })
      .finally(() => {
        inFlight = null;
        if (queuedContent !== null) {
          const next = queuedContent;
          queuedContent = null;
          inFlight = runSave(next);
        } else {
          setState("idle");
        }
      });
    return promise;
  };

  const fire = () => {
    timer = null;
    const content = pendingContent;
    if (content === null) {
      setState("idle");
      return;
    }
    pendingContent = null;
    if (inFlight) {
      // A save is already running — queue the new content for after.
      queuedContent = content;
      return;
    }
    inFlight = runSave(content);
  };

  return {
    markDirty(content: string) {
      // Phase P log — fires for every keystroke-driven edit so the
      // user can correlate typing bursts with downstream save events.
      // eslint-disable-next-line no-console
      console.log(`[autosave] markDirty bytes=${content.length}`);
      pendingContent = content;
      if (inFlight) {
        // We'll pick this up after the current save finishes.
        queuedContent = content;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, debounceMs);
      setState("scheduled");
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        fire();
      }
      if (inFlight) await inFlight;
      // Drain any queued follow-up too.
      while (inFlight !== null) {
        await inFlight;
      }
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingContent = null;
      queuedContent = null;
      // We don't abort the in-flight save — it's already past the
      // debounce window and the user pressed Save (or the viewer is
      // closing). Letting it complete preserves the user's intent.
      if (!inFlight) setState("idle");
    },
    dispose() {
      this.cancel();
    },
    getState: () => state,
  };
}
