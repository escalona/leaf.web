import { observer } from "mobx-react-lite";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  TrashIcon,
} from "../../icons";
import type { ReactNode } from "react";
import {
  FILTER_FUNCTIONS,
  createFilterEntry,
  createShadowEntry,
  formatBoxShadow,
  formatFilter,
  formatParkedEntries,
  formatShadowEntry,
  hiddenStyleKey,
  isFilterListParseable,
  isShadowListParseable,
  mergeParked,
  moveStackItem,
  parseBoxShadow,
  parseFilter,
  parseParkedEntries,
  parseShadowEntry,
  splitParked,
  type FilterEntry,
  type FilterFunctionName,
  type ParkedItem,
  type ShadowEntry,
  type ShadowFormatOptions,
  type StackItem,
} from "../../../core/editor/effects-css";
import {
  ColorField,
  IconButton,
  MixedNumberInput,
  MixedTextInput,
  Section,
  Select,
} from "../PropertyControls";
import { FONT_STACK } from "../../floating-styles";
import { isMixed } from "../selection-properties";
import type { SelectionProperties } from "../useSelectionProperties";
import { everyType, type SectionProps } from "./types";

/**
 * Shadow, inner shadow, and filter stacks.
 *
 * Everything here is derived from the CSS already on the node rather than from
 * a private model, which is the whole point: a shadow an agent wrote through
 * `write_html` has to be editable entry by entry, and a shadow the panel wrote
 * has to remain plain CSS an agent can read. Values the parser does not
 * understand fall back to a raw text field instead of being rewritten.
 */
export const EffectsSection = observer(({ props }: SectionProps) => {
  if (props.nodes.length === 0) return null;

  // A box shadow on a text node paints a rectangle around the glyph box, which
  // is never what was meant; text nodes target `text-shadow` and drop the
  // spread and inset the property does not support. That only decides which
  // property the *default* stack writes to. Either property can still be present
  // on the other kind of node because an agent wrote it, and a shadow that is on
  // the node has to be editable, so each one also gets its own stack whenever it
  // is actually there — otherwise an agent-authored shadow is unreachable.
  const textOnly = everyType(props.nodes, "text");
  const showBoxShadow = !textOnly || props.style("boxShadow") !== undefined;
  const showTextShadow = textOnly || props.style("textShadow") !== undefined;

  return (
    <>
      {showTextShadow && (
        <ShadowStack
          props={props}
          title={textOnly ? "Shadow" : "Text shadow"}
          stackId={textOnly ? "shadow" : "text-shadow"}
          styleKey="textShadow"
          group="outer"
          format={{ spread: false, inset: false }}
        />
      )}
      {showBoxShadow && (
        <ShadowStack
          props={props}
          title={textOnly ? "Box shadow" : "Shadow"}
          stackId={textOnly ? "box-shadow" : "shadow"}
          styleKey="boxShadow"
          group="outer"
        />
      )}
      {showBoxShadow && (
        <ShadowStack
          props={props}
          title="Inner shadow"
          stackId="inner-shadow"
          styleKey="boxShadow"
          group="inner"
        />
      )}
      <FilterStacks props={props} />
    </>
  );
});

// --- Shared row scaffolding -------------------------------------------------

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
} as const;

const entryStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "6px 0",
  minWidth: 0,
} as const;

const mixedRowStyle = {
  fontSize: 11,
  fontFamily: FONT_STACK,
  color: "var(--leaf-text-muted)",
  padding: "4px 0",
  width: "100%",
  border: "none",
  background: "transparent",
  textAlign: "left",
} as const;

function AddButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <IconButton onClick={onClick} title={title}>
      <PlusIcon size={12} />
    </IconButton>
  );
}

function EntryActions({
  visible,
  onToggleVisible,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  visible: boolean;
  onToggleVisible: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove: () => void;
}) {
  return (
    <>
      <IconButton onClick={onToggleVisible} title={visible ? "Hide" : "Show"}>
        {visible ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}
      </IconButton>
      <IconButton onClick={() => onMoveUp?.()} title="Move up">
        <ChevronUpIcon size={12} style={{ opacity: onMoveUp ? 1 : 0.3 }} />
      </IconButton>
      <IconButton onClick={() => onMoveDown?.()} title="Move down">
        <ChevronDownIcon size={12} style={{ opacity: onMoveDown ? 1 : 0.3 }} />
      </IconButton>
      <IconButton onClick={onRemove} title="Remove">
        <TrashIcon size={12} />
      </IconButton>
    </>
  );
}

