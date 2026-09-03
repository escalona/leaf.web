import { observer } from "mobx-react-lite";
import { useEffect, useState, useSyncExternalStore } from "react";
import { DownloadIcon } from "../../icons";
import {
  copyNodeAsPng,
  copyNodesAsJsx,
  copyNodesAsSvg,
  type ClipboardWriter,
} from "../../export/copy-as";
import {
  getExportPreferences,
  setExportPreferences,
  subscribeToExportPreferences,
} from "../../../core/editor/export/export-preferences";
import {
  EXPORT_SCALES,
  exportNodesToFiles,
  getExportableFormats,
  isExportScaleSupported,
  type ExportScale,
  type NodeRasterizer,
} from "../../export/node-export";
import { useEditorStore } from "../../../core/state/EditorStore";
import { FONT_STACK } from "../../floating-styles";
import { PropertyRow, Section, SegmentedControl } from "../PropertyControls";
import type { SectionProps } from "./types";

const actionButtonStyle = {
  flex: 1,
  height: 26,
  minWidth: 0,
  border: "1px solid #ececec",
  borderRadius: 6,
  backgroundColor: "transparent",
  color: "var(--leaf-text-secondary)",
  fontSize: 11,
  fontFamily: FONT_STACK,
} as const;

/** One look for "you cannot click this", whether from busy or a multi-selection. */
const buttonStyle = (disabled: boolean) =>
  ({
    ...actionButtonStyle,
    color: disabled ? "#d4d4d8" : actionButtonStyle.color,
    cursor: disabled ? "not-allowed" : "default",
  }) as const;

/**
 * Scale picker. `EXPORT_SCALES` only lists factors within the shared capture
 * ceiling, so every button here is live; the `supported` check stays as a
 * guard should the two ever drift.
 */
function ScaleControl({
  value,
  onChange,
}: {
  value: ExportScale;
  onChange: (value: ExportScale) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        backgroundColor: "var(--leaf-surface-app)",
        borderRadius: 6,
        padding: 2,
        gap: 2,
        width: "100%",
      }}
    >
      {EXPORT_SCALES.map((scale) => {
        const supported = isExportScaleSupported(scale);
        const active = scale === value;
        return (
          <button
            key={scale}
            type="button"
            data-property={`exportScale-${scale}`}
            disabled={!supported}
            onClick={() => onChange(scale)}
            title={supported ? `Export at ${scale}x` : `${scale}x exceeds Leaf's capture limit`}
            style={{
              flex: 1,
              height: 24,
              border: "none",
              borderRadius: 4,
              backgroundColor: active ? "var(--leaf-surface)" : "transparent",
              color: supported
                ? active
                  ? "var(--leaf-text)"
                  : "var(--leaf-text-muted)"
                : "#d4d4d8",
              fontSize: 11,
              fontFamily: FONT_STACK,
              fontWeight: 500,
              cursor: supported ? "default" : "not-allowed",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
            }}
          >
            {scale}x
          </button>
        );
      })}
    </div>
  );
}

/**
 * Export and "copy as", the way out of the editor.
 *
 * Rasterizing and JSX generation are injectable so a test can exercise the
 * panel without a real layout pass or a system clipboard.
 */
