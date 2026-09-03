export interface HtmlParseContext {
  flattenedPositionElements: WeakSet<Element>;
  /**
   * Strict ancestors of elements carrying an authored node id. Building this
   * once keeps identity preservation linear in the number of imported nodes.
   */
  identityBearingAncestors: WeakSet<Element>;
}

export function createHtmlParseContext(): HtmlParseContext {
  return {
    flattenedPositionElements: new WeakSet(),
    identityBearingAncestors: new WeakSet(),
  };
}
