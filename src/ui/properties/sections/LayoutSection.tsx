import { observer } from "mobx-react-lite";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DirectionColumnIcon,
  DirectionRowIcon,
  FrameWrapIcon,
  LinkIcon,
  MoveHorizontalIcon,
  MoveVerticalIcon,
  RectangleIcon,
  TrashIcon,
  UnlinkIcon,
  WrapIcon,
} from "../../icons";
import { useState, type ReactNode } from "react";
import {
  IconButton,
  IconInput,
  MIXED_LABEL,
  MixedSelect,
  PropertyGrid,
  PropertyRow,
  Section,
  SegmentedControl,
} from "../PropertyControls";
import { MIXED, isMixed, type MaybeMixed } from "../selection-properties";
import { useEditorStore } from "../../../core/state/EditorStore";
import { FONT_STACK } from "../../floating-styles";
import {
  addFlexToNode,
  isFlexContainer,
  measureNodeCanvasRect,
  paddingPatch,
  gapPatch,
  removeFlex,
  resolveGaps,
  resolvePaddingSides,
  setAbsolutePosition,
  wrapInFlex,
  type EdgeValues,
  type FlexAxis,
} from "../../../core/editor/auto-layout";
import {
  SIZING_INTENT_LABELS,
  allowedSizingIntents,
  authoredSize,
  classifySizing,
  sizingIntentPatch,
  type SizingAxis,
  type SizingContext,
  type SizingIntent,
} from "../../../core/editor/sizing-intent";
import type { EditorStore } from "../../../core/state/EditorStore";
import type { DesignNode } from "../../../core/types";
import type { SectionProps } from "./types";

type LayoutMode = "block" | "row" | "column";
type PaddingSide = keyof EdgeValues<unknown>;

const ALIGN_ITEMS_OPTIONS = [
  { label: "Stretch", value: "stretch" },
  { label: "Start", value: "flex-start" },
  { label: "Center", value: "center" },
  { label: "End", value: "flex-end" },
  { label: "Baseline", value: "baseline" },
];

const JUSTIFY_CONTENT_OPTIONS = [
  { label: "Start", value: "flex-start" },
  { label: "Center", value: "center" },
  { label: "End", value: "flex-end" },
  { label: "Between", value: "space-between" },
  { label: "Around", value: "space-around" },
  { label: "Evenly", value: "space-evenly" },
];

const CONSTRAINT_KEYS = ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const;

const PLAIN_LENGTH_PATTERN = /^-?(?:\d+|\d*\.\d+)(?:px)?$/;

const MUTED_LABEL_STYLE = {
  fontSize: 10,
  color: "var(--leaf-text-faint)",
  fontFamily: FONT_STACK,
} as const;

function isPlainLength(value: string | number): boolean {
  return typeof value === "number"
    ? Number.isFinite(value)
    : PLAIN_LENGTH_PATTERN.test(value.trim());
}

/** Collapse per-node reads that are not `DesignNode` fields into a value or MIXED. */
function combine<T>(values: readonly T[]): MaybeMixed<T | undefined> {
  if (values.length === 0) return undefined;
  const first = values[0]!;
  return values.every((value) => Object.is(value, first)) ? first : MIXED;
}

/**
 * Keep the value a node actually carries in the option list.
 *
 * A native `<select>` handed a value it has no option for silently renders its
 * first option instead, so an agent-authored `align-items: start` would read
 * back here as "Stretch" — the panel reporting a value nobody wrote. Anything
 * outside the curated list is surfaced verbatim rather than rounded to a
 * neighbour.
 */
function withCurrentValue(
  options: readonly { label: string; value: string }[],
  value: MaybeMixed<string | number | undefined>,
) {
  if (isMixed(value) || value === undefined) return [...options];
  const text = String(value);
  if (text === "" || options.some((option) => option.value === text)) return [...options];
  return [...options, { label: text, value: text }];
}

/**
 * A CSS length field: scrubbable while the value is a plain number, but always
 * free text underneath.
 *
 * A numeric-only control cannot express `1.5rem` — it reads it as 1 and writes
 * 1px back on the next keystroke — while a text-only control gives up dragging.
 * Plain values commit as numbers so the styles map stays px-typed; anything
 * with a unit or a keyword commits verbatim.
 *
 * Belongs in PropertyControls once the lead owns a shared version.
 */
