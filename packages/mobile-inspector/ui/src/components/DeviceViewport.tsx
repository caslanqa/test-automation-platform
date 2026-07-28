import { useLayoutEffect, useRef, useState } from 'react';

import type { ClientMessage, MobileNode, ScreenFrameMeta } from '../protocol';

interface DeviceViewportProps {
  frame: ScreenFrameMeta | null;
  hierarchy: MobileNode[];
  connecting: boolean;
  send: (message: ClientMessage) => void;
  /** Right-click: report the screen anchor so the parent can position the locator menu. */
  onContextMenu: (anchor: { x: number; y: number }) => void;
  /** Identity of the tree selection, re-resolved here each render so the box tracks the live tree. */
  selectedKey: string | null;
}

/**
 * Renders the latest device screenshot. Left-click records a tap; right-click asks the main process
 * to hit-test the point and returns ranked locator candidates (surfaced by the parent as a context
 * menu). Click coordinates are converted from on-screen CSS pixels to the driver's interaction
 * coordinate space.
 *
 * The frame's on-screen box is computed explicitly in JS (via `ResizeObserver`) rather than relying
 * on CSS `aspect-ratio` inside a flex container: a flex item's `aspect-ratio` only resolves reliably
 * when at least one axis has a definite size, which isn't guaranteed here (the container's cross size
 * depends on layout, and the image itself is sized as a percentage of the frame — a circular
 * reference). That combination silently produced a rendered image box that didn't match the
 * percentage math used for coordinate translation and the highlight overlay, so clicks landed on the
 * wrong device pixel and the highlight box drifted from the real element. Computing an explicit
 * `{ width, height }` in pixels and applying it directly removes the ambiguity: the frame div, the
 * image, and the overlay math are all guaranteed to agree.
 */
