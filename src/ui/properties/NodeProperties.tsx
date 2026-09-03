import { observer } from "mobx-react-lite";
import type { DesignNode } from "../../core/types";
import { FONT_STACK } from "../floating-styles";
import { useSelectionProperties } from "./useSelectionProperties";
import { ActionsSection } from "./sections/ActionsSection";
import { BlendingSection } from "./sections/BlendingSection";
import { BorderSection } from "./sections/BorderSection";
import { ClipContentSection } from "./sections/ClipContentSection";
import { CornerRadiusSection } from "./sections/CornerRadiusSection";
import { EffectsSection } from "./sections/EffectsSection";
import { ExportSection } from "./sections/ExportSection";
import { FillSection } from "./sections/FillSection";
import { ImageSection } from "./sections/ImageSection";
import { LayoutSection } from "./sections/LayoutSection";
import { NameSection } from "./sections/NameSection";
import { OtherStylesSection } from "./sections/OtherStylesSection";
import { OutlineSection } from "./sections/OutlineSection";
import { PathSection } from "./sections/PathSection";
import { ShaderSection } from "./sections/ShaderSection";
import { SvgFillStrokeSection } from "./sections/SvgFillStrokeSection";
import { SvgSection } from "./sections/SvgSection";
import { TextContentSection } from "./sections/TextContentSection";
import { TypographySection } from "./sections/TypographySection";

/**
 * Ordered inspector sections.
 *
 * Panel order is layout → geometry → blending → paint → text →
 * stroke → effects → leftovers → export, the order designers expect.
 * Each section self-gates on the selection, so adding one is a single line here.
 *
 * Export sits last among the titled sections because it acts on the selection
 * as a whole rather than styling it; `ActionsSection` stays below it as the
 * untitled destructive footer.
 */
const SECTIONS = [
  NameSection,
  LayoutSection,
  CornerRadiusSection,
  ClipContentSection,
  BlendingSection,
  FillSection,
  ImageSection,
  TypographySection,
  TextContentSection,
  BorderSection,
  OutlineSection,
  EffectsSection,
  SvgSection,
  SvgFillStrokeSection,
  PathSection,
  ShaderSection,
  OtherStylesSection,
  ExportSection,
  ActionsSection,
] as const;

/**
 * The design inspector.
 *
 * Takes the whole selection rather than a single node: every control reads
 * through `useSelectionProperties`, so multi-node editing and mixed-value
 * display come for free instead of being retrofitted per control.
 */
export const NodeProperties = observer(({ nodes }: { nodes: DesignNode[] }) => {
  const props = useSelectionProperties(nodes);
  if (nodes.length === 0) return null;

  return (
    <div className="properties-panel" style={{ fontFamily: FONT_STACK }}>
      {SECTIONS.map((SectionComponent, index) => (
        <SectionComponent key={index} props={props} />
      ))}
    </div>
  );
});