function LengthInput({
  affordance,
  value,
  onChange,
  onFocus,
  onBlur,
  min = Number.NEGATIVE_INFINITY,
}: {
  affordance: ReactNode;
  value: MaybeMixed<string | number | undefined>;
  onChange: (value: string | number) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  min?: number;
}) {
  const mixed = isMixed(value);
  const plain = !mixed && (value === undefined || isPlainLength(value));
  const numeric = plain && value !== undefined ? Number.parseFloat(String(value)) : 0;

  return (
    <IconInput
      affordance={affordance}
      type="text"
      value={mixed ? MIXED_LABEL : value === undefined ? "" : String(value)}
      onChange={(raw) => {
        const trimmed = raw.trim();
        if (trimmed === "") return;
        onChange(isPlainLength(trimmed) ? Math.max(min, Number.parseFloat(trimmed)) : trimmed);
      }}
      onFocus={onFocus}
      onBlur={onBlur}
      scrub={plain ? { onChange: (delta) => onChange(Math.max(min, numeric + delta)) } : undefined}
    />
  );
}

/** Link/split toggle shared by the padding and gap fields. */
function LinkToggle({ linked, onToggle }: { linked: boolean; onToggle: () => void }) {
  return (
    <IconButton
      onClick={onToggle}
      active={linked}
      title={linked ? "Split into sides" : "Link sides"}
    >
      {linked ? <LinkIcon size={12} /> : <UnlinkIcon size={12} />}
    </IconButton>
  );
}

/**
 * Checkbox row. Exported for ClipContentSection; both should move to
 * PropertyControls when the lead adds a shared checkbox.
 */
export function PropertyCheckbox({
  checked,
  label,
  onChange,
  indeterminate = false,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  indeterminate?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--leaf-text)",
        fontFamily: FONT_STACK,
        userSelect: "none",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        ref={(input) => {
          if (input) input.indeterminate = indeterminate;
        }}
        onChange={(event) => onChange(event.target.checked)}
        style={{ margin: 0 }}
      />
      {label}
    </label>
  );
}

function sizingContextFor(store: EditorStore, node: DesignNode, axis: SizingAxis): SizingContext {
  const parent = store.getParent(node.id);
  return {
    node,
    axis,
    parentDisplay: parent?.styles.display,
    parentFlexDirection: parent?.styles.flexDirection,
    hasParent: parent !== undefined,
  };
}

function layoutModeOf(node: DesignNode): LayoutMode {
  if (!isFlexContainer(node)) return "block";
  return String(node.styles.flexDirection ?? "row").startsWith("column") ? "column" : "row";
}

/**
 * Layout: flex container setup, sizing intent, spacing, and flow escape.
 *
 * Every write goes through the same resolution the display side reads from, so
 * a padding longhand or a `width: fit-content` an agent authored is editable
 * here rather than invisible.
 */
