import { observer } from "mobx-react-lite";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  TrashIcon,
} from "../../icons";
import { useRef, type CSSProperties } from "react";
import {
  convertFill,
  createFill,
  formatFills,
  fillsEqual,
  moveFill,
  parseFills,
  removeFill,
  replaceFill,
  setGradientKind,
  type Fill,
  type FillType,
  type GradientFill,
  type ImageFill,
} from "../../../core/editor/paint/fills";
import {
  formatGradient,
  insertGradientStop,
  sampleGradientColor,
  type Gradient,
  type GradientKind,
  type GradientStop,
} from "../../../core/editor/paint/gradient";
import {
  ColorField,
  IconButton,
  IconInput,
  MixedNumberInput,
  PropertyGrid,
  PropertyRow,
  Section,
  SegmentedControl,
  Select,
} from "../PropertyControls";
import { resolveNodeStyle } from "../selection-properties";
import type { DesignNode } from "../../../core/types";
import { FONT_STACK } from "../../floating-styles";
import { isBoxLike, type SectionProps } from "./types";

/** `background-blend-mode` accepts the separable and non-separable modes. */
const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
].map((mode) => ({
  label: mode.replace(/-/g, " ").replace(/^\w/, (char) => char.toUpperCase()),
  value: mode,
}));

const FILL_TYPES: { value: FillType; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "gradient", label: "Gradient" },
  { value: "image", label: "Image" },
];

const GRADIENT_KINDS = [
  { value: "linear", label: "Linear" },
  { value: "radial", label: "Radial" },
  { value: "conic", label: "Conic" },
];

/** `background-size` presets, named after the `object-fit` vocabulary. */
const IMAGE_FITS = [
  { value: "cover", label: "Cover" },
  { value: "contain", label: "Contain" },
  { value: "100% 100%", label: "Fill" },
  { value: "auto", label: "None" },
];

const CHECKERBOARD: CSSProperties = {
  backgroundImage: "conic-gradient(from 0deg, #ddd 25%, #fff 0 50%, #ddd 0 75%, #fff 0)",
  backgroundSize: "8px 8px",
};

const cardStyle: CSSProperties = {
  border: "1px solid #ececec",
  borderRadius: 8,
  padding: 8,
  marginBottom: 6,
  minWidth: 0,
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  color: "var(--leaf-text-muted)",
  fontFamily: FONT_STACK,
  marginBottom: 4,
};

const readFills = (node: DesignNode) => parseFills((key) => resolveNodeStyle(node, key));

const percentText = (position: number) => String(Math.round(position * 100));

/**
 * Stable render keys for a list of value objects that have no ids and are
 * re-derived from CSS on every render. Index keys leave DOM focus attached to
 * a position rather than an item when the list reorders, and content keys
 * would remount a row on every keystroke. Handlers that reshape the list
 * mirror the change here so a key follows its item; an untracked length
 * change (undo, collaboration, a raw layer re-parsing into a different count)
 * keeps the common prefix and degrades to positional identity for the rest.
 */
function useListKeys() {
  const ref = useRef({ keys: [] as number[], next: 0 });
  const identity = ref.current;
  return {
    sync(length: number): number[] {
      if (identity.keys.length !== length) {
        const keys = identity.keys.slice(0, length);
        while (keys.length < length) keys.push(identity.next++);
        identity.keys = keys;
      }
      return identity.keys;
    },
    insertAt(index: number) {
      const keys = [...identity.keys];
      keys.splice(index, 0, identity.next++);
      identity.keys = keys;
    },
    removeAt(index: number) {
      identity.keys = identity.keys.filter((_, i) => i !== index);
    },
    // Mirrors moveFill's bounds handling: an out-of-range move is a no-op.
    move(from: number, to: number) {
      if (from === to || from < 0 || from >= identity.keys.length) return;
      if (to < 0 || to >= identity.keys.length) return;
      const keys = [...identity.keys];
      const [moved] = keys.splice(from, 1);
      keys.splice(to, 0, moved!);
      identity.keys = keys;
    },
  };
}

