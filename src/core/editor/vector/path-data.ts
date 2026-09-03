/**
 * SVG path data <-> anchor model.
 *
 * Leaf stores a `path` node's geometry as the raw `d` string in `node.content`,
 * so an agent writing `d` through MCP and a designer dragging anchors on canvas
 * are editing the same value. This module is the only place that translates
 * between the two representations.
 *
 * Scope is a single subpath of M/L/C/Z, matching what the pen tool authors.
 * `H`/`V` normalize to line segments and `S`/`Q`/`T` convert to their exact
 * cubic equivalent, so those parse but re-format as `L`/`C`. Anything the model
 * cannot hold losslessly — arcs, or a second `M` — parses as `null` rather than
 * silently dropping geometry, which lets callers leave the string untouched.
 */

export interface VectorPoint {
  x: number;
  y: number;
}

export interface VectorAnchor {
  x: number;
  y: number;
  /** Absolute control point governing the curve arriving at this anchor. */
  inHandle?: VectorPoint;
  /** Absolute control point governing the curve leaving this anchor. */
  outHandle?: VectorPoint;
}

export interface VectorPath {
  anchors: VectorAnchor[];
  closed: boolean;
}

/** Distance under which a closing anchor is treated as the start anchor. */
const COINCIDENT_EPSILON = 1e-6;

const TOKEN_PATTERN = /[MmLlHhVvCcSsQqTtZzAa]|-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

type Token = string | number;

/**
 * Split `d` into command letters and numbers.
 *
 * Returns null when anything other than whitespace or commas sits between two
 * tokens: a `d` we cannot fully account for must not round-trip, because
 * re-formatting would drop the part we failed to read.
 */
function tokenize(d: string): Token[] | null {
  const tokens: Token[] = [];
  let consumed = 0;
  TOKEN_PATTERN.lastIndex = 0;
  let match = TOKEN_PATTERN.exec(d);
  while (match !== null) {
    if (/[^\s,]/.test(d.slice(consumed, match.index))) return null;
    consumed = match.index + match[0].length;
    const raw = match[0];
    if (/[A-Za-z]/.test(raw)) {
      tokens.push(raw);
    } else {
      const value = Number(raw);
      if (!Number.isFinite(value)) return null;
      tokens.push(value);
    }
    match = TOKEN_PATTERN.exec(d);
  }
  if (/[^\s,]/.test(d.slice(consumed))) return null;
  return tokens;
}

/**
 * Whether `d` is well-formed enough for the browser to paint something.
 *
 * Weaker than `parsePathData`, which also rejects geometry the anchor model
 * cannot *hold* (arcs, several subpaths) even though SVG draws it fine. This
 * separates "Leaf cannot edit these anchors" from "this string is not path
 * data at all", so the renderer can draw the first and flag the second instead
 * of leaving an invisible, unfindable node on the canvas.
 */
export function isDrawablePathData(d: string): boolean {
  const tokens = tokenize(d);
  if (!tokens || tokens.length === 0) return false;
  return tokens[0] === "M" || tokens[0] === "m";
}

function pointsCoincide(a: VectorPoint, b: VectorPoint): boolean {
  return Math.abs(a.x - b.x) <= COINCIDENT_EPSILON && Math.abs(a.y - b.y) <= COINCIDENT_EPSILON;
}

/** Reflect `control` through `origin` — the implicit control point of S/T. */
function reflect(origin: VectorPoint, control: VectorPoint): VectorPoint {
  return { x: origin.x * 2 - control.x, y: origin.y * 2 - control.y };
}

/** Exact quadratic-to-cubic control points; the curve is unchanged. */
function quadraticControls(
  from: VectorPoint,
  control: VectorPoint,
  to: VectorPoint,
): [VectorPoint, VectorPoint] {
  return [
    { x: from.x + ((control.x - from.x) * 2) / 3, y: from.y + ((control.y - from.y) * 2) / 3 },
    { x: to.x + ((control.x - to.x) * 2) / 3, y: to.y + ((control.y - to.y) * 2) / 3 },
  ];
}

