/**
 * Leaf markup — the internal rich-text-lite library.
 *
 * Everything outside this directory imports from here and nowhere deeper.
 * The library knows nothing about the editor, comments, or collaboration:
 * it turns plain strings into tokens (`tokenize.ts`) and tokens into React
 * elements (`MarkupText.tsx`). Callers own name resolution and storage.
 */
export { mentionMarkup, parseMarkup, type MarkupToken } from "./tokenize";
export { MarkupText } from "./MarkupText";
