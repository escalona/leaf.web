import {
  CommentIcon,
  FrameIcon,
  PanIcon,
  PenIcon,
  RectangleIcon,
  SelectIcon,
  TextIcon,
  type IconComponent,
} from "../icons";
import type { ToolMode } from "../../core/types";
import type { ImageGenerationReference } from "../../core/editor/image-generation-client";

export const DEFAULT_IMAGE_GENERATION_COUNT = 1;

export const toolbarTools: {
  mode: ToolMode;
  label: string;
  shortcut: string;
  icon: IconComponent;
}[] = [
  { mode: "select", label: "Select", shortcut: "V", icon: SelectIcon },
  { mode: "pan", label: "Pan", shortcut: "H", icon: PanIcon },
  { mode: "frame", label: "Frame", shortcut: "F", icon: FrameIcon },
  { mode: "rectangle", label: "Rectangle", shortcut: "R", icon: RectangleIcon },
  { mode: "text", label: "Text", shortcut: "T", icon: TextIcon },
  { mode: "ink", label: "Ink", shortcut: "I", icon: PenIcon },
  { mode: "comment", label: "Comment", shortcut: "C", icon: CommentIcon },
];

export type ImageGenerationReferencePreview = ImageGenerationReference & {
  width: number;
  height: number;
};