export const ExportSection = observer(
  ({
    props,
    clipboardWriter,
    rasterize,
  }: SectionProps & { clipboardWriter?: ClipboardWriter; rasterize?: NodeRasterizer }) => {
    const store = useEditorStore();
    // Format and scale live in the shared export preferences so the keyboard
    // shortcut and the context menu export exactly what this panel shows.
    const { format, scale } = useSyncExternalStore(
      subscribeToExportPreferences,
      getExportPreferences,
      getExportPreferences,
    );
    const setFormat = (next: "png" | "svg") => setExportPreferences({ format: next });
    const setScale = (next: ExportScale) => setExportPreferences({ scale: next });
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const { nodes, isMultiple } = props;
    const selectionKey = nodes.map((node) => node.id).join(",");

    // Format and scale are preferences that should survive a selection change;
    // the status line is a report about the nodes it ran against. The section
    // stays mounted as the selection moves, so without this "Copied PNG" would
    // sit under a node that was never copied.
    useEffect(() => setStatus(null), [selectionKey]);

    if (nodes.length === 0) return null;

    const availableFormats = getExportableFormats(nodes);
    const activeFormat = availableFormats.includes(format) ? format : "png";

    const run = (label: string, task: () => Promise<unknown>) => {
      setBusy(true);
      setStatus(null);
      void task()
        .then(() => setStatus(label))
        .catch((error: unknown) =>
          setStatus(error instanceof Error ? error.message : String(error)),
        )
        .finally(() => setBusy(false));
    };

    const exportFiles = () =>
      run(`Exported ${nodes.length} ${nodes.length === 1 ? "file" : "files"}`, async () => {
        const { exported, errors } = await exportNodesToFiles(
          store,
          nodes,
          { format: activeFormat, scale },
          rasterize,
        );
        if (errors.length > 0) throw new Error(errors.join(" "));
        if (exported.length === 0) throw new Error("Nothing was exported.");
      });

    return (
      <Section title="Export">
        <PropertyRow>
          {/* A control with one option is furniture, not a control. */}
          {availableFormats.length > 1 && (
            <div data-property="exportFormat" style={{ flex: 1, minWidth: 0 }}>
              <SegmentedControl
                value={activeFormat}
                onChange={(next) => setFormat(next)}
                options={availableFormats.map((value) => ({
                  value,
                  label: value.toUpperCase(),
                }))}
              />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <ScaleControl value={scale} onChange={setScale} />
          </div>
        </PropertyRow>

        <PropertyRow>
          <button
            type="button"
            data-property="exportFiles"
            onClick={exportFiles}
            disabled={busy}
            style={{
              ...buttonStyle(busy),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              color: busy ? "#d4d4d8" : "var(--leaf-text)",
            }}
          >
            <DownloadIcon size={12} />
            Export {nodes.length > 1 ? `${nodes.length} nodes` : ""}
          </button>
        </PropertyRow>

        <PropertyRow>
          {/*
            Clipboard PNG is one node at a time — there is no shared-bounds
            capture to composite a multi-node selection into one bitmap. Greying
            it out says so up front instead of letting the click come back as an
            error, the same way the name field greys out for a multi-selection.
          */}
          <button
            type="button"
            data-property="copyPng"
            onClick={() =>
              run("Copied PNG", () =>
                copyNodeAsPng(store, nodes, scale, clipboardWriter, rasterize),
              )
            }
            disabled={busy || isMultiple}
            title={
              isMultiple
                ? "Copy PNG captures one node at a time. Select a single node or frame."
                : undefined
            }
            style={buttonStyle(busy || isMultiple)}
          >
            Copy PNG
          </button>
          {availableFormats.includes("svg") && (
            <button
              type="button"
              data-property="copySvg"
              onClick={() => run("Copied SVG", () => copyNodesAsSvg(nodes, clipboardWriter))}
              disabled={busy}
              style={buttonStyle(busy)}
            >
              Copy SVG
            </button>
          )}
          <button
            type="button"
            data-property="copyJsx"
            onClick={() => run("Copied JSX", () => copyNodesAsJsx(nodes, clipboardWriter))}
            disabled={busy}
            style={buttonStyle(busy)}
          >
            Copy JSX
          </button>
        </PropertyRow>

        {status && (
          <div
            data-property="exportStatus"
            style={{
              fontSize: 10,
              color: "var(--leaf-text-muted)",
              fontFamily: FONT_STACK,
              lineHeight: 1.4,
            }}
          >
            {status}
          </div>
        )}
      </Section>
    );
  },
);
