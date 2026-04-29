export type DropPosition = "before" | "after";

/**
 * Return a new list where `draggedId` has been moved to the requested
 * position relative to `targetId`. No-op if either id is not in `ids`
 * or the drop would not change order.
 */
export function computeReorder(
  ids: string[],
  draggedId: string,
  targetId: string,
  position: DropPosition,
): string[] {
  if (draggedId === targetId) return ids.slice();
  if (!ids.includes(draggedId) || !ids.includes(targetId)) return ids.slice();
  const withoutDrag = ids.filter((x) => x !== draggedId);
  const targetIdx = withoutDrag.indexOf(targetId);
  const insertIdx = position === "before" ? targetIdx : targetIdx + 1;
  return [...withoutDrag.slice(0, insertIdx), draggedId, ...withoutDrag.slice(insertIdx)];
}
