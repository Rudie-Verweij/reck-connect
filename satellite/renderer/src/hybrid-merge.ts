// Hybrid mode rail merge.
//
// In hybrid mode the rail is fed from `client.listProjects()` against the
// primary (station) host, which only describes station-spawned panes. Panes
// the user opened against the local daemon (the orange `[L]` badge tabs)
// never make it onto the rail unless we also pull `listProjects` from local
// and concatenate the per-pane state per project.
//
// an earlier release / follow-up to the 2026-04-26 voice/gaze rollback. Pulled into
// its own module so it has a unit test independent of the boot orchestrator.

import { stoplightSeverity, type Project, type Stoplight } from "@proto/proto";

export function mergeHybridProjects(
  primary: Project[],
  secondary: Project[],
): Project[] {
  const secondaryById = new Map<string, Project>();
  for (const p of secondary) secondaryById.set(p.id, p);

  return primary.map((sp) => {
    const lp = secondaryById.get(sp.id);
    if (!lp) return sp;
    if (lp.pane_count === 0 && (lp.pane_ids?.length ?? 0) === 0) return sp;

    const primaryIds = sp.pane_ids ?? [];
    const primaryStoplights = sp.pane_stoplights ?? [];
    const secondaryIds = lp.pane_ids ?? [];
    const secondaryStoplights = lp.pane_stoplights ?? [];

    return {
      ...sp,
      pane_count: sp.pane_count + lp.pane_count,
      pane_ids: [...primaryIds, ...secondaryIds],
      pane_stoplights: [...primaryStoplights, ...secondaryStoplights],
      stoplight: maxSeverity(sp.stoplight, lp.stoplight),
    };
  });
}

function maxSeverity(a: Stoplight, b: Stoplight): Stoplight {
  return stoplightSeverity(a) >= stoplightSeverity(b) ? a : b;
}
