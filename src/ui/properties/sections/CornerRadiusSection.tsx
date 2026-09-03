import { observer } from "mobx-react-lite";
import { RadiusIcon, RadiusIndependentIcon, TrashIcon } from "../../icons";
import {
  IconButton,
  MixedNumberInput,
  MixedTextInput,
  PropertyGrid,
  PropertyRow,
  Section,
} from "../PropertyControls";
import { isMixed, resolveNodeStyle, type MaybeMixed } from "../selection-properties";
import { useEditorStore } from "../../../core/state/EditorStore";
import type { DesignNode } from "../../../core/types";
import { FONT_STACK } from "../../floating-styles";
import type { SectionProps } from "./types";

const CORNER_KEYS = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
] as const;

type CornerKey = (typeof CORNER_KEYS)[number];

const CORNER_LABELS: Record<CornerKey, string> = {
  borderTopLeftRadius: "TL",
  borderTopRightRadius: "TR",
  borderBottomLeftRadius: "BL",
  borderBottomRightRadius: "BR",
};

/** Text omits CornerRadius entirely; every other type has it. */
const ROUNDABLE_TYPES = new Set<DesignNode["type"]>([
  "frame",
  "rectangle",
  "image",
  "interactive-surface",
  "svg",
]);

/** What "Full" writes. Anything past half the box already renders as a pill. */
const FULL_RADIUS = 9999;

function plainPx(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  return /^-?\d*\.?\d+(px)?$/i.test(trimmed) ? Number.parseFloat(trimmed) : null;
}

function readPx(value: MaybeMixed<string | number | undefined>): number | null {
  return isMixed(value) ? null : plainPx(value);
}

function cornerPatch(value: string | number) {
  return Object.fromEntries(CORNER_KEYS.map((key) => [key, value]));
}

/**
 * Uniform radius, split per-corner radii, and the Full preset.
 *
 * Split state is read back off the model instead of held in component state:
 * the presence of a corner longhand *is* the split flag, so a radius an agent
 * wrote per corner opens split, and combining is what clears it.
 */
export const CornerRadiusSection = observer(({ props }: SectionProps) => {
  const { nodes, style, setStyles, removeStyles, beginEdit, endEdit, buffered } = props;
  const store = useEditorStore();
  if (nodes.length === 0 || !nodes.every((node) => ROUNDABLE_TYPES.has(node.type))) return null;

  const uniform = style("borderRadius");
  const uniformPx = readPx(uniform);
  // A value like `50%` or `8px 8px 0 0` has no numeric field; keep it editable
  // as text rather than silently rewriting it to a px number.
  const isFreeform = !isMixed(uniform) && uniform !== undefined && uniformPx === null;

  const corners = CORNER_KEYS.map((key) => style(key));
  const isSplit = corners.some((value) => value !== undefined);

  // Past half the smaller side a corner stops growing, so that is the useful
  // ceiling for the field. Multi-selections take the tightest node's limit.
  const tightest = nodes.reduce((limit, node) => {
    const half = Math.floor(Math.min(node.width, node.height) / 2);
    return Number.isFinite(half) ? Math.min(limit, Math.max(0, half)) : limit;
  }, Number.POSITIVE_INFINITY);
  const clamp = Number.isFinite(tightest) ? tightest : undefined;

  const hasRadius = isSplit || uniform !== undefined;

  const split = () => {
    const seeds = nodes.map((node) => ({
      nodeIds: [node.id],
      styles: cornerPatch(resolveNodeStyle(node, "borderRadius") ?? 0),
    }));
    beginEdit();
    // Removing `borderRadius` sweeps the corner longhands with it, so it has to
    // run before the per-corner seeds rather than inside the same patch.
    removeStyles(["borderRadius"]);
    store.runtime.updateStyles(seeds);
    endEdit();
  };

  const combine = () => {
    store.runtime.updateStyles(
      nodes.map((node) => {
        const largest = [...CORNER_KEYS, "borderRadius"].reduce((max, key) => {
          const value = plainPx(resolveNodeStyle(node, key));
          return value === null ? max : Math.max(max, value);
        }, 0);
        return { nodeIds: [node.id], styles: { borderRadius: largest } };
      }),
    );
  };

  return (
    <Section
      title="Corner radius"
      trailing={
        <>
          <IconButton
            active={isSplit}
            onClick={isSplit ? combine : split}
            title={isSplit ? "Combine corners" : "Split corners"}
          >
            <RadiusIndependentIcon size={12} />
          </IconButton>
          {hasRadius && (
            <IconButton onClick={() => removeStyles(["borderRadius"])} title="Remove corner radius">
              <TrashIcon size={12} />
            </IconButton>
          )}
        </>
      }
    >
      {isSplit ? (
        <PropertyGrid>
          {CORNER_KEYS.map((key, index) => {
            const corner = corners[index];
            const effective = corner === undefined ? uniform : corner;
            const px = readPx(effective);
            const freeformCorner = !isMixed(effective) && effective !== undefined && px === null;
            return (
              <div key={key} data-property={key} style={{ minWidth: 0 }}>
                {freeformCorner ? (
                  <MixedTextInput
                    affordance={CORNER_LABELS[key]}
                    value={effective}
                    onChange={(next) => setStyles({ [key]: next })}
                    {...buffered}
                  />
                ) : (
                  <MixedNumberInput
                    affordance={CORNER_LABELS[key]}
                    value={isMixed(effective) ? effective : (px ?? undefined)}
                    min={0}
                    max={clamp}
                    onChange={(next) => setStyles({ [key]: next })}
                    {...buffered}
                  />
                )}
              </div>
            );
          })}
        </PropertyGrid>
      ) : (
        <PropertyRow>
          <div data-property="borderRadius" style={{ flex: 1, minWidth: 0 }}>
            {isFreeform ? (
              <MixedTextInput
                affordance={<RadiusIcon size={12} />}
                value={uniform}
                onChange={(next) => setStyles({ borderRadius: next })}
                {...buffered}
              />
            ) : (
              <MixedNumberInput
                affordance={<RadiusIcon size={12} />}
                value={isMixed(uniform) ? uniform : (uniformPx ?? undefined)}
                min={0}
                max={clamp}
                onChange={(next) => setStyles({ borderRadius: next })}
                {...buffered}
              />
            )}
          </div>
          <button
            type="button"
            data-property="borderRadiusFull"
            onClick={() => setStyles({ borderRadius: FULL_RADIUS })}
            title={`Round fully (${FULL_RADIUS}px)`}
            style={{
              height: 28,
              padding: "0 10px",
              flexShrink: 0,
              border: "none",
              borderRadius: 14,
              backgroundColor: "var(--leaf-surface-app)",
              color: "var(--leaf-text-muted)",
              fontSize: 11,
              fontFamily: FONT_STACK,
              fontWeight: 500,
            }}
          >
            Full
          </button>
        </PropertyRow>
      )}
      {clamp !== undefined && (
        <div
          data-property="borderRadiusClamp"
          style={{ fontSize: 10, color: "var(--leaf-text-faint)", fontFamily: FONT_STACK }}
        >
          Max {clamp}
        </div>
      )}
    </Section>
  );
});
