// Split tree: a binary tree where internal nodes are splits and leaves are tab groups.
// Each leaf holds a list of tabs; each tab is one terminal (pane).
// This mirrors CMUX: tabs live inside a pane-box, splits create new pane-boxes.

import type { PaneKind } from "@proto/proto";
import { VALID_HOSTS, type HostRef } from "../host";

export type SplitDir = "vertical" | "horizontal";
// "vertical"   = side-by-side (left/right) with a vertical divider
// "horizontal" = stacked (top/bottom) with a horizontal divider

export interface Tab {
  id: string; // client-side id
  paneId: string; // daemon pane id — regenerated on every spawn
  title: string;
  kind: PaneKind;
  // Which daemon this tab's pane lives on (an earlier release). Stamped at tab
  // creation; immutable for the tab's lifetime — moving a tab between
  // hosts isn't a Phase 1+ feature. Legacy layouts that pre-date this
  // field are stamped "station" inside `loadLayouts()` before validation
  // (see `satellite/renderer/src/config.ts`), so the validator below
  // can require the field on all in-memory tabs.
  host: HostRef;
  // Claude panes: the daemon's `--resume` UUID. Stable across daemon
  // restarts (persisted in ~/.config/reck/sessions/<projectId>.json), so
  // reconcile() can re-key a saved layout tree onto a new generation of
  // `paneId`s without collapsing the split structure. Missing on tabs
  // created by older Satellite builds.
  sessionId?: string;
  // Shell panes: the daemon's SlotID (Scope B). Same role as
  // sessionId — stable across daemon restarts, captured on first poll
  // after create, used by reconcile() as the rekey seed. Empty for
  // Claude panes (they use sessionId).
  slotId?: string;
  // Optional hover tooltip for the tab title, e.g. the resolved Claude
  // launch args when the pane was spawned with extras. Omitted → default
  // browser behaviour (no tooltip).
  tooltip?: string;
}

export interface LeafNode {
  kind: "leaf";
  id: string;
  tabs: Tab[];
  activeTabId: string;
}

export interface SplitNode {
  kind: "split";
  id: string;
  dir: SplitDir;
  ratio: number; // 0..1, first child's fraction
  a: TreeNode;
  b: TreeNode;
}

export type TreeNode = LeafNode | SplitNode;

// --- id generators ---

export function newLeafId() { return "l_" + Math.random().toString(36).slice(2, 10); }
export function newSplitId() { return "s_" + Math.random().toString(36).slice(2, 10); }
export function newTabId() { return "t_" + Math.random().toString(36).slice(2, 10); }

// --- constructors ---

export function tab(
  paneId: string,
  kind: PaneKind,
  host: HostRef,
  title?: string,
  id = newTabId(),
  tooltip?: string,
  sessionId?: string,
  slotId?: string,
): Tab {
  return {
    id,
    paneId,
    kind,
    host,
    title: title ?? defaultTabTitle(kind),
    tooltip,
    sessionId,
    slotId,
  };
}

export function defaultTabTitle(kind: PaneKind): string {
  if (kind === "claude") return "Claude";
  if (kind === "codex") return "Codex";
  return "Shell";
}

export function leafWithTab(t: Tab, id = newLeafId()): LeafNode {
  return { kind: "leaf", id, tabs: [t], activeTabId: t.id };
}

// --- runtime validation ---

const VALID_PANE_KINDS = new Set<PaneKind>(["claude", "shell", "codex"]);
const VALID_SPLIT_DIRS = new Set<SplitDir>(["vertical", "horizontal"]);

/**
 * Recursive type guard for persisted layout trees.
 *
 * The renderer trusts `savedLayouts[projectId]` as if it had the right
 * shape; in practice the value comes from disk-backed JSON that may have
 * been hand-edited, partially written, or written by a future Satellite
 * with a schema we don't recognise. Without a guard, `reconcile()` will
 * crash deep inside `forEachTab` / `closeTab` with an unhelpful
 * `Cannot read properties of undefined` rather than failing fast at load
 * time.
 *
 * Returns true when `node` is a structurally valid `TreeNode`:
 *
 *   - Object with a `kind` discriminator of "leaf" or "split".
 *   - Leaves: non-empty string `id`, array `tabs` of valid `Tab`s, and
 *     `activeTabId` that matches one of the tabs' ids.
 *   - Splits: non-empty string `id`, `dir` ∈ { "vertical", "horizontal" },
 *     numeric `ratio` in [0, 1], and recursively-valid `a` and `b`.
 *
 * Tabs are validated minimally — `id`, `paneId`, and `kind` are
 * required (a tab without those would fail Pass 1 of reconcile anyway).
 * Optional fields (`title`, `tooltip`, `sessionId`, `slotId`) are
 * checked for the right type only when present, which lets a tab from
 * an older Satellite without the optional `slotId` field still pass.
 */
