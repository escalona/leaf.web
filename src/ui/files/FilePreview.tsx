import type { FileNavigationEntry } from "../../core/state/file-navigation";

export function FilePreview({ file }: { file: FileNavigationEntry }) {
  return (
    <div className="relative h-40 overflow-hidden rounded-md bg-surface-sunken">
      {file.thumbnailUrl ? (
        <img
          src={file.thumbnailUrl}
          alt=""
          loading="lazy"
          draggable={false}
          // Contain-fit shows the whole page like a mini-canvas; a cover crop
          // of a downscaled wide page reads as a blurry slice.
          className="absolute inset-0 h-full w-full object-contain"
        />
      ) : null}
    </div>
  );
}
