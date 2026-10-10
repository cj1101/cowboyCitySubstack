import { clamp } from "@/lib/maps/gestures";
import type { MapPoint } from "@/lib/types";

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function cleanPoints(points: MapPoint[], max = 64): MapPoint[] {
  const clean: MapPoint[] = [];
  for (const point of points) {
    if (clean.length >= max) break;
    if (!Number.isFinite(point.nx) || !Number.isFinite(point.ny)) continue;
    clean.push({ nx: clamp01(point.nx), ny: clamp01(point.ny) });
  }
  return clean;
}

export function centroid(points: MapPoint[]): MapPoint {
  if (points.length === 0) return { nx: 0.5, ny: 0.5 };
  const total = points.reduce(
    (sum, point) => ({ nx: sum.nx + point.nx, ny: sum.ny + point.ny }),
    { nx: 0, ny: 0 }
  );
  return { nx: total.nx / points.length, ny: total.ny / points.length };
}

/** Size the map to the full frame width and the image aspect ratio, with nothing cropped. */
export function fitMapToWidth(
  frameW: number,
  naturalW: number,
  naturalH: number
): { w: number; h: number } | null {
  if (!(frameW > 0) || !(naturalW > 0) || !(naturalH > 0)) return null;
  return { w: frameW, h: frameW * (naturalH / naturalW) };
}

export function frameView(input: {
  points: MapPoint[];
  frameW: number;
  frameH: number;
  imageW: number;
  imageH: number;
  maxScale?: number;
  padding?: number;
  minSpan?: number;
}): { scale: number; panX: number; panY: number } {
  const padding = input.padding ?? 48;
  const maxScale = input.maxScale ?? 4;
  const minSpan = input.minSpan ?? 0.12;
  const points = input.points.length ? input.points : [{ nx: 0.5, ny: 0.5 }];
  const minX = Math.min(...points.map((point) => point.nx));
  const maxX = Math.max(...points.map((point) => point.nx));
  const minY = Math.min(...points.map((point) => point.ny));
  const maxY = Math.max(...points.map((point) => point.ny));
  const spanX = Math.max(maxX - minX, minSpan);
  const spanY = Math.max(maxY - minY, minSpan);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const usableW = Math.max(input.frameW - padding * 2, 80);
  const usableH = Math.max(input.frameH - padding * 2, 80);
  const imageW = Math.max(input.imageW, 1);
  const imageH = Math.max(input.imageH, 1);
  const scale = clamp(Math.min(usableW / (spanX * imageW), usableH / (spanY * imageH)), 1, maxScale);
  return {
    scale,
    panX: input.frameW / 2 - centerX * imageW * scale,
    panY: input.frameH / 2 - centerY * imageH * scale,
  };
}
