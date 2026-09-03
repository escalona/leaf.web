/**
 * SVG sub-element decomposition, and the recomposition that undoes it.
 *
 * An `<svg>` is modelled as a parent plus one node per visual element, so a
 * single path is selectable and stylable on its own:
 * the parent `svg` node keeps the root markup — `viewBox`, `<defs>`, gradients,
 * filters, clipPaths, masks — and every visual element becomes a child node
 * holding just that element's markup.
 *
 * `composeSvgMarkup` is the exact inverse. Children go back into the parent's
 * markup in document order, which is paint order, so the canvas paints the same
 * DOM the import started from. A node with no children composes to its own
 * content byte-for-byte, which is what keeps hand-authored and script-created
 * SVG nodes on the path they had before decomposition existed.
 */
import type { DesignNode } from "../types";

/**
 * Elements that become their own node.
 *
 * Everything else — `<defs>`, gradients, `<filter>`, `<clipPath>`, `<mask>`,
 * `<symbol>`, `<style>`, `<title>` — stays in the parent's markup. None of it
 * paints on its own, and pulling it out of the root would break every
 * `fill="url(#id)"` that refers to it.
 */
const SVG_VISUAL_TAGS = new Set([
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "text",
  "image",
  "use",
  "g",
]);

/**
 * Elements that paint nothing by themselves.
 *
 * Decomposition moves every extracted element to the end of its parent's
 * markup, so it only preserves paint order when everything left behind is
 * inert. Anything in neither this set nor `SVG_VISUAL_TAGS` — `<foreignObject>`,
 * a nested `<svg>`, `<a>`, `<switch>`, `<tspan>` — is treated as
 * possibly-painting, and its level is left whole rather than restacked.
 *
 * Names are compared lowercased because the HTML parser hands SVG elements back
 * with their camelCase local names (`clipPath`, `linearGradient`).
 */
const SVG_INERT_TAGS = new Set([
  "defs",
  "lineargradient",
  "radialgradient",
  "pattern",
  "filter",
  "clippath",
  "mask",
  "marker",
  "symbol",
  "style",
  "title",
  "desc",
  "metadata",
  "script",
  "view",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "mpath",
  "solidcolor",
]);

const SVG_ELEMENT_LABELS: Record<string, string> = {
  path: "Path",
  circle: "Circle",
  ellipse: "Ellipse",
  rect: "Rectangle",
  line: "Line",
  polyline: "Polyline",
  polygon: "Polygon",
  text: "Text",
  image: "Image",
  use: "Use",
  g: "Group",
};

/** Paint the child inspector owns, as node style keys. */
export const SVG_PAINT_KEYS = ["fill", "stroke", "strokeWidth"] as const;

export type SvgPaintKey = (typeof SVG_PAINT_KEYS)[number];

/**
 * The presentation attribute each paint key is written back as.
 *
 * Attributes rather than an inline `style` on purpose: a presentation attribute
 * sits below every stylesheet rule, so the parent SVG node's `fill: inherit`
 * cascade (see `SvgSection`) keeps overriding a child's own fill.
 *
 * The one case this is not cascade-neutral: paint that was authored as an
 * inline `style` declaration comes back as an attribute, which loses to a rule
 * in a `<style>` block inside the same SVG. That needs an SVG carrying both a
 * stylesheet and an inline paint on the same element; the trade is deliberate,
 * because the alternative — writing inline style back — would make the root
 * SVG node's fill control unable to reach any decomposed shape.
 */
const SVG_PAINT_ATTRIBUTES: Record<SvgPaintKey, string> = {
  fill: "fill",
  stroke: "stroke",
  strokeWidth: "stroke-width",
};

export function isSvgVisualElement(el: Element): boolean {
  return SVG_VISUAL_TAGS.has(el.localName.toLowerCase());
}

/**
 * Whether this element's children can be pulled out without restacking it.
 *
 * Extraction appends children to the end of the parent's markup, so document
 * order only survives when every element that stays behind is inert. A level
 * holding a `<foreignObject>`, an `<a>`, a `<switch>` or a nested `<svg>` keeps
 * its whole subtree as one blob — the pre-decomposition behaviour — because
 * moving a sibling shape past one of those changes what covers what.
 */
export function canDecomposeSvgChildren(el: Element): boolean {
  return Array.from(el.children).every(
    (child) => isSvgVisualElement(child) || SVG_INERT_TAGS.has(child.localName.toLowerCase()),
  );
}

export function svgElementNodeName(el: Element): string {
  const authored = el.getAttribute("layer-name");
  if (authored) return authored;
  return SVG_ELEMENT_LABELS[el.localName.toLowerCase()] ?? "Shape";
}