const LENGTH_PATTERN = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i;

/**
 * A length that stays whatever the author made it.
 *
 * A plain numeric length gets a scrubbable number field; anything else — `calc()`,
 * a custom property, an empty unit the author chose deliberately — keeps a text
 * field so the panel never converts `2rem` into `2px`.
 */
function LengthField({
  affordance,
  field,
  value,
  onChange,
  buffered,
  fallbackUnit = "",
  min,
  max,
  step,
}: {
  affordance: ReactNode;
  field: string;
  value: string;
  onChange: (value: string) => void;
  buffered: SelectionProperties["buffered"];
  fallbackUnit?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const match = LENGTH_PATTERN.exec(value.trim());
  const amount = match ? Number.parseFloat(match[1]!) : 0;
  const unit = match ? match[2]! : "";

  return (
    <div data-effect-field={field} style={{ minWidth: 0 }}>
      {match ? (
        <MixedNumberInput
          affordance={affordance}
          value={amount}
          suffix={unit}
          min={min}
          max={max}
          step={step}
          onChange={(next) => {
            // A bare `0` carries no unit to preserve, so fall back to the unit
            // the property expects; a deliberate unitless value like
            // `opacity(.5)` keeps its form.
            const nextUnit = unit !== "" ? unit : amount === 0 ? fallbackUnit : "";
            onChange(`${next}${nextUnit}`);
          }}
          {...buffered}
        />
      ) : (
        <MixedTextInput
          affordance={affordance}
          value={value}
          monospace
          onChange={onChange}
          {...buffered}
        />
      )}
    </div>
  );
}

/**
 * Read a stack out of a CSS list plus its parked hidden entries.
 *
 * `mixed` collapses both keys: if the selection disagrees about either the
 * declaration or which entries are hidden, there is no single stack to edit.
 */
function readStack<T>(
  props: SelectionProperties,
  styleKey: string,
  parse: (css: string | number | undefined) => T[],
  parseOne: (source: string) => T | null,
  isParseable: (css: string | number | undefined) => boolean,
): { items: StackItem<T>[]; mixed: boolean; parseable: boolean; raw: string } {
  const raw = props.style(styleKey);
  const hidden = props.style(hiddenStyleKey(styleKey));
  if (isMixed(raw) || isMixed(hidden)) {
    return { items: [], mixed: true, parseable: true, raw: "" };
  }

  const parked: ParkedItem<T>[] = [];
  for (const item of parseParkedEntries(hidden)) {
    const value = parseOne(item.value);
    if (value !== null) parked.push({ index: item.index, value });
  }

  return {
    items: mergeParked(parse(raw), parked),
    mixed: false,
    parseable: isParseable(raw),
    raw: raw === undefined ? "" : String(raw),
  };
}

function writeStack<T>(
  props: SelectionProperties,
  styleKey: string,
  items: readonly StackItem<T>[],
  format: (values: readonly T[]) => string,
  formatOne: (value: T) => string,
) {
  const { visible, parked } = splitParked(items);
  const css = format(visible);
  const hidden = formatParkedEntries(
    parked.map((item) => ({ index: item.index, value: formatOne(item.value) })),
  );
  props.setStyles({
    [styleKey]: css === "" ? null : css,
    [hiddenStyleKey(styleKey)]: hidden === "" ? null : hidden,
  });
}

// --- Shadows ----------------------------------------------------------------

const ShadowStack = observer(
  ({
    props,
    title,
    stackId,
    styleKey,
    group,
    format = {},
  }: {
    props: SelectionProperties;
    title: string;
    stackId: string;
    styleKey: string;
    group: "outer" | "inner";
    format?: ShadowFormatOptions;
  }) => {
    const inset = group === "inner";
    const formatOne = (entry: ShadowEntry) => formatShadowEntry(entry, format);
    const stack = readStack(
      props,
      styleKey,
      (css) => parseBoxShadow(css),
      parseShadowEntry,
      isShadowListParseable,
    );

    // Outer and inner shadows share one `box-shadow` string, so a write from one
    // list has to carry the other list through untouched.
    const commit = (nextGroup: StackItem<ShadowEntry>[]) => {
      const others = stack.items.filter((item) => item.value.inset !== inset);
      const merged = inset ? [...others, ...nextGroup] : [...nextGroup, ...others];
      writeStack(props, styleKey, merged, (values) => formatBoxShadow(values, format), formatOne);
    };

    const rows = stack.items.filter((item) => item.value.inset === inset);

    // The two lists share one declaration, so the raw fallback is shown once.
    if (!stack.parseable && inset) return null;

    const add = () => commit([...rows, { value: createShadowEntry(inset), visible: true }]);
    const replaceMixed = () => {
      writeStack(
        props,
        styleKey,
        [{ value: createShadowEntry(inset), visible: true }],
        (values) => formatBoxShadow(values, format),
        formatOne,
      );
    };

    const update = (position: number, patch: Partial<ShadowEntry>) =>
      commit(
        rows.map((item, index) =>
          index === position
            ? { ...item, visible: true, value: { ...item.value, ...patch } }
            : item,
        ),
      );

    return (
      <Section
        title={title}
        trailing={
          <AddButton
            onClick={stack.mixed ? replaceMixed : add}
            title={`Add ${title.toLowerCase()}`}
          />
        }
      >
        <div data-effect-stack={stackId}>
          {stack.mixed ? (
            <button type="button" style={mixedRowStyle} onClick={replaceMixed}>
              Click to replace mixed shadows
            </button>
          ) : !stack.parseable ? (
            <MixedTextInput
              value={stack.raw}
              monospace
              onChange={(next) => props.setStyles({ [styleKey]: next === "" ? null : next })}
              {...props.buffered}
            />
          ) : (
            rows.map((item, position) => (
              <div key={position} data-effect-entry={position} style={entryStyle}>
                <div style={rowStyle}>
                  <div
                    data-effect-field="color"
                    style={{ flex: 1, minWidth: 0, opacity: item.visible ? 1 : 0.45 }}
                  >
                    <ColorField
                      value={item.value.color}
                      onChange={(next) => update(position, { color: next })}
                      {...props.buffered}
                    />
                  </div>
                  <EntryActions
                    visible={item.visible}
                    onToggleVisible={() =>
                      commit(
                        rows.map((entry, index) =>
                          index === position ? { ...entry, visible: !entry.visible } : entry,
                        ),
                      )
                    }
                    onMoveUp={
                      position > 0
                        ? () => commit(moveStackItem(rows, position, position - 1))
                        : undefined
                    }
                    onMoveDown={
                      position < rows.length - 1
                        ? () => commit(moveStackItem(rows, position, position + 1))
                        : undefined
                    }
                    onRemove={() => commit(rows.filter((_, index) => index !== position))}
                  />
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${format.spread === false ? 3 : 4}, minmax(0, 1fr))`,
                    gap: 6,
                    opacity: item.visible ? 1 : 0.45,
                  }}
                >
                  <LengthField
                    affordance="X"
                    field="offsetX"
                    value={item.value.offsetX}
                    fallbackUnit="px"
                    onChange={(next) => update(position, { offsetX: next })}
                    buffered={props.buffered}
                  />
                  <LengthField
                    affordance="Y"
                    field="offsetY"
                    value={item.value.offsetY}
                    fallbackUnit="px"
                    onChange={(next) => update(position, { offsetY: next })}
                    buffered={props.buffered}
                  />
                  <LengthField
                    affordance="B"
                    field="blur"
                    value={item.value.blur}
                    fallbackUnit="px"
                    min={0}
                    onChange={(next) => update(position, { blur: next })}
                    buffered={props.buffered}
                  />
                  {format.spread !== false && (
                    <LengthField
                      affordance="S"
                      field="spread"
                      value={item.value.spread}
                      fallbackUnit="px"
                      onChange={(next) => update(position, { spread: next })}
                      buffered={props.buffered}
                    />
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </Section>
    );
  },
);

// --- Filters ----------------------------------------------------------------

const FILTER_OPTIONS = Object.entries(FILTER_FUNCTIONS).map(([value, spec]) => ({
  value,
  label: spec.label,
}));

/**
 * Layer and backdrop filters, in one section with two sub-lists. They are
 * separate CSS properties, so each keeps its own stack.
 */
const FilterStacks = observer(({ props }: { props: SelectionProperties }) => (
  <Section title="Filters">
    <FilterList props={props} label="Layer" styleKey="filter" />
    <FilterList props={props} label="Backdrop" styleKey="backdropFilter" />
  </Section>
));

const FilterList = observer(
  ({ props, label, styleKey }: { props: SelectionProperties; label: string; styleKey: string }) => {
    const parseOne = (source: string): FilterEntry | null => parseFilter(source)[0] ?? null;
    const stack = readStack(props, styleKey, parseFilter, parseOne, isFilterListParseable);

    const commit = (items: StackItem<FilterEntry>[]) =>
      writeStack(props, styleKey, items, formatFilter, (entry) => formatFilter([entry]));

    const rows = stack.items;
    const add = () => commit([...rows, { value: createFilterEntry("blur"), visible: true }]);
    const replaceMixed = () => commit([{ value: createFilterEntry("blur"), visible: true }]);

    const update = (position: number, value: FilterEntry) =>
      commit(rows.map((item, index) => (index === position ? { value, visible: true } : item)));

    return (
      <div
        data-effect-stack={styleKey === "backdropFilter" ? "backdrop-filter" : "filter"}
        style={{ marginBottom: 4 }}
      >
        <div style={{ ...rowStyle, justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ fontSize: 11, color: "var(--leaf-text-muted)" }}>{label}</div>
          <AddButton
            onClick={stack.mixed ? replaceMixed : add}
            title={`Add ${label.toLowerCase()} filter`}
          />
        </div>
        {stack.mixed ? (
          <button type="button" style={mixedRowStyle} onClick={replaceMixed}>
            Click to replace mixed filters
          </button>
        ) : !stack.parseable ? (
          <MixedTextInput
            value={stack.raw}
            monospace
            onChange={(next) => props.setStyles({ [styleKey]: next === "" ? null : next })}
            {...props.buffered}
          />
        ) : (
          rows.map((item, position) => {
            const spec = FILTER_FUNCTIONS[item.value.type];
            return (
              <div
                key={position}
                data-effect-entry={position}
                style={{ ...rowStyle, marginBottom: 6, opacity: item.visible ? 1 : 0.45 }}
              >
                <div style={{ width: 96, flexShrink: 0 }}>
                  <Select
                    value={item.value.type}
                    options={FILTER_OPTIONS}
                    onChange={(next) =>
                      // Units differ per function, so carrying the old amount
                      // across would produce nonsense like `sepia(4px)`.
                      update(position, createFilterEntry(next as FilterFunctionName))
                    }
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {item.value.type === "drop-shadow" ? (
                    <MixedTextInput
                      value={item.value.value}
                      monospace
                      onChange={(next) => update(position, { ...item.value, value: next })}
                      {...props.buffered}
                    />
                  ) : (
                    <LengthField
                      affordance={spec.unit === "%" ? "%" : spec.unit === "deg" ? "°" : "px"}
                      field="amount"
                      value={item.value.value}
                      fallbackUnit={spec.unit}
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      onChange={(next) => update(position, { ...item.value, value: next })}
                      buffered={props.buffered}
                    />
                  )}
                </div>
                <EntryActions
                  visible={item.visible}
                  onToggleVisible={() =>
                    commit(
                      rows.map((entry, index) =>
                        index === position ? { ...entry, visible: !entry.visible } : entry,
                      ),
                    )
                  }
                  onMoveUp={
                    position > 0
                      ? () => commit(moveStackItem(rows, position, position - 1))
                      : undefined
                  }
                  onMoveDown={
                    position < rows.length - 1
                      ? () => commit(moveStackItem(rows, position, position + 1))
                      : undefined
                  }
                  onRemove={() => commit(rows.filter((_, index) => index !== position))}
                />
              </div>
            );
          })
        )}
      </div>
    );
  },
);
