import type { Project, Stoplight } from "@proto/proto";

/**
 * Return a Project with any "green" stoplight — both the aggregate and
 * the per-pane indicator dots  — dimmed to "gray" once the user
 * has acknowledged it.
 *
 * Two independent ack scopes:
 *
 *   - Project-level (`isUnseenGreen`): controls the project chip
 *     flash. Cleared when the user pointerdown/keydowns inside the
 *     project's content area (`acknowledgeSeen` in boot.ts) or when
 *     the auto-ack timer fires.
 *
 *   - Per-pane (`isPaneUnseen`, #158): controls each individual
 *     pane indicator dot. Cleared when the user focuses *that*
 *     specific pane (or its auto-ack timer fires). Survives
 *     project-level ack — see boot.ts:247-251 for the intent: "other
 *     tabs in the project (not the one the user is looking at) keep
 *     their green dots until the user actually switches to them".
 *
 * The two scopes layer rather than gate one another. The aggregate
 * dims iff project-level is acked. Each pane dot dims iff its own
 * per-pane is acked, regardless of project-level state. This is what
 * makes mixed-state projects work correctly: a project where one
 * pane just turned green while another is still working will have
 * `isUnseenGreen === false` (no aggregate transition into green) but
 * the freshly-completed pane should still flash.
 *
 * Backward compatibility: callers without per-pane info (Older
 * daemons that omit `pane_ids`, or callers that pass `isPaneUnseen`
 * undefined) fall back to project-flag-only — every green dims when
 * `isUnseenGreen` is false, every green stays when it's true. Same
 * behaviour as Older.
 */
export function effectiveStoplight(
  p: Project,
  isUnseenGreen: boolean,
  isPaneUnseen?: (paneId: string) => boolean,
): Project {
  const paneHasGreen = p.pane_stoplights?.some((s) => s === "green") ?? false;
  if (p.stoplight !== "green" && !paneHasGreen) return p;

  const aggregate: Stoplight =
    !isUnseenGreen && p.stoplight === "green" ? "gray" : p.stoplight;

  let nextPaneStoplights = p.pane_stoplights;
  if (p.pane_stoplights !== undefined) {
    const canFilterPerPane =
      isPaneUnseen !== undefined &&
      p.pane_ids !== undefined &&
      p.pane_ids.length === p.pane_stoplights.length;
    if (canFilterPerPane) {
      const ids = p.pane_ids!;
      nextPaneStoplights = p.pane_stoplights.map((s, i) =>
        s === "green" && !isPaneUnseen!(ids[i]) ? "gray" : s,
      );
    } else if (!isUnseenGreen) {
      // Coarse fallback: no per-pane info → collapse to project flag.
      nextPaneStoplights = p.pane_stoplights.map((s) =>
        s === "green" ? "gray" : s,
      );
    }
    // else: isUnseenGreen=true with no per-pane info → leave panes raw.
  }

  let panesChanged = false;
  if (
    p.pane_stoplights !== undefined &&
    nextPaneStoplights !== p.pane_stoplights
  ) {
    for (let i = 0; i < nextPaneStoplights!.length; i++) {
      if (nextPaneStoplights![i] !== p.pane_stoplights[i]) {
        panesChanged = true;
        break;
      }
    }
  }
  if (aggregate === p.stoplight && !panesChanged) return p;

  const out: Project = { ...p, stoplight: aggregate };
  if (panesChanged) out.pane_stoplights = nextPaneStoplights;
  return out;
}
