import { observer } from "mobx-react-lite";
import { Section } from "../PropertyControls";
import { resolveNodeStyle } from "../selection-properties";
import { useEditorStore } from "../../../core/state/EditorStore";
import { PropertyCheckbox } from "./LayoutSection";
import { isBoxLike, type SectionProps } from "./types";
import type { DesignNode } from "../../../core/types";

const CLIPPING_VALUES = new Set(["hidden", "clip", "auto", "scroll"]);

/** Every spelling that can make a node clip, so none of them goes unread. */
const OVERFLOW_KEYS = ["overflow", "overflowX", "overflowY"];

/**
 * Whether a node clips its content.
 *
 * `overflow` takes one or two values (`hidden auto`), and the axis longhands
 * override it, so all three keys have to be read: an agent-authored
 * `overflow-y: hidden` is otherwise invisible here and would survive an
 * uncheck as a dead key that keeps clipping.
 */
function clips(node: DesignNode): boolean {
  const values = OVERFLOW_KEYS.flatMap((key) => {
    const value = resolveNodeStyle(node, key);
    return value === undefined ? [] : String(value).trim().split(/\s+/);
  });
  if (values.length === 0) return node.isArtboard;
  return values.some((value) => CLIPPING_VALUES.has(value));
}

/**
 * Clip content — `overflow: hidden`.
 *
 * Unchecking removes the key so nothing dead is left in the styles map, except
 * on an artboard, where the renderer clips by default: there the un-clipped
 * state only exists as an explicit `visible`. Writes fan out per node so a
 * mixed artboard/frame selection does not push the artboard's spelling onto
 * the frames.
 */
export const ClipContentSection = observer(({ props }: SectionProps) => {
  const store = useEditorStore();
  const { nodes } = props;
  if (!isBoxLike(nodes)) return null;

  const perNode = nodes.map(clips);
  const clipped = perNode.every(Boolean);
  const indeterminate = !clipped && perNode.some(Boolean);

  const apply = (next: boolean) => {
    store.beginHistoryTransaction();
    try {
      for (const node of nodes) {
        store.runtime.updateStyles([
          {
            nodeIds: [node.id],
            // The other spellings are always cleared, or a leftover longhand
            // silently outvotes the shorthand this control just wrote.
            styles: {
              overflow: next ? "hidden" : node.isArtboard ? "visible" : null,
              overflowX: null,
              overflowY: null,
            },
          },
        ]);
      }
    } finally {
      store.endHistoryTransaction();
    }
  };

  return (
    <Section title="Clip content">
      <PropertyCheckbox
        label="Clip content"
        checked={clipped}
        indeterminate={indeterminate}
        onChange={apply}
      />
    </Section>
  );
});
