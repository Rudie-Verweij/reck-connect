// Reconcile a saved split-tree layout against the daemon's live pane list.
//
// Problem: when the daemon restarts, every `pane_id` is regenerated. The
// Satellite's saved layout tree keys tabs by `paneId`, so a naive match
// finds nothing and the user's splits + tab order collapse. The daemon
// persists a stable identity per pane — `session_id` for Claude panes
// (the `--resume` UUID) and `slot_id` for shell panes (an earlier release Scope
// B) — both surfaced on the wire `Pane` and saved onto `Tab`. Reconcile
// rekeys on the identity that matches the tab's kind.
//
// Kind-namespaced lookup (Codex MEDIUM #4): Claude session_ids and
// shell slot_ids are both UUIDs and live in separate maps. A Claude
// tab can ONLY rebind to a Claude pane whose session_id matches; a
// shell tab can ONLY rebind to a shell pane whose slot_id matches. A
// cross-kind collision (same UUID string used as session_id on one
// side and slot_id on the other — astronomically unlikely with a
// real generator but possible with hand-edited state) is treated as a
// non-match and the tab drops. Silent wrong-bind is the worst failure
// mode: the layout LOOKS valid while pointing at the wrong process.
//
// Three passes, in order:
//
//   1a. Rekey in-place by kind-scoped identity: for each saved tab
//       whose identity (sessionId for Claude tabs, slotId for shell
//       tabs) matches a live pane of the SAME kind, rewrite that tab's
//       `paneId` to the new generation. Split structure, ratios, tab
//       order, and `activeTabId` are preserved bit-for-bit.
//
//   1b. Capture identity: tabs without a stored identity but whose
//       paneId is still live (fresh-create race: pane was just
//       created, sessionId/slotId hadn't been fetched yet) get their
//       identity captured from the live pane (kind-correct field
//       only). Future restarts can then rekey via 1a.
//
//   2. Drop stale: any saved tab that didn't bind in 1a/1b is closed
//      via `closeTab`, which collapses leaves that become empty.
//
//   3. Append uncovered: any live pane that didn't bind to a saved tab
//      is appended to the first remaining leaf (or becomes the only
//      leaf if the tree is now empty). This is the pre-existing
//      fallback for panes that were created on another client.
//
// Duplicate policy: if the saved tree has two tabs sharing an
// identity, or the live list has two panes sharing one, we bind the
// first occurrence and drop the rest. Two live panes with the same
// identity shouldn't happen (daemon invariant), and two saved tabs
// with the same identity shouldn't either (we only capture it once,
// via reconcile), but we guard against both regardless — silently
// degrading is less confusing than throwing.
//
// A title-sync pass runs last, identical to the pre-issue-#46
// behaviour: for every bound tab, run the daemon's current pane
// shape through `titleFor` and copy the result onto the tab title
// so a rename (or a new Claude custom-title, per an earlier release) performed on
// another client becomes visible here.

import type { Pane, PaneKind } from "@proto/proto";
import type { HostRef } from "../host";
import {
  addTab,
  allLeaves,
  allPaneIds,
  closeTab,
  defaultTabTitle,
  leafWithTab,
  tab,
  type LeafNode,
  type Tab,
  type TreeNode,
} from "./split-tree";

/**
 * Per-host live-pane map. Entries are scoped by the host each pane
 * lives on, so reconcile can bind a saved tab to a live pane only
 * when both agree on host. Hybrid-mode callers (Phase 10 fixup after
 * Codex review) supply both hosts; single-host callers supply just
 * one.
 */
export type LivePanesByHost = Partial<Record<HostRef, Pane[]>>;

/**
 * Resolve the tab title for a pane. Precedence chain:
 *
 *   1. `display_name` — user-set override from the rename RPC. Wins
 *      unconditionally when non-empty (after trim).
 *   2. `auto_name`    — daemon-derived label from Claude Code's own
 *      session title . Daemon populates this for Claude
 *      panes without a display_name; stays empty for shell panes and
 *      for Claude sessions that haven't written a custom-title yet.
 *   3. `defaultTabTitle(kind)` — generic "Claude" / "Shell" fallback.
 *
 * Exposed so the renderer can reuse the same chain anywhere a pane
 * label needs computing (not just inside reconcile's title-sync pass).
 */