export function isValidTreeNode(node: unknown): node is TreeNode {
  if (!node || typeof node !== "object") return false;
  const n = node as { kind?: unknown };
  if (n.kind === "leaf") return isValidLeaf(node);
  if (n.kind === "split") return isValidSplit(node);
  return false;
}

function isValidLeaf(node: unknown): node is LeafNode {
  if (!node || typeof node !== "object") return false;
  const l = node as Partial<LeafNode> & { kind?: unknown };
  if (l.kind !== "leaf") return false;
  if (typeof l.id !== "string" || l.id.length === 0) return false;
  if (!Array.isArray(l.tabs) || l.tabs.length === 0) return false;
  for (const t of l.tabs) {
    if (!isValidTab(t)) return false;
  }
  if (typeof l.activeTabId !== "string") return false;
  if (!l.tabs.some((t) => t.id === l.activeTabId)) return false;
  return true;
}

function isValidSplit(node: unknown): node is SplitNode {
  if (!node || typeof node !== "object") return false;
  const s = node as Partial<SplitNode> & { kind?: unknown };
  if (s.kind !== "split") return false;
  if (typeof s.id !== "string" || s.id.length === 0) return false;
  if (typeof s.dir !== "string" || !VALID_SPLIT_DIRS.has(s.dir as SplitDir)) return false;
  if (typeof s.ratio !== "number" || !Number.isFinite(s.ratio)) return false;
  if (s.ratio < 0 || s.ratio > 1) return false;
  if (!isValidTreeNode(s.a)) return false;
  if (!isValidTreeNode(s.b)) return false;
  return true;
}

function isValidTab(value: unknown): value is Tab {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<Tab>;
  if (typeof t.id !== "string" || t.id.length === 0) return false;
  if (typeof t.paneId !== "string") return false;
  if (typeof t.kind !== "string" || !VALID_PANE_KINDS.has(t.kind as PaneKind)) return false;
  if (typeof t.title !== "string") return false;
  // `host` is required on in-memory tabs. Legacy persisted blobs that
  // pre-date Phase 1 are stamped "station" inside `loadLayouts()` before
  // they reach this validator, so reaching here without a host means
  // something built a Tab in code without supplying one — reject it.
  if (typeof t.host !== "string" || !VALID_HOSTS.has(t.host as HostRef)) return false;
  // Optional fields: present → must be string; absent → fine.
  if (t.tooltip !== undefined && typeof t.tooltip !== "string") return false;
  if (t.sessionId !== undefined && typeof t.sessionId !== "string") return false;
  if (t.slotId !== undefined && typeof t.slotId !== "string") return false;
  return true;
}

// --- queries ---

export function findLeaf(tree: TreeNode | null, leafId: string): LeafNode | null {
  if (!tree) return null;
  if (tree.kind === "leaf") return tree.id === leafId ? tree : null;
  return findLeaf(tree.a, leafId) ?? findLeaf(tree.b, leafId);
}

export function findLeafByPaneId(tree: TreeNode | null, paneId: string): LeafNode | null {
  if (!tree) return null;
  if (tree.kind === "leaf") return tree.tabs.some((t) => t.paneId === paneId) ? tree : null;
  return findLeafByPaneId(tree.a, paneId) ?? findLeafByPaneId(tree.b, paneId);
}

export function findTab(tree: TreeNode | null, tabId: string): { leaf: LeafNode; tab: Tab } | null {
  if (!tree) return null;
  if (tree.kind === "leaf") {
    const t = tree.tabs.find((t) => t.id === tabId);
    return t ? { leaf: tree, tab: t } : null;
  }
  return findTab(tree.a, tabId) ?? findTab(tree.b, tabId);
}

export function allLeaves(tree: TreeNode | null): LeafNode[] {
  if (!tree) return [];
  if (tree.kind === "leaf") return [tree];
  return [...allLeaves(tree.a), ...allLeaves(tree.b)];
}

export function allTabs(tree: TreeNode | null): Tab[] {
  return allLeaves(tree).flatMap((l) => l.tabs);
}

export function allPaneIds(tree: TreeNode | null): string[] {
  return allTabs(tree).map((t) => t.paneId);
}

// --- operations ---

