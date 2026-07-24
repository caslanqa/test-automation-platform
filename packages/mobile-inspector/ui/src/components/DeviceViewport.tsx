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
  selectedNode,
}: DeviceViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
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

  function toDeviceCoords(event: React.MouseEvent): { x: number; y: number } | null {
    const img = imgRef.current;
    if (!img || !frame) {
      return null;
    }
    const rect = img.getBoundingClientRect();
    const scaleX = frame.width / rect.width;
    const scaleY = frame.height / rect.height;
    return {
      x: Math.round((event.clientX - rect.left) * scaleX),
      y: Math.round((event.clientY - rect.top) * scaleY),
    };
  }

  function onClick(event: React.MouseEvent<HTMLImageElement>): void {
    const p = toDeviceCoords(event);
    if (p && frame) {
      send({ type: 'tapAt', x: p.x, y: p.y, frameId: frame.frameId });
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
            onClick={onClick}
            onContextMenu={onContext}
            onMouseMove={onMouseMove}
            onMouseLeave={() => setHoverNode(null)}
            draggable={false}
          />
          {highlight && (
            <div
              className={`hover-overlay${selectedNode?.bounds ? ' selected' : ''}`}
              style={{
                left: `${(highlight.x / frame.width) * 100}%`,
                top: `${(highlight.y / frame.height) * 100}%`,
                width: `${(highlight.width / frame.width) * 100}%`,
                height: `${(highlight.height / frame.height) * 100}%`,
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

function findSmallestNodeAt(nodes: MobileNode[], x: number, y: number): MobileNode | null {
  let best: MobileNode | null = null;
  let bestArea = Infinity;

  const visit = (node: MobileNode): void => {
    const b = node.bounds;
    if (b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
      const area = b.width * b.height;
      if (area < bestArea) {
        bestArea = area;
        best = node;
      }
    }
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return best;
}
