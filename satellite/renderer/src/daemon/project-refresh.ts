import { describeError as defaultDescribeError } from "./connection";

/**
 * Context handed to {@link ProjectRefresherOptions.onResult} on every
 * successful refresh.
 *
 * - `firstSuccess`  — true only on the very first successful refresh of
 *   this refresher's lifetime (regardless of how many projects came
 *   back). Boot uses it to dismiss the startup splash exactly once.
 * - `firstNonEmpty` — true only on the first successful refresh that
 *   returned at least one project. Boot uses it to auto-select the first
 *   project / advance the splash to the "layout" step exactly once.
 */
export interface ProjectRefreshInfo {
  firstSuccess: boolean;
  firstNonEmpty: boolean;
}

export interface ProjectRefresherOptions<T> {
  /**
   * The actual refresh operation (boot passes its `refreshProjects`,
   * which fetches `/projects`, merges the hybrid catalog, repaints the
   * rail, and kicks the station→local push). May reject.
   */
  refresh: () => Promise<T[]>;
  /**
   * Called after each successful refresh with the resolved projects and
   * a {@link ProjectRefreshInfo}. May be async; its rejection is
   * swallowed so a slow continuation can never demote the connection.
   */
  onResult?: (projects: T[], info: ProjectRefreshInfo) => void | Promise<void>;
  /**
   * Called with a human-readable message when a refresh fails, and with
   * `null` after a refresh succeeds (so callers can clear a stale error
   * banner). Never throws back into the loop.
   */
  onError?: (message: string | null) => void;
  /** Override the error→string mapping (defaults to connection's `describeError`). */
  describeError?: (e: unknown) => string;
}

/**
 * Single-flight project refresher that decouples rail population from the
 * connection's health-probe success gate.
 *
 * Why this exists: boot used to `await refreshProjects()` *inside* the
 * `DaemonConnection.onPollSuccess` handler, which runs before the probe
 * flips state to `connected`. A slow/failing `/projects` during a
 * half-open Tailscale recovery therefore bounced CONN back to
 * `reconnecting` and left the rail empty even though `/health` was fine.
 * Routing the refresh through this fire-and-forget runner means the heavy
 * fetch can never throw out of the gated handler — CONN reaches
 * `connected` the instant `/health` succeeds, and project-load failures
 * surface via `onError` instead of demoting the connection.
 *
 * Behaviour:
 *  - **Single-flight + coalesce.** `run()` while a refresh is in flight
 *    sets a "queued" flag and returns the in-flight promise; exactly one
 *    extra refresh runs after the current one finishes, no matter how
 *    many `run()` calls pile up. This prevents overlapping `listProjects`
 *    storms when polls and the manual refresh fire together.
 *  - **Never rejects.** `run()` resolves once the (possibly coalesced)
 *    cycle completes; refresh/continuation errors are routed to
 *    `onError`, not thrown. Callers can safely `void refresher.run()`.
 */
export class ProjectRefresher<T> {
  private inFlight = false;
  private queued = false;
  private current: Promise<void> | null = null;
  private seenSuccess = false;
  private seenNonEmpty = false;
  private readonly describe: (e: unknown) => string;

  constructor(private readonly opts: ProjectRefresherOptions<T>) {
    this.describe = opts.describeError ?? defaultDescribeError;
  }

  /**
   * Trigger a refresh. Fire-and-forget for production callers
   * (`void refresher.run()`); returns a never-rejecting promise that
   * resolves when the current cycle (including any coalesced re-run)
   * completes, which tests await.
   */
  run(): Promise<void> {
    if (this.inFlight) {
      this.queued = true;
      return this.current ?? Promise.resolve();
    }
    this.current = this.pump();
    return this.current;
  }

  private async pump(): Promise<void> {
    this.inFlight = true;
    try {
      do {
        this.queued = false;
        await this.cycle();
      } while (this.queued);
    } finally {
      this.inFlight = false;
      this.current = null;
    }
  }

  private async cycle(): Promise<void> {
    let projects: T[];
    try {
      projects = await this.opts.refresh();
    } catch (e) {
      this.opts.onError?.(this.describe(e));
      return;
    }
    const firstSuccess = !this.seenSuccess;
    this.seenSuccess = true;
    const firstNonEmpty = !this.seenNonEmpty && projects.length > 0;
    if (firstNonEmpty) this.seenNonEmpty = true;
    this.opts.onError?.(null);
    try {
      await this.opts.onResult?.(projects, { firstSuccess, firstNonEmpty });
    } catch (e) {
      // A continuation failure (e.g. selectProject) must not demote the
      // connection or abort the refresh loop — surface it and move on.
      console.warn("[project-refresh] onResult continuation failed", e);
    }
  }
}