/** Split a specific leaf in two. New leaf starts with one tab. Returns new tree + new leaf id + new tab id. */
export function splitLeaf(
  tree: TreeNode,
  leafId: string,
  dir: SplitDir,
  newTab: Tab,
): { tree: TreeNode; newLeafId: string; newTabId: string } {
  const newLeaf = leafWithTab(newTab);
  function recur(node: TreeNode): TreeNode {
    if (node.kind === "leaf") {
      if (node.id !== leafId) return node;
      return { kind: "split", id: newSplitId(), dir, ratio: 0.5, a: node, b: newLeaf };
    }
    return { ...node, a: recur(node.a), b: recur(node.b) };
  }
  return { tree: recur(tree), newLeafId: newLeaf.id, newTabId: newTab.id };
}

/** Add a new tab to an existing leaf; make it active. */
export function addTab(tree: TreeNode, leafId: string, t: Tab): TreeNode {
  function recur(node: TreeNode): TreeNode {
    if (node.kind === "leaf") {
      if (node.id !== leafId) return node;
      return { ...node, tabs: [...node.tabs, t], activeTabId: t.id };
    }
    return { ...node, a: recur(node.a), b: recur(node.b) };
  }
  return recur(tree);
}

/** Rename a tab. No-op if not found. */
export function renameTab(tree: TreeNode, tabId: string, newTitle: string): TreeNode {
  function recur(node: TreeNode): TreeNode {
    if (node.kind === "leaf") {
      const tabs = node.tabs.map((t) => (t.id === tabId ? { ...t, title: newTitle } : t));
      return { ...node, tabs };
    }
    return { ...node, a: recur(node.a), b: recur(node.b) };
  }
  return recur(tree);
}

/** Switch the active tab in a leaf. */
export function switchTab(tree: TreeNode, leafId: string, tabId: string): TreeNode {
  function recur(node: TreeNode): TreeNode {
    if (node.kind === "leaf") {
      if (node.id !== leafId) return node;
      if (!node.tabs.some((t) => t.id === tabId)) return node;
      return { ...node, activeTabId: tabId };
    }
    return { ...node, a: recur(node.a), b: recur(node.b) };
  }
  return recur(tree);
}

/**
 * Close a tab. If it was the last tab in the leaf, collapse the leaf (removing the split if needed).
 * Returns the new tree (possibly null if the whole tree collapses).
 */
export function closeTab(tree: TreeNode, leafId: string, tabId: string): TreeNode | null {
  if (tree.kind === "leaf") {
    if (tree.id !== leafId) return tree;
    const remaining = tree.tabs.filter((t) => t.id !== tabId);
    if (remaining.length === 0) return null;
    const activeTabId = tree.activeTabId === tabId ? remaining[remaining.length - 1].id : tree.activeTabId;
    return { ...tree, tabs: remaining, activeTabId };
  }
  const a = closeTab(tree.a, leafId, tabId);
  const b = closeTab(tree.b, leafId, tabId);
  if (a && b) return { ...tree, a, b };
  if (a) return a;
  if (b) return b;
  return null;
}

/** Remove a whole leaf (and collapse its split parent if the leaf was one side of it). */
export function closeLeaf(tree: TreeNode, leafId: string): TreeNode | null {
  if (tree.kind === "leaf") return tree.id === leafId ? null : tree;
  const a = closeLeaf(tree.a, leafId);
  const b = closeLeaf(tree.b, leafId);
  if (a && b) return { ...tree, a, b };
  if (a) return a;
  if (b) return b;
  return null;
}