/**
 * The fill stack.
 *
 * Paint is modelled as `solid | gradient | image` layers — but the stack is derived
 * from the node's own CSS on every render, so a gradient an agent wrote as a
 * raw `background-image` string is editable stop by stop here, not just
 * readable as text.
 */
export const FillSection = observer(({ props }: SectionProps) => {
  const { nodes, primary, setStyles, beginEdit, endEdit, buffered } = props;
  const fillKeys = useListKeys();
  if (!isBoxLike(nodes)) return null;

  const fills = readFills(primary);
  const keys = fillKeys.sync(fills.length);
  const mixed = nodes.some((node) => !fillsEqual(readFills(node), fills));

  // Writing the whole derived stack is what makes a mixed selection resolvable:
  // the first edit replaces every node's paint with one the user can see.
  const write = (next: Fill[]) => setStyles(formatFills(next));

  const updateFill = (index: number, fill: Fill) => write(replaceFill(fills, index, fill));

  return (
    <Section
      title="Fill"
      trailing={
        <IconButton
          onClick={() => {
            fillKeys.insertAt(0);
            write([createFill("solid"), ...fills]);
          }}
          title="Add fill"
        >
          <PlusIcon size={12} />
        </IconButton>
      }
    >
      {mixed && (
        <div style={{ ...labelStyle, marginBottom: 8 }}>
          Mixed across {nodes.length} layers — editing applies this stack to all of them.
        </div>
      )}
      {fills.length === 0 ? (
        <div style={labelStyle}>No fill</div>
      ) : (
        fills.map((fill, index) => (
          <FillRow
            key={keys[index]}
            fill={fill}
            index={index}
            count={fills.length}
            buffered={buffered}
            beginEdit={beginEdit}
            endEdit={endEdit}
            onChange={(next) => updateFill(index, next)}
            onMove={(to) => {
              fillKeys.move(index, to);
              write(moveFill(fills, index, to));
            }}
            onRemove={() => {
              fillKeys.removeAt(index);
              write(removeFill(fills, index));
            }}
          />
        ))
      )}
    </Section>
  );
});

interface FillRowProps {
  fill: Fill;
  index: number;
  count: number;
  buffered: { onFocus: () => void; onBlur: () => void };
  beginEdit: () => void;
  endEdit: () => void;
  onChange: (fill: Fill) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}

