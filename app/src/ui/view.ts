import type { Bbox, Pt } from '../engine/geom/types';

/** Orthographic local-metre view: no map projection, north is up. */
export interface View {
  /** screen px per metre */
  scale: number;
  /** world coordinate at the canvas centre */
  centre: Pt;
  width: number;
  height: number;
}

export const worldToScreen = (v: View, p: Pt): Pt => [
  v.width / 2 + (p[0] - v.centre[0]) * v.scale,
  v.height / 2 - (p[1] - v.centre[1]) * v.scale,
];

export const screenToWorld = (v: View, p: Pt): Pt => [
  v.centre[0] + (p[0] - v.width / 2) / v.scale,
  v.centre[1] - (p[1] - v.height / 2) / v.scale,
];

export function fitView(bbox: Bbox, width: number, height: number, padding = 32): View {
  const w = Math.max(1e-6, bbox.maxX - bbox.minX);
  const h = Math.max(1e-6, bbox.maxY - bbox.minY);
  const scale = Math.min((width - padding * 2) / w, (height - padding * 2) / h);
  return {
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    centre: [(bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2],
    width,
    height,
  };
}

/** A scale bar length that lands on a round number of metres. */
export function niceScaleBar(view: View, targetPx = 120): { metres: number; px: number } {
  const raw = targetPx / view.scale;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const candidates = [1, 2, 5, 10].map((m) => m * pow);
  const metres = candidates.reduce((best, c) => (Math.abs(c - raw) < Math.abs(best - raw) ? c : best), candidates[0]!);
  return { metres, px: metres * view.scale };
}
