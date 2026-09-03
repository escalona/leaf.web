import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { parseColor } from "../../core/editor/paint/color";
import { useEditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { usePaintedCanvasBackground } from "../properties/sections/PageSection";
import { FONT_STACK } from "../floating-styles";

/** Screen-space gap between a label's baseline box and the artboard's top edge. */
const LABEL_GAP = 6;
const LABEL_MAX_WIDTH = 260;
/**
 * The rename field's chrome, in screen pixels. The editor is offset by exactly
 * this much plus its border so its text lands where the label's text was: the
 * box grows outward around the name instead of nudging it on the first press.
 */
const INPUT_PADDING_X = 5;
const INPUT_PADDING_Y = 3;
const INPUT_BORDER = 1;
/** Keeps a short name from collapsing to an unclickable sliver. */
const INPUT_MIN_WIDTH = 24;
/** Matches the viewport's own double-click window. */
const DOUBLE_PRESS_MS = 400;
/** Custom property carrying the inverse zoom that keeps labels screen-sized. */
const LABEL_SCALE_VARIABLE = "--leaf-artboard-label-scale";
const LABEL_COLOR_ON_LIGHT = "#71717a";
const LABEL_COLOR_ON_DARK = "#a1a1aa";
/** Shared by the overlay's nested-frame titles so both read as one control. */
export const SELECTED_FRAME_TITLE_COLOR = "#1E90FF";
export const FRAME_TITLE_FONT_SIZE = 11;
/**
 * Screen-space drop from an artboard's top edge to the title's text baseline —
 * `LABEL_GAP` plus the descender the label's 14px line box leaves below it.
 */
export const FRAME_TITLE_BASELINE_GAP = LABEL_GAP + 3;

/**
 * Labels are the only reliable way to find an artboard once the page colour is
 * near the artboard's own fill, so their contrast follows the page rather than
 * being fixed against the default grey.
 */
function labelColorFor(background: string): string {
  const color = parseColor(background);
  if (!color) return LABEL_COLOR_ON_LIGHT;
  const luminance = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
  return luminance < 0.5 ? LABEL_COLOR_ON_DARK : LABEL_COLOR_ON_LIGHT;
}

/**
 * Every artboard on the canvas is named, selected or not. Frames created by
 * the frame tool are not flagged `isArtboard` — only MCP's `create_artboard`
 * sets it — so a root frame counts as an artboard here, which is what the user
 * sees on the canvas either way.
 */
function isLabelledArtboard(node: DesignNode): boolean {
  return node.visible !== false && (node.isArtboard || node.type === "frame");
}

/**
 * Persistent artboard names above every root frame.
 *
 * The camera transform is applied imperatively, matching `GridPattern`, so
 * panning and zooming never re-render the label list; React work is limited to
 * artboards being added, renamed, moved, or selected.
 */
export const ArtboardLabels = observer(() => {
  const store = useEditorStore();
  const cameraRef = useRef<HTMLDivElement | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Mirrors what has been typed so the sizer span can widen the field. The
  // input itself stays uncontrolled: React re-renders it on every hover and
  // selection change, and a controlled value would fight the caret.
  const [draftName, setDraftName] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const lastPressRef = useRef<{ nodeId: string; time: number } | null>(null);
  const labelColor = labelColorFor(usePaintedCanvasBackground(store));

  useLayoutEffect(
    () =>
      reaction(
        () => ({ panX: store.panX, panY: store.panY, zoom: store.zoom }),
        ({ panX, panY, zoom }) => {
          const element = cameraRef.current;
          if (!element) return;
          element.style.transform = `matrix(${zoom}, 0, 0, ${zoom}, ${panX}, ${panY})`;
          element.style.setProperty(LABEL_SCALE_VARIABLE, String(zoom === 0 ? 1 : 1 / zoom));
        },
        { fireImmediately: true },
      ),
    [store],
  );

  // Every artboard keeps its name, selected or not; selection only recolours it.
  const labels = store.nodes.filter(isLabelledArtboard);

  const commitRename = (node: DesignNode, name: string) => {
    const next = name.trim();
    if (next && next !== node.name) store.runtime.updateNode(node.id, { name: next });
    setRenamingId(null);
  };

  return (
    <div data-artboard-labels="" style={CONTAINER_STYLE}>
      <div ref={cameraRef} style={CAMERA_STYLE}>
        {labels.map((node) => {
          // Mirrors the overlay's drag handling: during a move the model x/y
          // lag the pointer by the offset captured at drag start. A remote
          // peer's in-flight drag moves the element the same way (via
          // remoteDragPreviews), so the label follows that offset too; the two
          // maps are mutually exclusive per node — a local gesture evicts the
          // remote preview.
          const offset = store.dragCanvasOffset.get(node.id);
          const remoteOffset = store.remoteDragPreviews.get(node.id);
          const renaming = renamingId === node.id;

          return (
            <div
              key={node.id}
              style={{
                ...ANCHOR_STYLE,
                left: node.x + (offset?.x ?? 0) + (remoteOffset?.x ?? 0),
                top: node.y + (offset?.y ?? 0) + (remoteOffset?.y ?? 0),
              }}
            >
              <div
                data-artboard-label={node.id}
                // The viewport resolves a press here to this node and drags it,
                // so the label is the frame's title handle: selecting, moving,
                // and renaming all happen on the name itself.
                data-frame-title-node={node.id}
                // The tooltip explains an ellipsized name; while renaming it
                // would just cover the field being typed into.
                title={renaming ? undefined : node.name}
                onPointerDown={(event) => {
                  // A press inside the rename field must not reach the viewport
                  // and start a drag behind the input.
                  if (renaming) {
                    event.stopPropagation();
                    return;
                  }
                  // The rename gesture is detected here rather than through a
                  // `dblclick` handler: the first press makes the viewport
                  // capture the pointer, and a capturing element receives the
                  // compatibility mouse events, so `dblclick` never reaches
                  // this label. Swallowing the second press also keeps the
                  // viewport from reading it as the double click that drills
                  // into the frame.
                  const previous = lastPressRef.current;
                  lastPressRef.current = { nodeId: node.id, time: Date.now() };
                  if (
                    previous?.nodeId === node.id &&
                    lastPressRef.current.time - previous.time < DOUBLE_PRESS_MS
                  ) {
                    event.stopPropagation();
                    // Without this the compatibility `mousedown` still fires and
                    // moves focus off the field that just mounted, blurring the
                    // rename shut on the very press that opened it.
                    event.preventDefault();
                    lastPressRef.current = null;
                    setRenamingId(node.id);
                    setDraftName(node.name);
                  }
                }}
                onPointerEnter={() => setHoveredId(node.id)}
                onPointerLeave={() =>
                  setHoveredId((current) => (current === node.id ? null : current))
                }
                style={{
                  ...LABEL_STYLE,
                  // The editor overflows this line box on every side; clipping
                  // and the name's own width clamp belong to the field instead.
                  ...(renaming ? RENAMING_LABEL_STYLE : null),
                  color:
                    store.selectedIds.has(node.id) || hoveredId === node.id
                      ? SELECTED_FRAME_TITLE_COLOR
                      : labelColor,
                }}
              >
                {renaming ? (
                  // An input cannot size itself to its text, so a sizer span
                  // holding the same string shares one grid cell with the field
                  // and dictates the track's width. The field then grows and
                  // shrinks with the name without measuring anything.
                  <span style={INPUT_SHELL_STYLE}>
                    <span aria-hidden="true" style={INPUT_SIZER_STYLE}>
                      {draftName}
                    </span>
                    <input
                      autoFocus
                      aria-label={`Rename ${node.name}`}
                      defaultValue={node.name}
                      data-artboard-label-input={node.id}
                      onBlur={(event) => commitRename(node, event.target.value)}
                      onChange={(event) => setDraftName(event.target.value)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") commitRename(node, event.currentTarget.value);
                        else if (event.key === "Escape") setRenamingId(null);
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      // Without this the field keeps its default ~20-character
                      // intrinsic width and the sizer can never shrink it.
                      size={1}
                      style={INPUT_STYLE}
                    />
                  </span>
                ) : (
                  node.name
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

const CONTAINER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  pointerEvents: "none",
};

const CAMERA_STYLE: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: 0,
  height: 0,
  transformOrigin: "0 0",
};

/**
 * A zero-sized box at the artboard's top-left corner, counter-scaled so its
 * contents are laid out in screen pixels no matter the zoom.
 */
const ANCHOR_STYLE: CSSProperties = {
  position: "absolute",
  width: 0,
  height: 0,
  transform: `scale(var(${LABEL_SCALE_VARIABLE}, 1))`,
  transformOrigin: "0 0",
};

const LABEL_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  bottom: LABEL_GAP,
  maxWidth: LABEL_MAX_WIDTH,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: FONT_STACK,
  fontSize: FRAME_TITLE_FONT_SIZE,
  lineHeight: "14px",
  pointerEvents: "auto",
  cursor: "default",
  userSelect: "none",
};

const RENAMING_LABEL_STYLE: CSSProperties = {
  maxWidth: "none",
  overflow: "visible",
};

/**
 * Anchored so the field's text sits exactly where the label's text was: back
 * and down by its own border and padding, leaving the name unmoved as the
 * editor opens.
 */
const INPUT_SHELL_STYLE: CSSProperties = {
  position: "absolute",
  left: -(INPUT_PADDING_X + INPUT_BORDER),
  bottom: -(INPUT_PADDING_Y + INPUT_BORDER),
  display: "inline-grid",
  minWidth: INPUT_MIN_WIDTH,
  maxWidth: LABEL_MAX_WIDTH,
};

/** Shares one grid cell with the field, so the two must lay text out alike. */
const TEXT_METRICS: CSSProperties = {
  gridArea: "1 / 1",
  boxSizing: "border-box",
  padding: `${INPUT_PADDING_Y}px ${INPUT_PADDING_X}px`,
  border: `${INPUT_BORDER}px solid transparent`,
  fontFamily: FONT_STACK,
  fontSize: FRAME_TITLE_FONT_SIZE,
  lineHeight: "14px",
};

const INPUT_SIZER_STYLE: CSSProperties = {
  ...TEXT_METRICS,
  // The clamp has to live on the sizer: a shrink-to-fit grid sizes its track to
  // the item's max-content first, so a `max-width` on the shell alone leaves the
  // field overflowing it. Past this width the name scrolls inside the field.
  maxWidth: LABEL_MAX_WIDTH,
  // A pixel of slack keeps the caret off the border at the end of the name,
  // and `pre` preserves the spaces a name may end with.
  paddingRight: INPUT_PADDING_X + 1,
  whiteSpace: "pre",
  visibility: "hidden",
};

const INPUT_STYLE: CSSProperties = {
  ...TEXT_METRICS,
  // The sizer owns the track's width; the field only fills it.
  width: "100%",
  minWidth: 0,
  borderColor: SELECTED_FRAME_TITLE_COLOR,
  borderRadius: 4,
  outline: "none",
  backgroundColor: "#ffffff",
  color: "#18181b",
  // The label suppresses selection so dragging a frame by its name never
  // highlights text; inside the field, selecting is the point.
  userSelect: "text",
};
