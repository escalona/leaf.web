/**
 * Pasting and dropping foreign content — HTML, SVG markup, and plain text —
 * onto the canvas.
 *
 * Everything routes through the HTML importer so a pasted snippet lands as the
 * same node tree `write_html` would produce. Insertion goes through the paste
 * pipeline (`preparePasteNodes` / `commitPreparedPaste`), which regenerates IDs
 * so pasting the same markup twice cannot collide.
 */
import { runInAction } from "mobx";
import { designNodeToPersistedNode } from "../../state/document";
import type { EditorStore } from "../../state/EditorStore";
import type { DesignNode, Point, Rect } from "../../types";
import { parseHtmlToNodes } from "../import/html-parser";

export type PastedContent = { kind: "markup"; markup: string } | { kind: "text"; text: string };

export interface ClipboardTextFlavors {
  html?: string | null;
  text?: string | null;
}

export interface ContentPastePlacement {
  /** Canvas-space point the content is centred on when it lands at page root. */
  canvasPoint: Point;
}

/** Stair step between repeated pastes of the same content, matching node paste. */
export const REPEATED_CONTENT_PASTE_STEP = 20;

type ContentPasteStair = { key: string; count: number };

// Session-local per store: a repeated paste of the same payload steps down
// and right like the node clipboard does, so copies never stack invisibly.
const contentPasteStairByStore = new WeakMap<EditorStore, ContentPasteStair>();

function contentPasteKey(content: PastedContent): string {
  return content.kind === "markup" ? `markup:${content.markup}` : `text:${content.text}`;
}

/**
 * Number of earlier consecutive pastes of this same content into the store.
 * Advances the counter; a different payload resets the stair.
 */
function advanceContentPasteStair(store: EditorStore, content: PastedContent): number {
  const key = contentPasteKey(content);
  const previous = contentPasteStairByStore.get(store);
  const count = previous?.key === key ? previous.count + 1 : 0;
  contentPasteStairByStore.set(store, { key, count });
  return count;
}

const OPENING_TAG_PATTERN = /^<([a-zA-Z][\w:-]*)(\s[^>]*)?\/?>/;
const PREAMBLE_PATTERN = /^\s*(?:<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!doctype[^>]*>)\s*/i;

/** Elements whose boundaries become line breaks when flattening rich HTML. */
const BLOCK_LEVEL_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DL",
  "DD",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
]);

function stripMarkupPreamble(value: string): string {
  let current = value.trimStart();
  let previous: string;
  do {
    previous = current;
    current = current.replace(PREAMBLE_PATTERN, "").trimStart();
  } while (current !== previous);
  return current;
}

/**
 * Whether a plain-text payload is source markup rather than prose.
 *
 * Requires both an opening tag at the start and a close (or self-close)
 * somewhere, so a sentence beginning with `<3` or `<- see below` stays text.
 */
export function looksLikeMarkup(value: string): boolean {
  const trimmed = stripMarkupPreamble(value);
  if (!OPENING_TAG_PATTERN.test(trimmed)) return false;
  return /<\/[a-zA-Z][\w:-]*\s*>|\/>/.test(trimmed);
}

export function looksLikeSvgMarkup(value: string): boolean {
  return /^<svg[\s>]/i.test(stripMarkupPreamble(value));
}

/**
 * Collapse rich HTML into newline-preserving plain text.
 *
 * Copying from a browser puts class-based markup on the clipboard, and Leaf's
 * importer only reads inline `style` attributes — so importing it would produce
 * an unstyled skeleton, so text is the honest result.
 *
 * Only an authored `<br>` can open a blank line; block boundaries merely end
 * the current one, so nested containers do not fan out into vertical gaps.
 */
export function flattenHtmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines: string[] = [""];
  const hardBreak = () => lines.push("");
  const softBreak = () => {
    if (lines[lines.length - 1]!.trim() !== "") lines.push("");
  };

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      lines[lines.length - 1] += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as Element;
    const tag = element.tagName.toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "HEAD") return;
    if (tag === "BR") {
      hardBreak();
      return;
    }

    const isBlock = BLOCK_LEVEL_TAGS.has(tag);
    if (isBlock) softBreak();
    for (const child of Array.from(element.childNodes)) visit(child);
    if (isBlock) softBreak();
  };

  visit(doc.body);
  return lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Decide what a clipboard or drop payload should become.
 *
 * Markup arriving as `text/plain` is source a user copied from an editor, so it
 * imports as nodes. `text/html` is a rendered fragment, so it flattens to text.
 */
