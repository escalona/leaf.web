import { observer } from "mobx-react-lite";
import type { CSSProperties } from "react";
import {
  AlignBottomIcon,
  AlignHCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignTopIcon,
  AlignVCenterIcon,
  DistributeHIcon,
  DistributeVIcon,
  type IconComponent,
} from "../icons";
import type { AlignEdge, DistributeAxis } from "../../core/editor/interaction/math";
import {
  alignSelection,
  distributeSelection,
  getTransformableSelectedIds,
  type TransformHud,
} from "../viewport/interaction-helpers";
import { FLOAT_SHADOW, FONT_STACK } from "../floating-styles";
import { useEditorStore } from "../../core/state/EditorStore";

/** Live W × H / angle readout anchored under the transformed box. */
export function TransformHudBadge({ hud, zoom }: { hud: TransformHud; zoom: number }) {
  const height = 20 / zoom;
  const width = Math.max(52 / zoom, (hud.text.length * 7 + 16) / zoom);
  const centerX = hud.rect.x + hud.rect.width / 2;
  const centerY = hud.rect.y + hud.rect.height / 2;
  const x = centerX - width / 2;
  const y = hud.rect.y + hud.rect.height + 8 / zoom;

  return (
    <g
      data-transform-hud={hud.text}
      pointerEvents="none"
      transform={hud.rotation ? `rotate(${hud.rotation} ${centerX} ${centerY})` : undefined}
    >
      <rect x={x} y={y} width={width} height={height} rx={height / 2} fill="#1E90FF" />
      <text
        x={centerX}
        y={y + height / 2}
        fill="#ffffff"
        style={{ fontFamily: FONT_STACK }}
        fontSize={11 / zoom}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {hud.text}
      </text>
    </g>
  );
}

const ALIGN_ACTIONS: Array<{ edge: AlignEdge; label: string; Icon: IconComponent }> = [
  { edge: "left", label: "Align left", Icon: AlignLeftIcon },
  { edge: "horizontal-center", label: "Align horizontal centers", Icon: AlignHCenterIcon },
  { edge: "right", label: "Align right", Icon: AlignRightIcon },
  { edge: "top", label: "Align top", Icon: AlignTopIcon },
  { edge: "vertical-center", label: "Align vertical centers", Icon: AlignVCenterIcon },
  { edge: "bottom", label: "Align bottom", Icon: AlignBottomIcon },
];

const DISTRIBUTE_ACTIONS: Array<{ axis: DistributeAxis; label: string; Icon: IconComponent }> = [
  {
    axis: "horizontal",
    label: "Distribute horizontal spacing",
    Icon: DistributeHIcon,
  },
  { axis: "vertical", label: "Distribute vertical spacing", Icon: DistributeVIcon },
];

const alignButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "#3f3f46",
};

export const AlignToolbar = observer(({ viewportEl }: { viewportEl: HTMLElement | null }) => {
  const store = useEditorStore();
  const canDistribute = getTransformableSelectedIds(store).length > 2;

  return (
    <div
      data-align-toolbar
      data-overlay-ui
      style={{
        position: "absolute",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "4px 6px",
        backgroundColor: "#fff",
        borderRadius: 10,
        boxShadow: FLOAT_SHADOW,
        pointerEvents: "auto",
        zIndex: 20,
      }}
    >
      {ALIGN_ACTIONS.map(({ edge, label, Icon }) => (
        <button
          key={edge}
          type="button"
          title={label}
          aria-label={label}
          data-align-edge={edge}
          style={alignButtonStyle}
          onClick={() => alignSelection(store, viewportEl, edge)}
        >
          <Icon size={16} />
        </button>
      ))}
      <span style={{ width: 1, height: 16, backgroundColor: "#e4e4e7", margin: "0 2px" }} />
      {DISTRIBUTE_ACTIONS.map(({ axis, label, Icon }) => (
        <button
          key={axis}
          type="button"
          title={label}
          aria-label={label}
          disabled={!canDistribute}
          data-distribute-axis={axis}
          style={{
            ...alignButtonStyle,
            color: canDistribute ? alignButtonStyle.color : "#d4d4d8",
          }}
          onClick={() => distributeSelection(store, viewportEl, axis)}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
});
