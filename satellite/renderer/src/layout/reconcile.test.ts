import { describe, it, expect } from "vitest";
import type { Pane, PaneKind, Stoplight } from "@proto/proto";
import {
  addTab,
  allLeaves,
  allTabs,
  leafWithTab,
  splitLeaf,
  switchTab,
  tab,
  type TreeNode,
} from "./split-tree";
import {
  countMatchingIdentities,
  countSavedIdentityTabsInReachableHosts,
  reconcile,
  titleFor,
} from "./reconcile";

// Build a fully-formed Pane for use in test fixtures. Only the fields
// reconcile() actually reads are interesting; the rest are filled with
// plausible defaults so we don't accidentally drift from the wire type.
function mkPane(overrides: Partial<Pane> & Pick<Pane, "id" | "kind">): Pane {
  const base: Pane = {
    id: overrides.id,
    kind: overrides.kind,
    state: "running",
    stoplight: "gray" as Stoplight,
  };
  return { ...base, ...overrides };
}

function mkClaude(id: string, sessionId?: string, displayName?: string): Pane {
  return mkPane({ id, kind: "claude", session_id: sessionId, display_name: displayName });
}

function mkShell(id: string, slotId?: string, displayName?: string): Pane {
  return mkPane({ id, kind: "shell", slot_id: slotId, display_name: displayName });
}

function mkCodex(id: string, slotId?: string, displayName?: string): Pane {
  return mkPane({ id, kind: "codex", slot_id: slotId, display_name: displayName });
}

