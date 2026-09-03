import { observer } from "mobx-react-lite";
import { useState } from "react";
import { LinkIcon, UnlinkIcon } from "../../icons";
import {
  IconButton,
  MixedNumberInput,
  MixedSelect,
  MixedTextInput,
  PropertyGrid,
  PropertyRow,
  Section,
} from "../PropertyControls";
import { isMixed, type MaybeMixed } from "../selection-properties";
import { useEditorStore } from "../../../core/state/EditorStore";
import type { DesignNode, ImageAssetRef } from "../../../core/types";
import { FONT_STACK } from "../../floating-styles";
import { everyType, type SectionProps } from "./types";

const OBJECT_FITS = [
  { label: "Contain", value: "contain" },
  { label: "Cover", value: "cover" },
  { label: "Fill", value: "fill" },
  { label: "None", value: "none" },
  { label: "Scale down", value: "scale-down" },
];

/** What `ImageRenderer` falls back to, so the panel shows the effective value. */
const DEFAULT_OBJECT_FIT = "contain";
const DEFAULT_OBJECT_POSITION = "left top";

const HORIZONTAL = ["left", "center", "right"] as const;
const VERTICAL = ["top", "center", "bottom"] as const;

function plainPx(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  return /^-?\d*\.?\d+(px)?$/i.test(trimmed) ? Number.parseFloat(trimmed) : null;
}

function readPx(value: MaybeMixed<string | number | undefined>): number | null {
  return isMixed(value) ? null : plainPx(value);
}

/**
 * Collapse an `object-position` to one of the nine keyword cells, or null when
 * it is a length/percentage the focal grid cannot represent.
 */
export function focalCell(value: string): { x: string; y: string } | null {
  const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 2) return null;

  let x: string | null = null;
  let y: string | null = null;
  for (const token of tokens) {
    if (token === "left" || token === "right") {
      if (x !== null) return null;
      x = token;
    } else if (token === "top" || token === "bottom") {
      if (y !== null) return null;
      y = token;
    } else if (token !== "center") {
      return null;
    }
  }
  // A lone `center` (or the leftover axis of `left`/`top`) centers the rest.
  return { x: x ?? "center", y: y ?? "center" };
}

/** Aspect ratio to preserve while the lock is on. */
function ratioOf(node: DesignNode): number {
  if (node.width > 0 && node.height > 0) return node.width / node.height;
  const asset = node.imageAsset;
  if (asset && asset.width > 0 && asset.height > 0) return asset.width / asset.height;
  return 1;
}

/**
 * Image fit, focal point, and size against the asset's intrinsic dimensions.
 *
 * The fit/position fallbacks here are Leaf's renderer defaults rather than the
 * CSS ones, so the control has to show the effective value or it would read as
 * unset while the image is visibly cropped.
 */
