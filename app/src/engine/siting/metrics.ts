import type { MultiPoly, Pt } from '../geom/types';
import { dist, distToSegment, multiCentroid, multiPolyArea, ringPerimeter } from '../geom/planar';
import type { Dem } from '../terrain/dem';
import { buildWaterModel, waterStatsFor } from '../terrain/water';
import type { WaterModel } from '../terrain/water';
import type { SiteModel } from '../site/loadSite';
import type { Zone } from '../site/types';
import { ZoneRaster } from '../generators/zoneRaster';
import { unbuildableSlopeDeg } from '../rules/kmbr';
import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import { m2ToAcres } from '../units';
import type { ZoneMetrics } from './types';

/**
 * Measures every zone once, so scoring a use against a zone is arithmetic
 * rather than geometry. Everything here is read off data the app already
 * holds: the DEM, the parcel, the registered zones and the existing road edges.
 */

const PLOT_WINDOW_X_M = 11.4;
const PLOT_WINDOW_Y_M = 14.2;
/** Upslope cells above which a DEM cell is treated as carrying a channel. */
const FLOW_CHANNEL_CELLS = 250;
/** Boundary sample spacing when measuring road frontage. */
const FRONTAGE_SAMPLE_M = 5;

export interface MetricsOptions {
  frontageSearchM?: number;
  /** Reuse a model already built rather than recomputing the hydrology. */
  water?: WaterModel;
  /** Strip either side of a watercourse counted as "near water". */
  waterBufferM?: number;
}

export function measureZones(
  site: SiteModel,
  kmbr: YamlDoc,
  siting: YamlDoc,
  opts: MetricsOptions = {},
): ZoneMetrics[] {
  const slopeLimit = unbuildableSlopeDeg(kmbr);
  const frontageSearchM = opts.frontageSearchM ?? pick<number>(siting, 'defaults.frontage_search_m', 60);

  const roads = roadSegments(site);
  const water =
    opts.water ??
    buildWaterModel({
      dem: site.dem,
      minUpslopeCells: pick<number>(siting, 'defaults.channel_upslope_cells', 250),
      majorUpslopeCells: pick<number>(siting, 'defaults.major_upslope_cells', 2000),
      pondingDepthM: pick<number>(siting, 'defaults.ponding_depth_m', 0.25),
      features: site.features,
    });
  const accumulation = water.accumulation;
  const fallGrid = site.dem.windowFallGrid(PLOT_WINDOW_X_M, PLOT_WINDOW_Y_M, 0.75);
  const bufferM = opts.waterBufferM ?? pick<number>(siting, 'defaults.water_buffer_m', 15);

  const zones = site.zones.filter((z) => z.geom.length > 0);
  const raw = zones.map((zone) =>
    measureZone(zone, site, slopeLimit, roads, accumulation, fallGrid, frontageSearchM, water, bufferM),
  );

  // Elevation and edge are ranked against the other zones, not in absolute
  // terms: "high" only means anything relative to this site.
  return withRanks(raw);
}

interface Segment {
  a: Pt;
  b: Pt;
}

function roadSegments(site: SiteModel): Segment[] {
  const out: Segment[] = [];
  for (const f of site.features) {
    if (f.layer !== 'RD') continue;
    for (const line of f.lines) {
      for (let i = 1; i < line.length; i++) out.push({ a: line[i - 1]!, b: line[i]! });
    }
  }
  return out;
}

function measureZone(
  zone: Zone,
  site: SiteModel,
  slopeLimit: number,
  roads: Segment[],
  accumulation: Float32Array,
  fallGrid: Float32Array,
  frontageSearchM: number,
  water: WaterModel,
  waterBufferM: number,
): ZoneMetrics {
  const raster = new ZoneRaster(site.dem, zone.geom, slopeLimit);
  const areaM2 = multiPolyArea(zone.geom);

  const terrain = zoneTerrain(site.dem, raster, accumulation, fallGrid);
  const hydro = waterStatsFor(site.dem, water, zone.geom, waterBufferM);
  const frontage = measureFrontage(zone.geom, roads, frontageSearchM);
  const centroid = multiCentroid(zone.geom);

  return {
    zoneId: zone.id,
    zoneName: zone.name,
    areaM2,
    areaAc: m2ToAcres(areaM2),
    centroid,
    buildableShare: raster.zoneCells > 0 ? raster.buildableCells / raster.zoneCells : 0,
    buildableAreaM2: raster.buildableAreaM2,
    unsurveyedShare: raster.zoneCells > 0 ? raster.unsurveyedCells / raster.zoneCells : 0,
    meanSlopeDeg: terrain.meanSlopeDeg,
    medianPlotFallM: terrain.medianFall,
    minRl: terrain.minRl,
    maxRl: terrain.maxRl,
    meanRl: terrain.meanRl,
    elevationRank: 0,
    distanceToRoadM: frontage.distanceToRoadM,
    frontageM: frontage.frontageM,
    frontageShare: frontage.perimeterM > 0 ? frontage.frontageM / frontage.perimeterM : 0,
    distanceToParcelEdgeM: distanceToBoundary(centroid, site.parcel),
    edgeRank: 0,
    drainageShare: terrain.drainageShare,

    wetnessRank: hydro.wetnessRank,
    minDistanceToWaterM: hydro.minDistanceToWaterM,
    meanDistanceToWaterM: hydro.meanDistanceToWaterM,
    nearWaterShare: hydro.nearWaterShare,
    pondingShare: hydro.pondingShare,
    catchments: hydro.catchments,
    phase: phaseOf(zone.name),
  };
}