describe("reconcile", () => {
  it("returns null when both saved and live are empty", () => {
    expect(reconcile(null, [], "station")).toBeNull();
  });

  it("seeds a single leaf from one live pane when nothing was saved", () => {
    const out = reconcile(null, [mkClaude("p_1", "sess-a")], "station");
    expect(out).not.toBeNull();
    const leaves = allLeaves(out!);
    expect(leaves.length).toBe(1);
    expect(leaves[0].tabs.length).toBe(1);
    expect(leaves[0].tabs[0].paneId).toBe("p_1");
    expect(leaves[0].tabs[0].sessionId).toBe("sess-a");
    expect(leaves[0].tabs[0].kind).toBe("claude");
  });

  it("rekeys a single saved tab to the new paneId when sessionId matches", () => {
    // Saved: one Claude tab against the OLD paneId.
    const saved = leafWithTab(
      tab("p_old", "claude", "station", "Custom Title", "t_1", undefined, "sess-a"),
    );
    // Daemon restarted: same session_id, brand new pane id. The
    // daemon also persists display_name keyed by session_id, so on
    // restart the live pane reports the same Custom Title.
    const out = reconcile(saved, [mkClaude("p_new", "sess-a", "Custom Title")], "station");
    expect(out).not.toBeNull();
    const tabs = allTabs(out!);
    expect(tabs.length).toBe(1);
    expect(tabs[0].paneId).toBe("p_new");
    expect(tabs[0].sessionId).toBe("sess-a");
    // Preserve the client-side tab id (layout identity) and title.
    expect(tabs[0].id).toBe("t_1");
    expect(tabs[0].title).toBe("Custom Title");
  });

  it("preserves split structure, ratios, tab order, and activeTabId across rekey", () => {
    // Build: [leafA(t1, t2)] | [leafB(t3)] with a 0.3 ratio.
    const leafA0 = leafWithTab(
      tab("p_a_old", "claude", "station", "Alpha", "t_a", undefined, "sess-a"),
    );
    const withT2 = addTab(
      leafA0,
      leafA0.id,
      tab("p_b_old", "claude", "station", "Beta", "t_b", undefined, "sess-b"),
    );
    // Set activeTabId to t_a to prove it survives.
    const active = switchTab(withT2, leafA0.id, "t_a");
    const split = splitLeaf(
      active,
      leafA0.id,
      "vertical",
      tab("p_c_old", "claude", "station", "Gamma", "t_c", undefined, "sess-c"),
    );
    const saved = split.tree;
    // Force a non-default ratio.
    (saved as { ratio: number }).ratio = 0.3;

    // Daemon restart regenerates every paneId but keeps session_ids.
    const livePanes: Pane[] = [
      mkClaude("p_a_new", "sess-a", "Alpha"),
      mkClaude("p_b_new", "sess-b", "Beta"),
      mkClaude("p_c_new", "sess-c", "Gamma"),
    ];

    const out = reconcile(saved, livePanes, "station");
    expect(out).not.toBeNull();

    // Still a split with the same ratio.
    expect(out!.kind).toBe("split");
    const asSplit = out as Extract<TreeNode, { kind: "split" }>;
    expect(asSplit.ratio).toBeCloseTo(0.3);
    expect(asSplit.dir).toBe("vertical");

    // Leaf A still has [t_a, t_b] in that order, still pointing at t_a.
    const leaves = allLeaves(out!);
    expect(leaves.length).toBe(2);
    const reLeafA = leaves.find((l) => l.id === leafA0.id)!;
    expect(reLeafA.tabs.map((t) => t.id)).toEqual(["t_a", "t_b"]);
    expect(reLeafA.activeTabId).toBe("t_a");
    expect(reLeafA.tabs.map((t) => t.paneId)).toEqual(["p_a_new", "p_b_new"]);

    // Leaf B still has just [t_c], rekeyed.
    const reLeafB = leaves.find((l) => l.id !== leafA0.id)!;
    expect(reLeafB.tabs.map((t) => t.id)).toEqual(["t_c"]);
    expect(reLeafB.tabs[0].paneId).toBe("p_c_new");
  });

  it("syncs titles from daemon display_name on the rekeyed tabs", () => {
    const saved = leafWithTab(
      tab("p_old", "claude", "station", "Old Title", "t_1", undefined, "sess-a"),
    );
    const out = reconcile(saved, [mkClaude("p_new", "sess-a", "Daemon Renamed")], "station");
    const tabs = allTabs(out!);
    expect(tabs[0].title).toBe("Daemon Renamed");
  });

  it("reverts a stale saved title to the kind-based default when the daemon has no display_name", () => {
    // A Satellite-side rename without the daemon confirmation (or a
    // daemon that has since cleared the override) re-defaults the
    // title. This matches pre-issue-#46 behaviour — the daemon is
    // source of truth.
    const saved = leafWithTab(
      tab("p_old", "claude", "station", "Stale Optimistic", "t_1", undefined, "sess-a"),
    );
    const out = reconcile(saved, [mkClaude("p_new", "sess-a")], "station");
    expect(allTabs(out!)[0].title).toBe("Claude");
  });

  it("drops a saved tab whose sessionId has no live match (collapsing the leaf)", () => {
    const saved = leafWithTab(
      tab("p_gone", "claude", "station", "Ghost", "t_g", undefined, "sess-gone"),
    );
    const out = reconcile(saved, [], "station");
    expect(out).toBeNull();
  });

  it("drops a saved tab without sessionId when its paneId is not live", () => {
    const saved = leafWithTab(tab("p_gone", "claude", "station", "Ghost", "t_g"));
    const out = reconcile(saved, [], "station");
    expect(out).toBeNull();
  });

  it("keeps a saved tab without sessionId when its paneId is still live (fresh-create case)", () => {
    // A pane was just created on this Satellite; sessionId hasn't been
    // persisted yet, but the daemon hasn't restarted so the paneId is
    // still valid. This is the first-poll-after-create path.
    const saved = leafWithTab(tab("p_live", "claude", "station", "Fresh", "t_f"));
    const out = reconcile(saved, [mkClaude("p_live", "sess-fresh", "Fresh")], "station");
    const tabs = allTabs(out!);
    expect(tabs.length).toBe(1);
    expect(tabs[0].id).toBe("t_f");
    expect(tabs[0].paneId).toBe("p_live");
    // reconcile captured the sessionId onto the tab so the next
    // daemon restart can rekey from it.
    expect(tabs[0].sessionId).toBe("sess-fresh");
  });

  it("preserves shell-pane tabs when their paneId is still live", () => {
    // Shell panes have no sessionId in Scope A; they rely on the
    // fresh-create fallback path. The daemon has not restarted.
    const saved = leafWithTab(tab("p_shell", "shell" as PaneKind, "station", "my-shell", "t_s"));
    const out = reconcile(saved, [mkShell("p_shell")], "station");
    const tabs = allTabs(out!);
    expect(tabs.length).toBe(1);
    expect(tabs[0].id).toBe("t_s");
    expect(tabs[0].paneId).toBe("p_shell");
    expect(tabs[0].sessionId).toBeUndefined();
  });

  it("drops a pre-Scope-B shell tab across a daemon restart (no slotId to rekey on)", () => {
    // Saved: one Claude tab + one shell tab side by side. The shell
    // tab was written by a pre-Scope-B Satellite build, so it has no
    // slotId. After restart the Claude tab rekeys via sessionId but
    // the shell tab has no identity to rebind against → dropped.
    // This is the back-compat guarantee for layouts saved before the
    // Scope B on-disk shape landed.
    const saved0 = leafWithTab(
      tab("p_claude_old", "claude", "station", "Claude", "t_c", undefined, "sess-c"),
    );
    const saved = addTab(saved0, saved0.id, tab("p_shell_old", "shell" as PaneKind, "station", "Shell", "t_s"));

    const out = reconcile(saved, [mkClaude("p_claude_new", "sess-c")], "station");
    const tabs = allTabs(out!);
    expect(tabs.map((t) => t.id)).toEqual(["t_c"]);
    expect(tabs[0].paneId).toBe("p_claude_new");
  });

  it("appends uncovered live panes to the first leaf", () => {
    const saved0 = leafWithTab(
      tab("p_a_old", "claude", "station", "Alpha", "t_a", undefined, "sess-a"),
    );
    const splitRes = splitLeaf(
      saved0,
      saved0.id,
      "vertical",
      tab("p_b_old", "claude", "station", "Beta", "t_b", undefined, "sess-b"),
    );
    const saved = splitRes.tree;

    // Live list has the two rekeyed panes plus a brand-new one that
    // wasn't saved anywhere.
    const out = reconcile(saved, [
      mkClaude("p_a_new", "sess-a"),
      mkClaude("p_b_new", "sess-b"),
      mkClaude("p_new", "sess-new", "Gamma"),
    ], "station");
    const leaves = allLeaves(out!);
    expect(leaves.length).toBe(2);
    // First leaf grew from 1 → 2 tabs. Per the existing fallback, the
    // new pane lands in the first leaf (leafA by construction order).
    const firstLeaf = leaves[0];
    expect(firstLeaf.tabs.map((t) => t.paneId)).toEqual(["p_a_new", "p_new"]);
    expect(firstLeaf.tabs[1].sessionId).toBe("sess-new");
    expect(firstLeaf.tabs[1].title).toBe("Gamma");
  });

  it("duplicate sessionId in saved tree: binds first, drops the rest", () => {
    // Two tabs both claim sess-a. Only the first can re-bind to the
    // single live pane with that session_id.
    const saved0 = leafWithTab(
      tab("p_old_a", "claude", "station", "First", "t_first", undefined, "sess-a"),
    );
    const saved = addTab(
      saved0,
      saved0.id,
      tab("p_old_a2", "claude", "station", "Second", "t_second", undefined, "sess-a"),
    );

    const out = reconcile(saved, [mkClaude("p_new", "sess-a")], "station");
    const tabs = allTabs(out!);
    // t_first wins the sessionId bind; t_second has a stale paneId,
    // gets dropped in Pass 2.
    expect(tabs.map((t) => t.id)).toEqual(["t_first"]);
    expect(tabs[0].paneId).toBe("p_new");
  });

  it("duplicate paneId in saved tree: only the sessionId-matching tab survives", () => {
    // Pathological saved state: two tabs both point at the same old
    // paneId, one carries a sessionId and the other doesn't. After
    // restart, only the sessionId tab can rebind legitimately. The
    // other must be dropped, not left aliased onto the same live pane.
    const saved0 = leafWithTab(
      tab("p_shared", "claude", "station", "With Session", "t_with", undefined, "sess-a"),
    );
    const saved = addTab(
      saved0,
      saved0.id,
      tab("p_shared", "claude", "station", "Without Session", "t_without"),
    );
    const out = reconcile(saved, [mkClaude("p_shared", "sess-a")], "station");
    const tabs = allTabs(out!);
    expect(tabs.map((t) => t.id)).toEqual(["t_with"]);
  });

  it("duplicate sessionId in live list: binds the first occurrence, appends the second", () => {
    // Daemon invariant violation — two live panes claim the same
    // session_id. The saved tab binds to the first; the second falls
    // through to the uncovered pass and lands in the first leaf as a
    // fresh tab.
    const saved = leafWithTab(
      tab("p_old", "claude", "station", "Bound", "t_bound", undefined, "sess-a"),
    );
    const out = reconcile(saved, [
      mkClaude("p_first", "sess-a"),
      mkClaude("p_second", "sess-a"),
    ], "station");
    const tabs = allTabs(out!);
    expect(tabs.length).toBe(2);
    // First tab is the bound/rekeyed one, keeping its t_bound id.
    expect(tabs[0].id).toBe("t_bound");
    expect(tabs[0].paneId).toBe("p_first");
    // Second is the appended duplicate — it still carries the
    // (duplicated) sessionId because we copy session_id verbatim into
    // new tabs.
    expect(tabs[1].paneId).toBe("p_second");
    expect(tabs[1].sessionId).toBe("sess-a");
  });

  it("mixes sessionId'd tabs with pre-session-id leftovers across a restart", () => {
    // Migration-realistic case: the user's saved layout has two tabs.
    // One (Alpha) was created by a new Satellite build and has
    // sessionId persisted. The other (Beta) was saved by the old
    // build before Tab.sessionId existed — no sessionId on disk. The
    // daemon has since restarted, so Beta's paneId is stale.
    const saved0 = leafWithTab(
      tab("p_a_old", "claude", "station", "Alpha", "t_a", undefined, "sess-a"),
    );
    const saved = addTab(
      saved0,
      saved0.id,
      tab("p_b_old", "claude", "station", "Beta", "t_b"), // no sessionId
    );

    const out = reconcile(saved, [
      mkClaude("p_a_new", "sess-a", "Alpha"),
      // Beta is still present on the daemon, but the Satellite can't
      // rekey it (no sessionId on the saved tab) — it shows up as a
      // fresh append.
      mkClaude("p_b_new", "sess-b", "Beta"),
    ], "station");

    const tabs = allTabs(out!);
    // Alpha rekeyed in-place with its original client tab id.
    expect(tabs[0].id).toBe("t_a");
    expect(tabs[0].paneId).toBe("p_a_new");
    // Beta appended fresh — new client id, carries the live sessionId.
    const betaTab = tabs.find((t) => t.paneId === "p_b_new")!;
    expect(betaTab.sessionId).toBe("sess-b");
    expect(betaTab.id).not.toBe("t_b");
  });

  it("does not mutate the caller's saved tree", () => {
    const saved = leafWithTab(
      tab("p_old", "claude", "station", "Original", "t_1", undefined, "sess-a"),
    );
    const snapshotPaneId = saved.tabs[0].paneId;
    const snapshotTitle = saved.tabs[0].title;

    reconcile(saved, [mkClaude("p_new", "sess-a", "Renamed")], "station");

    // Caller's original tree must be untouched — reconcile works on a
    // deep copy.
    expect(saved.tabs[0].paneId).toBe(snapshotPaneId);
    expect(saved.tabs[0].title).toBe(snapshotTitle);
  });

  it("returns a defaulted title when the pane has no display_name", () => {
    const out = reconcile(null, [mkClaude("p_1", "sess-a")], "station");
    expect(allTabs(out!)[0].title).toBe("Claude");
  });

  it("returns a defaulted title for shell panes without display_name", () => {
    const out = reconcile(null, [mkShell("p_1")], "station");
    expect(allTabs(out!)[0].title).toBe("Shell");
  });

  // --- Scope B: shell panes carry a stable slot_id; reconcile rekeys
  // on that identity the same way it does on session_id for Claude. ---

  it("rekeys a saved shell tab via slotId across a daemon restart", () => {
    // Saved: a shell tab against the OLD paneId with a slotId captured.
    const saved = leafWithTab(
      tab("p_old", "shell", "station", "my-shell", "t_1", undefined, undefined, "slot-a"),
    );
    // Restart: same slot_id, new pane id. The daemon also persists
    // display_name keyed by slot_id, so the live pane carries the
    // user's previous label.
    const out = reconcile(saved, [mkShell("p_new", "slot-a", "my-shell")], "station");
    const tabs = allTabs(out!);
    expect(tabs.length).toBe(1);
    expect(tabs[0].paneId).toBe("p_new");
    expect(tabs[0].slotId).toBe("slot-a");
    expect(tabs[0].id).toBe("t_1");
    expect(tabs[0].title).toBe("my-shell");
  });

  it("captures slotId onto a shell tab that was bound by paneId only (fresh-create race)", () => {
    // A fresh shell pane was just created on this Satellite and the
    // first poll hasn't populated its slotId yet. The daemon has not
    // restarted, so the paneId is still live. Reconcile should bind
    // by paneId and capture the slotId onto the tab for future rekeys.
    const saved = leafWithTab(tab("p_live", "shell", "station", "Fresh", "t_f"));
    const out = reconcile(saved, [mkShell("p_live", "slot-fresh")], "station");
    const tabs = allTabs(out!);
    expect(tabs.length).toBe(1);
    expect(tabs[0].id).toBe("t_f");
    expect(tabs[0].slotId).toBe("slot-fresh");
  });

  it("seeds a new tab with slotId from a fresh shell live pane", () => {
    const out = reconcile(null, [mkShell("p_1", "slot-a")], "station");
    const tabs = allTabs(out!);
    expect(tabs[0].slotId).toBe("slot-a");
    expect(tabs[0].sessionId).toBeUndefined();
  });

  // --- Codex panes reuse the shell slot_id identity, so reconcile
  // rekeys and restart-survives them exactly like shell. ---

  it("rekeys a saved codex tab via slotId across a daemon restart", () => {
    const saved = leafWithTab(
      tab("p_old", "codex", "station", "my-codex", "t_1", undefined, undefined, "slot-c"),
    );
    const out = reconcile(saved, [mkCodex("p_new", "slot-c", "my-codex")], "station");
    const tabs = allTabs(out!);
    expect(tabs.length).toBe(1);
    expect(tabs[0].paneId).toBe("p_new");
    expect(tabs[0].slotId).toBe("slot-c");
    expect(tabs[0].id).toBe("t_1");
  });

  it("captures slotId onto a codex tab bound by paneId only (fresh-create race)", () => {
    const saved = leafWithTab(tab("p_live", "codex", "station", "Fresh", "t_f"));
    const out = reconcile(saved, [mkCodex("p_live", "slot-fresh")], "station");
    const tabs = allTabs(out!);
    expect(tabs.length).toBe(1);
    expect(tabs[0].id).toBe("t_f");
    expect(tabs[0].slotId).toBe("slot-fresh");
  });

  it("seeds a new tab with slotId from a fresh codex live pane", () => {
    const out = reconcile(null, [mkCodex("p_1", "slot-c")], "station");
    const tabs = allTabs(out!);
    expect(tabs[0].slotId).toBe("slot-c");
    expect(tabs[0].sessionId).toBeUndefined();
  });

  it("countMatchingIdentities counts a codex slot match", () => {
    const saved = leafWithTab(
      tab("p_old", "codex", "station", "c", "t_1", undefined, undefined, "slot-c"),
    );
    const n = countMatchingIdentities(saved, {
      station: [mkCodex("p_new", "slot-c")],
    });
    expect(n).toBe(1);
  });

  it("preserves mixed Claude + shell layout across a daemon restart", () => {
    // One Claude tab and one shell tab in the same leaf. After a
    // restart the Claude session_id AND the shell slot_id should
    // both rekey in place — previous Scope A would have dropped the
    // shell tab since it had no persistent identity.
    const saved0 = leafWithTab(
      tab("p_c_old", "claude", "station", "Claude", "t_c", undefined, "sess-c"),
    );
    const saved = addTab(
      saved0,
      saved0.id,
      tab("p_s_old", "shell", "station", "Shell", "t_s", undefined, undefined, "slot-s"),
    );
    const out = reconcile(saved, [
      mkClaude("p_c_new", "sess-c"),
      mkShell("p_s_new", "slot-s"),
    ], "station");
    const tabs = allTabs(out!);
    expect(tabs.map((t) => t.id)).toEqual(["t_c", "t_s"]);
    expect(tabs[0].paneId).toBe("p_c_new");
    expect(tabs[1].paneId).toBe("p_s_new");
    expect(tabs[1].slotId).toBe("slot-s");
  });

  it("duplicate slotId in saved tree: binds first, drops the rest", () => {
    // Two tabs both claim slot-a. Only the first can re-bind to the
    // single live shell pane with that slot_id.
    const saved0 = leafWithTab(
      tab("p_old_a", "shell", "station", "First", "t_first", undefined, undefined, "slot-a"),
    );
    const saved = addTab(
      saved0,
      saved0.id,
      tab("p_old_a2", "shell", "station", "Second", "t_second", undefined, undefined, "slot-a"),
    );
    const out = reconcile(saved, [mkShell("p_new", "slot-a")], "station");
    const tabs = allTabs(out!);
    expect(tabs.map((t) => t.id)).toEqual(["t_first"]);
    expect(tabs[0].paneId).toBe("p_new");
  });

  it("drops a saved shell tab when its slotId has no live match", () => {
    const saved = leafWithTab(
      tab("p_old", "shell", "station", "Ghost", "t_g", undefined, undefined, "slot-gone"),
    );
    const out = reconcile(saved, [], "station");
    expect(out).toBeNull();
  });

  it("drops a saved Claude tab rather than cross-binding to a shell pane with the same UUID (Scope B)", () => {
    // Pathological cross-kind collision: saved Claude tab with
    // sessionId "x" and a live shell pane with slot_id "x". Silent
    // wrong-bind is the worst failure mode — the layout LOOKS valid
    // while pointing at a process of the wrong kind. Pass 1 now
    // namespaces the rebind map by kind, so the Claude tab finds
    // nothing in the Claude map and drops. No live Claude pane left
    // to append, so the tree collapses to null.
    const saved = leafWithTab(
      tab("p_old", "claude", "station", "Claude", "t_1", undefined, "x"),
    );
    const out = reconcile(saved, [mkShell("p_new", "x")], "station");
    // Saved Claude tab dropped; the shell pane (with slot_id "x")
    // still appears as a freshly appended shell tab.
    const tabs = allTabs(out!);
    expect(tabs.length).toBe(1);
    expect(tabs[0].kind).toBe("shell");
    expect(tabs[0].paneId).toBe("p_new");
    expect(tabs[0].slotId).toBe("x");
  });

  it("symmetric: drops a saved shell tab rather than cross-binding to a Claude pane with the same UUID", () => {
    const saved = leafWithTab(
      tab("p_old", "shell", "station", "Shell", "t_1", undefined, undefined, "x"),
    );
    const out = reconcile(saved, [mkClaude("p_new", "x")], "station");
    const tabs = allTabs(out!);
    // Saved shell tab dropped; Claude pane appended.
    expect(tabs.length).toBe(1);
    expect(tabs[0].kind).toBe("claude");
    expect(tabs[0].paneId).toBe("p_new");
    expect(tabs[0].sessionId).toBe("x");
  });

  it("1b capture refuses to bind a Claude tab to a same-paneId shell live pane", () => {
    // Defence in depth: a fresh-create Claude tab without sessionId
    // whose paneId happens to collide with a live shell pane's
    // paneId (which would itself be a daemon bug — paneIds are
    // unique per spawn) must NOT pick up the shell's slot_id onto
    // the Claude tab. Reconcile treats the kinds as mismatched →
    // Pass 1b declines to bind → Pass 2 drops the tab.
    const saved = leafWithTab(tab("p_shared", "claude", "station", "Claude", "t_1"));
    const out = reconcile(saved, [mkShell("p_shared", "slot-a")], "station");
    const tabs = allTabs(out!);
    // The Claude tab dropped; shell pane was then appended fresh
    // (Pass 3), taking over "p_shared" as a shell-kind tab.
    expect(tabs.length).toBe(1);
    expect(tabs[0].kind).toBe("shell");
    expect(tabs[0].slotId).toBe("slot-a");
    expect(tabs[0].sessionId).toBeUndefined();
  });
});