export function titleFor(p: Pane): string {
  const display = p.display_name?.trim();
  if (display) return display;
  const auto = p.auto_name?.trim();
  if (auto) return auto;
  return defaultTabTitle(p.kind);
}

/**
 * Return the kind-correct identity for a tab: sessionId iff the tab
 * is Claude-kind, slotId iff it's shell- or codex-kind (both use the
 * slot identity). Undefined for panes without a persistent identity
 * (pre-Scope-B tabs, or any tab the daemon hasn't yet surfaced an id
 * for).
 */
function identityOfTab(t: Tab): string | undefined {
  if (t.kind === "claude") return t.sessionId;
  if (t.kind === "shell" || t.kind === "codex") return t.slotId;
  return undefined;
}

/**
 * Same rule applied to a live Pane.
 */
function identityOfPane(p: Pane): string | undefined {
  if (p.kind === "claude") return p.session_id;
  if (p.kind === "shell" || p.kind === "codex") return p.slot_id;
  return undefined;
}

/**
 * Walk the tree and, for each leaf, mutate tab objects in place. This
 * is safe because reconcile() builds a fresh working copy before
 * handing it back to callers (see the top-level structuredClone), and
 * because we don't rely on referential identity anywhere — TreeNodes
 * are plain data.
 */
function forEachTab(tree: TreeNode, fn: (leaf: LeafNode, tab: Tab) => void) {
  for (const leaf of allLeaves(tree)) {
    for (const t of leaf.tabs) fn(leaf, t);
  }
}

/**
 * Reconcile a saved layout tree against fresh live-pane lists from
 * every enabled host. See the file-level comment for the full
 * algorithm; briefly:
 *
 *   - rekey saved tabs by stable id (session_id for Claude, slot_id
 *     for shell) onto new `paneId`s — a tab whose `host` is X only
 *     binds against live panes from host X (Phase 10 fixup; codex
 *     review flagged that the single-client reconcile mislabelled or
 *     dropped cross-host tabs on re-select).
 *   - also capture the stable id onto tabs that were bound by `paneId`
 *     but hadn't yet been given one (first poll after creation)
 *   - drop saved tabs with no live match in their own host's list
 *   - append remaining live panes to the first leaf, stamping each
 *     new tab with the host its pane came from (so hybrid layouts
 *     reconcile correctly after daemon restarts on either side)
 *   - sync titles from `display_name`
 *
 * `livePanesByHost` accepts one entry per enabled host. Missing
 * entries mean "no live panes from that host" — saved tabs on a
 * missing host are treated as stale (exactly the same as the
 * single-host behaviour for a disappeared pane). A station-only
 * setup passes `{ station: panes }`; a hybrid setup passes both.
 */
export function reconcile(
  saved: TreeNode | null,
  livePanesByHost: LivePanesByHost,
): TreeNode | null;
/**
 * Back-compat overload for single-host callers. Equivalent to calling
 * the map form with `{ [host]: livePanes }`. Kept so the pre-hybrid
 * test corpus didn't need a mechanical rewrite and so a future non-
 * hybrid consumer stays ergonomic.
 */
export function reconcile(
  saved: TreeNode | null,
  livePanes: Pane[],
  host: HostRef,
): TreeNode | null;
export function reconcile(
  saved: TreeNode | null,
  arg2: LivePanesByHost | Pane[],
  host?: HostRef,
): TreeNode | null {
  const livePanesByHost: LivePanesByHost = Array.isArray(arg2)
    ? ({ [host as HostRef]: arg2 } as LivePanesByHost)
    : arg2;
  return reconcileImpl(saved, livePanesByHost);
}

/**
 * Count how many saved tabs' (host, kind, identity) triples have a
 * live pane in their host's list. Used by `selectProject`'s retry
 * loop (hybrid mode phase 10a fixup round 2): a saved local tab can
 * only be "matched" when local's pane list actually contains that
 * session_id / slot_id. Station pane identities never cover for
 * local tabs — that cross-host bleed was the round-1 bug.
 *
 * Tabs whose host isn't keyed in `livePanesByHost` contribute zero
 * to the count regardless of their identity (reconcile would drop
 * them as stale anyway; no point waiting on a host we're not
 * querying).
 */
