import { makeAutoObservable, observable } from "mobx";
import type { DesignNode, NodeType } from "../types";

const DEFAULT_FONT_FAMILY = "system-ui, sans-serif";

const NODE_DEFAULTS: Record<NodeType, Partial<DesignNode>> = {
  frame: {
    name: "Frame",
    width: 300,
    height: 200,
    backgroundColor: "#ffffff",
    borderRadius: 8,
    // No default border. Under `box-sizing: border-box` a 1px border shrinks
    // the content box by 2px, so a 1440-wide artboard laid its children out in
    // 1438 — enough to change where text wraps. The canvas overlay draws the
    // frame boundary instead, where it cannot affect layout.
    borderColor: "transparent",
    borderWidth: 0,
    content: "",
    imageAsset: null,
    fontSize: 16,
    fontFamily: DEFAULT_FONT_FAMILY,
    color: "#000000",
    fontWeight: "normal",
    textAutoSize: false,
  },
  text: {
    name: "Text",
    width: 200,
    height: 40,
    backgroundColor: "transparent",
    borderRadius: 0,
    borderColor: "transparent",
    borderWidth: 0,
    content: "Text",
    imageAsset: null,
    fontSize: 16,
    fontFamily: DEFAULT_FONT_FAMILY,
    color: "#000000",
    fontWeight: "normal",
    textAutoSize: false,
  },
  rectangle: {
    name: "Rectangle",
    width: 150,
    height: 150,
    backgroundColor: "#4A90D9",
    borderRadius: 0,
    borderColor: "transparent",
    borderWidth: 0,
    content: "",
    imageAsset: null,
    fontSize: 16,
    fontFamily: DEFAULT_FONT_FAMILY,
    color: "#000000",
    fontWeight: "normal",
    textAutoSize: false,
  },
  svg: {
    name: "SVG",
    width: 400,
    height: 300,
    backgroundColor: "transparent",
    borderRadius: 0,
    borderColor: "transparent",
    borderWidth: 0,
    content: "<svg viewBox='0 0 24 24' />",
    imageAsset: null,
    fontSize: 16,
    fontFamily: DEFAULT_FONT_FAMILY,
    color: "#000000",
    fontWeight: "normal",
    textAutoSize: false,
  },
  "interactive-surface": {
    name: "Interactive Surface",
    width: 1440,
    height: 900,
    backgroundColor: "#ffffff",
    borderRadius: 0,
    // Interactive surfaces host runtime-owned DOM inside the exact stored box.
    // Keep their border in editor chrome so it cannot alter that viewport.
    borderColor: "transparent",
    borderWidth: 0,
    content: "",
    imageAsset: null,
    fontSize: 16,
    fontFamily: DEFAULT_FONT_FAMILY,
    color: "#000000",
    fontWeight: "normal",
    textAutoSize: false,
  },
  path: {
    name: "Path",
    width: 200,
    height: 200,
    backgroundColor: "transparent",
    borderRadius: 0,
    borderColor: "transparent",
    borderWidth: 0,
    // SVG path data in the node's own coordinate space.
    content: "",
    imageAsset: null,
    fontSize: 16,
    fontFamily: DEFAULT_FONT_FAMILY,
    color: "#000000",
    fontWeight: "normal",
    textAutoSize: false,
  },
  shader: {
    name: "Shader",
    width: 400,
    height: 300,
    backgroundColor: "transparent",
    borderRadius: 0,
    borderColor: "transparent",
    borderWidth: 0,
    // Shader id plus its parameters, serialized as JSON.
    content: "",
    imageAsset: null,
    fontSize: 16,
    fontFamily: DEFAULT_FONT_FAMILY,
    color: "#000000",
    fontWeight: "normal",
    textAutoSize: false,
  },
  image: {
    name: "Image",
    width: 320,
    height: 240,
    backgroundColor: "transparent",
    borderRadius: 0,
    borderColor: "transparent",
    borderWidth: 0,
    content: "",
    imageAsset: null,
    fontSize: 16,
    fontFamily: DEFAULT_FONT_FAMILY,
    color: "#000000",
    fontWeight: "normal",
    textAutoSize: false,
  },
};

