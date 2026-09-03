export function isFlexLayoutDisplay(display: unknown) {
  return display === "flex" || display === "inline-flex";
}

export function isGridLayoutDisplay(display: unknown) {
  return display === "grid" || display === "inline-grid";
}

export function isFlowLayoutDisplay(display: unknown) {
  return isFlexLayoutDisplay(display) || isGridLayoutDisplay(display);
}