export function classifyPastedContent(flavors: ClipboardTextFlavors): PastedContent | null {
  const text = flavors.text ?? "";
  const html = flavors.html ?? "";

  if (text.trim() && looksLikeMarkup(text)) {
    return { kind: "markup", markup: text.trim() };
  }
  if (text.trim()) return { kind: "text", text };
  if (html.trim()) {
    const flattened = flattenHtmlToText(html);
    if (flattened) return { kind: "text", text: flattened };
  }
  return null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Wrap plain text in a measurable element so the importer produces a text node
 * whose size matches how the canvas will actually render it.
 *
 * `pre-wrap` mirrors the renderer's default for text nodes, and the max width
 * keeps a pasted paragraph from measuring as one enormous line.
 */
export function buildTextNodeMarkup(text: string): string {
  const escaped = escapeHtml(text).split("\n").join("<br>");
  return (
    '<div style="font-family:Inter, system-ui, sans-serif;font-size:16px;color:#000000;' +
    `line-height:1.4;white-space:pre-wrap;max-width:640px">${escaped}</div>`
  );
}

function getNodesBounds(nodes: readonly DesignNode[]): Rect | null {
  if (nodes.length === 0) return null;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + node.width);
    bottom = Math.max(bottom, node.y + node.height);
  }
  return Number.isFinite(left)
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

/**
 * The frame pasted content should land inside, if any.
 *
 * Deliberately narrower than the node clipboard's target search: content paste
 * only nests when the user has clearly pointed at one container, because a
 * mis-targeted HTML import is far more disruptive than a mis-placed duplicate.
 */
export function resolveContentPasteParent(store: EditorStore): DesignNode | null {
  if (store.enteredContainerId) {
    const entered = store.getNode(store.enteredContainerId);
    if (entered?.type === "frame") return entered;
  }
  const selected = store.selectedNodes;
  if (selected.length !== 1) return null;
  return selected[0]!.type === "frame" ? selected[0]! : null;
}

/**
 * Import content into the document and select what it created.
 *
 * Returns the created root nodes, or an empty array when the payload parsed to
 * nothing (an HTML comment, an empty fragment).
 */
export function insertPastedContent(
  store: EditorStore,
  content: PastedContent,
  placement: ContentPastePlacement,
): DesignNode[] {
  const markup = content.kind === "markup" ? content.markup : buildTextNodeMarkup(content.text);
  const parent = resolveContentPasteParent(store);
  const contextElement = parent ? (store.domIndex.getElement(parent) ?? null) : null;

  const parsed = parseHtmlToNodes(markup, { contextElement });
  if (parsed.length === 0) return [];

  // Inside a parent the importer has already reconciled positions against the
  // real container, so only root-level content gets centred on the drop point
  // (and stair-stepped when the same payload is pasted again).
  const bounds = parent ? null : getNodesBounds(parsed);
  const stairStep = advanceContentPasteStair(store, content) * REPEATED_CONTENT_PASTE_STEP;
  const offset = bounds
    ? {
        x: placement.canvasPoint.x - (bounds.x + bounds.width / 2) + stairStep,
        y: placement.canvasPoint.y - (bounds.y + bounds.height / 2) + stairStep,
      }
    : undefined;

  const prepared = store.runtime.preparePasteNodes(
    parsed.map((node) => ({
      node: designNodeToPersistedNode(node),
      ...(parent ? { parentId: parent.id } : {}),
      ...(offset ? { offset } : {}),
    })),
  );

  return runInAction(() => {
    const results = store.runtime.commitPreparedPaste(prepared);
    store.setSelectedIds(results.map(({ newId }) => newId));
    store.setTool("select");
    return prepared.map(({ node }) => node);
  });
}