let nextId: number | null = null;

export function generateId(): string {
  if (nextId !== null) {
    return `node_${nextId++}`;
  }

  const uuid = (
    globalThis as typeof globalThis & { crypto?: { randomUUID?: () => string } }
  ).crypto?.randomUUID?.();
  if (uuid) return `node_${uuid}`;

  return `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function resetIdCounter(start = 1) {
  nextId = start;
}

export function getNodeDefaults(type: NodeType): Partial<DesignNode> {
  return NODE_DEFAULTS[type];
}

export function createNode(type: NodeType, overrides: Partial<DesignNode> = {}): DesignNode {
  return makeAutoObservable(
    {
      // Persisted nodes already have stable ids. Avoid generating (and then
      // overwriting) a crypto UUID for every node during document hydration.
      id: overrides.id ?? generateId(),
      type,
      x: 0,
      y: 0,
      rotation: 0,
      visible: true,
      locked: false,
      children: [] as DesignNode[],
      isArtboard: false,
      imageGeneration: null,
      styles: {} as Record<string, string | number>,
      ...NODE_DEFAULTS[type],
      ...overrides,
    },
    {
      // Child nodes are already independently observable. A shallow observable
      // list still tracks insert/reorder/delete without recursively converting
      // every hydrated subtree a second time.
      children: observable.shallow,
      // Image metadata is replaced as a unit by every mutation path.
      imageAsset: observable.ref,
      // Generation provenance is durable but replaced as one immutable value.
      imageGeneration: observable.ref,
      // Imported HTML averages many CSS keys per node. Observing the map by
      // reference avoids creating an observable wrapper for every individual
      // key; runtime mutation paths replace the map copy-on-write.
      styles: observable.ref,
    },
  ) as DesignNode;
}

type DesignNodeFields = Omit<DesignNode, "id" | "type" | "children">;

export function cloneNodeFields({
  id: _id,
  type: _type,
  children: _children,
  ...fields
}: DesignNode): DesignNodeFields {
  return {
    ...fields,
    name: String(fields.name),
    rotation: Number.isFinite(fields.rotation) ? Number(fields.rotation) : 0,
    visible: fields.visible !== false,
    locked: fields.locked === true,
    backgroundColor: String(fields.backgroundColor),
    borderColor: String(fields.borderColor),
    content: String(fields.content),
    imageAsset: fields.imageAsset
      ? {
          ...fields.imageAsset,
          assetId: String(fields.imageAsset.assetId),
          src: fields.imageAsset.src === undefined ? undefined : String(fields.imageAsset.src),
          mimeType: String(fields.imageAsset.mimeType),
          sourceName:
            fields.imageAsset.sourceName === undefined
              ? undefined
              : String(fields.imageAsset.sourceName),
        }
      : null,
    imageGeneration: fields.imageGeneration
      ? {
          ...fields.imageGeneration,
          prompt: String(fields.imageGeneration.prompt),
          modelId: String(fields.imageGeneration.modelId),
          referenceNodeIds: fields.imageGeneration.referenceNodeIds.map(String),
        }
      : null,
    fontFamily: String(fields.fontFamily),
    color: String(fields.color),
    fontWeight: String(fields.fontWeight),
    styles: Object.fromEntries(
      Object.entries(fields.styles ?? {}).map(([key, value]) => [
        key,
        typeof value === "number" ? value : String(value),
      ]),
    ),
  };
}

export function cloneNodeTree(node: DesignNode, idMap: Record<string, string>): DesignNode {
  const clone = createNode(node.type, {
    ...cloneNodeFields(node),
    children: node.children.map((child) => cloneNodeTree(child, idMap)),
  });

  idMap[node.id] = clone.id;
  return clone;
}
