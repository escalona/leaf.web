import { observer } from "mobx-react-lite";
import { PenIcon } from "../../icons";
import { setPathClosed } from "../../../core/editor/vector/edit-ops";
import { refitPathToNode } from "../../../core/editor/vector/geometry";
import { formatPathData } from "../../../core/editor/vector/path-data";
import { getPathGeometry, resolvePathPaint } from "../../../core/editor/vector/path-node";
import { vectorEdit } from "../../../core/editor/vector/vector-edit-session";
import { useEditorStore } from "../../../core/state/EditorStore";
import {
  ColorField,
  MixedNumberInput,
  MixedSelect,
  PropertyRow,
  SegmentedControl,
  Section,
  Textarea,
} from "../PropertyControls";
import { aggregate, isMixed } from "../selection-properties";
import { FONT_STACK } from "../../floating-styles";
import { everyType, type SectionProps } from "./types";

function Label({ children }: { children: string }) {
  return (
    <div
      style={{
        width: 46,
        flexShrink: 0,
        fontSize: 10,
        color: "var(--leaf-text-muted)",
        fontFamily: FONT_STACK,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Vector path geometry and paint.
 *
 * The `d` string is exposed raw because it is the node's real geometry: a path
 * an agent wrote through MCP has to be editable here, and every control in this
 * section reads back through the same parse the canvas renders from.
 *
 * Fill and stroke live here rather than in `FillSection`/`BorderSection` —
 * those gate on box-like nodes, and a path paints an outline, not a box.
 */
export const PathSection = observer(({ props }: SectionProps) => {
  const { nodes, primary, isMultiple, style, setStyles, buffered } = props;
  const store = useEditorStore();
  if (!everyType(nodes, "path")) return null;

  const geometry = getPathGeometry(primary.content);
  const isEditing = vectorEdit.isEditing(primary.id);

  const fill = style("fill") ?? style("backgroundColor") ?? primary.backgroundColor;
  const stroke = style("stroke") ?? style("borderColor") ?? primary.borderColor;
  // Read the width the canvas actually paints rather than the raw style, so the
  // field agrees with the artwork when a stroke colour was set without a width
  // and `resolvePathPaint` supplies SVG's default of 1.
  const strokeWidth = aggregate(nodes, (node) => resolvePathPaint(node).strokeWidth);

  const setClosed = (closed: boolean) => {
    if (!geometry) return;
    const next = setPathClosed(geometry.path, closed);
    const refit = refitPathToNode(next, primary, geometry.bounds);
    if (!refit) return;
    store.runtime.updateNode(primary.id, {
      content: formatPathData(refit.path),
      x: refit.x,
      y: refit.y,
      width: refit.width,
      height: refit.height,
    });
  };

  return (
    <Section title="Path">
      <PropertyRow>
        <Label>Fill</Label>
        <div data-property="pathFill" style={{ flex: 1, minWidth: 0 }}>
          <ColorField
            value={fill}
            onChange={(next) => setStyles({ fill: next, backgroundColor: null })}
            {...buffered}
          />
        </div>
      </PropertyRow>
      <PropertyRow>
        <Label>Stroke</Label>
        <div data-property="pathStroke" style={{ flex: 1, minWidth: 0 }}>
          <ColorField
            value={stroke}
            onChange={(next) => setStyles({ stroke: next, borderColor: null })}
            {...buffered}
          />
        </div>
        <div data-property="pathStrokeWidth" style={{ width: 62, flexShrink: 0 }}>
          <MixedNumberInput
            affordance="W"
            value={
              isMixed(strokeWidth)
                ? strokeWidth
                : Number.isFinite(strokeWidth)
                  ? strokeWidth
                  : undefined
            }
            min={0}
            step={0.5}
            onChange={(next) => setStyles({ strokeWidth: next, borderWidth: null })}
            {...buffered}
          />
        </div>
      </PropertyRow>

      <PropertyRow>
        <Label>Rule</Label>
        <div data-property="fillRule" style={{ flex: 1, minWidth: 0 }}>
          <MixedSelect
            value={style("fillRule") ?? "nonzero"}
            options={[
              { value: "nonzero", label: "Non-zero" },
              { value: "evenodd", label: "Even-odd" },
            ]}
            onChange={(next) => setStyles({ fillRule: next === "nonzero" ? null : next })}
          />
        </div>
      </PropertyRow>

      {isMultiple ? (
        <div style={{ fontSize: 10, color: "var(--leaf-text-faint)", fontFamily: FONT_STACK }}>
          Select a single path to edit its geometry
        </div>
      ) : (
        <>
          <PropertyRow>
            <div data-property="pathClosed" style={{ flex: 1, minWidth: 0 }}>
              <SegmentedControl
                value={geometry?.path.closed ? "closed" : "open"}
                options={[
                  { value: "open", label: "Open" },
                  { value: "closed", label: "Closed" },
                ]}
                onChange={(next) => setClosed(next === "closed")}
              />
            </div>
          </PropertyRow>

          <button
            type="button"
            data-property="editPath"
            onClick={() => (isEditing ? vectorEdit.exit() : vectorEdit.enter(primary.id))}
            disabled={!geometry}
            title={
              geometry
                ? "Show anchors and handles on canvas"
                : "This path uses commands Leaf cannot edit as anchors yet"
            }
            style={{
              width: "100%",
              height: 26,
              marginBottom: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              border: "1px solid #ececec",
              borderRadius: 6,
              backgroundColor: isEditing ? "var(--leaf-surface-app)" : "transparent",
              color: geometry ? "var(--leaf-text-muted)" : "#c4c4c8",
              fontSize: 11,
              fontFamily: FONT_STACK,
            }}
          >
            <PenIcon size={12} />
            {isEditing ? "Done editing" : "Edit anchors"}
          </button>

          <div data-property="pathData">
            <Textarea
              value={primary.content}
              onChange={(next) => store.runtime.updateNode(primary.id, { content: next })}
              minHeight={90}
              monospace
              {...buffered}
            />
          </div>
        </>
      )}
    </Section>
  );
});