export function DeviceViewport({
  frame,
  hierarchy,
  connecting,
  send,
  onContextMenu,
  selectedKey,
}: DeviceViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const gestureRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [hoverNode, setHoverNode] = useState<MobileNode | null>(null);
  const [renderSize, setRenderSize] = useState<{ width: number; height: number } | null>(null);

  // Recompute the rendered frame box whenever the container resizes or a new frame changes the
  // device's native aspect ratio (e.g. orientation change).
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !frame || !frame.width || !frame.height) {
      setRenderSize(null);
      return;
    }
    const compute = (): void => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (!cw || !ch) {
        return;
      }
      const scale = Math.min(cw / frame.width, ch / frame.height);
      setRenderSize({ width: frame.width * scale, height: frame.height * scale });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [frame?.width, frame?.height]);

  function toDeviceCoords(event: {
    clientX: number;
    clientY: number;
  }): { x: number; y: number } | null {
    const img = imgRef.current;
    if (!img || !frame) {
      return null;
    }
    const rect = img.getBoundingClientRect();
    const scaleX = (frame.coordinateWidth ?? frame.width) / rect.width;
    const scaleY = (frame.coordinateHeight ?? frame.height) / rect.height;
    return {
      x: Math.round((event.clientX - rect.left) * scaleX),
      y: Math.round((event.clientY - rect.top) * scaleY),
    };
  }

  function onPointerDown(event: React.PointerEvent<HTMLImageElement>): void {
    if (event.button !== 0) {
      return;
    }
    gestureRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerUp(event: React.PointerEvent<HTMLImageElement>): void {
    const start = gestureRef.current;
    gestureRef.current = null;
    if (!start || start.pointerId !== event.pointerId || !frame) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const dx = event.clientX - start.clientX;
    const dy = event.clientY - start.clientY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 16) {
      const point = toDeviceCoords(event);
      if (point) {
        send({ type: 'tapAt', x: point.x, y: point.y, frameId: frame.frameId });
      }
      return;
    }
    const direction =
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    send({ type: 'perform', action: { kind: 'swipe', direction } });
  }

  function onPointerCancel(event: React.PointerEvent<HTMLImageElement>): void {
    if (gestureRef.current?.pointerId === event.pointerId) {
      gestureRef.current = null;
    }
  }

  function onContext(event: React.MouseEvent<HTMLImageElement>): void {
    event.preventDefault();
    const p = toDeviceCoords(event);
    if (p && frame) {
      send({ type: 'inspectAt', x: p.x, y: p.y, frameId: frame.frameId });
      onContextMenu({ x: event.clientX, y: event.clientY });
    }
  }

  function onMouseMove(event: React.MouseEvent<HTMLImageElement>): void {
    const p = toDeviceCoords(event);
    if (p) {
      setHoverNode(findSmallestNodeAt(hierarchy, p.x, p.y));
    }
  }

  const selectedNode = selectedKey ? findByKey(hierarchy, selectedKey) : undefined;
  const highlight = selectedNode?.bounds ?? hoverNode?.bounds;
  const coordinateWidth = frame?.coordinateWidth ?? frame?.width ?? 1;
  const coordinateHeight = frame?.coordinateHeight ?? frame?.height ?? 1;
  const visibleHighlight = highlight
    ? intersectBounds(highlight, coordinateWidth, coordinateHeight)
    : null;

  return (
    <div className="device-viewport" ref={containerRef}>
      {frame && renderSize ? (
        <div
          className="device-viewport-frame"
          style={{ width: renderSize.width, height: renderSize.height }}
        >
          <img
            ref={imgRef}
            // The bytes come from the service; the browser decodes off-thread and caches by frame id.
            src={`/frame/${frame.frameId}`}
            alt="device screen"
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onContextMenu={onContext}
            onMouseMove={onMouseMove}
            onMouseLeave={() => setHoverNode(null)}
            draggable={false}
          />
          {visibleHighlight && (
            <div
              className={`hover-overlay${selectedNode?.bounds ? ' selected' : ''}`}
              style={{
                left: `${(visibleHighlight.x / coordinateWidth) * 100}%`,
                top: `${(visibleHighlight.y / coordinateHeight) * 100}%`,
                width: `${(visibleHighlight.width / coordinateWidth) * 100}%`,
                height: `${(visibleHighlight.height / coordinateHeight) * 100}%`,
              }}
            />
          )}
        </div>
      ) : (
        <div className="device-viewport-empty muted">
          {connecting ? 'connecting to device…' : 'connect a device to see the live screen'}
        </div>
      )}
    </div>
  );
}

function intersectBounds(
  bounds: { x: number; y: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  const x = Math.max(0, bounds.x);
  const y = Math.max(0, bounds.y);
  const right = Math.min(viewportWidth, bounds.x + bounds.width);
  const bottom = Math.min(viewportHeight, bounds.y + bounds.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Local, not imported from mobile-core: that package's entry also exports the test fixture, which would
 *  pull @playwright/test into the browser bundle. */
function findByKey(nodes: MobileNode[], key: string): MobileNode | undefined {
  for (const node of nodes) {
    if (node.key === key) {
      return node;
    }
    const inChildren = findByKey(node.children ?? [], key);
    if (inChildren) {
      return inChildren;
    }
  }
  return undefined;
}

function findSmallestNodeAt(nodes: MobileNode[], x: number, y: number): MobileNode | null {
  let smallest: MobileNode | null = null;
  let smallestArea = Infinity;
  let smallestStable: MobileNode | null = null;
  let smallestStableArea = Infinity;

  const visit = (node: MobileNode): void => {
    const b = node.bounds;
    if (b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
      const area = b.width * b.height;
      if (area < smallestArea) {
        smallestArea = area;
        smallest = node;
      }
      if ((node.accessibilityId || node.resourceId || node.text) && area < smallestStableArea) {
        smallestStableArea = area;
        smallestStable = node;
      }
    }
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return smallestStable ?? smallest;
}
