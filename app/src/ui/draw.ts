import type { MultiPoly, Pt } from '../engine/geom/types';
import { worldToScreen } from './view';
import type { View } from './view';

export function pathMulti(ctx: CanvasRenderingContext2D, view: View, mp: MultiPoly): void {
  ctx.beginPath();
  for (const poly of mp) {
    for (const ring of poly) {
      ring.forEach((p, i) => {
        const [x, y] = worldToScreen(view, p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
  }
}

export function fillMulti(
  ctx: CanvasRenderingContext2D,
  view: View,
  mp: MultiPoly,
  fill?: string,
  stroke?: string,
  lineWidth = 1,
): void {
  if (mp.length === 0) return;
  pathMulti(ctx, view, mp);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill('evenodd');
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

export function strokePolyline(
  ctx: CanvasRenderingContext2D,
  view: View,
  line: readonly Pt[],
  stroke: string,
  lineWidth = 1,
  close = false,
): void {
  if (line.length < 2) return;
  ctx.beginPath();
  line.forEach((p, i) => {
    const [x, y] = worldToScreen(view, p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  if (close) ctx.closePath();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

export function label(
  ctx: CanvasRenderingContext2D,
  view: View,
  at: Pt,
  text: string,
  colour = '#dfe7ea',
  font: string | undefined = '11px ui-sans-serif, system-ui, sans-serif',
  pen = 1,
): void {
  const [x, y] = worldToScreen(view, at);
  // Sheet exports render several times larger than the screen, so text and
  // haloes are scaled with the pen rather than staying at screen pixel sizes.
  const base = font ?? '11px ui-sans-serif, system-ui, sans-serif';
  ctx.font = pen === 1 ? base : base.replace(/(\d+(?:\.\d+)?)px/, (_, n) => `${Number(n) * pen}px`);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3 * pen;
  ctx.strokeStyle = 'rgba(8,12,14,0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}

/** Colour per allocated use. The plan shows the use, not the zone's old name. */
export const USE_COLOUR: Record<string, string> = {
  villas: '#6fd3c7',
  senior: '#9db6e6',
  apartments: '#e0a3d6',
  school: '#e6c55a',
  hospital_reserved: '#e3735e',
  club: '#8fc98a',
  commercial: '#f0956b',
  hotel: '#d9a3f0',
  office: '#7fb2e6',
  infrastructure: '#98a6ad',
  unassigned: '#b9c6cc',
};

/** Stable, readable colour per zone use, derived from its name. */
export function zoneColour(name: string): string {
  const n = name.toUpperCase();
  if (n.includes('VILLA')) return '#6fd3c7';
  if (n.includes('SENIOR')) return '#9db6e6';
  if (n.includes('APARTMENT')) return '#e0a3d6';
  if (n.includes('SCHOOL')) return '#e6c55a';
  if (n.includes('HOSPITAL')) return '#e3735e';
  if (n.includes('CLUB')) return '#8fc98a';
  if (n.includes('COMMERCIAL') || n.includes('CONVENTION')) return '#f0956b';
  if (n.includes('BATCHING')) return '#98a6ad';
  if (n.includes('PHASE')) return '#7f92a0';
  return '#b9c6cc';
}