interface ZoneTerrain {
  meanSlopeDeg: number;
  medianFall: number;
  minRl: number;
  maxRl: number;
  meanRl: number;
  drainageShare: number;
}

function zoneTerrain(
  dem: Dem,
  raster: ZoneRaster,
  accumulation: Float32Array,
  fallGrid: Float32Array,
): ZoneTerrain {
  const slope = dem.slopeGrid();
  const nx = dem.meta.nx;
  let slopeSum = 0;
  let slopeCount = 0;
  let rlSum = 0;
  let rlCount = 0;
  let minRl = Infinity;
  let maxRl = -Infinity;
  let channelCells = 0;
  const falls: number[] = [];

  for (let j = 0; j < raster.ny; j++) {
    for (let i = 0; i < raster.nx; i++) {
      if (raster.at(i, j) === 0) continue;
      const k = (raster.j0 + j) * nx + (raster.i0 + i);
      const s = slope[k]!;
      if (Number.isFinite(s)) {
        slopeSum += s;
        slopeCount++;
      }
      const rl = raster.rlAt(i, j);
      if (Number.isFinite(rl)) {
        rlSum += rl;
        rlCount++;
        if (rl < minRl) minRl = rl;
        if (rl > maxRl) maxRl = rl;
      }
      const f = fallGrid[k]!;
      if (Number.isFinite(f)) falls.push(f);
      if (accumulation[k]! >= FLOW_CHANNEL_CELLS) channelCells++;
    }
  }

  falls.sort((a, b) => a - b);
  return {
    meanSlopeDeg: slopeCount > 0 ? slopeSum / slopeCount : Number.NaN,
    medianFall: falls.length > 0 ? falls[Math.floor(falls.length / 2)]! : Number.NaN,
    minRl: rlCount > 0 ? minRl : Number.NaN,
    maxRl: rlCount > 0 ? maxRl : Number.NaN,
    meanRl: rlCount > 0 ? rlSum / rlCount : Number.NaN,
    drainageShare: raster.zoneCells > 0 ? channelCells / raster.zoneCells : 0,
  };
}

interface Frontage {
  distanceToRoadM: number;
  frontageM: number;
  perimeterM: number;
}

/**
 * Walks the zone boundary at a fixed spacing and counts the length that runs
 * within reach of an existing road edge. A zone with no frontage cannot be
 * given a use that needs its own gate on a public road.
 */
function measureFrontage(zone: MultiPoly, roads: Segment[], searchM: number): Frontage {
  let nearest = Infinity;
  let frontageM = 0;
  let perimeterM = 0;

  for (const poly of zone) {
    const ring = poly[0];
    if (!ring || ring.length < 2) continue;
    perimeterM += ringPerimeter(ring);
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]!;
      const b = ring[i]!;
      const len = dist(a, b);
      if (len === 0) continue;
      const steps = Math.max(1, Math.ceil(len / FRONTAGE_SAMPLE_M));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const d = nearestRoadDistance(p, roads);
        if (d < nearest) nearest = d;
        if (d <= searchM) frontageM += len / steps;
      }
    }
  }
  return { distanceToRoadM: Number.isFinite(nearest) ? nearest : Number.NaN, frontageM, perimeterM };
}

function nearestRoadDistance(p: Pt, roads: Segment[]): number {
  let best = Infinity;
  for (const seg of roads) {
    // A cheap bounding reject keeps this affordable over ~400 segments per sample.
    if (Math.abs(seg.a[0] - p[0]) > best && Math.abs(seg.b[0] - p[0]) > best) continue;
    const d = distToSegment(p, seg.a, seg.b);
    if (d < best) best = d;
  }
  return best;
}

function distanceToBoundary(p: Pt, mp: MultiPoly): number {
  let best = Infinity;
  for (const poly of mp) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const d = distToSegment(p, ring[j]!, ring[i]!);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** "PHASE 2" -> 2. The client zoning plan names phases in the zone label. */
function phaseOf(zoneName: string): number | null {
  const match = /PHASE\s*(\d+)/i.exec(zoneName);
  return match ? Number(match[1]) : null;
}

/** Ranks elevation and edge-ness 0..1 across the zones actually present. */
function withRanks(metrics: ZoneMetrics[]): ZoneMetrics[] {
  const rls = metrics.map((m) => m.meanRl).filter((v) => Number.isFinite(v));
  const edges = metrics.map((m) => m.distanceToParcelEdgeM).filter((v) => Number.isFinite(v));
  const rlMin = Math.min(...rls);
  const rlMax = Math.max(...rls);
  const edgeMin = Math.min(...edges);
  const edgeMax = Math.max(...edges);

  return metrics.map((m) => ({
    ...m,
    elevationRank: normalise(m.meanRl, rlMin, rlMax),
    // Far from the boundary = central, so edgeRank inverts the distance.
    edgeRank: 1 - normalise(m.distanceToParcelEdgeM, edgeMin, edgeMax),
  }));
}

function normalise(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0.5;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}
