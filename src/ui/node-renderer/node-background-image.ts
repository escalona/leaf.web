import { useEffect, type CSSProperties } from "react";
import { buildLocalAssetSrc } from "../../core/state/image-assets";
import { useImageAssetUrl } from "../../core/state/use-image-asset-url";
import type { DesignNode } from "../../core/types";

function isAssetBackedBackground(node: DesignNode) {
  if (!node.imageAsset || typeof node.styles.backgroundImage !== "string") return false;
  const source = node.imageAsset.src ?? buildLocalAssetSrc(node.imageAsset.assetId);
  return node.styles.backgroundImage.includes(source);
}

/** Resolve a persisted content-addressed background asset into a browser URL. */
export function useResolvedNodeBackgroundImage(node: DesignNode, style: CSSProperties) {
  const usesBackgroundAsset = isAssetBackedBackground(node);
  const { url, handleImageLoad, handleImageLoadError } = useImageAssetUrl(
    usesBackgroundAsset ? node.imageAsset : null,
  );

  useEffect(() => {
    if (!usesBackgroundAsset || !url) return;
    const image = new Image();
    image.onload = handleImageLoad;
    image.onerror = handleImageLoadError;
    image.src = url;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [handleImageLoad, handleImageLoadError, url, usesBackgroundAsset]);

  if (!usesBackgroundAsset) return;
  style.backgroundImage = url ? `url(${JSON.stringify(url)})` : "none";
}
