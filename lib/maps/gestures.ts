export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