export function countMatchingIdentities(
  saved: TreeNode | null,
  livePanesByHost: LivePanesByHost,
): number {
  if (!saved) return 0;
  type Buckets = { claude: Set<string>; shell: Set<string>; codex: Set<string> };
  const byHost = new Map<HostRef, Buckets>();
  for (const [host, panes] of Object.entries(livePanesByHost)) {
    if (!panes) continue;
    const b: Buckets = { claude: new Set(), shell: new Set(), codex: new Set() };
    for (const p of panes) {
      if (p.kind === "claude" && p.session_id) b.claude.add(p.session_id);
      if (p.kind === "shell" && p.slot_id) b.shell.add(p.slot_id);
      if (p.kind === "codex" && p.slot_id) b.codex.add(p.slot_id);
    }
    byHost.set(host as HostRef, b);
  }
  let n = 0;
  for (const leaf of allLeaves(saved)) {
    for (const tb of leaf.tabs) {
      const bucket = byHost.get(tb.host);
      if (!bucket) continue;
      if (tb.kind === "claude" && tb.sessionId && bucket.claude.has(tb.sessionId)) n++;
      else if (tb.kind === "shell" && tb.slotId && bucket.shell.has(tb.slotId)) n++;
      else if (tb.kind === "codex" && tb.slotId && bucket.codex.has(tb.slotId)) n++;
    }
  }
  return n;
}

/**
 * Count saved tabs that have a stable identity (sessionId for Claude,
 * slotId for shell) AND whose host is queried in `livePanesByHost`
 * (including hosts with an empty-array entry — an empty entry means
 * "host is reachable but hasn't returned panes yet"). Tabs whose host
 * is omitted from the map are excluded — they belong to a host we
 * can't reach in the current session and waiting on them would stall
 * the retry budget for 12 s per project-open (codex round 3).
 */
export function countSavedIdentityTabsInReachableHosts(
  saved: TreeNode | null,
  livePanesByHost: LivePanesByHost,
): number {
  if (!saved) return 0;
  const reachable = new Set(Object.keys(livePanesByHost));
  let n = 0;
  for (const leaf of allLeaves(saved)) {
    for (const tb of leaf.tabs) {
      const hasIdentity =
        (tb.kind === "claude" && !!tb.sessionId) ||
        ((tb.kind === "shell" || tb.kind === "codex") && !!tb.slotId);
      if (!hasIdentity) continue;
      if (!reachable.has(tb.host)) continue;
      n++;
    }
  }
  return n;
}