/**
 * Move an element's fill/stroke/stroke-width onto a style map, stripping them
 * from the element.
 *
 * Hoisting is what makes the child node the single source of truth for its
 * paint: the inspector reads and writes `node.styles`, and composition puts the
 * value back on the element. An inline declaration wins over the presentation
 * attribute, matching the cascade, so the hoisted value is the one that painted.
 */
export function extractSvgPaintStyles(el: Element): Record<string, string> {
  const styles: Record<string, string> = {};
  const inline = (el as Partial<SVGElement>).style;

  for (const key of SVG_PAINT_KEYS) {
    const attribute = SVG_PAINT_ATTRIBUTES[key];
    const declared = inline?.getPropertyValue(attribute) ?? "";
    const value = (declared || el.getAttribute(attribute) || "").trim();
    if (value) styles[key] = value;
    el.removeAttribute(attribute);
    inline?.removeProperty(attribute);
  }

  // CSSOM leaves an empty `style=""` behind once its last declaration is gone.
  if (el.getAttribute("style")?.trim() === "") el.removeAttribute("style");
  return styles;
}

/** Compose a parent SVG node and its decomposed children back into one `<svg>`. */
export function composeSvgMarkup(node: DesignNode): string {
  if (node.children.length === 0) return node.content;
  return insertSvgChildren(node.content, node.children);
}

/** Every decomposed descendant of an SVG node, parents before children. */
export function collectSvgElementNodes(node: DesignNode): DesignNode[] {
  const collected: DesignNode[] = [];
  const visit = (parent: DesignNode) => {
    for (const child of parent.children) {
      collected.push(child);
      visit(child);
    }
  };
  visit(node);
  return collected;
}

interface OpenTag {
  index: number;
  text: string;
  name: string;
  selfClosing: boolean;
}

const TAG_NAME_PATTERN = /<([A-Za-z][-\w:.]*)/;

/**
 * Find an element's opening tag, honouring quoted attribute values.
 *
 * HTML serialization escapes `&` and `"` inside an attribute value but leaves
 * `>` alone, so `<path aria-label="a > b" d="…"/>` comes out of `outerHTML`
 * with a bare `>` mid-tag. Scanning to the first `>` would cut the tag in half
 * and shred the rest of the element, so the scan tracks quoting instead.
 */
function findOpenTag(markup: string): OpenTag | null {
  const match = TAG_NAME_PATTERN.exec(markup);
  if (!match) return null;

  let quote: string | null = null;
  for (let index = match.index + match[0].length; index < markup.length; index += 1) {
    const char = markup[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== ">") continue;
    return {
      index: match.index,
      text: markup.slice(match.index, index + 1),
      name: match[1]!,
      selfClosing: markup[index - 1] === "/",
    };
  }
  return null;
}

interface TagAttribute {
  start: number;
  end: number;
  name: string;
}

/** Attribute spans inside a serialized open tag, quoting-aware. */
function scanTagAttributes(tag: string): TagAttribute[] {
  const name = TAG_NAME_PATTERN.exec(tag);
  if (!name || name.index !== 0) return [];

  const attributes: TagAttribute[] = [];
  const limit = tag.length - (tag.endsWith("/>") ? 2 : 1);
  let index = name[0].length;

  const skipSpace = () => {
    while (index < limit && /\s/.test(tag[index]!)) index += 1;
  };

  while (index < limit) {
    skipSpace();
    if (index >= limit) break;

    const start = index;
    while (index < limit && !/[\s=/]/.test(tag[index]!)) index += 1;
    const attributeName = tag.slice(start, index);
    if (!attributeName) {
      index += 1;
      continue;
    }

    const afterName = index;
    skipSpace();
    if (tag[index] === "=" && index < limit) {
      index += 1;
      skipSpace();
      const quote = tag[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        while (index < limit && tag[index] !== quote) index += 1;
        index += 1;
      } else {
        while (index < limit && !/\s/.test(tag[index]!)) index += 1;
      }
    } else {
      index = afterName;
    }

    attributes.push({ start, end: index, name: attributeName });
  }

  return attributes;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeAttributeValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/**
 * Set (or, with `null`, drop) one attribute on a serialized open tag.
 *
 * The existing occurrences are located by scanning rather than by regex: a
 * pattern like `\sfill\s*=\s*"[^"]*"` also matches inside a neighbouring
 * attribute's value (`aria-label='fill="red"'`), which would corrupt the tag.
 */
function withTagAttribute(tag: string, name: string, value: string | null): string {
  const lower = name.toLowerCase();
  const existing = scanTagAttributes(tag).filter(
    (attribute) => attribute.name.toLowerCase() === lower,
  );

  let stripped = tag;
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const attribute = existing[index]!;
    // Eat the whitespace that separated it from the previous attribute too, so
    // dropping one does not leave a double space behind.
    let from = attribute.start;
    while (from > 0 && /\s/.test(stripped[from - 1]!)) from -= 1;
    stripped = stripped.slice(0, from) + stripped.slice(attribute.end);
  }
  if (value === null) return stripped;

  const selfClosing = stripped.endsWith("/>");
  const head = stripped.slice(0, stripped.length - (selfClosing ? 2 : 1)).trimEnd();
  return `${head} ${name}="${escapeAttributeValue(value)}"${selfClosing ? "/>" : ">"}`;
}