export const LayoutSection = observer(({ props }: SectionProps) => {
  const store = useEditorStore();
  const { nodes, style, setStyles, removeStyles, buffered, isMultiple } = props;
  const [paddingSplit, setPaddingSplit] = useState(false);
  const [gapSplit, setGapSplit] = useState(false);
  const [constraintsOpen, setConstraintsOpen] = useState(false);

  // Computed sizes come from the DOM, so re-read them whenever a tracked
  // element resizes.
  void store.domIndex.resizeTick.get();

  const isContainer = nodes.every((node) => node.type === "frame" || node.type === "rectangle");
  const anyFlex = nodes.some(isFlexContainer);
  const layoutMode = combine(nodes.map(layoutModeOf));

  const flowChildren = nodes.filter((node) => store.isFlowChild(node.id));
  const absoluteChildren = nodes.filter(
    (node) => store.getParent(node.id) !== undefined && node.styles.position === "absolute",
  );
  const canDetach = flowChildren.length + absoluteChildren.length === nodes.length;

  const paddingPerNode = nodes.map((node) => resolvePaddingSides(node.styles));
  const paddingSide = (side: PaddingSide) => combine(paddingPerNode.map((sides) => sides[side]));
  const paddingLinked =
    !paddingSplit &&
    paddingPerNode.every((sides) =>
      [sides.right, sides.bottom, sides.left].every(
        (value) => String(value ?? "") === String(sides.top ?? ""),
      ),
    );

  const gapsPerNode = nodes.map((node) => resolveGaps(node.styles));
  const gapLinked =
    !gapSplit && gapsPerNode.every((gaps) => String(gaps.row ?? "") === String(gaps.column ?? ""));

  const wrapValue = style("flexWrap");
  const wraps = !isMixed(wrapValue) && wrapValue !== undefined && wrapValue !== "nowrap";

  const alignItems = style("alignItems") ?? "stretch";
  const justifyContent = style("justifyContent") ?? "flex-start";

  const applyLayoutMode = (mode: LayoutMode) => {
    store.beginHistoryTransaction();
    try {
      for (const node of nodes) {
        if (mode === "block") {
          if (isFlexContainer(node)) removeFlex(store, node.id);
          continue;
        }
        if (isFlexContainer(node)) {
          store.runtime.updateStyles([{ nodeIds: [node.id], styles: { flexDirection: mode } }]);
        } else {
          addFlexToNode(store, node.id, { direction: mode as FlexAxis });
        }
      }
    } finally {
      store.endHistoryTransaction();
    }
  };

  const applyPadding = (side: PaddingSide | "all", value: string | number) => {
    store.beginHistoryTransaction();
    try {
      for (const node of nodes) {
        const sides = resolvePaddingSides(node.styles);
        const next: EdgeValues<string | number> =
          side === "all"
            ? { top: value, right: value, bottom: value, left: value }
            : {
                top: sides.top ?? 0,
                right: sides.right ?? 0,
                bottom: sides.bottom ?? 0,
                left: sides.left ?? 0,
                [side]: value,
              };
        store.runtime.updateStyles([
          { nodeIds: [node.id], styles: paddingPatch(next, side === "all") },
        ]);
      }
    } finally {
      store.endHistoryTransaction();
    }
  };

  const applyGap = (axis: "row" | "column" | "all", value: string | number) => {
    store.beginHistoryTransaction();
    try {
      for (const node of nodes) {
        const gaps = resolveGaps(node.styles);
        const row = axis === "column" ? (gaps.row ?? 0) : value;
        const column = axis === "row" ? (gaps.column ?? 0) : value;
        store.runtime.updateStyles([
          { nodeIds: [node.id], styles: gapPatch(row, column, axis === "all") },
        ]);
      }
    } finally {
      store.endHistoryTransaction();
    }
  };

  // Re-linking has to write the shared value out, or the split longhands keep
  // rendering while the control claims the sides are linked.
  const togglePaddingLink = () => {
    if (paddingLinked) {
      setPaddingSplit(true);
      return;
    }
    setPaddingSplit(false);
    store.beginHistoryTransaction();
    try {
      for (const node of nodes) {
        const value = resolvePaddingSides(node.styles).top ?? 0;
        store.runtime.updateStyles([
          {
            nodeIds: [node.id],
            styles: paddingPatch({ top: value, right: value, bottom: value, left: value }, true),
          },
        ]);
      }
    } finally {
      store.endHistoryTransaction();
    }
  };

  const toggleGapLink = () => {
    if (gapLinked) {
      setGapSplit(true);
      return;
    }
    setGapSplit(false);
    store.beginHistoryTransaction();
    try {
      for (const node of nodes) {
        const value = resolveGaps(node.styles).row ?? 0;
        store.runtime.updateStyles([{ nodeIds: [node.id], styles: gapPatch(value, value, true) }]);
      }
    } finally {
      store.endHistoryTransaction();
    }
  };

  const applySizingIntent = (axis: SizingAxis, intent: SizingIntent) => {
    store.beginHistoryTransaction();
    try {
      for (const node of nodes) {
        const context = sizingContextFor(store, node, axis);
        const fixedPx = Math.round(measureNodeCanvasRect(store, node)[axis]);
        store.runtime.updateStyles([
          { nodeIds: [node.id], styles: sizingIntentPatch(context, intent, { fixedPx }) },
        ]);
      }
    } finally {
      store.endHistoryTransaction();
    }
  };

  const renderSizingRow = (axis: SizingAxis, affordance: string) => {
    const contexts = nodes.map((node) => sizingContextFor(store, node, axis));
    const intent = combine(contexts.map(classifySizing));
    const authored = combine(contexts.map(authoredSize));
    const computed = combine(
      nodes.map((node) => Math.round(measureNodeCanvasRect(store, node)[axis])),
    );
    // Offer only what every selected node can honour, so a mixed selection
    // cannot be sent to an intent that silently does nothing on half of it.
    const allowed = contexts.reduce<SizingIntent[]>(
      (offered, context) =>
        offered.filter((intent) => allowedSizingIntents(context).includes(intent)),
      allowedSizingIntents(contexts[0]!),
    );
    // The intent a node already has is always shown, even when it is not one we
    // would offer: a canvas root authored `width: 50%` really is Relative, and
    // dropping it from the list would make the control claim it is Fixed.
    if (!isMixed(intent) && intent !== undefined && !allowed.includes(intent)) {
      allowed.push(intent);
    }
    const options = allowed.map((value) => ({ label: SIZING_INTENT_LABELS[value], value }));

    return (
      <PropertyRow>
        <div style={{ flex: 1, minWidth: 0 }}>
          <LengthInput
            affordance={affordance}
            value={authored}
            onChange={(next) => setStyles({ [axis]: next })}
            {...buffered}
          />
        </div>
        <div style={{ width: 84, flexShrink: 0 }}>
          <MixedSelect
            value={intent}
            options={options}
            onChange={(next) => applySizingIntent(axis, next as SizingIntent)}
          />
        </div>
        <div style={{ width: 30, flexShrink: 0, textAlign: "right", ...MUTED_LABEL_STYLE }}>
          {isMixed(computed) || computed === undefined ? "" : computed}
        </div>
      </PropertyRow>
    );
  };

  const hasConstraint = nodes.some((node) =>
    CONSTRAINT_KEYS.some((key) => node.styles[key] !== undefined),
  );

  return (
    <Section
      title="Layout"
      trailing={
        isMultiple ? (
          <IconButton
            onClick={() => {
              const frameId = wrapInFlex(
                store,
                nodes.map((node) => node.id),
              );
              if (frameId) store.selectNode(frameId);
            }}
            title="Wrap in flex frame"
          >
            <FrameWrapIcon size={12} />
          </IconButton>
        ) : undefined
      }
    >
      {isContainer && (
        <div style={{ marginBottom: 6 }}>
          <SegmentedControl<string>
            value={isMixed(layoutMode) ? "" : (layoutMode ?? "block")}
            onChange={(mode) => applyLayoutMode(mode as LayoutMode)}
            options={[
              { value: "block", icon: <RectangleIcon size={12} />, title: "Block" },
              { value: "row", icon: <DirectionRowIcon size={12} />, title: "Horizontal flex" },
              { value: "column", icon: <DirectionColumnIcon size={12} />, title: "Vertical flex" },
            ]}
          />
        </div>
      )}

      {renderSizingRow("width", "W")}
      {renderSizingRow("height", "H")}

      {anyFlex && (
        <>
          <PropertyRow>
            {gapLinked ? (
              <div style={{ flex: 1, minWidth: 0 }}>
                <LengthInput
                  affordance={<MoveHorizontalIcon size={12} />}
                  value={combine(gapsPerNode.map((gaps) => gaps.row))}
                  min={0}
                  onChange={(next) => applyGap("all", next)}
                  {...buffered}
                />
              </div>
            ) : (
              <>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <LengthInput
                    affordance={<MoveVerticalIcon size={12} />}
                    value={combine(gapsPerNode.map((gaps) => gaps.row))}
                    min={0}
                    onChange={(next) => applyGap("row", next)}
                    {...buffered}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <LengthInput
                    affordance={<MoveHorizontalIcon size={12} />}
                    value={combine(gapsPerNode.map((gaps) => gaps.column))}
                    min={0}
                    onChange={(next) => applyGap("column", next)}
                    {...buffered}
                  />
                </div>
              </>
            )}
            <LinkToggle linked={gapLinked} onToggle={toggleGapLink} />
            <IconButton
              onClick={() => setStyles({ flexWrap: wraps ? null : "wrap" })}
              active={wraps}
              title="Wrap"
            >
              <WrapIcon size={12} />
            </IconButton>
          </PropertyRow>
          <PropertyGrid>
            <MixedSelect
              value={alignItems}
              onChange={(next) => setStyles({ alignItems: next })}
              options={withCurrentValue(ALIGN_ITEMS_OPTIONS, alignItems)}
            />
            <MixedSelect
              value={justifyContent}
              onChange={(next) => setStyles({ justifyContent: next })}
              options={withCurrentValue(JUSTIFY_CONTENT_OPTIONS, justifyContent)}
            />
          </PropertyGrid>
        </>
      )}

      {isContainer && (
        <PropertyRow>
          {paddingLinked ? (
            <div style={{ flex: 1, minWidth: 0 }}>
              <LengthInput
                affordance="P"
                value={paddingSide("top")}
                min={0}
                onChange={(next) => applyPadding("all", next)}
                {...buffered}
              />
            </div>
          ) : (
            <div style={{ flex: 1, minWidth: 0 }}>
              <PropertyGrid>
                <LengthInput
                  affordance="T"
                  value={paddingSide("top")}
                  min={0}
                  onChange={(next) => applyPadding("top", next)}
                  {...buffered}
                />
                <LengthInput
                  affordance="R"
                  value={paddingSide("right")}
                  min={0}
                  onChange={(next) => applyPadding("right", next)}
                  {...buffered}
                />
                <LengthInput
                  affordance="B"
                  value={paddingSide("bottom")}
                  min={0}
                  onChange={(next) => applyPadding("bottom", next)}
                  {...buffered}
                />
                <LengthInput
                  affordance="L"
                  value={paddingSide("left")}
                  min={0}
                  onChange={(next) => applyPadding("left", next)}
                  {...buffered}
                />
              </PropertyGrid>
            </div>
          )}
          <LinkToggle linked={paddingLinked} onToggle={togglePaddingLink} />
        </PropertyRow>
      )}

      {canDetach && (
        <div style={{ marginTop: 8 }}>
          <PropertyCheckbox
            label="Absolute position"
            checked={absoluteChildren.length === nodes.length}
            indeterminate={absoluteChildren.length > 0 && absoluteChildren.length < nodes.length}
            onChange={(checked) =>
              setAbsolutePosition(
                store,
                nodes.map((node) => node.id),
                checked,
              )
            }
          />
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            type="button"
            onClick={() => setConstraintsOpen((open) => !open)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: 0,
              border: "none",
              background: "transparent",
              ...MUTED_LABEL_STYLE,
            }}
          >
            {constraintsOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            Min and max size
          </button>
          {hasConstraint && (
            <IconButton
              onClick={() => removeStyles([...CONSTRAINT_KEYS])}
              title="Clear min and max size"
            >
              <TrashIcon size={12} />
            </IconButton>
          )}
        </div>
        {constraintsOpen && (
          <div style={{ marginTop: 6 }}>
            <PropertyGrid>
              <LengthInput
                affordance="W≥"
                value={style("minWidth")}
                min={0}
                onChange={(next) => setStyles({ minWidth: next })}
                {...buffered}
              />
              <LengthInput
                affordance="W≤"
                value={style("maxWidth")}
                min={0}
                onChange={(next) => setStyles({ maxWidth: next })}
                {...buffered}
              />
            </PropertyGrid>
            <PropertyGrid>
              <LengthInput
                affordance="H≥"
                value={style("minHeight")}
                min={0}
                onChange={(next) => setStyles({ minHeight: next })}
                {...buffered}
              />
              <LengthInput
                affordance="H≤"
                value={style("maxHeight")}
                min={0}
                onChange={(next) => setStyles({ maxHeight: next })}
                {...buffered}
              />
            </PropertyGrid>
          </div>
        )}
      </div>
    </Section>
  );
});
