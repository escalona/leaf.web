import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { hasStyledInlineChildren } from "../../core/editor/import/html-parser";
import { isFlowLayoutDisplay } from "../../core/editor/layout-display";
import { parseFontFamilies } from "../../core/fonts/loader";
import { isGenericLayerName } from "./generic-names";
import { getMcpNodeType } from "./node-inspection";

interface CreatedNodeSummary {
  id: string;
  type: string;
  name: string;
  children?: CreatedNodeSummary[];
}

export function summarizeCreatedNode(store: EditorStore, node: DesignNode): CreatedNodeSummary {
  const summary: CreatedNodeSummary = {
    id: node.id,
    type: getMcpNodeType(store, node),
    name: node.name,
  };
  if (node.children.length > 0) {
    summary.children = node.children.map((child) => summarizeCreatedNode(store, child));
  }
  return summary;
}

export function countCreatedNodes(nodes: DesignNode[]): number {
  let count = 0;
  const visit = (node: DesignNode) => {
    count += 1;
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return count;
}

const GENERIC_LAYER_WARNING_EXAMPLE_LIMIT = 3;

export function collectGenericLayerWarnings(nodes: readonly DesignNode[]) {
  const generic: DesignNode[] = [];
  let total = 0;
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    total += 1;
    if (isGenericLayerName(node.name)) generic.push(node);
    pending.push(...node.children);
  }
  if (generic.length === 0) return [];

  const examples = generic
    .slice(0, GENERIC_LAYER_WARNING_EXAMPLE_LIMIT)
    .map((node) => `${node.id} ("${node.name}")`)
    .join(", ");
  const ellipsis = generic.length > GENERIC_LAYER_WARNING_EXAMPLE_LIMIT ? ", …" : "";
  return [
    `${generic.length} of ${total} created layers have generic names (${examples}${ellipsis}). Name layers inline with layer-name="…" attributes on meaningful elements, or rename_nodes afterward, so later targeted edits stay reliable.`,
  ];
}

/**
 * Parse the imported markup once for every pre-import inspection pass. A staged
 * write_html body can be megabytes, so each extra DOMParser run is a full
 * re-parse of the same string on the renderer's main thread.
 */
export function parseHtmlForInspection(html: string): Document {
  return new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
}

/**
 * Warn once when imported markup contains styled inline spans inside a text
 * run. Leaf has no rich text: each styled span becomes its own block-level
 * text node stacked in a column, which is rarely what the author intended.
 *
 * The synthetic wrapper is scanned alongside the authored elements so bare
 * top-level spans warn too — that case is worse than the nested one, because
 * interstitial top-level text ("Read <span>…</span> and …") is not imported at
 * all. Authored flex/grid containers are exempt: laying styled spans out side
 * by side is exactly what the remediation suggests, so warning on them would
 * only train readers to ignore the warning.
 */
export function collectStyledInlineSpanWarnings(doc: Document): string[] {
  const wrapper = doc.body.firstElementChild;
  if (!wrapper) return [];

  const examples: string[] = [];
  for (const element of [wrapper, ...Array.from(wrapper.querySelectorAll("*"))]) {
    if (isFlowLayoutDisplay((element as HTMLElement).style?.display)) continue;
    if (!hasStyledInlineChildren(element as HTMLElement)) continue;
    examples.push(element === wrapper ? "top-level markup" : `<${element.tagName.toLowerCase()}>`);
    if (examples.length >= 3) break;
  }
  if (examples.length === 0) return [];

  return [
    `Mixed-style inline spans (in ${examples.join(", ")}) are not rich text: each styled span becomes a separate stacked text node, and bare text between top-level spans is dropped entirely, fragmenting the sentence. Use one text element per style run, or restructure so each styled phrase is its own element in a flex row.`,
  ];
}

export function collectExternalSvgUseWarnings(doc: Document): string[] {
  const references = new Set<string>();

  for (const use of Array.from(doc.querySelectorAll("svg use"))) {
    const href =
      use.getAttribute("href") ??
      use.getAttribute("xlink:href") ??
      use.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    const normalized = href?.trim();
    if (normalized && !normalized.startsWith("#")) references.add(normalized);
  }

  return [...references]
    .slice(0, 5)
    .map(
      (reference) =>
        `External SVG <use> reference "${reference}" was preserved but not fetched or rebased. Inline its <symbol> or path geometry before importing; fragment-only href="#id" works when the referenced geometry is included in the same markup.`,
    );
}

export function collectInlineStyleWarnings(doc: Document): string[] {
  const wrapper = doc.body.firstElementChild;
  if (!wrapper) return [];

  const properties = new Set<string>();
  const propertyProbe = doc.createElement("div").style;
  for (const element of Array.from(wrapper.querySelectorAll("[style]"))) {
    const style = element.getAttribute("style");
    if (!style) continue;

    for (const property of collectStyleDeclarationProperties(style)) {
      const looksLikeJavaScriptStyleName =
        /[a-z0-9][A-Z]/.test(property) || /^(?:Webkit|Moz|ms|O)[A-Z]/.test(property);
      if (property.startsWith("--") || !looksLikeJavaScriptStyleName) continue;
      propertyProbe.cssText = "";
      propertyProbe.setProperty(property, "initial");
      if (propertyProbe.length === 0) properties.add(property);
    }
  }

  return [...properties].map((property) => {
    const kebabCase = cssPropertyToKebabCase(property);
    return `Inline style property "${property}" was ignored. Use kebab-case "${kebabCase}" in HTML style attributes; update_styles uses camelCase property names instead.`;
  });
}

function collectStyleDeclarationProperties(style: string): string[] {
  const properties: string[] = [];
  let declarationStart = 0;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let inComment = false;

  const collectDeclaration = (end: number) => {
    const declaration = style
      .slice(declarationStart, end)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .trim();
    const colonIndex = declaration.indexOf(":");
    if (colonIndex < 0) return;

    const property = declaration.slice(0, colonIndex).trim();
    if (property) properties.push(property);
  };

  for (let index = 0; index < style.length; index += 1) {
    const character = style[index]!;
    const nextCharacter = style[index + 1];

    if (inComment) {
      if (character === "*" && nextCharacter === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      inComment = true;
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
    } else if (character === ";" && depth === 0) {
      collectDeclaration(index);
      declarationStart = index + 1;
    }
  }

  collectDeclaration(style.length);
  return properties;
}

function cssPropertyToKebabCase(property: string): string {
  const vendorPrefix = /^(?:Webkit|Moz|ms|O)[A-Z]/.test(property) ? "-" : "";
  const kebabCase = property
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
  return `${vendorPrefix}${kebabCase}`;
}

export function collectFontLoadRequests(doc: Document): { families: string[]; requests: string[] } {
  const wrapper = doc.body.firstElementChild as HTMLElement | null;
  if (!wrapper) return { families: [], requests: [] };

  const families = new Set<string>();
  const requests = new Set<string>();

  for (const element of Array.from(wrapper.querySelectorAll<HTMLElement>("*"))) {
    const fontFamilyValue = element.style.fontFamily;
    if (!fontFamilyValue) continue;

    const fontSize = element.style.fontSize || "16px";
    const fontWeight = element.style.fontWeight || "400";

    for (const family of parseFontFamilies(fontFamilyValue)) {
      families.add(family);
      requests.add(`${fontWeight} ${fontSize} "${family}"`);
    }
  }

  return {
    families: [...families],
    requests: [...requests],
  };
}