function reconcileImpl(
  saved: TreeNode | null,
  livePanesByHost: LivePanesByHost,
): TreeNode | null {
  // Build per-host maps. Kind-namespaced so a Claude tab with
  // sessionId == X can't cross-bind to a shell pane with slot_id ==
  // X (and vice versa); host-namespaced so a local tab never binds
  // to a station pane whose identity happens to match. Two live
  // panes of the same kind+host sharing an identity would still be a
  // daemon-invariant violation; we pick the first and let the second
  // fall through to the "uncovered" pass (where it lands in the first
  // leaf as a new tab with the right host).
  type KindMap = Record<PaneKind, Map<string, Pane>>;
  const makeKindMap = (): KindMap => ({
    claude: new Map<string, Pane>(),
    shell: new Map<string, Pane>(),
    codex: new Map<string, Pane>(),
  });
  const paneByHostId = new Map<HostRef, Map<string, Pane>>();
  const paneByHostKindIdentity = new Map<HostRef, KindMap>();
  const allHosts: HostRef[] = ["station", "local"];
  for (const host of allHosts) {
    const hostPanes = livePanesByHost[host] ?? [];
    const idMap = new Map<string, Pane>();
    const kindMap = makeKindMap();
    for (const p of hostPanes) {
      idMap.set(p.id, p);
      const id = identityOfPane(p);
      if (id && !kindMap[p.kind].has(id)) kindMap[p.kind].set(id, p);
    }
    paneByHostId.set(host, idMap);
    paneByHostKindIdentity.set(host, kindMap);
  }

  // Start from a deep copy so we can mutate tabs in place during the
  // rekey pass without aliasing the caller's saved state.
  let t: TreeNode | null = saved ? structuredClone(saved) : null;

  // --- Pass 1: rekey by kind+host-scoped identity, in place. ---
  const boundTabIds = new Set<string>();
  // Pair (host, paneId) so a station pane and a local pane that
  // happen to share a paneId string don't consume each other's bind
  // slot. Keys: `"station:abc"` / `"local:xyz"`.
  const consumedHostPaneKeys = new Set<string>();
  const hostKey = (host: HostRef, paneId: string) => `${host}:${paneId}`;
  if (t) {
    forEachTab(t, (_leaf, tb) => {
      const id = identityOfTab(tb);
      if (!id) return;
      const kindMap = paneByHostKindIdentity.get(tb.host);
      if (!kindMap) return;
      const live = kindMap[tb.kind].get(id);
      if (!live) return;
      const key = hostKey(tb.host, live.id);
      if (consumedHostPaneKeys.has(key)) return;
      tb.paneId = live.id;
      boundTabIds.add(tb.id);
      consumedHostPaneKeys.add(key);
    });

    // Secondary bind (Pass 1b): tabs without an identity but whose
    // paneId happens to still be live on the same host (e.g. the very
    // first reconcile after the tab was created, before it had a
    // chance to pick up a session_id/slot_id, on a daemon that hasn't
    // restarted). Capture whichever identity matches the tab's kind.
    forEachTab(t, (_leaf, tb) => {
      if (identityOfTab(tb)) return;
      const hostIds = paneByHostId.get(tb.host);
      if (!hostIds) return;
      const key = hostKey(tb.host, tb.paneId);
      if (consumedHostPaneKeys.has(key)) return;
      const live = hostIds.get(tb.paneId);
      if (!live) return;
      if (live.kind !== tb.kind) return;
      if (tb.kind === "claude" && live.session_id) tb.sessionId = live.session_id;
      if ((tb.kind === "shell" || tb.kind === "codex") && live.slot_id)
        tb.slotId = live.slot_id;
      boundTabIds.add(tb.id);
      consumedHostPaneKeys.add(key);
    });
  }

  // --- Pass 2: drop stale. ---
  if (t) {
    const stale: { leafId: string; tabId: string }[] = [];
    forEachTab(t, (leaf, tb) => {
      if (!boundTabIds.has(tb.id)) {
        stale.push({ leafId: leaf.id, tabId: tb.id });
      }
    });
    for (const { leafId, tabId } of stale) {
      t = closeTab(t!, leafId, tabId);
      if (!t) break;
    }
  }

  // --- Title sync. ---
  if (t) {
    forEachTab(t, (_leaf, tb) => {
      const p = paneByHostId.get(tb.host)?.get(tb.paneId);
      if (!p) return;
      const wanted = titleFor(p);
      if (tb.title !== wanted) tb.title = wanted;
    });
  }

  // --- Pass 3: append uncovered live panes, host-tagged. ---
  //
  // Walk each host's pane list in a fixed order (station then local)
  // so a hybrid reconcile is deterministic — same saved state + same
  // inputs always produce the same tree. Only the kind-correct
  // identity is copied onto the fresh tab.
  const coveredByHost = new Map<HostRef, Set<string>>();
  for (const host of allHosts) coveredByHost.set(host, new Set<string>());
  if (t) {
    forEachTab(t, (_leaf, tb) => {
      coveredByHost.get(tb.host)?.add(tb.paneId);
    });
  }
  for (const host of allHosts) {
    const hostPanes = livePanesByHost[host] ?? [];
    const covered = coveredByHost.get(host) ?? new Set<string>();
    for (const p of hostPanes) {
      if (covered.has(p.id)) continue;
      const sessionId = p.kind === "claude" ? p.session_id : undefined;
      const slotId =
        p.kind === "shell" || p.kind === "codex" ? p.slot_id : undefined;
      const newTab = tab(
        p.id,
        p.kind,
        host,
        titleFor(p),
        undefined,
        undefined,
        sessionId,
        slotId,
      );
      if (!t) {
        t = leafWithTab(newTab);
      } else {
        const firstLeaf = allLeaves(t)[0];
        t = addTab(t, firstLeaf.id, newTab);
      }
      covered.add(p.id);
    }
  }

  return t;
}
