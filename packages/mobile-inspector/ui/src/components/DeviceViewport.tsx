import { useLayoutEffect, useRef, useState } from 'react';

import type { ClientMessage, MobileNode, ScreenFrame } from '../protocol';

interface DeviceViewportProps {
  frame: ScreenFrame | null;
  hierarchy: MobileNode[];
  connecting: boolean;
  send: (message: ClientMessage) => void;
  /** Right-click: report the screen anchor so the parent can position the locator menu. */
  onContextMenu: (anchor: { x: number; y: number }) => void;
  /** Node currently selected in the tree, to mirror its highlight on the device image. */
  selectedNode: MobileNode | null;
}

/**
 * Renders the latest device screenshot. Left-click records a tap; right-click asks the main process
 * to hit-test the point and returns ranked locator candidates (surfaced by the parent as a context
 * menu). Click coordinates are converted from on-screen CSS pixels back to native device pixels.
 */
export function DeviceViewport({
  frame,
  hierarchy,
  connecting,
  send,
  onContextMenu,
  selectedNode,
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

  // Give the frame a definite pixel box. CSS aspect-ratio inside this flex layout creates a circular
  // dependency because the percentage-sized image also participates in sizing its parent.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !frame || !frame.width || !frame.height) {
      setRenderSize(null);
      return;
    }

    const compute = (): void => {
      const availableWidth = container.clientWidth;
      const availableHeight = container.clientHeight;
      if (!availableWidth || !availableHeight) {
        return;
      }
      const scale = Math.min(availableWidth / frame.width, availableHeight / frame.height);
      setRenderSize({
        width: frame.width * scale,
        height: frame.height * scale,
      });
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(container);
    return () => observer.disconnect();
  }, [frame?.height, frame?.width]);

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
            src={`data:image/png;base64,${frame.imageBase64}`}
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
