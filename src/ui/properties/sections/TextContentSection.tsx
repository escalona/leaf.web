import { observer } from "mobx-react-lite";
import {
  getAnchoredTextSizePatch,
  measurePlainTextForElement,
} from "../../../core/editor/text-measure";
import { useEditorStore } from "../../../core/state/EditorStore";
import { Section, Textarea } from "../PropertyControls";
import { everyType, type SectionProps } from "./types";

/**
 * The text a node renders, editable without entering the canvas editor.
 *
 * Single-selection only: two nodes cannot share one string, and a shared
 * textarea would silently flatten them into the first node's content.
 */
export const TextContentSection = observer(({ props }: SectionProps) => {
  const store = useEditorStore();
  const { nodes, primary, isMultiple, buffered } = props;
  if (isMultiple || !everyType(nodes, "text")) return null;

  const setContent = (content: string) => {
    store.runtime.setTextContent([{ nodeId: primary.id, textContent: content }]);

    // The canvas editor re-measures on every keystroke; typing here has to do
    // the same or the node keeps the box its old string needed and clips.
    const element = store.domIndex.getElement(primary);
    if (!element) return;
    const measured = measurePlainTextForElement(element, content, {
      maxWidth: primary.textAutoSize ? null : primary.width,
    });
    store.runtime.updateNode(
      primary.id,
      getAnchoredTextSizePatch(
        primary,
        primary.textAutoSize ? measured : { width: primary.width, height: measured.height },
      ),
    );
  };

  return (
    <Section title="Content">
      <Textarea value={primary.content} onChange={setContent} {...buffered} />
    </Section>
  );
});
