import { describe, it, expect } from "vitest";
import {
  leafWithTab,
  tab,
  splitLeaf,
  addTab,
  switchTab,
  closeTab,
  closeLeaf,
  findLeaf,
  findLeafByPaneId,
  findTab,
  allLeaves,
  allTabs,
  allPaneIds,
  setRatio,
  focusNav,
  reorderTab,
  moveTab,
  isValidTreeNode,
} from "./split-tree";

function leaf1(paneId: string) {
  return leafWithTab(tab(paneId, "claude", "station"));
}

describe("split-tree", () => {
  it("starts as a single leaf with one tab", () => {
    const t = leaf1("p_1");
    expect(allLeaves(t).length).toBe(1);
    expect(allTabs(t).length).toBe(1);
    expect(findLeaf(t, t.id)?.tabs[0].paneId).toBe("p_1");
  });

  // Hybrid mode (an earlier release, plan rev 3.1): tab() now carries a HostRef.
  it("stamps host on tabs created via tab()", () => {
    const t1 = tab("p_1", "claude", "station");
    const t2 = tab("p_2", "shell", "local");
    expect(t1.host).toBe("station");
    expect(t2.host).toBe("local");
  });

  it("splits a leaf vertically", () => {
    const t = leaf1("p_1");
    const r = splitLeaf(t, t.id, "vertical", tab("p_2", "claude", "station"));
    expect(allLeaves(r.tree).length).toBe(2);
    expect(allPaneIds(r.tree).sort()).toEqual(["p_1", "p_2"]);
  });

  it("supports nested splits", () => {
    const t = leaf1("p_1");
    const r1 = splitLeaf(t, t.id, "vertical", tab("p_2", "claude", "station"));
    const leaves = allLeaves(r1.tree);
    const r2 = splitLeaf(r1.tree, leaves[1].id, "horizontal", tab("p_3", "claude", "station"));
    expect(allLeaves(r2.tree).length).toBe(3);
  });

  it("adds a tab to a leaf and makes it active", () => {
    const t = leaf1("p_1");
    const t2 = tab("p_2", "shell", "station");
    const after = addTab(t, t.id, t2);
    const l = findLeaf(after, t.id)!;
    expect(l.tabs.map((x) => x.paneId)).toEqual(["p_1", "p_2"]);
    expect(l.activeTabId).toBe(t2.id);
  });

  it("switches active tab", () => {
    const t = leaf1("p_1");
    const t2 = tab("p_2", "shell", "station");
    const a1 = addTab(t, t.id, t2);
    const a2 = switchTab(a1, t.id, t.tabs[0].id);
    expect(findLeaf(a2, t.id)!.activeTabId).toBe(t.tabs[0].id);
  });

  it("closes a tab inside a leaf, keeping the leaf", () => {
    const t = leaf1("p_1");
    const t2 = tab("p_2", "shell", "station");
    const a1 = addTab(t, t.id, t2);
    const after = closeTab(a1, t.id, t2.id);
    expect(after).not.toBeNull();
    const l = findLeaf(after!, t.id)!;
    expect(l.tabs.length).toBe(1);
    expect(l.tabs[0].paneId).toBe("p_1");
  });

  it("closes the last tab in a leaf, collapsing the leaf", () => {
    const t = leaf1("p_1");
    const r = splitLeaf(t, t.id, "vertical", tab("p_2", "claude", "station"));
    const leftLeaf = allLeaves(r.tree).find((l) => l.tabs[0].paneId === "p_1")!;
    const tabId = leftLeaf.tabs[0].id;
    const after = closeTab(r.tree, leftLeaf.id, tabId);
    expect(after).not.toBeNull();
    expect(allLeaves(after!).length).toBe(1);
    expect(allPaneIds(after!)).toEqual(["p_2"]);
  });

  it("closes the only leaf's only tab → null", () => {
    const t = leaf1("p_1");
    expect(closeTab(t, t.id, t.tabs[0].id)).toBeNull();
  });

  it("closeLeaf removes a whole leaf and collapses the split", () => {
    const t = leaf1("p_1");
    const r = splitLeaf(t, t.id, "vertical", tab("p_2", "claude", "station"));
    const after = closeLeaf(r.tree, r.newLeafId);
    expect(after).not.toBeNull();
    expect(allLeaves(after!).length).toBe(1);
    expect(allPaneIds(after!)).toEqual(["p_1"]);
  });

  it("findLeafByPaneId searches across tabs", () => {
    const t = leaf1("p_1");
    const after = addTab(t, t.id, tab("p_9", "shell", "station"));
    const l = findLeafByPaneId(after, "p_9");
    expect(l?.id).toBe(t.id);
  });

  it("findTab locates a tab", () => {
    const t = leaf1("p_1");
    const t2 = tab("p_2", "shell", "station");
    const after = addTab(t, t.id, t2);
    const f = findTab(after, t2.id);
    expect(f?.tab.paneId).toBe("p_2");
    expect(f?.leaf.id).toBe(t.id);
  });

  it("setRatio clamps between 0.1 and 0.9", () => {
    const t = leaf1("p_1");
    const r = splitLeaf(t, t.id, "vertical", tab("p_2", "claude", "station"));
    const split = r.tree as Extract<typeof r.tree, { kind: "split" }>;
    const after = setRatio(r.tree, split.id, 0.99);
    expect((after as { ratio: number }).ratio).toBeCloseTo(0.9);
    const after2 = setRatio(r.tree, split.id, 0.01);
    expect((after2 as { ratio: number }).ratio).toBeCloseTo(0.1);
  });

  it("focus nav cycles in-order across leaves", () => {
    const t = leaf1("p_1");
    const r1 = splitLeaf(t, t.id, "vertical", tab("p_2", "claude", "station"));
    const leaves = allLeaves(r1.tree);
    const r2 = splitLeaf(r1.tree, leaves[1].id, "horizontal", tab("p_3", "claude", "station"));
    const allIds = allLeaves(r2.tree).map((l) => l.id);
    expect(focusNav(r2.tree, allIds[0], "next")).toBe(allIds[1]);
    expect(focusNav(r2.tree, allIds[0], "prev")).toBe(allIds[allIds.length - 1]);
  });

  it("reorders a tab to a new index within its leaf", () => {
    const t = leaf1("p_1");
    const t2 = tab("p_2", "shell", "station");
    const t3 = tab("p_3", "claude", "station");
    const a1 = addTab(t, t.id, t2);
    const a2 = addTab(a1, t.id, t3);
    // tabs start as [p_1, p_2, p_3]
    const after = reorderTab(a2, t.id, t2.id, 0);
    expect(findLeaf(after, t.id)!.tabs.map((x) => x.paneId)).toEqual(["p_2", "p_1", "p_3"]);
  });

  it("clamps newIndex above tabs.length - 1", () => {
    const t = leaf1("p_1");
    const t2 = tab("p_2", "shell", "station");
    const a1 = addTab(t, t.id, t2);
    const after = reorderTab(a1, t.id, t.tabs[0].id, 99);
    expect(findLeaf(after, t.id)!.tabs.map((x) => x.paneId)).toEqual(["p_2", "p_1"]);
  });

  it("clamps newIndex below 0", () => {
    const t = leaf1("p_1");
    const t2 = tab("p_2", "shell", "station");
    const a1 = addTab(t, t.id, t2);
    const after = reorderTab(a1, t.id, t2.id, -5);
    expect(findLeaf(after, t.id)!.tabs.map((x) => x.paneId)).toEqual(["p_2", "p_1"]);
  });

  it("is a no-op when tabId is unknown", () => {
    const t = leaf1("p_1");
    const t2 = tab("p_2", "shell", "station");
    const a1 = addTab(t, t.id, t2);
    const after = reorderTab(a1, t.id, "t_nonexistent", 0);
    expect(findLeaf(after, t.id)!.tabs.map((x) => x.paneId)).toEqual(["p_1", "p_2"]);
  });

  it("is a no-op when leafId is unknown", () => {
    const t = leaf1("p_1");
    const t2 = tab("p_2", "shell", "station");
    const a1 = addTab(t, t.id, t2);
    const after = reorderTab(a1, "l_nonexistent", t2.id, 0);
    expect(findLeaf(after, t.id)!.tabs.map((x) => x.paneId)).toEqual(["p_1", "p_2"]);
  });

  describe("moveTab", () => {
    it("moves a tab to a different leaf at the requested index", () => {
      // Left leaf has [p_1, p_2]; right leaf has [p_3]. Move p_2 into right
      // leaf at index 0 → right becomes [p_2, p_3].
      const base = leaf1("p_1");
      const t2 = tab("p_2", "shell", "station");
      const withTwo = addTab(base, base.id, t2);
      const split = splitLeaf(withTwo, base.id, "vertical", tab("p_3", "claude", "station"));
      const leftLeafId = base.id;
      const rightLeafId = split.newLeafId;

      const after = moveTab(split.tree, t2.id, rightLeafId, 0)!;
      expect(after).not.toBeNull();

      const leftLeaf = findLeaf(after, leftLeafId)!;
      const rightLeaf = findLeaf(after, rightLeafId)!;
      expect(leftLeaf.tabs.map((x) => x.paneId)).toEqual(["p_1"]);
      expect(rightLeaf.tabs.map((x) => x.paneId)).toEqual(["p_2", "p_3"]);
      // Moved tab becomes active in the target leaf.
      expect(rightLeaf.activeTabId).toBe(t2.id);
    });

    it("appends when targetIndex equals target leaf's tab count", () => {
      const base = leaf1("p_1");
      const t2 = tab("p_2", "shell", "station");
      const withTwo = addTab(base, base.id, t2);
      const split = splitLeaf(withTwo, base.id, "vertical", tab("p_3", "claude", "station"));
      const rightLeafId = split.newLeafId;

      // Right leaf has one tab; targetIndex=1 means append after p_3.
      const after = moveTab(split.tree, t2.id, rightLeafId, 1)!;
      const rightLeaf = findLeaf(after, rightLeafId)!;
      expect(rightLeaf.tabs.map((x) => x.paneId)).toEqual(["p_3", "p_2"]);
    });

    it("clamps targetIndex above target leaf's tab count", () => {
      const base = leaf1("p_1");
      const t2 = tab("p_2", "shell", "station");
      const withTwo = addTab(base, base.id, t2);
      const split = splitLeaf(withTwo, base.id, "vertical", tab("p_3", "claude", "station"));
      const rightLeafId = split.newLeafId;

      const after = moveTab(split.tree, t2.id, rightLeafId, 999)!;
      const rightLeaf = findLeaf(after, rightLeafId)!;
      expect(rightLeaf.tabs.map((x) => x.paneId)).toEqual(["p_3", "p_2"]);
    });

    it("clamps targetIndex below 0", () => {
      const base = leaf1("p_1");
      const t2 = tab("p_2", "shell", "station");
      const withTwo = addTab(base, base.id, t2);
      const split = splitLeaf(withTwo, base.id, "vertical", tab("p_3", "claude", "station"));
      const rightLeafId = split.newLeafId;

      const after = moveTab(split.tree, t2.id, rightLeafId, -5)!;
      const rightLeaf = findLeaf(after, rightLeafId)!;
      expect(rightLeaf.tabs.map((x) => x.paneId)).toEqual(["p_2", "p_3"]);
    });

    it("collapses the source leaf when the moved tab was its only tab", () => {
      // Both leaves have one tab; move p_1 out of the left leaf → left leaf
      // becomes empty and collapses; tree reduces to a single leaf.
      const base = leaf1("p_1");
      const split = splitLeaf(base, base.id, "vertical", tab("p_2", "claude", "station"));
      const leftLeafId = base.id;
      const rightLeafId = split.newLeafId;
      const p1TabId = base.tabs[0].id;

      const after = moveTab(split.tree, p1TabId, rightLeafId, 0)!;
      expect(after).not.toBeNull();
      // Source leaf is gone.
      expect(findLeaf(after, leftLeafId)).toBeNull();
      // Exactly one leaf remains, with both tabs.
      expect(allLeaves(after).length).toBe(1);
      const rightLeaf = findLeaf(after, rightLeafId)!;
      expect(rightLeaf.tabs.map((x) => x.paneId)).toEqual(["p_1", "p_2"]);
      expect(rightLeaf.activeTabId).toBe(p1TabId);
    });

    it("updates activeTabId on source leaf when the moved tab was active", () => {
      // Source leaf has [p_1, p_2] with p_2 active. Moving p_2 out should
      // leave source with [p_1] and p_1 active.
      const base = leaf1("p_1");
      const t2 = tab("p_2", "shell", "station");
      const withTwo = addTab(base, base.id, t2); // addTab sets t2 active
      const split = splitLeaf(withTwo, base.id, "vertical", tab("p_3", "claude", "station"));
      const leftLeafId = base.id;
      const rightLeafId = split.newLeafId;
      expect(findLeaf(split.tree, leftLeafId)!.activeTabId).toBe(t2.id);

      const after = moveTab(split.tree, t2.id, rightLeafId, 0)!;
      const leftLeaf = findLeaf(after, leftLeafId)!;
      expect(leftLeaf.tabs.map((x) => x.paneId)).toEqual(["p_1"]);
      expect(leftLeaf.activeTabId).toBe(leftLeaf.tabs[0].id);
    });

    it("falls through to a within-leaf reorder when source leaf === target leaf", () => {
      // tabs [p_1, p_2, p_3]; move p_1 to index 2 → [p_2, p_3, p_1].
      const base = leaf1("p_1");
      const t2 = tab("p_2", "shell", "station");
      const t3 = tab("p_3", "claude", "station");
      const a1 = addTab(base, base.id, t2);
      const a2 = addTab(a1, base.id, t3);
      const p1TabId = base.tabs[0].id;

      const after = moveTab(a2, p1TabId, base.id, 2)!;
      const leaf = findLeaf(after, base.id)!;
      expect(leaf.tabs.map((x) => x.paneId)).toEqual(["p_2", "p_3", "p_1"]);
    });

    it("is a no-op when same-leaf move lands at the current index", () => {
      const base = leaf1("p_1");
      const t2 = tab("p_2", "shell", "station");
      const a1 = addTab(base, base.id, t2);
      const p1TabId = base.tabs[0].id;

      const after = moveTab(a1, p1TabId, base.id, 0)!;
      expect(findLeaf(after, base.id)!.tabs.map((x) => x.paneId)).toEqual(["p_1", "p_2"]);
    });

    it("is a no-op when sourceTabId is unknown", () => {
      const base = leaf1("p_1");
      const split = splitLeaf(base, base.id, "vertical", tab("p_2", "claude", "station"));
      const after = moveTab(split.tree, "t_nonexistent", split.newLeafId, 0)!;
      expect(after).toBe(split.tree);
    });

    it("is a no-op when targetLeafId is unknown", () => {
      const base = leaf1("p_1");
      const t2 = tab("p_2", "shell", "station");
      const a1 = addTab(base, base.id, t2);
      const after = moveTab(a1, t2.id, "l_nonexistent", 0)!;
      expect(after).toBe(a1);
    });
  });
});