export function setRatio(tree: TreeNode, splitId: string, ratio: number): TreeNode {
  if (tree.kind === "leaf") return tree;
  if (tree.id === splitId) return { ...tree, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
  return { ...tree, a: setRatio(tree.a, splitId, ratio), b: setRatio(tree.b, splitId, ratio) };
}

/** Move a tab to a new index within its leaf. Clamps newIndex to [0, tabs.length-1]. No-op if the tab or leaf isn't found. */
export function reorderTab(tree: TreeNode, leafId: string, tabId: string, newIndex: number): TreeNode {
  function recur(node: TreeNode): TreeNode {
    if (node.kind === "leaf") {
      if (node.id !== leafId) return node;
      const idx = node.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return node;
      const clamped = Math.max(0, Math.min(node.tabs.length - 1, newIndex));
      if (idx === clamped) return node;
      const next = node.tabs.slice();
      const [moved] = next.splice(idx, 1);
      next.splice(clamped, 0, moved);
      return { ...node, tabs: next };
    }
    return { ...node, a: recur(node.a), b: recur(node.b) };
  }
  return recur(tree);
}

/**
 * Move a tab from its current leaf to `targetLeafId` at position `targetIndex`.
 *
 * Semantics:
 *  - `targetIndex` is clamped to `[0, targetLeaf.tabs.length]` for cross-leaf
 *    moves (`length` means "append at end"), and to
 *    `[0, targetLeaf.tabs.length - 1]` for same-leaf moves (since removal
 *    shrinks the list by one before re-insertion).
 *  - If the tab was the only one in its source leaf and the move is
 *    cross-leaf, the source leaf is collapsed via the same logic as
 *    `closeLeaf` (the parent split is removed, sibling bubbles up).
 *  - If `sourceLeaf === targetLeaf`, this reduces to a within-leaf reorder
 *    (no collapse, never empties the leaf).
 *  - The moved tab becomes the target leaf's `activeTabId`.
 *
 * No-ops (tree returned unchanged):
 *  - `sourceTabId` doesn't exist anywhere in the tree.
 *  - `targetLeafId` doesn't exist anywhere in the tree.
 *  - `sourceLeaf === targetLeaf` and the move is already at the same index.
 *
 * Returns `null` only if the tree collapses entirely — which can't happen
 * here because the moved tab always survives in the target leaf. The
 * nullable return type matches the sibling `closeTab` / `closeLeaf`
 * signatures for consistency.
 */
export function moveTab(
  tree: TreeNode,
  sourceTabId: string,
  targetLeafId: string,
  targetIndex: number,
): TreeNode | null {
  const source = findTab(tree, sourceTabId);
  if (!source) return tree;
  const targetLeaf = findLeaf(tree, targetLeafId);
  if (!targetLeaf) return tree;

  const sameLeaf = source.leaf.id === targetLeafId;

  if (sameLeaf) {
    // Translate to an in-leaf reorder. `reorderTab` clamps and handles the
    // no-op case; its `targetIndex` semantics are "index in the final list",
    // which matches what callers pass for same-leaf drops.
    return reorderTab(tree, targetLeafId, sourceTabId, targetIndex);
  }

  // Cross-leaf: remove from source (possibly collapsing its leaf), then
  // insert into target.
  const movedTab = source.tab;
  const sourceLeafId = source.leaf.id;
  const sourceIsLastTab = source.leaf.tabs.length === 1;

  let next: TreeNode | null = tree;
  if (sourceIsLastTab) {
    next = closeLeaf(next, sourceLeafId);
  } else {
    // Remove the single tab from source leaf.
    function removeRecur(node: TreeNode): TreeNode {
      if (node.kind === "leaf") {
        if (node.id !== sourceLeafId) return node;
        const remaining = node.tabs.filter((t) => t.id !== sourceTabId);
        const activeTabId =
          node.activeTabId === sourceTabId
            ? remaining[remaining.length - 1].id
            : node.activeTabId;
        return { ...node, tabs: remaining, activeTabId };
      }
      return { ...node, a: removeRecur(node.a), b: removeRecur(node.b) };
    }
    next = removeRecur(next);
  }

  if (!next) {
    // Tree collapsed — shouldn't happen unless target leaf was already gone,
    // which we guarded against above. Fall back to the single-leaf tree
    // holding just the moved tab so we don't lose it.
    return leafWithTab(movedTab);
  }

  // Insert into target leaf at clamped index.
  function insertRecur(node: TreeNode): TreeNode {
    if (node.kind === "leaf") {
      if (node.id !== targetLeafId) return node;
      const clamped = Math.max(0, Math.min(node.tabs.length, targetIndex));
      const tabs = node.tabs.slice();
      tabs.splice(clamped, 0, movedTab);
      return { ...node, tabs, activeTabId: movedTab.id };
    }
    return { ...node, a: insertRecur(node.a), b: insertRecur(node.b) };
  }
  return insertRecur(next);
}

// --- navigation ---

export type NavDir = "left" | "right" | "up" | "down" | "next" | "prev";

export function focusNav(tree: TreeNode, currentLeafId: string, dir: NavDir): string | null {
  const leaves = allLeaves(tree);
  if (leaves.length === 0) return null;
  const idx = leaves.findIndex((l) => l.id === currentLeafId);
  if (idx < 0) return leaves[0].id;
  switch (dir) {
    case "next":
    case "right":
    case "down":
      return leaves[(idx + 1) % leaves.length].id;
    case "prev":
    case "left":
    case "up":
      return leaves[(idx - 1 + leaves.length) % leaves.length].id;
  }
}
