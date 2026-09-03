import type { DesignNode } from "../types";

export function normalizeSelectedIds(
  ids: Iterable<string>,
  nodeMap: ReadonlyMap<string, DesignNode>,
  parentMap: ReadonlyMap<string, string>,
): string[] {
  const requestedIds = Array.from(new Set(ids));
  const nextIds = requestedIds.filter((id) => nodeMap.has(id));
  const nextIdSet = new Set(nextIds);

  return nextIds.filter((id) => {
    let parentId = parentMap.get(id);
    while (parentId) {
      if (nextIdSet.has(parentId)) return false;
      parentId = parentMap.get(parentId);
    }
    return true;
  });
}

export function areSelectedIdsEqual(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}
