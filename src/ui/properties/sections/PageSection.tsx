import { useSyncExternalStore } from "react";
import { reaction } from "mobx";
import { ResetIcon } from "../../icons";
import { observer } from "mobx-react-lite";
import { ColorField, IconButton, PropertyRow, Section } from "../PropertyControls";
import { parseColor } from "../../../core/editor/paint/color";
import { useEditorStore, type EditorStore } from "../../../core/state/EditorStore";
import { DEFAULT_CANVAS_BACKGROUND, resolvePageBackground } from "../../../core/state/document";

/**
 * The page background is a document value: `EditorPage.background`, carried
 * on the wire as `LeafPageRecord.background` through the same `set-pages`
 * mutation that renames and reorders pages, so it persists, syncs to peers,
 * and takes part in history like any other page edit.
 *
 * Only a colour that parses is ever written. The hex field keeps its own
 * draft while it is being typed (see `ColorField`), so `#f2` on the way to
 * `#f2f2f2` never reaches the document, where it would paint as transparent.
 */

/** The colour painted behind the given page's artboards. */
export function getPageBackground(store: EditorStore, pageId = store.activePageId): string {
  const page = store.pages.find((candidate) => candidate.id === pageId);
  return resolvePageBackground(page?.background);
}

/**
 * Durable page-background write through `EditorRuntime`, so MCP and the UI
 * share one mutation and one history step. `null` restores the default.
 */
export function setPageBackground(
  store: EditorStore,
  pageId: string,
  background: string | null,
): void {
  const color = background?.trim() ?? "";
  if (color && !parseColor(color)) {
    throw new Error(`"${background}" is not a colour.`);
  }
  const next = color && color !== DEFAULT_CANVAS_BACKGROUND ? color : null;
  const page = store.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`Page ${pageId} does not exist`);
  if ((page.background ?? null) === next) return;
  store.runtime.setPageBackground(pageId, next);
}

function subscribeToPageBackground(store: EditorStore, listener: () => void) {
  return reaction(() => getPageBackground(store), listener);
}

/**
 * The active page's stored background and its durable setter. The value is
 * what the document holds — never a half-typed draft, which `ColorField`
 * keeps to itself.
 */
export function useCanvasBackground(store: EditorStore) {
  const value = useSyncExternalStore(
    (listener) => subscribeToPageBackground(store, listener),
    () => getPageBackground(store),
    () => getPageBackground(store),
  );
  return [value, (next: string) => setPageBackground(store, store.activePageId, next)] as const;
}

/**
 * The colour actually on the canvas. Anything deriving contrast from the page
 * (labels, overlays) reads this; it only ever changes to a colour that parsed.
 */
export function usePaintedCanvasBackground(store: EditorStore) {
  return useSyncExternalStore(
    (listener) => subscribeToPageBackground(store, listener),
    () => getPageBackground(store),
    () => getPageBackground(store),
  );
}

/**
 * The no-selection inspector, the `Page` panel: one colour for
 * the canvas behind the artboards.
 */
export const PageSection = observer(() => {
  const store = useEditorStore();
  const [background, setBackground] = useCanvasBackground(store);
  const isDefault = background === DEFAULT_CANVAS_BACKGROUND;

  return (
    <Section
      title="Page"
      bordered={false}
      trailing={
        !isDefault ? (
          <IconButton
            onClick={() => setBackground(DEFAULT_CANVAS_BACKGROUND)}
            title="Reset page background"
          >
            <ResetIcon size={12} />
          </IconButton>
        ) : undefined
      }
    >
      <div data-property="canvasBackground">
        <PropertyRow>
          <ColorField value={background} onChange={setBackground} />
        </PropertyRow>
      </div>
    </Section>
  );
});
