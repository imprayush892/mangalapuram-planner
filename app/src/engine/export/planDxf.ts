import { Colors, DxfWriter, point3d } from '@tarikjabiri/dxf';
import type { PlanResult } from '../pipeline/plan';
import type { SiteModel } from '../site/loadSite';
import type { MultiPoly, Pt, Ring } from '../geom/types';
import { multiCentroid, multiPolyArea } from '../geom/planar';
import { m2ToAcres } from '../units';

/**
 * A master plan (the pipeline's plan, owner 12 Oct) as DXF, one layer per kind of thing: the parcel, the zones by use,
 * each kind of green and the water, the roads by tier, the villa plots and their houses, the buildings by use, and
 * the labels. Local metres (site_origin.json), or UTM when asked.
 */
export interface PlanDxfOptions {
  site: SiteModel;
  plan: PlanResult;
  /** The zoning the plan was drawn on (its option's: the optimised zoning, with its pockets or link). */
  zones: SiteModel['draftZones'];
  title: string;
  utm?: boolean;
}

const ZONE_COLOUR: Record<string, number> = {
  villas: Colors.Yellow,
  apartments: Colors.Red,
  senior: Colors.Magenta,
  school: Colors.Blue,
  clubhouse: Colors.Cyan,
  retail: Colors.Magenta,
  office: Colors.Magenta,
};
const GREEN_LAYER = (z: { water?: boolean; within?: string; green?: string }): string =>
  z.water || z.green === 'lake' ? 'WATER' : z.within || z.green === 'zone' ? 'GREEN-IN-VILLAS' : z.green === 'landscape' ? 'GREEN-LANDSCAPE' : 'GREEN-RC';

export function exportPlanDxf(opts: PlanDxfOptions): string {
  const w = new DxfWriter();
  const [ox, oy] = opts.utm ? opts.site.origin.local_origin_utm : [0, 0];
  const at = (p: Pt): ReturnType<typeof point3d> => point3d(p[0] + ox, p[1] + oy);
  const layers: [string, number][] = [
    ['SITE-BOUNDARY', Colors.White],
    ['WATER', Colors.Blue],
    ['GREEN-RC', Colors.Green],
    ['GREEN-IN-VILLAS', Colors.Green],
    ['GREEN-LANDSCAPE', Colors.Green],
    ['ROAD-EXISTING', Colors.Yellow],
    ['ROAD-PRIMARY', Colors.Red],
    ['ROAD-SECONDARY', Colors.Red],
    ['ROAD-TERTIARY', Colors.White],
    ['PLOT', Colors.Cyan],
    ['VILLA-HOUSE', Colors.White],
    ['TEXT-ZONE', Colors.White],
    ['TEXT-PLOT', Colors.White],
    ['TEXT-TITLE', Colors.White],
  ];
  for (const u of Object.keys(ZONE_COLOUR)) layers.push([`ZONE-${u.toUpperCase()}`, ZONE_COLOUR[u]!]);
  for (const u of Object.keys(ZONE_COLOUR)) layers.push([`BUILDING-${u.toUpperCase()}`, ZONE_COLOUR[u]!]);
  for (const [name, colour] of layers) w.addLayer(name, colour);

  const polyline = (ring: Ring, layer: string, closed = true): void => {
    if (ring.length < 2) return;
    w.setCurrentLayerName(layer);
    w.addLWPolyline(
      ring.map((p) => ({ point: at(p) })),
      { flags: closed ? 1 : 0 },
    );
  };
  const multi = (mp: MultiPoly, layer: string): void => {
    for (const poly of mp) for (const ring of poly) polyline(ring, layer);
  };
  const text = (p: Pt, height: number, value: string, layer: string): void => {
    w.setCurrentLayerName(layer);
    w.addText(at(p), height, value);
  };

  multi(opts.site.parcel, 'SITE-BOUNDARY');
  for (const f of opts.site.features) if (f.layer === 'RD') for (const line of f.lines) polyline(line as Ring, 'ROAD-EXISTING', false);

  for (const z of opts.zones) {
    if (z.geom.length === 0) continue;
    const use = z.use ?? 'park';
    const layer = use === 'park' ? GREEN_LAYER(z) : `ZONE-${use.toUpperCase()}`;
    multi(z.geom, layer);
    text(multiCentroid(z.geom), 3, `${z.name} ${m2ToAcres(multiPolyArea(z.geom)).toFixed(2)} ac`, 'TEXT-ZONE');
  }
  for (const r of opts.plan.roads) multi(r.geom, `ROAD-${r.tier.toUpperCase()}`);
  for (const q of opts.plan.plots) {
    polyline(q.ring as Ring, 'PLOT');
    if (q.groundFloor) polyline(q.groundFloor as Ring, 'VILLA-HOUSE');
  }
  for (const b of opts.plan.buildings) {
    const layer = ZONE_COLOUR[b.typology] !== undefined ? `BUILDING-${b.typology.toUpperCase()}` : 'BUILDING-CLUBHOUSE';
    polyline(b.ring as Ring, layer);
    const c = multiCentroid([[b.ring as Ring]]);
    text(c, 2, `${b.id} ${b.floors}F${b.units ? ` ${b.units} units` : ''}`, 'TEXT-PLOT');
  }
  const [x0, y0] = opts.site.parcel.flat(2).reduce(([a, b], p) => [Math.min(a, p[0]), Math.min(b, p[1])], [Infinity, Infinity]);
  text([x0, y0 - 20], 6, `${opts.title} · ${opts.plan.plots.length} villas · local metres (site_origin.json)${opts.utm ? ', shifted to UTM' : ''}`, 'TEXT-TITLE');
  return w.stringify();
}
