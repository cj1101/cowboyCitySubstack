export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Map a click to normalized image coordinates.
 * Clicks outside the image are ignored so a shifted or letterboxed map
 * cannot snap a corner to the left edge.
 */
export function imageNorm(input: {
  clientX: number;
  clientY: number;
  left: number;
  top: number;
  width: number;
  height: number;
}): { nx: number; ny: number } | null {
  if (!(input.width > 0) || !(input.height > 0)) return null;
  const nx = (input.clientX - input.left) / input.width;
  const ny = (input.clientY - input.top) / input.height;
  if (nx < -0.002 || ny < -0.002 || nx > 1.002 || ny > 1.002) return null;
  return { nx: clamp(nx, 0, 1), ny: clamp(ny, 0, 1) };
}

export function pinchView(input: {
  startScale: number;
  startPanX: number;
  startPanY: number;
  originX: number;
  originY: number;
  ratio: number;
  minScale?: number;
  maxScale?: number;
}) {
  const scale = clamp(input.startScale * input.ratio, input.minScale ?? 1, input.maxScale ?? 6);
  const safeStart = input.startScale || 1;
  const worldX = (input.originX - input.startPanX) / safeStart;
  const worldY = (input.originY - input.startPanY) / safeStart;
  return {
    scale,
    panX: input.originX - worldX * scale,
    panY: input.originY - worldY * scale,
  };
}

export function popupPosition(input: {
  x: number;
  y: number;
  frameW: number;
  frameH: number;
  popupW: number;
  popupH: number;
  margin?: number;
}) {
  const margin = input.margin ?? 8;
  const width = Math.min(input.popupW, Math.max(160, input.frameW - margin * 2));
  const height = Math.min(input.popupH, Math.max(120, input.frameH - margin * 2));
  return {
    width,
    height,
    x: clamp(input.x, margin, Math.max(margin, input.frameW - width - margin)),
    y: clamp(input.y, margin, Math.max(margin, input.frameH - height - margin)),
  };
}
