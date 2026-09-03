import { reaction } from "mobx";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useEditorStore } from "../../core/state/EditorStore";

export function CameraLayer({
  children,
  suppressNativeSelection,
}: {
  children: ReactNode;
  suppressNativeSelection: boolean;
}) {
  const store = useEditorStore();
  const elementRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const dispose = reaction(
      () => ({
        isPanning: store.isPanning,
        isZooming: store.isZooming,
        transform: store.cssTransform3d,
      }),
      ({ isPanning, isZooming, transform }) => {
        const element = elementRef.current;
        if (!element) return;
        element.style.transform = transform;
        // Transient promotion scales the cached raster during zoom. Removing
        // the hint on settle lets Chrome repaint the DOM sharply at final scale.
        element.style.willChange = isZooming || isPanning ? "transform" : "";
      },
      { fireImmediately: true },
    );
    return dispose;
  }, [store]);

  return (
    <div
      ref={elementRef}
      data-camera-layer
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        zIndex: 1,
        transformOrigin: "0 0",
        userSelect: suppressNativeSelection ? "none" : undefined,
        WebkitUserSelect: suppressNativeSelection ? "none" : undefined,
      }}
    >
      {children}
    </div>
  );
}