/**
 * Put composed children inside an element's markup.
 *
 * The content of a decomposed node is one element with its visual children
 * removed, so the insertion point is just before its closing tag. A root that
 * was authored self-closing is expanded so it can hold artwork at all. Markup
 * we cannot make sense of degrades to appending — never to throwing, which
 * would blank the canvas for one malformed paste.
 */
function insertSvgChildren(markup: string, children: readonly DesignNode[]): string {
  const inner = children.map(composeSvgElement).join("");
  if (!inner) return markup;

  const open = findOpenTag(markup);
  if (!open) return markup;

  if (open.selfClosing) {
    const opened = `${open.text.slice(0, -2).trimEnd()}>`;
    return (
      markup.slice(0, open.index) +
      opened +
      inner +
      `</${open.name}>` +
      markup.slice(open.index + open.text.length)
    );
  }

  const close = new RegExp(`</${escapeRegExp(open.name)}\\s*>\\s*$`, "i").exec(markup);
  if (!close) return markup + inner;
  return markup.slice(0, close.index) + inner + markup.slice(close.index);
}

function composeSvgElement(node: DesignNode): string {
  if (node.visible === false) return "";

  // Content with no recognisable tag is passed through rather than dropped —
  // losing artwork is worse than composing markup we could not annotate.
  const open = findOpenTag(node.content);
  if (!open) return node.content;

  // The node id rides on the element itself so the viewport's existing
  // `data-node-id` hit test resolves a click on a path to that path's node.
  let tag = withTagAttribute(open.text, "data-node-id", node.id);
  for (const key of SVG_PAINT_KEYS) {
    const value = node.styles[key];
    tag = withTagAttribute(
      tag,
      SVG_PAINT_ATTRIBUTES[key],
      value === undefined ? null : String(value),
    );
  }

  const markup =
    node.content.slice(0, open.index) + tag + node.content.slice(open.index + open.text.length);
  return node.children.length > 0 ? insertSvgChildren(markup, node.children) : markup;
}

/**
 * Make an SVG's root element fill the node box it is rendered into.
 *
 * The renderer injects composed markup inside a div sized from the node model,
 * and that div clips its overflow. Authored markup almost always carries fixed
 * `width`/`height` attributes, so the artwork keeps its intrinsic size no
 * matter how large or small the node is: resize a node down and the icon is
 * cut off, resize it up and the icon sits in the corner of an empty box.
 *
 * Swapping the root's `width`/`height` for `100%` makes the artwork scale with
 * the node instead. That requires a `viewBox` to scale against, so one is
 * synthesised from the authored dimensions when the markup omits it.
 * `preserveAspectRatio` is left alone — its default already scales without
 * distorting, and an author who set it meant it.
 *
 * Applied at render time rather than in `composeSvgMarkup` so the decompose /
 * compose round trip stays byte-exact. Only sizing is rewritten here: how the
 * root lays out (an inline replaced element would sit on a text baseline) is
 * the renderer's wrapper's job, so authored `style` is never touched.
 */
export function normalizeSvgRootForDisplay(markup: string): string {
  const openTag = findOpenTag(markup);
  if (!openTag || openTag.name.toLowerCase() !== "svg") return markup;

  const attributes = scanTagAttributes(openTag.text);
  const read = (name: string) => {
    const attribute = attributes.find((candidate) => candidate.name.toLowerCase() === name);
    if (!attribute) return undefined;
    const span = openTag.text.slice(attribute.start, attribute.end);
    const separator = span.indexOf("=");
    if (separator < 0) return "";
    return span
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])([\s\S]*)\1$/, "$2");
  };

  let tag = openTag.text;

  if (read("viewbox") === undefined) {
    const width = parseSvgLength(read("width"));
    const height = parseSvgLength(read("height"));
    // Without any intrinsic size there is nothing to build a viewBox from, so
    // leave the markup exactly as authored rather than inventing a coordinate
    // system and scaling the artwork wrongly.
    if (width === null || height === null) return markup;
    tag = withTagAttribute(tag, "viewBox", `0 0 ${width} ${height}`);
  }

  tag = withTagAttribute(tag, "width", "100%");
  tag = withTagAttribute(tag, "height", "100%");

  return markup.slice(0, openTag.index) + tag + markup.slice(openTag.index + openTag.text.length);
}

/** A plain SVG length attribute in user units, or null when it is not one. */
function parseSvgLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^\s*(-?\d*\.?\d+)(px)?\s*$/i.exec(value);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]!);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
