import type { HealthResponse } from "@proto/proto";
import { ApiClient, HttpError } from "@client-core/api/client";

export type ConnState = "connecting" | "connected" | "reconnecting";

export interface ConnectionInfo {
  state: ConnState;
  /** Human-readable reason for the last failed probe. Cleared on success. */
  lastError: string | null;
  /** Daemon-reported uptime from the last successful probe. */
  uptimeSec: number | null;
}

export type StateListener = (info: ConnectionInfo) => void;

export interface DaemonConnectionConfig {
  client: ApiClient;
  /** Interval between polls after a successful probe. */
  pollIntervalMs?: number;
  /** Timeout for the background poll fetch. */
  pollTimeoutMs?: number;
  /**
   * Timeout for a user-initiated `refresh()`. Kept short so the spinner
   * stops promptly when the station is unreachable — 5 s still feels
   * like "forever" to someone staring at a UI.
   */
  refreshTimeoutMs?: number;
  /**
   * Called on each successful probe with the health payload. This is
   * where callers refresh projects, reload on uptime regressions, prompt
   * for session restore, etc. Errors thrown here turn into a
   * "reconnecting" state with the thrown error as the reason.
   */
  onPollSuccess?: (health: HealthResponse) => void | Promise<void>;
  /**
   * Called whenever the last probe fails. Separate from state listeners
   * so callers can react to specific errors (e.g. 401 → re-auth prompt)
   * without subscribing to every tick.
   */
  onPollFailure?: (reason: string, error: unknown) => void;
  /**
   * Predicate consulted before each *background* poll. When it returns
   * false the probe is skipped and the loop simply reschedules — used to
   * hold off polling a host until it's authenticated, so a token-less
   * probe never draws a spurious 401. A user-initiated `refresh()` is
   * unaffected and always probes. Absent = always poll.
   */
  shouldPoll?: () => boolean;
}

/**
 * Central daemon-connection controller. Owns the poll loop, the abort
 * controller per probe, the state machine, and the subscriber fanout.
 * All CONN-dot rendering and the Refresh button both read from here —
 * there's no other source of truth.
 *
 *   const conn = new DaemonConnection({ client, onPollSuccess });
 *   const off = conn.subscribe((info) => statusBar.setConn(info));
 *   conn.start();
 *   await conn.refresh();  // button click
 *   conn.stop();
 *   off();
 */
export class DaemonConnection {
  private info: ConnectionInfo = {
    state: "connecting",
    lastError: null,
    uptimeSec: null,
  };
  private listeners = new Set<StateListener>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: AbortController | null = null;
  private running = false;

  constructor(private config: DaemonConnectionConfig) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedulePoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.abortInflight();
  }

  subscribe(cb: StateListener): () => void {
    this.listeners.add(cb);
    cb(this.info);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getInfo(): ConnectionInfo {
    return this.info;
  }

  /**
   * Force an immediate probe. Cancels any in-flight fetch and the
   * pending background tick, flips the state to "reconnecting" so the
   * user sees instant feedback, probes with the short refresh timeout,
   * and re-arms the regular cadence in `finally`. Re-throws so callers
   * (e.g. the status-bar button) can surface a failure.
   */
  async refresh(): Promise<void> {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.abortInflight();
    // Immediate "reconnecting" so the CONN dot isn't stuck on stale
    // green while the fetch is in flight. lastError cleared — we'll set
    // it only if the refresh itself fails.
    this.updateState({ state: "reconnecting", lastError: null });
    try {
      await this.probe(this.config.refreshTimeoutMs ?? 3000);
    } finally {
      // Only re-arm the regular cadence if the controller is running —
      // a refresh() without a prior start() stays one-shot.
      if (this.running) this.schedulePoll(this.config.pollIntervalMs ?? 2000);
    }
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    if (this.config.shouldPoll && !this.config.shouldPoll()) {
      // Not ready to probe yet (e.g. local host still un-authenticated).
      // Reschedule so the loop keeps ticking and picks up readiness later.
      if (this.running) this.schedulePoll(this.config.pollIntervalMs ?? 2000);
      return;
    }
    try {
      await this.probe(this.config.pollTimeoutMs ?? 5000);
    } catch {
      // Swallow — state is already updated in probe(). The background
      // loop shouldn't surface failures on its own.
    }
    if (this.running) this.schedulePoll(this.config.pollIntervalMs ?? 2000);
  }

  private async probe(timeoutMs: number): Promise<HealthResponse> {
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // Diagnostic : record probe start so we can correlate
    // failure timing against MOUNT transitions on a Tailscale drop.
    const startMs = Date.now();
    try {
      const health = await this.config.client.health({ signal: ctrl.signal });
      // Run the success handler BEFORE flipping to "connected" — we want
      // /projects fetches and session-restore prompts to count as part
      // of "connected". A failure there surfaces as reconnecting, not a
      // momentary-green glitch.
      if (this.config.onPollSuccess) await this.config.onPollSuccess(health);
      this.updateState({
        state: "connected",
        lastError: null,
        uptimeSec: health.uptime_sec,
      });
      return health;
    } catch (e) {
      const reason = describeError(e);
      const elapsed = Date.now() - startMs;
      console.log(
        `[conn] ${Date.now()} probe fail elapsed=${elapsed}ms timeoutMs=${timeoutMs} reason=${reason}`,
      );
      // If `this.inflight` has already been cleared or replaced, this
      // probe was externally superseded (e.g. `refresh()` called
      // `abortInflight()` and started a fresh probe). The caller has
      // either already updated state or is about to; don't emit a
      // stale "Timed out" that arms an earlier release MountHint on a deliberate
      // abort rather than a real tailnet failure.
      if (this.inflight === ctrl) {
        this.updateState({ state: "reconnecting", lastError: reason });
        if (this.config.onPollFailure) this.config.onPollFailure(reason, e);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (this.inflight === ctrl) this.inflight = null;
    }
  }

  private abortInflight(): void {
    if (this.inflight) {
      this.inflight.abort();
      this.inflight = null;
    }
  }

  private updateState(patch: Partial<ConnectionInfo>): void {
    const prev = this.info.state;
    this.info = { ...this.info, ...patch };
    // Diagnostic : log CONN state transitions with a wall-clock
    // timestamp so the MOUNT/CONN asymmetry can be measured against
    // `[mount]` log lines when reproducing a Tailscale drop.
    if (patch.state !== undefined && patch.state !== prev) {
      const err = this.info.lastError ? ` reason=${this.info.lastError}` : "";
      console.log(`[conn] ${Date.now()} state ${prev} -> ${this.info.state}${err}`);
    }
    for (const l of this.listeners) l(this.info);
  }
}

export function describeError(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 401) return "Unauthorized";
    return `HTTP ${e.status}`;
  }
  if (e instanceof DOMException && e.name === "AbortError") return "Timed out";
  if (e instanceof TypeError) return "Network unreachable";
  if (e instanceof Error && e.message) return e.message;
  return "Unknown error";
}