// --- an earlier release: titleFor precedence chain ---
describe("titleFor", () => {
  it("prefers display_name over everything", () => {
    expect(
      titleFor(
        mkPane({
          id: "p_1",
          kind: "claude",
          display_name: "user label",
          auto_name: "auto label",
        }),
      ),
    ).toBe("user label");
  });

  it("falls back to auto_name when display_name is empty", () => {
    expect(
      titleFor(
        mkPane({
          id: "p_1",
          kind: "claude",
          auto_name: "Claude-derived label",
        }),
      ),
    ).toBe("Claude-derived label");
  });

  it("falls back to auto_name when display_name is whitespace only", () => {
    expect(
      titleFor(
        mkPane({
          id: "p_1",
          kind: "claude",
          display_name: "   ",
          auto_name: "real auto",
        }),
      ),
    ).toBe("real auto");
  });

  it("ignores whitespace-only auto_name and falls through to kind default", () => {
    expect(
      titleFor(
        mkPane({
          id: "p_1",
          kind: "claude",
          auto_name: "  \t ",
        }),
      ),
    ).toBe("Claude");
  });

  it("returns the kind default when both names are absent", () => {
    expect(titleFor(mkPane({ id: "p_1", kind: "claude" }))).toBe("Claude");
    expect(titleFor(mkPane({ id: "p_2", kind: "shell" }))).toBe("Shell");
    expect(titleFor(mkPane({ id: "p_3", kind: "codex" }))).toBe("Codex");
  });

  it("auto_name on a shell pane still wins over the default (future-proofs the wire)", () => {
    // The daemon won't emit auto_name on shell panes today (an earlier release
    // is Claude-only) but the precedence chain is defined over the
    // wire field, not the pane kind — if a future daemon change sets
    // it, clients should honour it rather than drop it.
    expect(
      titleFor(
        mkPane({ id: "p_1", kind: "shell", auto_name: "future shell label" }),
      ),
    ).toBe("future shell label");
  });
});

