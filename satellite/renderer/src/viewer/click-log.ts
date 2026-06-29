// Round 8.6 Phase 9 — shared click-log + openInViewer-handle helper.
//
// Centralises three things that used to drift across surfaces:
//   1. Consistent log format ([click:<surface>] activate {...})
//   2. Result handling (same-popup toast, rejection toast, throw-warn)
//   3. One place to evolve the contract when adding a new surface
//
// Before this helper, the markdown surface had a rich `.then()` chain
// that surfaced both rejections and the same-popup toast, while the
// source surface fire-and-forgot the openInViewer promise — so neither
// toast fired and the user got pure silence on same-file clicks.

export type ClickSurface =
  | "pane"
  | "popup-markdown"
  | "popup-source"
  | "popup-picker"
  | "popup-recursive";

/**
 * Common payload for every click that ends in `reckAPI.files.openInViewer`.
 * Surfaces fill what they know; missing fields are omitted from the log.
 */
export interface ClickContext {
  surface: ClickSurface;
  /** Raw clicked text (before any pre-resolution). */
  href: string;
  /** The file the click originated FROM (popup surfaces only). */
  opener?: string;
  /** The path actually sent to openInViewer (may differ from href). */
  target: string;
  sourceHost?: "station" | "local";
  projectCwd?: string;
  /** Free-form per-surface fields (e.g. paneId, resolvedHost). */
  extras?: Record<string, unknown>;
}

/** Click activation — fired immediately before the IPC call. */
export function logClickActivate(ctx: ClickContext): void {
  console.log(`[click:${ctx.surface}] activate`, redactCtx(ctx));
}

/** IPC returned a rejection (ok=false or unexpected shape). */
export function logClickRejected(
  ctx: ClickContext,
  result: { ok?: boolean; code?: string; error?: string } | undefined,
): void {
  console.warn(`[click:${ctx.surface}] openInViewer rejected`, {
    ...redactCtx(ctx),
    result,
  });
}

/** IPC promise rejected (network / preload error). */
export function logClickThrew(ctx: ClickContext, err: unknown): void {
  console.warn(`[click:${ctx.surface}] openInViewer threw`, {
    ...redactCtx(ctx),
    error: err,
  });
}

/** Main returned `code: "same-popup"` — the user clicked the same file. */
export function logClickSamePopup(ctx: ClickContext): void {
  console.log(`[click:${ctx.surface}] already-open (toast)`, redactCtx(ctx));
}

/**
 * Drop noisy/empty fields from the log payload. Returning a shallow copy
 * keeps the caller's ctx untouched and yields a tight one-line log.
 */
function redactCtx(ctx: ClickContext): Record<string, unknown> {
  const out: Record<string, unknown> = {
    surface: ctx.surface,
    href: ctx.href,
    target: ctx.target,
  };
  if (ctx.opener) out.opener = ctx.opener;
  if (ctx.sourceHost) out.sourceHost = ctx.sourceHost;
  if (ctx.projectCwd) out.projectCwd = ctx.projectCwd;
  if (ctx.extras) Object.assign(out, ctx.extras);
  return out;
}

// --- openInViewer wrapper with toast handling -------------------------------

export interface OpenInViewerResult {
  ok?: boolean;
  code?: string;
  error?: string;
}

export interface ToastShowOpts {
  ttl?: number;
  /** Round 8.6 follow-up — "info" (default, Reck-orange) or "error" (Wes-rose). */
  kind?: "info" | "error";
}

export interface OpenInViewerWithToastOpts {
  ctx: ClickContext;
  /** Bound caller — e.g. `() => window.reckAPI.files.openInViewer(target, opts)`. */
  openInViewer: () => Promise<OpenInViewerResult | undefined>;
  /**
   * Toast surface. Receives the message + optional `{ ttl, kind }`.
   * Wire to Toast.ts's `showToast` like:
   *   `(msg, o) => showToast(shell.body, msg, { durationMs: o?.ttl, kind: o?.kind })`
   */
  showToast: (msg: string, opts?: ToastShowOpts) => void;
}

/**
 * Calls openInViewer, then dispatches the result:
 *   - ok=true + no code         → silent
 *   - ok=true + code=same-popup → toast "Already viewing this file." (info)
 *   - ok=true + code=focused-existing → silent (sibling popup focused)
 *   - ok=false                  → toast "Could not open: {error}" (error, 3.5s)
 *   - thrown                    → warn-log only (avoid spam on transients)
 *
 * Always resolves; never rejects. Callers can `void openInViewerWithToast(...)`.
 */
export async function openInViewerWithToast(
  opts: OpenInViewerWithToastOpts,
): Promise<void> {
  try {
    const result = await opts.openInViewer();
    if (!result || result.ok !== true) {
      logClickRejected(opts.ctx, result);
      opts.showToast(
        result?.error ? `Could not open: ${result.error}` : "Could not open file.",
        { ttl: 3500, kind: "error" },
      );
      return;
    }
    if (result.code === "same-popup") {
      logClickSamePopup(opts.ctx);
      opts.showToast("Already viewing this file.");
    }
    // ok=true + code=focused-existing OR no code → no UI signal needed
  } catch (err) {
    logClickThrew(opts.ctx, err);
  }
}