function FillRow({
  fill,
  index,
  count,
  buffered,
  beginEdit,
  endEdit,
  onChange,
  onMove,
  onRemove,
}: FillRowProps) {
  return (
    <div style={cardStyle} data-fill={index}>
      {/* A lone fill keeps its buttons on the switcher's line. Once
          reordering adds two more, the group wraps to its own
          right-aligned line rather than squeezing the labels into ellipses. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <div style={{ flex: "1 1 150px" }}>
          {fill.type === "raw" ? (
            // Retyping a layer the panel cannot model would discard the CSS it
            // is preserving, so a raw layer is labelled instead of switchable.
            <div style={{ ...labelStyle, marginBottom: 0 }}>Custom</div>
          ) : (
            <SegmentedControl
              value={fill.type}
              options={FILL_TYPES}
              onChange={(type) => onChange(convertFill(fill, type))}
            />
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <IconButton
            onClick={() => onChange({ ...fill, visible: !fill.visible })}
            title={fill.visible ? "Hide fill" : "Show fill"}
            active={!fill.visible}
          >
            {fill.visible ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}
          </IconButton>
          {count > 1 && (
            <>
              <IconButton onClick={() => onMove(index - 1)} title="Move up">
                <ChevronUpIcon size={12} />
              </IconButton>
              <IconButton onClick={() => onMove(index + 1)} title="Move down">
                <ChevronDownIcon size={12} />
              </IconButton>
            </>
          )}
          <IconButton onClick={onRemove} title="Remove fill">
            <TrashIcon size={12} />
          </IconButton>
        </div>
      </div>

      {fill.type === "solid" && (
        <div data-property="fillColor">
          <PropertyRow>
            <ColorField
              value={fill.color}
              onChange={(color) => color.trim() !== "" && onChange({ ...fill, color })}
              {...buffered}
            />
          </PropertyRow>
        </div>
      )}

      {fill.type === "gradient" && (
        <GradientEditor
          fill={fill}
          buffered={buffered}
          beginEdit={beginEdit}
          endEdit={endEdit}
          onChange={onChange}
        />
      )}

      {fill.type === "image" && <ImageEditor fill={fill} buffered={buffered} onChange={onChange} />}

      {fill.type === "raw" && (
        <div data-property="fillRawCss">
          <PropertyRow>
            <IconInput
              affordance={<span style={{ fontSize: 9 }}>CSS</span>}
              value={fill.css}
              onChange={(css) => css.trim() !== "" && onChange({ ...fill, css })}
              selectOnFocus={false}
              {...buffered}
            />
          </PropertyRow>
        </div>
      )}

      {(count > 1 || fill.blendMode !== undefined) && (
        <div data-property="fillBlendMode">
          <PropertyRow>
            <Select
              value={fill.blendMode ?? "normal"}
              options={BLEND_MODES}
              onChange={(mode) =>
                onChange({ ...fill, blendMode: mode === "normal" ? undefined : mode })
              }
              {...buffered}
            />
          </PropertyRow>
        </div>
      )}
    </div>
  );
}

interface GradientEditorProps {
  fill: GradientFill;
  buffered: { onFocus: () => void; onBlur: () => void };
  beginEdit: () => void;
  endEdit: () => void;
  onChange: (fill: Fill) => void;
}

function GradientEditor({ fill, buffered, beginEdit, endEdit, onChange }: GradientEditorProps) {
  const stopKeys = useListKeys();
  const gradient = fill.gradient;
  const keys = stopKeys.sync(gradient.stops.length);
  const setGradient = (next: Gradient) => onChange({ ...fill, gradient: next });
  const setStops = (stops: GradientStop[]) => setGradient({ ...gradient, stops });

  const addStopAt = (position: number) => {
    beginEdit();
    // insertGradientStop appends then stable-sorts by position, so the new
    // stop lands after every stop at or before its position.
    stopKeys.insertAt(gradient.stops.filter((stop) => stop.position <= position).length);
    setGradient(
      insertGradientStop(gradient, {
        color: sampleGradientColor(gradient, position),
        position,
      }),
    );
    endEdit();
  };

  return (
    <>
      <GradientBar gradient={gradient} onInsert={addStopAt} />
      <PropertyGrid>
        <div data-property="gradientKind">
          <Select
            value={gradient.kind}
            options={GRADIENT_KINDS}
            onChange={(kind) => onChange(setGradientKind(fill, kind as GradientKind))}
            {...buffered}
          />
        </div>
        <div data-property="gradientAngle">
          <MixedNumberInput
            affordance="∠"
            value={Math.round(gradient.angle)}
            suffix="°"
            onChange={(angle) => setGradient({ ...gradient, angle })}
            {...buffered}
          />
        </div>
      </PropertyGrid>
      {gradient.stops.map((stop, index) => (
        <div
          key={keys[index]}
          data-stop={index}
          style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, minWidth: 0 }}
        >
          <div style={{ flex: 1, minWidth: 0 }} data-property="stopColor">
            <ColorField
              value={stop.color}
              allowAlpha={false}
              onChange={(color) =>
                // An empty colour would drop the stop on the next parse, so a
                // half-typed value is left in the field rather than committed.
                color.trim() !== "" &&
                setStops(gradient.stops.map((s, i) => (i === index ? { ...s, color } : s)))
              }
              {...buffered}
            />
          </div>
          <div style={{ width: 50, flexShrink: 0 }} data-property="stopPosition">
            <IconInput
              affordance={<span style={{ fontSize: 9 }}>%</span>}
              value={percentText(stop.position)}
              onChange={(raw) => {
                const percent = Number.parseFloat(raw);
                if (!Number.isFinite(percent)) return;
                setStops(
                  gradient.stops.map((s, i) =>
                    i === index ? { ...s, position: Math.min(1, Math.max(0, percent / 100)) } : s,
                  ),
                );
              }}
              scrub={{
                onChange: (delta) =>
                  setStops(
                    gradient.stops.map((s, i) =>
                      i === index
                        ? { ...s, position: Math.min(1, Math.max(0, s.position + delta / 100)) }
                        : s,
                    ),
                  ),
              }}
              {...buffered}
            />
          </div>
          <IconButton
            onClick={() => {
              stopKeys.removeAt(index);
              setStops(gradient.stops.filter((_, i) => i !== index));
            }}
            title="Remove stop"
          >
            <TrashIcon size={12} />
          </IconButton>
        </div>
      ))}
      <button
        type="button"
        onClick={() => addStopAt(0.5)}
        style={{
          width: "100%",
          height: 24,
          border: "1px dashed var(--leaf-border)",
          borderRadius: 6,
          backgroundColor: "transparent",
          color: "var(--leaf-text-muted)",
          fontSize: 11,
          fontFamily: FONT_STACK,
        }}
      >
        Add stop
      </button>
    </>
  );
}

/**
 * The live ramp, flattened to a horizontal linear gradient so radial and conic
 * stacks stay readable as a stop sequence. Clicking inserts a stop at the
 * clicked position in the colour already shown there.
 */
function GradientBar({
  gradient,
  onInsert,
}: {
  gradient: Gradient;
  onInsert: (position: number) => void;
}) {
  const ramp = formatGradient({
    ...gradient,
    kind: "linear",
    repeating: false,
    angle: 90,
    shape: undefined,
    center: undefined,
  });

  return (
    <div
      role="presentation"
      data-property="gradientBar"
      title="Click to add a stop"
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width <= 0) return;
        onInsert(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)));
      }}
      style={{
        ...CHECKERBOARD,
        position: "relative",
        height: 20,
        borderRadius: 4,
        border: "1px solid rgba(0,0,0,0.1)",
        marginBottom: 6,
        cursor: "copy",
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", inset: 0, backgroundImage: ramp }} />
      {gradient.stops.map((stop, index) => (
        <div
          key={index}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${Math.min(1, Math.max(0, stop.position)) * 100}%`,
            width: 2,
            marginLeft: -1,
            backgroundColor: "#fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
            pointerEvents: "none",
          }}
        />
      ))}
    </div>
  );
}

function ImageEditor({
  fill,
  buffered,
  onChange,
}: {
  fill: ImageFill;
  buffered: { onFocus: () => void; onBlur: () => void };
  onChange: (fill: Fill) => void;
}) {
  const fit = fill.size ?? "auto";
  const options = IMAGE_FITS.some((option) => option.value === fit)
    ? IMAGE_FITS
    : [...IMAGE_FITS, { value: fit, label: fit }];

  return (
    <>
      <div data-property="fillImageUrl">
        <PropertyRow>
          <IconInput
            affordance={<span style={{ fontSize: 9 }}>URL</span>}
            value={fill.url}
            onChange={(url) => onChange({ ...fill, url })}
            selectOnFocus={false}
            {...buffered}
          />
        </PropertyRow>
      </div>
      <PropertyGrid>
        <div data-property="fillImageFit">
          <Select
            value={fit}
            options={options}
            onChange={(size) => onChange({ ...fill, size })}
            {...buffered}
          />
        </div>
        <div data-property="fillImagePosition">
          <IconInput
            affordance={<span style={{ fontSize: 9 }}>◎</span>}
            value={fill.position ?? "50% 50%"}
            onChange={(position) => onChange({ ...fill, position })}
            {...buffered}
          />
        </div>
      </PropertyGrid>
    </>
  );
}