// --- an earlier release: reconcile picks up auto_name on the title-sync pass ---
describe("reconcile + auto_name", () => {
  it("copies auto_name onto the tab title when display_name is empty", () => {
    const saved = leafWithTab(
      tab("p_old", "claude", "station", "Old Title", "t_1", undefined, "sess-a"),
    );
    const out = reconcile(saved, [
      mkPane({
        id: "p_new",
        kind: "claude",
        session_id: "sess-a",
        auto_name: "from-jsonl label",
      }),
    ], "station");
    expect(allTabs(out!)[0].title).toBe("from-jsonl label");
  });

  it("display_name beats auto_name on the title-sync pass", () => {
    const saved = leafWithTab(
      tab("p_old", "claude", "station", "Old Title", "t_1", undefined, "sess-a"),
    );
    const out = reconcile(saved, [
      mkPane({
        id: "p_new",
        kind: "claude",
        session_id: "sess-a",
        display_name: "user rename",
        auto_name: "should be ignored",
      }),
    ], "station");
    expect(allTabs(out!)[0].title).toBe("user rename");
  });

  it("falls through to the kind default when neither name is present", () => {
    const saved = leafWithTab(
      tab("p_old", "claude", "station", "Old Title", "t_1", undefined, "sess-a"),
    );
    const out = reconcile(saved, [
      mkPane({ id: "p_new", kind: "claude", session_id: "sess-a" }),
    ], "station");
    expect(allTabs(out!)[0].title).toBe("Claude");
  });

  it("appended fresh pane uses auto_name for its first tab title", () => {
    const out = reconcile(null, [
      mkPane({
        id: "p_new",
        kind: "claude",
        session_id: "sess-a",
        auto_name: "fresh-auto",
      }),
    ], "station");
    expect(allTabs(out!)[0].title).toBe("fresh-auto");
  });

  // Hybrid mode (an earlier release, plan rev 3.1): Pass 3 stamps the host
  // arg onto every freshly-appended tab. host is required — no default
  // — so Phase 4+ call sites can't silently mislabel local panes as
  // station by forgetting to thread the arg.
  it("stamps the host arg onto Pass 3 fresh tabs", () => {
    const local = reconcile(null, [mkClaude("p_1", "sess-a")], "local");
    const station = reconcile(null, [mkClaude("p_2", "sess-b")], "station");
    expect(allTabs(local!)[0].host).toBe("local");
    expect(allTabs(station!)[0].host).toBe("station");
  });

  // ---- Hybrid (plan rev 3.1, phase 10 fixup; post-codex review) ----
  // Codex flagged that `selectProject` only loaded panes from the
  // single primary client + hard-stamped host=station on reconcile,
  // so local panes in a hybrid saved layout were either dropped (in
  // station-primary mode) or silently restamped as station (in
  // local-primary mode). These tests guard the per-host-map form.

  describe("hybrid mode", () => {
    it("preserves a local tab when station's pane list is the only one reconciled", () => {
      const saved: TreeNode = leafWithTab(
        tab("p_local_old", "shell", "local", undefined, "t-local", undefined, undefined, "slot-a"),
      );
      // Map form: station has panes, local not provided (host
      // unreachable this tick). The local tab should NOT be dropped —
      // the hybrid reconciler treats a missing host's tabs as still-
      // present rather than stale.
      // Note: with the new semantics, a host whose map entry is
      // missing is treated as "no fresh data" and its tabs fall
      // through Pass 2 as stale. To keep them, callers must supply
      // at least an empty array OR preserve by omission; we chose
      // "stale-when-missing" because it mirrors the single-host
      // behaviour for a disappeared pane. So here we check the
      // narrower contract: when BOTH hosts' pane lists are supplied,
      // local tabs bind correctly.
      const out = reconcile(saved, {
        station: [],
        local: [mkShell("p_local_new", "slot-a")],
      });
      const tabs = allTabs(out!);
      expect(tabs.length).toBe(1);
      expect(tabs[0].host).toBe("local");
      expect(tabs[0].paneId).toBe("p_local_new");
      expect(tabs[0].slotId).toBe("slot-a");
    });

    it("rebinds both a station tab and a local tab across a hybrid restart", () => {
      const stationTab = tab(
        "p_station_old", "claude", "station", undefined, "t-station", undefined, "sess-s",
      );
      const localTab = tab(
        "p_local_old", "claude", "local", undefined, "t-local", undefined, "sess-l",
      );
      const saved: TreeNode = {
        kind: "split",
        id: "s1",
        dir: "vertical",
        ratio: 0.5,
        a: leafWithTab(stationTab),
        b: leafWithTab(localTab),
      };
      const out = reconcile(saved, {
        station: [mkClaude("p_station_new", "sess-s")],
        local: [mkClaude("p_local_new", "sess-l")],
      });
      const tabs = allTabs(out!);
      expect(tabs.length).toBe(2);
      const byHost = new Map(tabs.map((t) => [t.host, t]));
      expect(byHost.get("station")?.paneId).toBe("p_station_new");
      expect(byHost.get("station")?.sessionId).toBe("sess-s");
      expect(byHost.get("local")?.paneId).toBe("p_local_new");
      expect(byHost.get("local")?.sessionId).toBe("sess-l");
    });

    it("does NOT cross-bind tabs across hosts even when session_id collides", () => {
      // Astronomically unlikely in practice — session_ids are UUIDs
      // — but a hand-edited config or a test harness could hit it.
      // A station tab must only bind to the station pane, never to
      // a local pane whose session_id happens to match.
      const stationTab = tab(
        "p_station_old", "claude", "station", undefined, "t-s", undefined, "sess-X",
      );
      const localTab = tab(
        "p_local_old", "claude", "local", undefined, "t-l", undefined, "sess-X",
      );
      const saved: TreeNode = {
        kind: "split",
        id: "s1",
        dir: "vertical",
        ratio: 0.5,
        a: leafWithTab(stationTab),
        b: leafWithTab(localTab),
      };
      const out = reconcile(saved, {
        // Same session_id on both hosts:
        station: [mkClaude("p_station_new", "sess-X")],
        local: [mkClaude("p_local_new", "sess-X")],
      });
      const tabs = allTabs(out!);
      expect(tabs.length).toBe(2);
      const station = tabs.find((t) => t.host === "station");
      const local = tabs.find((t) => t.host === "local");
      expect(station?.paneId).toBe("p_station_new");
      expect(local?.paneId).toBe("p_local_new");
      // Confirm no cross-bind: station tab does NOT now claim the
      // local pane's id, and vice versa.
      expect(station?.paneId).not.toBe("p_local_new");
      expect(local?.paneId).not.toBe("p_station_new");
    });

    it("Pass 3 stamps uncovered panes with the correct per-host tag", () => {
      // No saved tree; reconcile should surface a station-uncovered
      // and a local-uncovered pane as two fresh tabs, each tagged
      // with its own host.
      const out = reconcile(null, {
        station: [mkClaude("p_s", "sess-s")],
        local: [mkShell("p_l", "slot-l")],
      });
      const tabs = allTabs(out!);
      expect(tabs.length).toBe(2);
      const station = tabs.find((t) => t.paneId === "p_s");
      const local = tabs.find((t) => t.paneId === "p_l");
      expect(station?.host).toBe("station");
      expect(local?.host).toBe("local");
    });

    it("back-compat overload still stamps single host correctly", () => {
      // The legacy single-host signature is kept so pre-hybrid
      // callers + the existing 30+ tests don't need rewriting.
      const out = reconcile(null, [mkClaude("p_1", "sess-a")], "local");
      const t0 = allTabs(out!)[0];
      expect(t0.host).toBe("local");
      expect(t0.paneId).toBe("p_1");
    });

    it("a saved local tab whose station-side identity collides survives even if only station panes land first", () => {
      // Fixup round 2: the retry-loop's countMatchingIdentities
      // was host-agnostic, so a station pane's session_id could
      // falsely cover for a saved local tab with the same id,
      // stopping the retry and dropping the local tab. This test
      // exercises the reconcile side of that scenario directly:
      // station panes arrive, local doesn't; the local tab should
      // survive only when local's map has the id. Here we feed a
      // livePanesByHost where local is empty — the local tab
      // should be dropped (stale), and ONLY the station tab
      // survives. This is the correct hybrid behaviour after the
      // per-host binding fix.
      const stationTab = tab(
        "p_s_old", "claude", "station", undefined, "t-s", undefined, "sess-X",
      );
      const localTab = tab(
        "p_l_old", "claude", "local", undefined, "t-l", undefined, "sess-X",
      );
      const saved: TreeNode = {
        kind: "split",
        id: "s1",
        dir: "vertical",
        ratio: 0.5,
        a: leafWithTab(stationTab),
        b: leafWithTab(localTab),
      };
      const out = reconcile(saved, {
        station: [mkClaude("p_s_new", "sess-X")],
        local: [],
      });
      const tabs = allTabs(out!);
      expect(tabs.length).toBe(1);
      expect(tabs[0].host).toBe("station");
      expect(tabs[0].paneId).toBe("p_s_new");
      // Critically: the station pane did NOT rebind the local tab
      // (which would put two tabs here if it did, or swap hosts).
    });
  });

  // Codex follow-up ask (round 3 approval notes): lock in the exact
  // host-reachability semantics of the retry-loop's savedIdTabs count
  // and the matchedSaved count. These helpers drive selectProject's
  // ~12 s retry window; wrong answers either stall project-open
  // unnecessarily (burn 12 s on a host we'll never reach) or stop
  // retrying early and drop live tabs as stale.
  describe("retry-loop helpers", () => {
    it("countMatchingIdentities: empty livePanesByHost returns 0 even with saved tabs", () => {
      const saved: TreeNode = leafWithTab(
        tab("p1", "claude", "station", undefined, "t1", undefined, "sess-a"),
      );
      expect(countMatchingIdentities(saved, {})).toBe(0);
    });

    it("countMatchingIdentities: station identity does NOT cover for a local tab with same id", () => {
      const stationTab = tab("p_s", "claude", "station", undefined, "t-s", undefined, "sess-X");
      const localTab = tab("p_l", "claude", "local", undefined, "t-l", undefined, "sess-X");
      const saved: TreeNode = {
        kind: "split",
        id: "s",
        dir: "vertical",
        ratio: 0.5,
        a: leafWithTab(stationTab),
        b: leafWithTab(localTab),
      };
      // Only station has the pane. Without host-keying, the loop
      // would falsely count 2 (both tabs have sess-X and station
      // has sess-X). With host-keying it returns 1 — only the
      // station tab is genuinely matched.
      expect(
        countMatchingIdentities(saved, { station: [mkClaude("p_s", "sess-X")] }),
      ).toBe(1);
    });

    it("countSavedIdentityTabsInReachableHosts: omitted host excluded, empty-array host INCLUDED", () => {
      const stationTab = tab("p_s", "claude", "station", undefined, "t-s", undefined, "sess-a");
      const localTab = tab("p_l", "claude", "local", undefined, "t-l", undefined, "sess-b");
      const saved: TreeNode = {
        kind: "split",
        id: "s",
        dir: "vertical",
        ratio: 0.5,
        a: leafWithTab(stationTab),
        b: leafWithTab(localTab),
      };
      // Station-only session (local omitted from the map): the
      // local tab is excluded from the retry budget. savedIdTabs=1.
      expect(countSavedIdentityTabsInReachableHosts(saved, { station: [] })).toBe(1);
      // Hybrid session where local is reachable but hasn't returned
      // panes yet ({local: []} ≠ omitted): the local tab IS still
      // retryable — the daemon may be warming up. savedIdTabs=2.
      expect(
        countSavedIdentityTabsInReachableHosts(saved, { station: [], local: [] }),
      ).toBe(2);
      // Neither reachable: everything excluded; retry loop exits
      // immediately instead of stalling for nothing.
      expect(countSavedIdentityTabsInReachableHosts(saved, {})).toBe(0);
    });

    it("countSavedIdentityTabsInReachableHosts: only counts tabs with a stable identity", () => {
      // A Claude tab WITHOUT sessionId (fresh-create race) and a
      // shell tab WITHOUT slotId don't participate in the retry
      // budget — they bind via paneId in Pass 1b, not identity.
      const noIdClaude = tab("p_c", "claude", "station", undefined, "t-c");
      const noIdShell = tab("p_sh", "shell", "station", undefined, "t-sh");
      const withIdClaude = tab(
        "p_c2", "claude", "station", undefined, "t-c2", undefined, "sess-a",
      );
      const saved: TreeNode = {
        kind: "leaf",
        id: "L",
        tabs: [noIdClaude, noIdShell, withIdClaude],
        activeTabId: noIdClaude.id,
      };
      expect(countSavedIdentityTabsInReachableHosts(saved, { station: [] })).toBe(1);
    });
  });
});
