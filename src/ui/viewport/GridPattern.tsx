import { reaction } from "mobx";
import { useLayoutEffect, useRef } from "react";
import { useEditorStore } from "../../core/state/EditorStore";

/** Subtle dot grid for spatial reference. */
export function GridPattern() {
  const store = useEditorStore();
  const elementRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(
    () =>
      reaction(
        () => ({
          isPanning: store.isPanning,
          isZooming: store.isZooming,
          panX: store.panX,
          panY: store.panY,
          zoom: store.zoom,
        }),
        ({ isPanning, isZooming, panX, panY, zoom }) => {
          const element = elementRef.current;
          if (!element) return;
          if (isZooming || zoom < 0.3) {
            element.style.display = "none";
            element.style.willChange = "";
            return;
          }
          const gridSize = 20;
          const dotSize = 1;
          const opacity = Math.min(0.3, zoom * 0.15);
          const tileSize = gridSize * zoom;
          const offsetX = ((panX % tileSize) + tileSize) % tileSize;
          const offsetY = ((panY % tileSize) + tileSize) % tileSize;
          element.style.display = "block";
          element.style.inset = `${-tileSize}px`;
          element.style.backgroundImage = `radial-gradient(circle, rgba(0,0,0,${opacity}) ${dotSize}px, transparent ${dotSize}px)`;
          element.style.backgroundSize = `${tileSize}px ${tileSize}px`;
          element.style.backgroundPosition = "0 0";
          element.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0)`;
          element.style.willChange = isPanning ? "transform" : "";
        },
        { fireImmediately: true },
      ),
    [store],
  );

  return <div ref={elementRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />;
}