// --- isValidTreeNode (defensive load-time validation) ---
//
// reconcile() trusts its `saved` argument. The renderer reads
// `savedLayouts[projectId]` from disk-backed JSON that may have been
// hand-edited, partially written, or written by a future Satellite.
// boot.ts gates entry through this validator and drops anything it
// rejects so reconcile() never sees a malformed shape.
describe("isValidTreeNode", () => {
  it("accepts a fresh single-leaf tree", () => {
    const t = leaf1("p_1");
    expect(isValidTreeNode(t)).toBe(true);
  });

  it("accepts a split tree built via the public API", () => {
    const base = leaf1("p_1");
    const r = splitLeaf(base, base.id, "vertical", tab("p_2", "claude", "station"));
    expect(isValidTreeNode(r.tree)).toBe(true);
  });

  it("accepts a deeply nested tree", () => {
    const base = leaf1("p_1");
    const r1 = splitLeaf(base, base.id, "vertical", tab("p_2", "claude", "station"));
    const leaves = allLeaves(r1.tree);
    const r2 = splitLeaf(r1.tree, leaves[1].id, "horizontal", tab("p_3", "shell", "station"));
    expect(isValidTreeNode(r2.tree)).toBe(true);
  });

  // --- structural rejections ---

  it("rejects null, undefined, primitives", () => {
    expect(isValidTreeNode(null)).toBe(false);
    expect(isValidTreeNode(undefined)).toBe(false);
    expect(isValidTreeNode("leaf")).toBe(false);
    expect(isValidTreeNode(42)).toBe(false);
    expect(isValidTreeNode(true)).toBe(false);
  });

  it("rejects objects with no kind discriminator", () => {
    expect(isValidTreeNode({})).toBe(false);
    expect(isValidTreeNode({ id: "l_x", tabs: [] })).toBe(false);
  });

  it("rejects objects with an unknown kind", () => {
    expect(isValidTreeNode({ kind: "diagonal", id: "x" })).toBe(false);
    expect(isValidTreeNode({ kind: "node", id: "x" })).toBe(false);
  });

  it("rejects a leaf with no tabs array", () => {
    expect(
      isValidTreeNode({ kind: "leaf", id: "l_x", activeTabId: "t_x" }),
    ).toBe(false);
  });

  it("rejects a leaf with an empty tabs array", () => {
    expect(
      isValidTreeNode({
        kind: "leaf",
        id: "l_x",
        tabs: [],
        activeTabId: "t_x",
      }),
    ).toBe(false);
  });

  it("rejects a leaf whose activeTabId doesn't reference a tab", () => {
    const t1 = tab("p_1", "claude", "station");
    expect(
      isValidTreeNode({
        kind: "leaf",
        id: "l_x",
        tabs: [t1],
        activeTabId: "t_does_not_exist",
      }),
    ).toBe(false);
  });

  it("rejects a leaf whose activeTabId is missing", () => {
    const t1 = tab("p_1", "claude", "station");
    expect(isValidTreeNode({ kind: "leaf", id: "l_x", tabs: [t1] })).toBe(false);
  });

  it("rejects a leaf with an empty id", () => {
    const t1 = tab("p_1", "claude", "station");
    expect(
      isValidTreeNode({ kind: "leaf", id: "", tabs: [t1], activeTabId: t1.id }),
    ).toBe(false);
  });

  // --- tab shape ---

  it("rejects a leaf whose tab is missing required fields", () => {
    const bad = {
      kind: "leaf",
      id: "l_x",
      tabs: [{ id: "t_x", title: "x" } /* missing paneId, kind */],
      activeTabId: "t_x",
    };
    expect(isValidTreeNode(bad)).toBe(false);
  });

  it("rejects a leaf with a tab of an unknown pane kind", () => {
    const bad = {
      kind: "leaf",
      id: "l_x",
      tabs: [
        {
          id: "t_x",
          paneId: "p_x",
          title: "x",
          kind: "telnet" /* not in PaneKind */,
        },
      ],
      activeTabId: "t_x",
    };
    expect(isValidTreeNode(bad)).toBe(false);
  });

  it("accepts a leaf where tabs omit optional sessionId / slotId / tooltip", () => {
    // Older Satellite builds wrote tabs without slotId or sessionId; load
    // path must remain backward-compatible with those.
    const t = leafWithTab(tab("p_1", "claude", "station"));
    delete t.tabs[0].sessionId;
    delete t.tabs[0].slotId;
    delete t.tabs[0].tooltip;
    expect(isValidTreeNode(t)).toBe(true);
  });

  it("rejects when an optional tab field has the wrong type", () => {
    const t = leafWithTab(tab("p_1", "claude", "station"));
    (t.tabs[0] as unknown as { sessionId: number }).sessionId = 42;
    expect(isValidTreeNode(t)).toBe(false);
  });

  // --- host (an earlier release, plan rev 3.1) ---
  //
  // Persisted blobs without `host` are stamped "station" inside
  // loadLayouts() (config.ts) before this validator runs. Reaching here
  // without a host means in-code construction skipped it — that's a bug
  // the validator should surface.

  it("rejects a tab missing host", () => {
    const bad = {
      kind: "leaf",
      id: "l_x",
      tabs: [{ id: "t_x", paneId: "p_x", kind: "claude", title: "Claude" }],
      activeTabId: "t_x",
    };
    expect(isValidTreeNode(bad)).toBe(false);
  });

  it("rejects a tab with an unknown host value", () => {
    const bad = {
      kind: "leaf",
      id: "l_x",
      tabs: [
        { id: "t_x", paneId: "p_x", kind: "claude", title: "Claude", host: "cloud" },
      ],
      activeTabId: "t_x",
    };
    expect(isValidTreeNode(bad)).toBe(false);
  });

  it("accepts both station and local hosts", () => {
    const a = leafWithTab(tab("p_1", "claude", "station"));
    const b = leafWithTab(tab("p_2", "shell", "local"));
    expect(isValidTreeNode(a)).toBe(true);
    expect(isValidTreeNode(b)).toBe(true);
  });

  // --- split shape ---

  it("rejects a split with an unknown direction", () => {
    const child = leaf1("p_1");
    expect(
      isValidTreeNode({
        kind: "split",
        id: "s_x",
        dir: "diagonal",
        ratio: 0.5,
        a: child,
        b: leaf1("p_2"),
      }),
    ).toBe(false);
  });

  it("rejects a split with a non-numeric ratio", () => {
    expect(
      isValidTreeNode({
        kind: "split",
        id: "s_x",
        dir: "vertical",
        ratio: "0.5",
        a: leaf1("p_1"),
        b: leaf1("p_2"),
      }),
    ).toBe(false);
  });

  it("rejects a split with an out-of-range ratio", () => {
    expect(
      isValidTreeNode({
        kind: "split",
        id: "s_x",
        dir: "vertical",
        ratio: 1.5,
        a: leaf1("p_1"),
        b: leaf1("p_2"),
      }),
    ).toBe(false);
    expect(
      isValidTreeNode({
        kind: "split",
        id: "s_x",
        dir: "vertical",
        ratio: -0.1,
        a: leaf1("p_1"),
        b: leaf1("p_2"),
      }),
    ).toBe(false);
  });

  it("rejects a split with NaN ratio", () => {
    expect(
      isValidTreeNode({
        kind: "split",
        id: "s_x",
        dir: "vertical",
        ratio: NaN,
        a: leaf1("p_1"),
        b: leaf1("p_2"),
      }),
    ).toBe(false);
  });

  it("rejects a split missing one of its children", () => {
    expect(
      isValidTreeNode({
        kind: "split",
        id: "s_x",
        dir: "vertical",
        ratio: 0.5,
        a: leaf1("p_1"),
        // b missing
      }),
    ).toBe(false);
  });

  it("rejects a split whose nested child is invalid (recursive check)", () => {
    const garbageLeaf = { kind: "leaf", id: "l_g", tabs: "not-an-array" };
    expect(
      isValidTreeNode({
        kind: "split",
        id: "s_x",
        dir: "horizontal",
        ratio: 0.5,
        a: leaf1("p_1"),
        b: garbageLeaf,
      }),
    ).toBe(false);
  });

  it("rejects deeply-nested gibberish", () => {
    expect(
      isValidTreeNode({
        kind: "split",
        id: "s_outer",
        dir: "vertical",
        ratio: 0.5,
        a: {
          kind: "split",
          id: "s_inner",
          dir: "horizontal",
          ratio: 0.5,
          a: leaf1("p_1"),
          b: { kind: "leaf", id: "l_b", tabs: [{}], activeTabId: "x" },
        },
        b: leaf1("p_2"),
      }),
    ).toBe(false);
  });
});

// --- regression: reconcile recovers when boot.ts drops a malformed entry ---
describe("isValidTreeNode + reconcile recovery", () => {
  it("treating a dropped entry as null lets reconcile fall through to Pass 3 (append live panes fresh)", async () => {
    // boot.ts deletes invalid entries; subsequent lookup yields
    // undefined, which boot.ts coalesces to `null` before calling
    // reconcile(). Verify reconcile(null, livePanes, "station") produces a fresh
    // tree with the live panes — i.e. recovery is graceful.
    const { reconcile } = await import("./reconcile");
    const live = [
      {
        id: "p_live",
        kind: "claude" as const,
        state: "running" as const,
        stoplight: "green" as const,
        session_id: "sess-x",
      },
    ];
    const out = reconcile(null, live, "station");
    expect(out).not.toBeNull();
    expect(allPaneIds(out!)).toEqual(["p_live"]);
  });
});
