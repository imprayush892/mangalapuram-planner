import type { CirculationRoad } from '../engine/masterplan/circulation';
import type { MultiPoly } from '../engine/geom/types';
import { fillMulti, label } from './draw';
import type { View } from './view';

/**
 * The roads between the zones, drawn as a hierarchy so the plan reads: the main
 * spine widest and brightest, the retained public roads next, the collectors
 * that join each zone to them thinnest. Internal roads inside a zone are drawn
 * by `drawLayout` and sit a tier below these again.
 */
const TIER = {
  spine: { fill: 'rgba(246,226,160,0.55)', stroke: 'rgba(252,240,200,0.95)', width: 1.6 },
  public: { fill: 'rgba(233,205,150,0.42)', stroke: 'rgba(243,222,180,0.85)', width: 1.2 },
  collector: { fill: 'rgba(214,206,190,0.34)', stroke: 'rgba(232,226,212,0.7)', width: 1 },
} as const;

export function drawCirculation(
  ctx: CanvasRenderingContext2D,
  view: View,
  roads: CirculationRoad[],
  pen = 1,
  splays?: MultiPoly,
): void {
  // Junction splays sit under the roads: the land the junction needs beyond the
  // two carriageways, which is what KMBR Rule 31 asks to be kept clear.
  if (splays && splays.length > 0) {
    fillMulti(ctx, view, splays, 'rgba(226,214,186,0.28)', 'rgba(236,228,206,0.5)', 0.8 * pen);
  }
  // Draw the widest tier last so junctions read as the bigger road running
  // through, the way a drawn master plan shows them.
  const order: CirculationRoad['tier'][] = ['collector', 'public', 'spine'];
  for (const tier of order) {
    const style = TIER[tier];
    for (const road of roads) {
      if (road.tier !== tier) continue;
      fillMulti(ctx, view, road.geom, style.fill, style.stroke, style.width * pen);
    }
  }

  const spine = roads.find((r) => r.tier === 'spine');
  if (spine && view.scale > 0.12 && spine.centreline.length >= 2) {
    const a = spine.centreline[0]!;
    const b = spine.centreline[spine.centreline.length - 1]!;
    label(
      ctx,
      view,
      [a[0], (a[1] + b[1]) / 2],
      `MAIN SPINE ${spine.widthM} m`,
      'rgba(252,240,200,0.95)',
      '600 10px ui-sans-serif, system-ui, sans-serif',
      pen,
    );
  }
}
