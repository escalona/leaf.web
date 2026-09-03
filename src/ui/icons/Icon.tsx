import type { ReactElement, SVGProps } from "react";
import { GLYPHS, type IconName } from "./glyphs.generated";

/**
 * The two sizes Leaf renders icons at. 12 for panels, rows, fields, menus and tabs; 16 for the
 * toolbar, the selection overlay, the files dashboard and empty states. Weight never changes with
 * state, so there is no strokeWidth prop: each master carries its own stroke.
 */
export type IconSize = 12 | 16;

export type IconProps = Omit<
  SVGProps<SVGSVGElement>,
  "width" | "height" | "strokeWidth" | "children" | "viewBox" | "dangerouslySetInnerHTML" | "name"
> & {
  size?: IconSize;
  /** Draw the filled twin when the glyph has one (an object state, never the active tool). */
  filled?: boolean;
};

export interface IconComponent {
  (props: IconProps): ReactElement;
  displayName?: string;
}

function pickMaster(name: IconName, size: IconSize, filled: boolean) {
  const glyph = GLYPHS[name];
  if (size === 12 && "12" in glyph && glyph[12]) return glyph[12];
  if (filled && "filled16" in glyph && glyph.filled16) return glyph.filled16;
  return glyph[16];
}

/**
 * Renders one glyph from the Leaf icon set. Masters are static generated markup, so the inner
 * SVG is injected as a string; no user content ever reaches it.
 */
export function Icon({
  name,
  size = 12,
  filled = false,
  ...props
}: IconProps & { name: IconName }) {
  const master = pickMaster(name, size, filled);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${master.grid} ${master.grid}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={master.stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      dangerouslySetInnerHTML={{ __html: master.body }}
      {...props}
    />
  );
}

export function createIcon(name: IconName): IconComponent {
  const Component: IconComponent = (props) => <Icon {...props} name={name} />;
  Component.displayName = `Icon(${name})`;
  return Component;
}