export const ImageSection = observer(({ props }: SectionProps) => {
  const { nodes, primary, isMultiple, style, field, setStyles, buffered } = props;
  const store = useEditorStore();
  const [lockRatio, setLockRatio] = useState(true);
  if (!everyType(nodes, "image")) return null;

  const objectFit = style("objectFit");
  const objectPosition = style("objectPosition");
  const positionValue = isMixed(objectPosition)
    ? null
    : ((objectPosition as string | undefined) ?? DEFAULT_OBJECT_POSITION);
  const cell = positionValue === null ? null : focalCell(positionValue);

  const widthStyle = style("width");
  const heightStyle = style("height");
  const width = widthStyle === undefined ? field("width") : widthStyle;
  const height = heightStyle === undefined ? field("height") : heightStyle;
  const widthPx = readPx(width);
  const heightPx = readPx(height);

  const assets = nodes
    .map((node) => node.imageAsset)
    .filter((asset): asset is ImageAssetRef => asset != null);
  const first = assets[0];
  const intrinsic =
    first &&
    assets.length === nodes.length &&
    assets.every((asset) => asset.width === first.width && asset.height === first.height)
      ? first
      : null;

  const applyDimension = (axis: "width" | "height", next: number) => {
    if (!lockRatio) {
      setStyles({ [axis]: next });
      return;
    }
    // Each node keeps its own ratio, so a mixed-size selection scales rather
    // than collapsing onto the primary's proportions.
    store.runtime.updateStyles(
      nodes.map((node) => {
        const ratio = ratioOf(node);
        return {
          nodeIds: [node.id],
          styles:
            axis === "width"
              ? { width: next, height: Math.round(next / ratio) }
              : { height: next, width: Math.round(next * ratio) },
        };
      }),
    );
  };

  const resetToIntrinsic = () => {
    store.runtime.updateStyles(
      nodes
        .filter((node) => node.imageAsset)
        .map((node) => ({
          nodeIds: [node.id],
          styles: { width: node.imageAsset!.width, height: node.imageAsset!.height },
        })),
    );
  };

  return (
    <Section title="Image">
      <PropertyRow>
        <div data-property="objectFit" style={{ flex: 1, minWidth: 0 }}>
          <MixedSelect
            value={objectFit ?? DEFAULT_OBJECT_FIT}
            onChange={(next) => setStyles({ objectFit: next })}
            options={OBJECT_FITS}
            {...buffered}
          />
        </div>
      </PropertyRow>

      <div style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 6 }}>
        <div
          data-property="objectPositionGrid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 18px)",
            gridTemplateRows: "repeat(3, 18px)",
            gap: 2,
            flexShrink: 0,
          }}
        >
          {VERTICAL.map((y) =>
            HORIZONTAL.map((x) => {
              const active = cell?.x === x && cell?.y === y;
              return (
                <button
                  key={`${x}-${y}`}
                  type="button"
                  data-focal={`${x} ${y}`}
                  title={`${x} ${y}`}
                  onClick={() => setStyles({ objectPosition: `${x} ${y}` })}
                  style={{
                    width: 18,
                    height: 18,
                    padding: 0,
                    border: "none",
                    borderRadius: 3,
                    // Kept literal: ImageSection.test.tsx identifies the active
                    // focal cell by this computed rgb value.
                    backgroundColor: active ? "#3b82f6" : "var(--leaf-surface-app)",
                  }}
                />
              );
            }),
          )}
        </div>
        <div data-property="objectPosition" style={{ flex: 1, minWidth: 0 }}>
          <MixedTextInput
            value={isMixed(objectPosition) ? objectPosition : (positionValue ?? undefined)}
            monospace
            onChange={(next) => setStyles({ objectPosition: next })}
            {...buffered}
          />
        </div>
      </div>

      <PropertyGrid>
        <div data-property="imageWidth" style={{ minWidth: 0 }}>
          {!isMixed(width) && width !== undefined && widthPx === null ? (
            <MixedTextInput
              affordance="W"
              value={width}
              onChange={(next) => setStyles({ width: next })}
              {...buffered}
            />
          ) : (
            <MixedNumberInput
              affordance="W"
              value={isMixed(width) ? width : (widthPx ?? undefined)}
              min={1}
              onChange={(next) => applyDimension("width", next)}
              {...buffered}
            />
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          <div data-property="imageHeight" style={{ flex: 1, minWidth: 0 }}>
            {!isMixed(height) && height !== undefined && heightPx === null ? (
              <MixedTextInput
                affordance="H"
                value={height}
                onChange={(next) => setStyles({ height: next })}
                {...buffered}
              />
            ) : (
              <MixedNumberInput
                affordance="H"
                value={isMixed(height) ? height : (heightPx ?? undefined)}
                min={1}
                onChange={(next) => applyDimension("height", next)}
                {...buffered}
              />
            )}
          </div>
          <IconButton
            active={lockRatio}
            onClick={() => setLockRatio((locked) => !locked)}
            title={lockRatio ? "Unlock aspect ratio" : "Lock aspect ratio"}
          >
            {lockRatio ? <LinkIcon size={12} /> : <UnlinkIcon size={12} />}
          </IconButton>
        </div>
      </PropertyGrid>

      {intrinsic && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 6,
            fontSize: 10,
            color: "var(--leaf-text-faint)",
            fontFamily: FONT_STACK,
          }}
        >
          <span data-property="intrinsicSize">
            Original {intrinsic.width} × {intrinsic.height}
          </span>
          <button
            type="button"
            data-property="resetIntrinsicSize"
            onClick={resetToIntrinsic}
            title="Resize to the image's original dimensions"
            style={{
              padding: 0,
              border: "none",
              background: "transparent",
              color: "var(--leaf-text-muted)",
              fontSize: 10,
              fontFamily: FONT_STACK,
              textDecoration: "underline",
            }}
          >
            Reset
          </button>
        </div>
      )}
      {!intrinsic && !isMultiple && primary.imageAsset == null && (
        <div style={{ fontSize: 10, color: "var(--leaf-text-faint)", fontFamily: FONT_STACK }}>
          No asset metadata
        </div>
      )}
    </Section>
  );
});
