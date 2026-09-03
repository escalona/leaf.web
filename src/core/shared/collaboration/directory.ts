import type { LeafNodeRecord, LeafNodeType } from "./protocol";

const DEFAULT_SPATIAL_CELL_SIZE = 1024;
const MAX_GRID_CELLS_PER_HEADER = 256;

export type LeafApproximateBounds = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type LeafRecordHeader = {
  bounds: LeafApproximateBounds;
  dependencyShardIds: string[];
  detailShardId: string;
  id: string;
  isArtboard: boolean;
  name: string;
  parentId: string | null;
  rank: string;
  type: LeafNodeType;
  visible: boolean;
};

export type LeafInterestSnapshot = {
  dependencyShardIds: string[];
  generation: number;
  retainedShardIds: string[];
  shardIds: string[];
};

/** Compact hierarchy/spatial index. It intentionally owns no MobX objects. */
export class LeafRecordDirectory {
  private readonly headers = new Map<string, LeafRecordHeader>();
  private readonly childrenByParent = new Map<string | null, string[]>();
  private readonly headersByShard = new Map<string, string[]>();
  private readonly spatialCells = new Map<string, Set<string>>();
  private readonly globalSpatialIds = new Set<string>();

  constructor(
    headers: readonly LeafRecordHeader[],
    private readonly spatialCellSize = DEFAULT_SPATIAL_CELL_SIZE,
  ) {
    if (!Number.isFinite(spatialCellSize) || spatialCellSize <= 0) {
      throw new Error("Directory spatial cell size is invalid");
    }
    this.replace(headers);
  }

  get size() {
    return this.headers.size;
  }

  get(id: string) {
    const header = this.headers.get(id);
    return header ? cloneHeader(header) : null;
  }

  getChildren(parentId: string | null) {
    return [...(this.childrenByParent.get(parentId) ?? [])];
  }

  getShardHeaders(shardId: string) {
    return (this.headersByShard.get(shardId) ?? [])
      .map((id) => this.headers.get(id))
      .filter((header): header is LeafRecordHeader => !!header)
      .map(cloneHeader);
  }

  getPath(nodeId: string) {
    const path: string[] = [];
    const seen = new Set<string>();
    let current = this.headers.get(nodeId);
    while (current) {
      if (seen.has(current.id)) throw new Error("Directory hierarchy contains a cycle");
      seen.add(current.id);
      path.push(current.id);
      current = current.parentId ? this.headers.get(current.parentId) : undefined;
    }
    if (path.length === 0) return [];
    return path.reverse();
  }

  query(bounds: LeafApproximateBounds, overscan = 0) {
    assertBounds(bounds);
    if (!Number.isFinite(overscan) || overscan < 0) {
      throw new Error("Directory overscan is invalid");
    }
    const query = {
      x: bounds.x - overscan,
      y: bounds.y - overscan,
      width: bounds.width + overscan * 2,
      height: bounds.height + overscan * 2,
    };
    const ids = new Set(this.globalSpatialIds);
    for (const cell of cellsForBounds(query, this.spatialCellSize)) {
      for (const id of this.spatialCells.get(cell) ?? []) ids.add(id);
    }
    return [...ids]
      .map((id) => this.headers.get(id))
      .filter((header): header is LeafRecordHeader => !!header && intersects(header.bounds, query))
      .sort((left, right) =>
        this.hierarchySortKey(left).localeCompare(this.hierarchySortKey(right)),
      )
      .map((header) => header.id);
  }

  replace(headers: readonly LeafRecordHeader[]) {
    const next = validateHeaders(headers);
    this.headers.clear();
    this.childrenByParent.clear();
    this.headersByShard.clear();
    this.spatialCells.clear();
    this.globalSpatialIds.clear();
    for (const header of next.values()) this.headers.set(header.id, header);
    for (const header of this.headers.values()) {
      const children = this.childrenByParent.get(header.parentId) ?? [];
      children.push(header.id);
      this.childrenByParent.set(header.parentId, children);
      const shardHeaders = this.headersByShard.get(header.detailShardId) ?? [];
      shardHeaders.push(header.id);
      this.headersByShard.set(header.detailShardId, shardHeaders);
      this.indexSpatialHeader(header);
    }
    for (const [parentId, ids] of this.childrenByParent) {
      ids.sort((leftId, rightId) =>
        compareHeaders(this.headers.get(leftId)!, this.headers.get(rightId)!),
      );
      this.childrenByParent.set(parentId, ids);
    }
  }

  private indexSpatialHeader(header: LeafRecordHeader) {
    const cells = cellsForBounds(header.bounds, this.spatialCellSize);
    if (cells.length > MAX_GRID_CELLS_PER_HEADER) {
      this.globalSpatialIds.add(header.id);
      return;
    }
    for (const cell of cells) {
      const ids = this.spatialCells.get(cell) ?? new Set<string>();
      ids.add(header.id);
      this.spatialCells.set(cell, ids);
    }
  }

  private hierarchySortKey(header: LeafRecordHeader) {
    return this.getPath(header.id)
      .map((id) => {
        const entry = this.headers.get(id)!;
        return `${entry.rank}:${entry.id}`;
      })
      .join("/");
  }
}

/** Reliable viewport/Layers interest with generation fencing and preview retention. */
export class LeafInterestTracker {
  private generation = 0;
  private viewportNodeIds = new Set<string>();
  private layerNodeIds = new Set<string>();
  private forcedNodeIds = new Set<string>();
  private loadedShardIds = new Set<string>();
  private desiredShardIds = new Set<string>();

  constructor(private readonly directory: LeafRecordDirectory) {}

