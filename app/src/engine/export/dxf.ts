import { Colors, DxfWriter, point3d } from '@tarikjabiri/dxf';
import type { LayoutOption } from '../generators/types';
import type { SiteModel } from '../site/loadSite';
import type { MultiPoly, Pt, Ring } from '../geom/types';
import { multiCentroid } from '../geom/planar';
import { m2ToAcres } from '../units';

/**
 * DXF export in LOCAL METRES, the same coordinates the app works in, with one
 * layer per thing a drawing office would want to switch off. The local origin
 * is written into the header comment block so the file can be moved onto UTM.
 */

export interface DxfExportOptions {
  site: SiteModel;
  /** Layouts to draw, in the order they should appear. */
  layouts: LayoutOption[];
  includeContours?: boolean;
  includeZones?: boolean;
  includeExistingRoads?: boolean;
  /** Write UTM 43N coordinates instead of local metres. */
  utm?: boolean;
}

const LAYERS = {
  parcel: { name: 'SITE-BOUNDARY', colour: Colors.White },
  zone: { name: 'ZONE', colour: Colors.Cyan },
  contourMinor: { name: 'CONTOUR-1M', colour: Colors.Blue },
  contourMajor: { name: 'CONTOUR-5M', colour: Colors.Cyan },
  existingRoad: { name: 'ROAD-EXISTING', colour: Colors.Yellow },
  road: { name: 'ROAD-INTERNAL', colour: Colors.Green },
  culDeSac: { name: 'ROAD-CUL-DE-SAC', colour: Colors.Green },
  fireLane: { name: 'ROAD-FIRE-LANE', colour: Colors.Red },
  access: { name: 'ROAD-ACCESS', colour: Colors.Green },
  plot: { name: 'PLOT', colour: Colors.Cyan },
  plotCorner: { name: 'PLOT-CORNER', colour: Colors.Yellow },
  footprint: { name: 'VILLA-FOOTPRINT', colour: Colors.White },
  tower: { name: 'TOWER', colour: Colors.Magenta },
  block: { name: 'BLOCK', colour: Colors.Red },
  openSpace: { name: 'OPEN-SPACE', colour: Colors.Green },
  recreation: { name: 'OPEN-SPACE-RECREATION', colour: Colors.Green },
  unbuildable: { name: 'UNBUILDABLE-RULE22', colour: Colors.Red },
  textPlot: { name: 'TEXT-PLOT', colour: Colors.White },
  textZone: { name: 'TEXT-ZONE', colour: Colors.Cyan },
} as const;

export function exportDxf(opts: DxfExportOptions): string {
  const w = new DxfWriter();
  const [ox, oy] = opts.utm ? opts.site.origin.local_origin_utm : [0, 0];
  const at = (p: Pt): ReturnType<typeof point3d> => point3d(p[0] + ox, p[1] + oy);

  for (const layer of Object.values(LAYERS)) w.addLayer(layer.name, layer.colour);

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

  /* the site */
  multi(opts.site.parcel, LAYERS.parcel.name);

  if (opts.includeContours !== false) {
    for (const c of opts.site.contours) {
      polyline(c.line as Ring, c.major ? LAYERS.contourMajor.name : LAYERS.contourMinor.name, false);
    }
  }

  if (opts.includeExistingRoads !== false) {
    for (const f of opts.site.features) {
      if (f.layer !== 'RD') continue;
      for (const line of f.lines) polyline(line as Ring, LAYERS.existingRoad.name, false);
    }
  }

  if (opts.includeZones !== false) {
    for (const zone of opts.site.zones) {
      if (zone.geom.length === 0) continue;
      multi(zone.geom, LAYERS.zone.name);
      const c = multiCentroid(zone.geom);
      text(c, 4, `${zone.name} — ${zone.computedInScopeAc.toFixed(2)} ac`, LAYERS.textZone.name);
    }
  }

  /* the layouts */
  for (const layout of opts.layouts) {
    for (const os of layout.openSpace) {
      multi(os.geom, os.countsAsRecreation ? LAYERS.recreation.name : LAYERS.openSpace.name);
    }
    for (const road of layout.roads) {
      const layer =
        road.kind === 'cul_de_sac'
          ? LAYERS.culDeSac.name
          : road.kind === 'fire_lane'
            ? LAYERS.fireLane.name
            : road.kind === 'access'
              ? LAYERS.access.name
              : LAYERS.road.name;
      multi(road.geom, layer);
      if (road.headGeom) multi(road.headGeom, LAYERS.culDeSac.name);
    }
    for (const plot of layout.plots) {
      polyline(plot.ring, plot.corner ? LAYERS.plotCorner.name : LAYERS.plot.name);
      if (plot.footprint) polyline(plot.footprint, LAYERS.footprint.name);
      const c = centroidOfRing(plot.ring);
      text(c, 1.2, `${plot.id} · ${plot.areaM2.toFixed(0)} m²`, LAYERS.textPlot.name);
      if (Number.isFinite(plot.terrain.platformRl)) {
        text([c[0], c[1] - 2], 1.2, `RL ${plot.terrain.platformRl.toFixed(2)}`, LAYERS.textPlot.name);
      }
    }
    for (const tower of layout.towers) {
      polyline(tower.ring, LAYERS.tower.name);
      text(tower.centre, 3, `${tower.id} · ${tower.floors}F · ${tower.flats} flats`, LAYERS.textPlot.name);
      if (Number.isFinite(tower.podiumRl)) {
        text([tower.centre[0], tower.centre[1] - 4], 2, `podium RL ${tower.podiumRl.toFixed(2)}`, LAYERS.textPlot.name);
      }
    }
    for (const block of layout.blocks) {
      polyline(block.ring, LAYERS.block.name);
      const c = centroidOfRing(block.ring);
      text(c, 3, `${block.use} · ${block.floors}F`, LAYERS.textPlot.name);
    }
  }

  return w.stringify();
}

function centroidOfRing(ring: Ring): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

/** A short note for the drawing register, written beside the DXF. */
export function dxfReadme(opts: DxfExportOptions): string {
  const { site } = opts;
  const total = opts.layouts.reduce((s, l) => s + l.metrics.zoneAreaM2, 0);
  return [
    'Mangalapuram Township Planner — DXF export',
    '',
    opts.utm
      ? `Coordinates: UTM 43N (EPSG:32643), metres.`
      : `Coordinates: LOCAL metres. Add E ${site.origin.local_origin_utm[0]}, N ${site.origin.local_origin_utm[1]} for UTM 43N (EPSG:32643).`,
    `Levels: RL on an assumed datum, TBM = ${site.origin.tbm.rl.toFixed(3)} at local (${site.origin.tbm.local[0].toFixed(3)}, ${site.origin.tbm.local[1].toFixed(3)}). The MSL offset is not known.`,
    '',
    `Layouts drawn: ${opts.layouts.map((l) => `${l.zoneName} (${l.strategy})`).join('; ') || 'none'}`,
    `Zone area covered: ${m2ToAcres(total).toFixed(2)} ac of ${site.parcelAreaAc.toFixed(2)} ac in scope.`,
    '',
    'Layers:',
    ...Object.values(LAYERS).map((l) => `  ${l.name}`),
  ].join('\n');
}
