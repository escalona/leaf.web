import { CURSORS, CURSOR_HALO, type CursorName } from "./cursors.generated";

export interface CursorOptions {
  /** Ink colour of the silhouette. Presence pointers pass the peer colour. */
  fill?: string;
  halo?: string;
  /** Rendered size in CSS pixels; defaults to the grid so 1 unit is 1px. */
  size?: number;
  /** Rotation in degrees around the image centre, for the rotate handles. */
  rotate?: number;
}

/** The body markup translated so its hotspot sits at the origin, for inline SVG use. */
export function cursorBodyAtOrigin(name: CursorName): { body: string; halo: number } {
  const cursor = CURSORS[name];
  const [hx, hy] = cursor.hotspot;
  return {
    body: `<g transform="translate(${-hx} ${-hy})">${cursor.body}</g>`,
    halo: cursor.kind === "fill" ? CURSOR_HALO * 2 : cursor.stroke! + CURSOR_HALO * 2,
  };
}

export function cursorSvg(
  name: CursorName,
  { fill = "#18181b", halo = "#ffffff", size, rotate = 0 }: CursorOptions = {},
): string {
  const cursor = CURSORS[name];
  const px = size ?? cursor.grid;
  const centre = cursor.grid / 2;
  const open = rotate ? `<g transform="rotate(${rotate} ${centre} ${centre})">` : "<g>";
  const haloLayer =
    cursor.kind === "fill"
      ? `<g fill="${halo}" stroke="${halo}" stroke-width="${CURSOR_HALO * 2}" stroke-linejoin="round">${cursor.body}</g>`
      : `<g fill="none" stroke="${halo}" stroke-width="${cursor.stroke! + CURSOR_HALO * 2}" stroke-linecap="round" stroke-linejoin="round">${cursor.body}</g>`;
  const inkLayer =
    cursor.kind === "fill"
      ? `<g fill="${fill}">${cursor.body}</g>`
      : `<g fill="none" stroke="${fill}" stroke-width="${cursor.stroke}" stroke-linecap="round" stroke-linejoin="round">${cursor.body}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${cursor.grid} ${cursor.grid}">${open}${haloLayer}${inkLayer}</g></svg>`;
}

/** A CSS `cursor` value with the hotspot baked in and a keyword fallback. */
export function cursorCss(
  name: CursorName,
  options: CursorOptions = {},
  fallback = "auto",
): string {
  const [hx, hy] = CURSORS[name].hotspot;
  return `url("data:image/svg+xml,${encodeURIComponent(cursorSvg(name, options))}") ${hx} ${hy}, ${fallback}`;
}

export { CURSORS, CURSOR_HALO };
export type { CursorName };