export function parsePathData(d: string): VectorPath | null {
  const tokens = tokenize(d);
  if (!tokens || tokens.length === 0) return null;
  if (tokens[0] !== "M" && tokens[0] !== "m") return null;

  const anchors: VectorAnchor[] = [];
  let closed = false;
  let index = 0;
  let command = "";
  let previousCurve: "cubic" | "quadratic" | null = null;
  let lastControl: VectorPoint | null = null;
  let current: VectorPoint = { x: 0, y: 0 };

  const readNumbers = (count: number): number[] | null => {
    const values: number[] = [];
    for (let step = 0; step < count; step++) {
      const token = tokens[index];
      if (typeof token !== "number") return null;
      values.push(token);
      index += 1;
    }
    return values;
  };

  const lastAnchor = (): VectorAnchor | null => anchors[anchors.length - 1] ?? null;

  while (index < tokens.length) {
    const token = tokens[index];
    if (typeof token === "string") {
      command = token;
      index += 1;
    } else if (command === "") {
      return null;
    }

    // A subpath that has already closed cannot continue: the model holds one.
    if (closed) return null;

    const relative = command === command.toLowerCase();
    const dx = relative ? current.x : 0;
    const dy = relative ? current.y : 0;

    switch (command.toUpperCase()) {
      case "M": {
        const values = readNumbers(2);
        if (!values) return null;
        if (anchors.length > 0) return null;
        current = { x: values[0]! + dx, y: values[1]! + dy };
        anchors.push({ x: current.x, y: current.y });
        // Extra coordinate pairs after a moveto are implicit linetos.
        command = relative ? "l" : "L";
        previousCurve = null;
        lastControl = null;
        break;
      }
      case "L": {
        const values = readNumbers(2);
        if (!values) return null;
        current = { x: values[0]! + dx, y: values[1]! + dy };
        anchors.push({ x: current.x, y: current.y });
        previousCurve = null;
        lastControl = null;
        break;
      }
      case "H": {
        const values = readNumbers(1);
        if (!values) return null;
        current = { x: values[0]! + dx, y: current.y };
        anchors.push({ x: current.x, y: current.y });
        previousCurve = null;
        lastControl = null;
        break;
      }
      case "V": {
        const values = readNumbers(1);
        if (!values) return null;
        current = { x: current.x, y: values[0]! + dy };
        anchors.push({ x: current.x, y: current.y });
        previousCurve = null;
        lastControl = null;
        break;
      }
      case "C": {
        const values = readNumbers(6);
        if (!values) return null;
        const previous = lastAnchor();
        if (!previous) return null;
        const control1 = { x: values[0]! + dx, y: values[1]! + dy };
        const control2 = { x: values[2]! + dx, y: values[3]! + dy };
        current = { x: values[4]! + dx, y: values[5]! + dy };
        previous.outHandle = control1;
        anchors.push({ x: current.x, y: current.y, inHandle: control2 });
        previousCurve = "cubic";
        lastControl = control2;
        break;
      }
      case "S": {
        const values = readNumbers(4);
        if (!values) return null;
        const previous = lastAnchor();
        if (!previous) return null;
        const control1 =
          previousCurve === "cubic" && lastControl ? reflect(current, lastControl) : { ...current };
        const control2 = { x: values[0]! + dx, y: values[1]! + dy };
        current = { x: values[2]! + dx, y: values[3]! + dy };
        previous.outHandle = control1;
        anchors.push({ x: current.x, y: current.y, inHandle: control2 });
        previousCurve = "cubic";
        lastControl = control2;
        break;
      }
      case "Q":
      case "T": {
        const isSmooth = command.toUpperCase() === "T";
        const values = readNumbers(isSmooth ? 2 : 4);
        if (!values) return null;
        const previous = lastAnchor();
        if (!previous) return null;
        const control: VectorPoint = isSmooth
          ? previousCurve === "quadratic" && lastControl
            ? reflect(current, lastControl)
            : { ...current }
          : { x: values[0]! + dx, y: values[1]! + dy };
        const end = isSmooth
          ? { x: values[0]! + dx, y: values[1]! + dy }
          : { x: values[2]! + dx, y: values[3]! + dy };
        const [control1, control2] = quadraticControls(current, control, end);
        previous.outHandle = control1;
        anchors.push({ x: end.x, y: end.y, inHandle: control2 });
        current = end;
        previousCurve = "quadratic";
        lastControl = control;
        break;
      }
      case "Z": {
        closed = true;
        previousCurve = null;
        lastControl = null;
        break;
      }
      default:
        // Arcs carry radii and flags the anchor model cannot hold.
        return null;
    }
  }

  if (anchors.length === 0) return null;

  // An explicitly drawn closing segment lands a duplicate anchor on the start
  // point. Fold it back into the start anchor so the model has one anchor per
  // corner and `closed` alone describes the join.
  if (closed && anchors.length > 1) {
    const first = anchors[0]!;
    const last = anchors[anchors.length - 1]!;
    if (pointsCoincide(first, last)) {
      if (last.inHandle) first.inHandle = last.inHandle;
      anchors.pop();
    }
  }

  return { anchors, closed };
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function formatSegment(from: VectorAnchor, to: VectorAnchor): string {
  if (!from.outHandle && !to.inHandle) {
    return `L ${formatNumber(to.x)} ${formatNumber(to.y)}`;
  }
  const control1 = from.outHandle ?? { x: from.x, y: from.y };
  const control2 = to.inHandle ?? { x: to.x, y: to.y };
  return (
    `C ${formatNumber(control1.x)} ${formatNumber(control1.y)} ` +
    `${formatNumber(control2.x)} ${formatNumber(control2.y)} ` +
    `${formatNumber(to.x)} ${formatNumber(to.y)}`
  );
}

export function formatPathData(path: VectorPath): string {
  const { anchors, closed } = path;
  const first = anchors[0];
  if (!first) return "";

  const parts = [`M ${formatNumber(first.x)} ${formatNumber(first.y)}`];
  for (let index = 1; index < anchors.length; index++) {
    parts.push(formatSegment(anchors[index - 1]!, anchors[index]!));
  }

  if (closed) {
    const last = anchors[anchors.length - 1]!;
    // `Z` already draws a straight closing segment; only a curved one needs
    // spelling out, and writing it keeps the handles through a round trip.
    if (anchors.length > 1 && (last.outHandle || first.inHandle)) {
      parts.push(formatSegment(last, first));
    }
    parts.push("Z");
  }

  return parts.join(" ");
}

/** True when the anchor's handles are collinear and opposite about the point. */
export function isSmoothAnchor(anchor: VectorAnchor): boolean {
  const { inHandle, outHandle } = anchor;
  if (!inHandle || !outHandle) return false;
  const inX = anchor.x - inHandle.x;
  const inY = anchor.y - inHandle.y;
  const outX = outHandle.x - anchor.x;
  const outY = outHandle.y - anchor.y;
  const cross = inX * outY - inY * outX;
  const dot = inX * outX + inY * outY;
  const scale = Math.hypot(inX, inY) * Math.hypot(outX, outY);
  if (scale === 0) return false;
  return Math.abs(cross) / scale < 1e-4 && dot > 0;
}

export function clonePath(path: VectorPath): VectorPath {
  return {
    closed: path.closed,
    anchors: path.anchors.map((anchor) => ({
      x: anchor.x,
      y: anchor.y,
      ...(anchor.inHandle ? { inHandle: { ...anchor.inHandle } } : {}),
      ...(anchor.outHandle ? { outHandle: { ...anchor.outHandle } } : {}),
    })),
  };
}
