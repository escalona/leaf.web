import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertIcon } from "../icons";
import { loadGoogleFont } from "../../core/fonts/loader";
import { useFontLoadState } from "./useFontLoadState";
import {
  ensureGoogleFontCatalogLoaded,
  getFontCatalogEntry,
  isGoogleFontCatalogReady,
  normalizeFontFamilyValue,
  replacePrimaryFontFamily,
} from "../../core/fonts/catalog";
import { FontPickerOverlay } from "./FontPickerOverlay";

interface FontPickerProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * True when the selection spans more than one family. The trigger shows
   * "Mixed" instead of a blank field, and picking a family applies it to the
   * whole selection.
   */
  mixed?: boolean;
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  backgroundColor: "#f7f7f5",
  border: "1px solid #d6d6d1",
  borderRadius: 6,
  color: "#353535",
  fontSize: 12,
  boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.75)",
};

export function FontPicker({ value, onChange, mixed = false }: FontPickerProps) {
  const [isCatalogReady, setIsCatalogReady] = useState(() => isGoogleFontCatalogReady());
  const [isOpen, setIsOpen] = useState(false);
  const [overlayStyle, setOverlayStyle] = useState<React.CSSProperties | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const selectedFamily = normalizeFontFamilyValue(value);
  const selectedEntry = getFontCatalogEntry(value);
  const loadFamily = selectedEntry?.family ?? selectedFamily;
  // A family the loader could not fetch renders in a fallback face. Say so
  // next to the name — the canvas alone cannot tell "this is what the font
  // looks like" from "this is what the fallback looks like".
  const loadState = useFontLoadState(mixed ? null : loadFamily);
  const isUnavailable = loadState === "unavailable";

  useEffect(() => {
    if (loadFamily) {
      void loadGoogleFont(loadFamily);
    }
  }, [loadFamily]);

  useEffect(() => {
    if (!isOpen || isCatalogReady) return;

    let cancelled = false;
    ensureGoogleFontCatalogLoaded()
      .then(() => {
        if (!cancelled) setIsCatalogReady(true);
      })
      .catch((error) => {
        console.error("Failed to load generated font catalog assets", error);
      });

    return () => {
      cancelled = true;
    };
  }, [isCatalogReady, isOpen]);

  // The overlay owns its search/highlight state and drops it on unmount, so
  // closing is just unmounting it.
  const closePicker = useCallback(() => {
    setIsOpen(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !overlayRef.current?.contains(target)) {
        closePicker();
      }
    };

    document.addEventListener("mousedown", handlePointerDown, true);
    return () => document.removeEventListener("mousedown", handlePointerDown, true);
  }, [closePicker, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updateOverlayPosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const width = Math.min(344, window.innerWidth - 24);
      const left = Math.min(Math.max(12, rect.right - width), window.innerWidth - width - 12);
      const belowTop = rect.bottom + 6;
      const belowHeight = window.innerHeight - belowTop - 12;
      const aboveHeight = rect.top - 18;
      const shouldOpenAbove = belowHeight < 280 && aboveHeight > belowHeight;

      if (shouldOpenAbove) {
        setOverlayStyle({
          position: "fixed",
          left,
          bottom: window.innerHeight - rect.top + 6,
          width,
          maxHeight: Math.min(520, aboveHeight),
          zIndex: 200,
        });
        return;
      }

      setOverlayStyle({
        position: "fixed",
        left,
        top: belowTop,
        width,
        maxHeight: Math.min(520, Math.max(220, belowHeight)),
        zIndex: 200,
      });
    };

    updateOverlayPosition();
    window.addEventListener("resize", updateOverlayPosition);
    window.addEventListener("scroll", updateOverlayPosition, true);
    return () => {
      window.removeEventListener("resize", updateOverlayPosition);
      window.removeEventListener("scroll", updateOverlayPosition, true);
    };
  }, [isOpen]);

  const commitSelection = (family: string) => {
    void loadGoogleFont(family);
    onChange(replacePrimaryFontFamily(value, family));
    closePicker();
  };

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", minWidth: 0 }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (isOpen) {
            closePicker();
            return;
          }
          setIsOpen(true);
        }}
        title={
          isUnavailable
            ? `${selectedFamily} could not be loaded; text is showing in a fallback font.`
            : undefined
        }
        style={{
          ...fieldStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          minWidth: 0,
          textAlign: "left",
          backgroundColor: isOpen ? "#ffffff" : fieldStyle.backgroundColor,
          borderColor: isOpen ? "#8cb3ff" : isUnavailable ? "#f0c36d" : "#d6d6d1",
          boxShadow: isOpen
            ? "0 0 0 2px rgba(96, 145, 255, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.82)"
            : fieldStyle.boxShadow,
        }}
      >
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {mixed ? "Mixed" : selectedFamily || "Choose a font"}
        </span>
        {isUnavailable ? (
          <span
            role="button"
            tabIndex={0}
            data-font-unavailable={loadFamily}
            aria-label={`${selectedFamily} could not be loaded. Retry`}
            title="This font could not be loaded; text is showing in a fallback font. Click to retry."
            onClick={(event) => {
              event.stopPropagation();
              if (loadFamily) void loadGoogleFont(loadFamily, { force: true });
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              if (loadFamily) void loadGoogleFont(loadFamily, { force: true });
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              padding: "1px 5px",
              borderRadius: 999,
              backgroundColor: "#fef3c7",
              color: "#92400e",
              fontSize: 10,
              fontWeight: 600,
              lineHeight: 1.4,
              flexShrink: 0,
              cursor: "pointer",
            }}
          >
            <AlertIcon size={12} />
            Unavailable
          </span>
        ) : null}
        <span style={{ color: "#7d7d76", fontSize: 10 }}>{isOpen ? "▲" : "▼"}</span>
      </button>

      {isOpen && overlayStyle ? (
        <FontPickerOverlay
          isCatalogReady={isCatalogReady}
          onClose={closePicker}
          onCommitSelection={commitSelection}
          overlayRef={overlayRef}
          overlayStyle={overlayStyle}
          selectedFamily={selectedFamily}
        />
      ) : null}
    </div>
  );
}
