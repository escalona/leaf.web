export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type CompassDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export type InkPoint = { x: number; y: number; pressure: number };
export type DragInsertionAxis = "row" | "column";
export type SnapGuideAxis = "x" | "y";

export interface ImageAssetRef {
  assetId: string;
  src?: string;
  mimeType: string;
  byteLength: number;
  width: number;
  height: number;
  sourceName?: string;
}

/** Durable provenance for the latest generated raster authored onto a node. */
export interface ImageGenerationMetadata {
  prompt: string;
  modelId: string;
  aspectRatio:
    | "auto"
    | "1:1"
    | "3:2"
    | "4:3"
    | "16:9"
    | "2:1"
    | "3:1"
    | "2:3"
    | "3:4"
    | "9:16"
    | "1:2"
    | "1:3";
  /** Missing means the provider's automatic background treatment. */
  background?: "opaque" | "transparent";
  target: "image" | "background";
  referenceNodeIds: string[];
  /** Optional only for documents authored before generation lifecycle syncing. */
  status?: "generating" | "ready" | "failed";
  error?: string;
  /**
   * Wall-clock start of the request (ms since epoch). Lets any client fail a
   * placeholder whose owning session vanished long ago instead of leaving it
   * "generating" forever.
   */
  startedAt?: number;
}

export interface DragInsertionPreview {
  nodeId: string;
  parentId: string;
  index: number;
  axis: DragInsertionAxis;
}

export interface SnapGuide {
  axis: SnapGuideAxis;
  position: number;
  from: number;
  to: number;
}

export interface GeneratedImageJob {
  generationId?: string;
  prompt: string;
  status: "generating" | "ready" | "failed";
  error?: string;
  output?: "raster";
  target?: "image" | "background";
}

export type NodeType =
  | "frame"
  | "text"
  | "rectangle"
  | "svg"
  | "interactive-surface"
  | "image"
  | "path"
  | "shader";

/**
 * A page of the document. Pages own their own root nodes and camera, and are
 * the unit users switch between in the page bar. Node IDs stay unique across
 * the whole document so a single flat `nodeMap` still resolves any node.
 */
export interface EditorPage {
  id: string;
  name: string;
  nodes: DesignNode[];
  camera?: { zoom: number; panX: number; panY: number };
  /** Colour behind the page's artboards; absent means the default canvas colour. */
  background?: string;
}

export interface DesignNode {
  id: string;
  type: NodeType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, about the node's center. */
  rotation?: number;
  visible?: boolean;
  /** Locked nodes render normally but are not hit-testable or transformable. */
  locked?: boolean;
  children: DesignNode[];
  // Style properties (typed, for backward compat with manually-created nodes)
  backgroundColor: string;
  borderRadius: number;
  borderColor: string;
  borderWidth: number;
  // Text properties
  content: string;
  imageAsset?: ImageAssetRef | null;
  imageGeneration?: ImageGenerationMetadata | null;
  fontSize: number;
  fontFamily: string;
  color: string;
  fontWeight: string;
  textAutoSize?: boolean;
  // Artboard flag
  isArtboard: boolean;
  // Flexible CSS styles map (camelCase keys, like React.CSSProperties).
  // Stores arbitrary CSS from parsed HTML. Renderer merges these with typed
  // properties above — styles map takes precedence when both are present.
  styles: Record<string, string | number>;
}

export type ToolMode = "select" | "pan" | "frame" | "text" | "rectangle" | "ink" | "comment";
