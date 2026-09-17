import type { LayoutOption } from '../engine/generators/types';
import { fillMulti, label, strokePolyline } from './draw';
import type { View } from './view';
import { worldToScreen } from './view';

const COLOURS = {
  buildable: 'rgba(111,211,199,0.05)',
  road: { fill: 'rgba(186,196,202,0.35)', stroke: 'rgba(222,231,236,0.75)' },
  culDeSac: { fill: 'rgba(186,196,202,0.5)', stroke: 'rgba(222,231,236,0.8)' },
  open: { fill: 'rgba(127,201,138,0.22)', stroke: 'rgba(127,201,138,0.7)' },
  recreation: { fill: 'rgba(127,201,138,0.35)', stroke: 'rgba(160,225,170,0.9)' },
  plot: { fill: 'rgba(111,211,199,0.13)', stroke: 'rgba(111,211,199,0.75)' },
  cornerPlot: { fill: 'rgba(230,197,90,0.18)', stroke: 'rgba(230,197,90,0.9)' },
  footprint: 'rgba(223,231,234,0.55)',
  tower: { fill: 'rgba(224,163,214,0.3)', stroke: 'rgba(240,190,230,0.95)' },
  block: { fill: 'rgba(240,149,107,0.25)', stroke: 'rgba(245,175,140,0.9)' },
} as const;

export function drawLayout(ctx: CanvasRenderingContext2D, view: View, layout: LayoutOption): void {
  fillMulti(ctx, view, layout.buildable, COLOURS.buildable, 'rgba(111,211,199,0.25)', 1);

  for (const os of layout.openSpace) {
    const c = os.countsAsRecreation ? COLOURS.recreation : COLOURS.open;
    fillMulti(ctx, view, os.geom, c.fill, c.stroke, 1);
  }

  for (const road of layout.roads) {
    const c = road.kind === 'cul_de_sac' ? COLOURS.culDeSac : COLOURS.road;
    fillMulti(ctx, view, road.geom, c.fill, c.stroke, 0.8);
    if (road.headGeom) fillMulti(ctx, view, road.headGeom, COLOURS.culDeSac.fill, COLOURS.culDeSac.stroke, 0.8);
  }

  const showDetail = view.scale > 0.6;
  for (const plot of layout.plots) {
    const c = plot.corner ? COLOURS.cornerPlot : COLOURS.plot;
    strokePolyline(ctx, view, plot.ring, c.stroke, 0.9, true);
    if (view.scale > 0.25) {
      ctx.beginPath();
      plot.ring.forEach((p, i) => {
        const [x, y] = worldToScreen(view, p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = c.fill;
      ctx.fill();
    }
    if (showDetail && plot.footprint) strokePolyline(ctx, view, plot.footprint, COLOURS.footprint, 0.8, true);
  }

  for (const tower of layout.towers) {
    strokePolyline(ctx, view, tower.ring, COLOURS.tower.stroke, 1.4, true);
    ctx.beginPath();
    tower.ring.forEach((p, i) => {
      const [x, y] = worldToScreen(view, p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = COLOURS.tower.fill;
    ctx.fill();
    if (view.scale > 0.35) {
      label(ctx, view, tower.centre, `${tower.id} · ${tower.floors}F`, '#f4d9ee', '600 10px ui-sans-serif, sans-serif');
    }
  }

  for (const block of layout.blocks) {
    strokePolyline(ctx, view, block.ring, COLOURS.block.stroke, 1.4, true);
    ctx.beginPath();
    block.ring.forEach((p, i) => {
      const [x, y] = worldToScreen(view, p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = COLOURS.block.fill;
    ctx.fill();
  }
}
