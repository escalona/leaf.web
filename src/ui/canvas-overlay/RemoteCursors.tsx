import { CURSORS, CURSOR_HALO } from "../icons";
import { useEffect, useLayoutEffect, useRef } from "react";
import { RemoteCursorInterpolator, type RemoteCursorSample } from "./remote-cursor-interpolation";

// Leaf's pointer from the icon set's cursor family, translated so the tip sits on the peer's point.
const POINTER_PATH = CURSORS.pointer.body
  .replace(/^<path d="/, "")
  .replace(/"\/>$/, "")
  .replace(/M2 2 /, "M0 0 ")
  .replace(
    /L([\d.]+) ([\d.]+)/g,
    (_m, x: string, y: string) => `L${Number(x) - 2} ${Number(y) - 2}`,
  );
const POINTER_HALO = CURSOR_HALO * 2;

export interface RemoteCursorPeer {
  sessionId: string;
  color: string;
  label: string;
  cursor: RemoteCursorSample | null;
}

/**
 * Remote collaborator cursors, positioned outside the React render path.
 *
 * React owns mount/unmount and the zoom-dependent chrome (an inner group
 * counter-scales the glyph); each cursor's canvas position is eased toward its
 * latest network target by a requestAnimationFrame loop that writes the outer
 * group's transform directly. The outer group must therefore never receive a
 * React-rendered transform, or re-renders would clobber the animated position.
 */
export function RemoteCursors({
  peers,
  zoom,
}: {
  peers: readonly RemoteCursorPeer[];
  zoom: number;
}) {
  const interpolatorRef = useRef<RemoteCursorInterpolator | null>(null);
  interpolatorRef.current ??= new RemoteCursorInterpolator();
  const elementsRef = useRef(new Map<string, SVGGElement>());
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const applyPositions = () => {
    for (const [sessionId, element] of elementsRef.current) {
      const position = interpolatorRef.current!.positionOf(sessionId);
      if (position) element.setAttribute("transform", `translate(${position.x} ${position.y})`);
    }
  };

  const tick = (timestamp: number) => {
    frameRef.current = null;
    const dtMs = lastFrameAtRef.current === null ? 1000 / 60 : timestamp - lastFrameAtRef.current;
    lastFrameAtRef.current = timestamp;
    const moving = interpolatorRef.current!.step(dtMs, zoomRef.current);
    applyPositions();
    if (moving) {
      frameRef.current = requestAnimationFrame(tick);
    } else {
      lastFrameAtRef.current = null;
    }
  };

  useLayoutEffect(() => {
    const interpolator = interpolatorRef.current!;
    const live = new Set<string>();
    let changed = false;
    for (const peer of peers) {
      if (!peer.cursor) continue;
      live.add(peer.sessionId);
      changed = interpolator.setTarget(peer.sessionId, peer.cursor, zoomRef.current) || changed;
    }
    interpolator.prune(live);
    // Re-renders without new cursor samples (pan, zoom, selection) skip the
    // repaint and the frame kick — the translate is zoom-independent, and any
    // in-flight glide is already sustained by the frame loop.
    if (!changed) return;
    // Newly mounted cursors get their position before first paint; gliding ones
    // are advanced by the frame loop.
    applyPositions();
    if (frameRef.current === null && typeof requestAnimationFrame === "function") {
      frameRef.current = requestAnimationFrame(tick);
    }
  });

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    [],
  );

  return (
    <>
      {peers.map((peer) =>
        peer.cursor ? (
          <g
            key={peer.sessionId}
            data-remote-cursor={peer.sessionId}
            pointerEvents="none"
            ref={(element) => {
              if (element) elementsRef.current.set(peer.sessionId, element);
              else elementsRef.current.delete(peer.sessionId);
            }}
          >
            <g transform={`scale(${1 / zoom})`}>
              <path
                d={POINTER_PATH}
                fill="#ffffff"
                stroke="#ffffff"
                strokeWidth={POINTER_HALO}
                strokeLinejoin="round"
              />
              <path d={POINTER_PATH} fill={peer.color} />
              <rect
                x={14}
                y={15}
                width={Math.max(48, peer.label.length * 7 + 16)}
                height={24}
                rx={6}
                fill={peer.color}
              />
              <text
                x={22}
                y={27}
                fill="#fff"
                fontFamily="Inter, system-ui, sans-serif"
                fontSize={12}
                dominantBaseline="middle"
              >
                {peer.label}
              </text>
            </g>
          </g>
        ) : null,
      )}
    </>
  );
}
