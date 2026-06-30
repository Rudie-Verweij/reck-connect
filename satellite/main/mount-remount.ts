/**
 * Mount remount with escalation — extracted from the Electron `main.ts`
 * IPC handler so it can be unit-tested without booting the app. All side
 * effects are injected.
 *
 * Sequence:
 *   1. kickstart the fuse-t watchdog LaunchAgent (it unmounts a stale
 *      handle, reaps orphan go-nfsv4 helpers, then re-runs sshfs).
 *   2. wait up to `waitMs` for the mount sentinel to appear.
 *   3. on timeout, ESCALATE: `diskutil unmount force` the mount point
 *      (belt-and-braces — the watchdog already does this internally, but a
 *      wedged handle the agent can't see is cleared here), then kickstart
 *      again and wait once more.
 *
 * The per-attempt budget must exceed the watchdog's ~16 s worst case
 * (15 s perl-alarm sshfs + settle); a shorter flat wait misreports a
 * slow-but-real remount as "Remount timed out". So each attempt waits the
 * full budget before escalating, and the result tells the caller honestly
 * whether it worked and whether it escalated.
 */
export interface RemountDeps {
  /** Run `launchctl kickstart -k gui/<uid>/eu.verwey.reck-mount`. May reject. */
  kickstart: () => Promise<void>;
  /** Run `diskutil unmount force <mountPoint>`. May reject (non-fatal). */
  unmountForce: () => Promise<void>;
  /** True iff the mount sentinel file is currently stat-able. */
  sentinelPresent: () => boolean;
  /** Injectable delay (real impl: setTimeout; tests: instant). */
  sleep: (ms: number) => Promise<void>;
  /** Per-attempt budget to wait for the sentinel (default 12 s). */
  waitMs?: number;
  /** Sentinel poll interval (default 250 ms). */
  pollMs?: number;
}

export interface RemountResult {
  ok: boolean;
  escalated: boolean;
  error?: string;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function waitForSentinel(
  deps: RemountDeps,
  waitMs: number,
  pollMs: number,
): Promise<boolean> {
  if (deps.sentinelPresent()) return true;
  let waited = 0;
  while (waited < waitMs) {
    await deps.sleep(pollMs);
    waited += pollMs;
    if (deps.sentinelPresent()) return true;
  }
  return false;
}

export async function performRemount(deps: RemountDeps): Promise<RemountResult> {
  const waitMs = deps.waitMs ?? 12_000;
  const pollMs = deps.pollMs ?? 250;

  // Attempt 1 — a clean kickstart.
  try {
    await deps.kickstart();
  } catch (e) {
    return { ok: false, escalated: false, error: `kickstart failed: ${messageOf(e)}` };
  }
  if (await waitForSentinel(deps, waitMs, pollMs)) {
    return { ok: true, escalated: false };
  }

  // Escalate — force-unmount the stale handle, then kick again.
  try {
    await deps.unmountForce();
  } catch {
    // Non-fatal: the watchdog force-unmounts internally too, and the mount
    // may simply not be mounted. Proceed to the re-kick regardless.
  }
  try {
    await deps.kickstart();
  } catch (e) {
    return {
      ok: false,
      escalated: true,
      error: `re-kick after force-unmount failed: ${messageOf(e)}`,
    };
  }
  const ok = await waitForSentinel(deps, waitMs, pollMs);
  return {
    ok,
    escalated: true,
    error: ok ? undefined : "Remount timed out after force-unmount + re-kick",
  };
}