  setViewport(bounds: LeafApproximateBounds, overscan = 0) {
    this.viewportNodeIds = new Set(this.directory.query(bounds, overscan));
    return this.recompute();
  }

  setLayersNodes(nodeIds: readonly string[]) {
    this.layerNodeIds = new Set(nodeIds);
    return this.recompute();
  }

  setForcedNodes(nodeIds: readonly string[]) {
    this.forcedNodeIds = new Set(nodeIds);
    return this.recompute();
  }

  markLoaded(shardIds: readonly string[]) {
    for (const id of shardIds) this.loadedShardIds.add(id);
    return this.snapshot();
  }

  markUnloaded(shardIds: readonly string[]) {
    for (const id of shardIds) this.loadedShardIds.delete(id);
    return this.snapshot();
  }

  snapshot(): LeafInterestSnapshot {
    const dependencyShardIds = new Set<string>();
    for (const shardId of this.desiredShardIds) {
      for (const header of this.directory.getShardHeaders(shardId)) {
        for (const dependency of header.dependencyShardIds) dependencyShardIds.add(dependency);
      }
    }
    const retainedShardIds = [...this.loadedShardIds].filter((id) => !this.desiredShardIds.has(id));
    return {
      generation: this.generation,
      shardIds: [...this.desiredShardIds].sort(),
      dependencyShardIds: [...dependencyShardIds].sort(),
      retainedShardIds: retainedShardIds.sort(),
    };
  }

  private recompute() {
    const next = new Set<string>();
    const nodeIds = new Set([...this.viewportNodeIds, ...this.layerNodeIds, ...this.forcedNodeIds]);
    for (const nodeId of nodeIds) {
      for (const pathId of this.directory.getPath(nodeId)) {
        const header = this.directory.get(pathId);
        if (header) next.add(header.detailShardId);
      }
    }
    if (!setsEqual(next, this.desiredShardIds)) {
      this.desiredShardIds = next;
      this.generation += 1;
    }
    return this.snapshot();
  }
}

export function leafRecordToHeader(
  record: LeafNodeRecord,
  detailShardId: string,
  dependencyShardIds: readonly string[] = [],
): LeafRecordHeader {
  return {
    id: record.id,
    parentId: record.parentId,
    rank: record.rank,
    type: record.type,
    name: record.name,
    visible: record.visible,
    isArtboard: record.isArtboard,
    bounds: { x: record.x, y: record.y, width: record.width, height: record.height },
    detailShardId,
    dependencyShardIds: [...new Set(dependencyShardIds)].sort(),
  };
}

function validateHeaders(headers: readonly LeafRecordHeader[]) {
  const map = new Map<string, LeafRecordHeader>();
  for (const input of headers) {
    assertHeader(input);
    if (map.has(input.id)) throw new Error(`Duplicate directory node id: ${input.id}`);
    map.set(input.id, cloneHeader(input));
  }
  const siblingRanks = new Set<string>();
  for (const header of map.values()) {
    if (header.parentId !== null && !map.has(header.parentId)) {
      throw new Error(`Directory parent not found: ${header.parentId}`);
    }
    const rankKey = JSON.stringify([header.parentId, header.rank]);
    if (siblingRanks.has(rankKey)) throw new Error(`Duplicate directory rank: ${header.rank}`);
    siblingRanks.add(rankKey);
    const seen = new Set<string>();
    let ancestor: LeafRecordHeader | undefined = header;
    while (ancestor) {
      if (seen.has(ancestor.id)) throw new Error("Directory hierarchy contains a cycle");
      seen.add(ancestor.id);
      ancestor = ancestor.parentId ? map.get(ancestor.parentId) : undefined;
    }
  }
  return map;
}

function assertHeader(header: LeafRecordHeader) {
  if (
    !header.id ||
    header.id.length > 512 ||
    (header.parentId !== null && !header.parentId) ||
    !/^[0-9a-z]{16}$/.test(header.rank) ||
    !header.name ||
    !header.detailShardId ||
    !Array.isArray(header.dependencyShardIds) ||
    header.dependencyShardIds.some((id) => !id) ||
    typeof header.visible !== "boolean" ||
    typeof header.isArtboard !== "boolean"
  ) {
    throw new Error("Directory header is invalid");
  }
  assertBounds(header.bounds);
}

function assertBounds(bounds: LeafApproximateBounds) {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width < 0 ||
    bounds.height < 0
  ) {
    throw new Error("Directory bounds are invalid");
  }
}

function cellsForBounds(bounds: LeafApproximateBounds, cellSize: number) {
  const minX = Math.floor(bounds.x / cellSize);
  const minY = Math.floor(bounds.y / cellSize);
  const maxX = Math.floor((bounds.x + Math.max(bounds.width, 1)) / cellSize);
  const maxY = Math.floor((bounds.y + Math.max(bounds.height, 1)) / cellSize);
  const cells: string[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) cells.push(`${x}:${y}`);
  }
  return cells;
}

function intersects(left: LeafApproximateBounds, right: LeafApproximateBounds) {
  return !(
    left.x + left.width < right.x ||
    right.x + right.width < left.x ||
    left.y + left.height < right.y ||
    right.y + right.height < left.y
  );
}

function compareHeaders(left: LeafRecordHeader, right: LeafRecordHeader) {
  return left.rank.localeCompare(right.rank) || left.id.localeCompare(right.id);
}

function cloneHeader(header: LeafRecordHeader): LeafRecordHeader {
  return {
    ...header,
    bounds: { ...header.bounds },
    dependencyShardIds: [...header.dependencyShardIds],
  };
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}
