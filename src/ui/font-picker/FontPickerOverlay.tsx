import { SearchIcon } from "../icons";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  getFontPreviewStack,
  getGoogleFontCatalog,
  searchGoogleFontCatalog,
} from "../../core/fonts/catalog";
import { FontPreviewRow } from "./FontPreviewRow";

export function FontPickerOverlay({
  isCatalogReady,
  onClose,
  onCommitSelection,
  overlayRef,
  overlayStyle,
  selectedFamily,
}: {
  isCatalogReady: boolean;
  onClose: () => void;
  onCommitSelection: (family: string) => void;
  overlayRef: RefObject<HTMLDivElement | null>;
  overlayStyle: CSSProperties;
  selectedFamily: string;
}) {
  const [query, setQuery] = useState("");
  const [activeFamily, setActiveFamily] = useState<string | null>(null);
  const [hoveredFamily, setHoveredFamily] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Starts true so the freshly opened overlay scrolls to the selected entry.
  const shouldAutoScrollRef = useRef(true);

  const results = useMemo(
    // isCatalogReady flips when the async catalog load lands mid-open.
    () => searchGoogleFontCatalog(deferredQuery, getGoogleFontCatalog().length, selectedFamily),
    [deferredQuery, isCatalogReady, selectedFamily],
  );

  const activeEntry =
    results.find((entry) => entry.family === activeFamily) ??
    results.find((entry) => entry.family === selectedFamily) ??
    results[0] ??
    null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    const activeIndex = activeEntry
      ? results.findIndex((entry) => entry.family === activeEntry.family)
      : -1;
    if (activeIndex < 0) return;
    shouldAutoScrollRef.current = false;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeEntry, results]);

  const moveActiveEntry = (direction: -1 | 1) => {
    if (results.length === 0) return;
    const currentIndex =
      activeEntry === null
        ? 0
        : Math.max(
            results.findIndex((entry) => entry.family === activeEntry.family),
            0,
          );
    const nextIndex = Math.max(0, Math.min(currentIndex + direction, results.length - 1));
    shouldAutoScrollRef.current = true;
    setHoveredFamily(null);
    setActiveFamily(results[nextIndex]?.family ?? null);
  };

  return createPortal(
    <div
      ref={overlayRef}
      style={{
        ...overlayStyle,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#ffffff",
        border: "1px solid rgba(196, 196, 188, 0.9)",
        borderRadius: 10,
        boxShadow: "0 18px 48px rgba(28, 28, 24, 0.18), 0 2px 10px rgba(28, 28, 24, 0.08)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "10px 10px 6px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 10px",
            height: 32,
            borderRadius: 6,
            border: "2px solid #8cb3ff",
            boxShadow: "0 0 0 1px rgba(96, 145, 255, 0.1)",
            backgroundColor: "#ffffff",
          }}
        >
          <SearchIcon size={12} style={{ display: "block", color: "#7c828c", flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            aria-label="Search fonts"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              shouldAutoScrollRef.current = true;
              setActiveFamily(null);
              setHoveredFamily(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActiveEntry(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActiveEntry(-1);
              } else if (event.key === "Enter" && activeEntry) {
                event.preventDefault();
                onCommitSelection(activeEntry.family);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Search fonts"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "#4265a8",
              fontSize: 13,
              fontWeight: 500,
              padding: 0,
            }}
          />
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "0 0 8px",
        }}
      >
        {!isCatalogReady ? (
          <div
            style={{
              padding: "14px 14px 16px",
              color: "#7f7f7f",
              fontSize: 12,
            }}
          >
            Loading generated font previews...
          </div>
        ) : results.length === 0 ? (
          <div
            style={{
              padding: "14px 14px 16px",
              color: "#7f7f7f",
              fontSize: 12,
            }}
          >
            No fonts match "{deferredQuery.trim()}".
          </div>
        ) : (
          results.map((entry, index) => {
            const isSelected = entry.family === selectedFamily;
            const isActive =
              hoveredFamily === null
                ? entry.family === activeEntry?.family
                : entry.family === hoveredFamily;

            return (
              <button
                key={entry.family}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                onMouseEnter={() => setHoveredFamily(entry.family)}
                onMouseLeave={() => setHoveredFamily(null)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onCommitSelection(entry.family)}
                style={{
                  width: "100%",
                  padding: "8px 14px",
                  border: "none",
                  borderRadius: 0,
                  backgroundColor: isSelected ? "#dfdfdf" : isActive ? "#f4f4f1" : "transparent",
                  color: "#2f2f2a",
                  textAlign: "left",
                }}
              >
                <FontPreviewRow
                  entry={entry}
                  fallbackFontFamily={
                    entry.family === selectedFamily ? getFontPreviewStack(entry.family) : undefined
                  }
                />
              </button>
            );
          })
        )}
      </div>
    </div>,
    document.body,
  );
}
