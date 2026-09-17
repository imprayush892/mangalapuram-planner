import type { MultiPoly, Pt, Ring } from '../geom/types';
import { dist, multiPolyArea, orientedRect, pointInMulti } from '../geom/planar';
import { difference, intersect, union } from '../geom/boolean';
import { bufferPolyline, insetMulti, offsetMulti } from '../geom/offset';
import type { Dem } from '../terrain/dem';
import { classifyFall, dominantAspectDeg } from '../terrain/analysis';
import type { FallThresholds } from '../terrain/analysis';
import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import { sizeApartments, towerSpacing } from '../rules/client';
import type { BandName } from '../rules/client';
import {
  accessWidthM,
  daylightDepthM,
  governingYardM,
  highRise,
  travelDistanceM,
  unbuildableSlopeDeg,
  yardsFor,
} from '../rules/kmbr';
import { toRad } from '../units';
import type {
  LayoutMetrics,
  LayoutOption,
  OpenSpaceResult,
  RoadResult,
  ScoreBreakdown,
  TerrainSummary,
  TowerResult,
} from './types';
import { ZoneRaster } from './zoneRaster';
import { checkTowerLayout } from '../rules/towerCompliance';

export interface TowerGeneratorInput {
  zoneId: string;
  zoneName: string;
  zone: MultiPoly;
  dem: Dem;
  kmbr: YamlDoc;
  client: YamlDoc;
  assumptions: YamlDoc;
  fsi: number;
  /** Floor counts to explore; the milestone asks for 12, 15 and 20. */
  floorOptions: number[];
  mix: BandName[];
  flatsPerFloor: number;
  householdSize: number;
  noGo?: MultiPoly;
  keep?: number;
}

/** Shallowest plate worth building; the deep end comes from KMBR Rule 41. */
const PLATE_DEPTH_MIN_M = 14;
/** Above this, a plate needs two cores; the generator flags it. */
const TWO_CORE_PLATE_M2 = 1080;
/** Fall a podium platform should absorb across one tower footprint. */
const PODIUM_MAX_FALL_M = 3;
const CANDIDATE_GRID_M = 6;
/** Metres of tower spacing an extra metre of fall is worth giving up. */
const FALL_PENALTY_M_PER_M = 8;

/**
 * SPEC 6.2. Sizes the scheme with the client method, derives a plate inside the
 * daylight depth band, then places the towers inside the KMBR yard offset by
 * maximising the minimum pairwise distance. Joins are allowed only where the
 * zone cannot hold the client's 12 m clear spacing.
 */
export function generateTowerLayouts(input: TowerGeneratorInput): LayoutOption[] {
  const { zone, dem, kmbr, client, assumptions } = input;
  if (zone.length === 0) return [];

  const slopeLimit = unbuildableSlopeDeg(kmbr);
  const raster = new ZoneRaster(dem, zone, slopeLimit, input.noGo ?? []);
  if (raster.zoneCells === 0) return [];

  const zoneAreaM2 = multiPolyArea(zone);
  const floorToFloor = pick<number>(assumptions, 'floor_to_floor_m.apartments', 3.0);
  const maxHeight = pick<number>(client, 'apartments.max_height_m', 70);
  const aaiCap = pick<number | null>(assumptions, 'aai_height_cap_m', null);
  const spacing = towerSpacing(client);
  const buildable = buildableGeometry(raster, zone);
  // Towers run with their long axis along the contours, which keeps the fall
  // across one footprint as small as the ground allows.
  const contourAngle = contourAngleOf(dem, zone);

  const options: LayoutOption[] = [];
  for (const floors of input.floorOptions) {
    const option = buildTowerOption(input, {
      raster,
      zoneAreaM2,
      buildable,
      floors,
      floorToFloor,
      maxHeight,
      aaiCap,
      spacing,
      contourAngle,
    });
    if (option) options.push(option);
  }

  options.sort((a, b) => b.score.total - a.score.total);
  return options.slice(0, input.keep ?? 3);
}

interface TowerContext {
  raster: ZoneRaster;
  zoneAreaM2: number;
  buildable: MultiPoly;
  floors: number;
  floorToFloor: number;
  maxHeight: number;
  aaiCap: number | null;
  spacing: ReturnType<typeof towerSpacing>;
  contourAngle: number;
}

function buildTowerOption(input: TowerGeneratorInput, ctx: TowerContext): LayoutOption | null {
  const { kmbr, client, assumptions, dem } = input;
  const sizing = sizeApartments(client, {
    landM2: ctx.zoneAreaM2,
    fsi: input.fsi,
    floors: ctx.floors,
    mix: input.mix,
    flatsPerFloor: input.flatsPerFloor,
    // Size the footprint against the floors actually built, so a 12-floor
    // scheme uses the FSI rather than leaving a third of it on the table.
    floorsForSizing: ctx.floors,
  });
  if (sizing.towers <= 0 || sizing.plateM2 <= 0) return null;

  const heightM = Math.min(ctx.floors * ctx.floorToFloor, ctx.maxHeight);
  const hr = highRise(kmbr, heightM, ctx.floors);
  const { yards } = yardsFor(kmbr, { occupancy: 'A1', heightM });
  const yardM = governingYardM(yards);
  // Client rule: a joined block must sit inside the zone offset 6 m inward, or
  // the KMBR height-driven yard where that is larger.
  const insetM = Math.max(ctx.spacing.joinedInsideOffsetM, yardM);

  // 2. Plate geometry. Habitable space must be within the Rule 41 daylight
  // depth of an opening, so a double-loaded plate can be twice that plus the
  // corridor, which is not habitable.
  const corridorM = pick<number>(assumptions, 'corridor_width_m', 2.0);
  const maxDepth = daylightDepthM(kmbr) * 2 + corridorM;
  // Towers are sized to the footprint the FSI actually allows: `towers` comes
  // from the client's ceil(), so spreading the footprint evenly over them keeps
  // the FSI exact instead of overshooting by the rounding.
  const builtPlateM2 = sizing.totalFootprintM2 / sizing.towers;
  const depth = Math.min(maxDepth, Math.max(PLATE_DEPTH_MIN_M, Math.sqrt(builtPlateM2 / 2.2)));
  const length = builtPlateM2 / depth;

  const placeable = insetMulti(ctx.buildable, insetM);
  if (placeable.length === 0) return null;

  // 4. Placement: farthest-point over a candidate grid, long axis along the contours.
  const placement = placeTowers(
    placeable,
    sizing.towers,
    length,
    depth,
    ctx.contourAngle,
    ctx.spacing.minClearM,
    (centre) => {
      // Cheap fall probe: the footprint corners, its edge midpoints and centre.
      const ring = orientedRect(centre, length, depth, ctx.contourAngle);
      const probes: Pt[] = [...ring, centre];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        probes.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
      const samples = probes.map((p) => dem.sample(p)).filter((v) => Number.isFinite(v));
      if (samples.length === 0) return 0;
      return Math.max(...samples) - Math.min(...samples);
    },
  );
  if (placement.centres.length === 0) return null;

  const fallThresholds = pick<FallThresholds>(assumptions, 'plot_fall_thresholds_m', {
    build_as_drawn: 0.5,
    absorb_in_plinth: 1.0,
    stepped_plinth: 2.0,
    split_level: 3.0,
  });

  // Flats follow the towers actually placed, not the towers the sizing wanted:
  // a zone that holds six of ten towers holds six towers' worth of flats.
  const flatsPerTower = Math.max(
    1,
    Math.round(((sizing.flatsShare * builtPlateM2) / sizing.avgUnitPlinthM2) * ctx.floors),
  );
  const towers: TowerResult[] = placement.centres.map((centre, i) => {
    const ring = orientedRect(centre, length, depth, ctx.contourAngle);
    const terrain = towerTerrain(dem, ring, fallThresholds);
    const notes: string[] = [];
    if (builtPlateM2 > TWO_CORE_PLATE_M2) {
      notes.push(`Plate ${Math.round(builtPlateM2)} m² is over ${TWO_CORE_PLATE_M2} m²: two cores are needed.`);
    }
    if (Number.isFinite(terrain.fall) && terrain.fall > PODIUM_MAX_FALL_M) {
      notes.push(
        `Ground falls ${terrain.fall.toFixed(1)} m across this footprint: terrace the podium so no platform carries more than ${PODIUM_MAX_FALL_M} m.`,
      );
    }
    if (terrain.unsurveyedShare > 0.25) notes.push('Mostly unsurveyed ground: the platform RL is low-confidence.');
    return {
      id: `T${i + 1}`,
      ring,
      centre,
      plateM2: builtPlateM2,
      lengthM: length,
      depthM: depth,
      angleRad: ctx.contourAngle,
      floors: ctx.floors,
      heightM,
      flats: flatsPerTower,
      cores: builtPlateM2 > TWO_CORE_PLATE_M2 ? 2 : 1,
      podiumRl: terrain.platformRl,
      terrain,
      joinedWith: placement.joined.get(i) ?? [],
      notes,
    };
  });

  // 5. Circulation: an access road sized from Table 7 and fire lanes round each tower.
  const access = accessWidthM(kmbr, 'A1', sizing.totalFloorAreaM2);
  const fireLaneM = pick<number>(kmbr, 'chapter17_high_rise.fire_open_space.width_m', 5);
  const roads = buildCirculation(input.zone, ctx.buildable, towers, access.widthM, hr.isHighRise ? fireLaneM : 0);

  const towerGeom: MultiPoly = towers.map((t) => [t.ring]);
  const roadGeom = union(...roads.map((r) => r.geom));
  const openSpace = buildOpenSpace(ctx.buildable, roadGeom, towerGeom, input.zone);

  const footprintM2 = towers.length * builtPlateM2;
  const totalFloorAreaM2 = footprintM2 * ctx.floors;
  const metrics: LayoutMetrics = {
    zoneAreaM2: ctx.zoneAreaM2,
    buildableAreaM2: ctx.raster.buildableAreaM2,
    unbuildableAreaM2: ctx.raster.steepAreaM2,
    unsurveyedAreaM2: ctx.raster.unsurveyedAreaM2,
    roadAreaM2: multiPolyArea(roadGeom),
    openSpaceAreaM2: openSpace.reduce((s, o) => s + o.areaM2, 0),
    saleableAreaM2: footprintM2,
    shares: {
      roads: ctx.zoneAreaM2 > 0 ? multiPolyArea(roadGeom) / ctx.zoneAreaM2 : 0,
      openSpace: ctx.zoneAreaM2 > 0 ? openSpace.reduce((s, o) => s + o.areaM2, 0) / ctx.zoneAreaM2 : 0,
      saleable: ctx.zoneAreaM2 > 0 ? footprintM2 / ctx.zoneAreaM2 : 0,
    },
    targetShares: { roads: 0, openSpace: 0, saleable: 0 },
    plotCount: 0,
    unitCount: towers.reduce((s, t) => s + t.flats, 0),
    targetUnits: sizing.flats,
    towerCount: towers.length,
    totalFloorAreaM2,
    footprintM2,
    fsiUsed: ctx.zoneAreaM2 > 0 ? totalFloorAreaM2 / ctx.zoneAreaM2 : 0,
    coveragePct: ctx.zoneAreaM2 > 0 ? (footprintM2 / ctx.zoneAreaM2) * 100 : 0,
    cutM3: towers.reduce((s, t) => s + (Number.isFinite(t.terrain.cutM3) ? t.terrain.cutM3 : 0), 0),
    fillM3: towers.reduce((s, t) => s + (Number.isFinite(t.terrain.fillM3) ? t.terrain.fillM3 : 0), 0),
    retainingFaceM2: towers.reduce(
      (s, t) => s + (Number.isFinite(t.terrain.fall) ? (t.terrain.fall / 2) * (t.lengthM + t.depthM) * 2 : 0),
      0,
    ),
    cornerPlots: 0,
    goodOrientationShare: 1,
    populationCapacity: towers.reduce((s, t) => s + t.flats, 0) * input.householdSize,
  };

  const option: LayoutOption = {
    id: `${input.zoneId}-tower-${ctx.floors}`,
    zoneId: input.zoneId,
    zoneName: input.zoneName,
    kind: 'tower',
    strategy: `${towers.length} towers at ${ctx.floors} floors (${heightM.toFixed(0)} m), ${input.mix.join(' + ')} at ${input.flatsPerFloor} per floor, plate ${Math.round(builtPlateM2)} m² (${length.toFixed(0)} × ${depth.toFixed(0)} m), FSI ${input.fsi}`,
    plots: [],
    roads,
    openSpace,
    towers,
    blocks: [],
    buildable: ctx.buildable,
    metrics,
    score: scoreTowerLayout(metrics, placement.minClear, sizing.footprintShareOk, placement.joined.size),
    findings: [],
    warnings: sizing.notes,
  };
  option.findings = checkTowerLayout(option, {
    client,
    kmbr,
    assumptions,
    sizing,
    heightM,
    floors: ctx.floors,
    yards,
    yardM,
    insetM,
    minClearM: placement.minClear,
    requiredClearM: ctx.spacing.minClearM,
    joinedCount: placement.joined.size,
    towersShort: placement.short,
    towersWanted: sizing.towers,
    plateDepthM: depth,
    plateLengthM: length,
    builtPlateM2,
    maxPlateDepthM: maxDepth,
    accessWidthM: access.widthM,
    isHighRise: hr.isHighRise,
    highRiseReason: hr.reason,
    travelDistanceM: travelDistanceM(kmbr, pick<boolean>(assumptions, 'sprinklered_towers', true)),
    daylightDepthM: daylightDepthM(kmbr),
    aaiCapM: ctx.aaiCap,
  });
  return option;
}

/* ------------------------------------------------------------- the placement */

interface Placement {
  centres: Pt[];
  /** Tower index -> ids it abuts, where the zone could not hold the spacing. */
  joined: Map<number, string[]>;
  /** Smallest clear distance actually achieved between any two separate towers. */
  minClear: number;
  /** Towers the zone could not hold at all. */
  short: number;
}

/**
 * Farthest-point placement over a candidate grid: each tower goes where the
 * clear distance to the towers already placed is largest, which is the direct
 * reading of "maximise the distance between towers".
 *
 * Where the zone cannot hold the client's clear distance, the fallback is not a
 * smaller gap: a gap under the KMBR minimum is illegal, so the tower is joined
 * short side to short side at 0 m, which the client allows and which KMBR reads
 * as one block. A tower that can neither be spaced nor joined is not placed,
 * and the shortfall is reported.
 */
function placeTowers(
  placeable: MultiPoly,
  count: number,
  length: number,
  depth: number,
  angle: number,
  clientMinClearM: number,
  fallAt: (centre: Pt) => number,
): Placement {
  const candidates = candidateCentres(placeable, length, depth, angle);
  if (candidates.length === 0) return { centres: [], joined: new Map(), minClear: 0, short: count };

  const centres: Pt[] = [candidates[0]!];
  const joinedPairs: [number, number][] = [];

  const clearTo = (c: Pt, skip = -1): number => {
    let clear = Infinity;
    centres.forEach((placed, i) => {
      if (i === skip) return;
      clear = Math.min(clear, clearBetween(c, placed, length, depth, angle));
    });
    return clear;
  };

  while (centres.length < count) {
    // Among the positions that keep the clear distance, prefer the one that
    // stands on the flattest ground: a podium absorbs a few metres of fall, and
    // beyond that the earthwork is real money. Fall up to the podium limit is
    // free; past it, each extra metre costs FALL_PENALTY metres of spacing.
    let best: Pt | null = null;
    let bestValue = -Infinity;
    let bestClearOverall = -Infinity;
    for (const c of candidates) {
      const clear = clearTo(c);
      if (clear > bestClearOverall) bestClearOverall = clear;
      if (clear < clientMinClearM) continue;
      const fall = fallAt(c);
      const value = clear - FALL_PENALTY_M_PER_M * Math.max(0, fall - PODIUM_MAX_FALL_M);
      if (value > bestValue) {
        bestValue = value;
        best = c;
      }
    }

    // The client rule has no middle ground: either the clear distance is kept,
    // or the towers join at 0 m. A 7 m gap satisfies neither.
    if (best) {
      centres.push(best);
      continue;
    }
    void bestClearOverall;

    // Nothing at the clear distance is free: join short side to short side.
    const join = findJoin(centres, placeable, length, depth, angle, clientMinClearM, clearTo);
    if (!join) break;
    centres.push(join.centre);
    joinedPairs.push([join.against, centres.length - 1]);
  }

  let minClear = Infinity;
  const joined = new Map<number, string[]>();
  for (const [a, b] of joinedPairs) {
    joined.set(a, [...(joined.get(a) ?? []), `T${b + 1}`]);
    joined.set(b, [...(joined.get(b) ?? []), `T${a + 1}`]);
  }
  for (let i = 0; i < centres.length; i++) {
    for (let j = i + 1; j < centres.length; j++) {
      // A joined pair is one block, so its 0 m gap is not a spacing failure.
      if (joined.get(i)?.includes(`T${j + 1}`)) continue;
      minClear = Math.min(minClear, clearBetween(centres[i]!, centres[j]!, length, depth, angle));
    }
  }
  return {
    centres,
    joined,
    minClear: centres.length > 1 ? minClear : Infinity,
    short: Math.max(0, count - centres.length),
  };
}

/**
 * A join position: the new tower abuts an existing one end to end, stays inside
 * the placeable area and keeps the KMBR gap to every other tower.
 */
function findJoin(
  centres: Pt[],
  placeable: MultiPoly,
  length: number,
  depth: number,
  angle: number,
  clientMinClearM: number,
  clearTo: (c: Pt, skip?: number) => number,
): { centre: Pt; against: number } | null {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let best: { centre: Pt; against: number; margin: number } | null = null;
  for (let i = 0; i < centres.length; i++) {
    const base = centres[i]!;
    for (const sign of [1, -1]) {
      const centre: Pt = [base[0] + sign * length * cos, base[1] + sign * length * sin];
      const ring = orientedRect(centre, length, depth, angle);
      if (!ring.every((p) => pointInMulti(p, placeable))) continue;
      // The join itself is 0 m. Every OTHER tower must still keep the client's
      // clear distance: a join is not a licence to crowd a third tower.
      if (clearTo(centre, i) < clientMinClearM) continue;
      const margin = Math.min(...ring.map((p) => distanceInside(p, placeable)));
      if (!best || margin > best.margin) best = { centre, against: i, margin };
    }
  }
  return best ? { centre: best.centre, against: best.against } : null;
}

/** Grid positions whose whole tower rectangle fits inside the placeable area. */
function candidateCentres(placeable: MultiPoly, length: number, depth: number, angle: number): Pt[] {
  const b = placeable.reduce(
    (acc, poly) => {
      for (const [x, y] of poly[0] ?? []) {
        acc.minX = Math.min(acc.minX, x);
        acc.minY = Math.min(acc.minY, y);
        acc.maxX = Math.max(acc.maxX, x);
        acc.maxY = Math.max(acc.maxY, y);
      }
      return acc;
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  const out: { pt: Pt; margin: number }[] = [];
  for (let y = b.minY; y <= b.maxY; y += CANDIDATE_GRID_M) {
    for (let x = b.minX; x <= b.maxX; x += CANDIDATE_GRID_M) {
      const centre: Pt = [x, y];
      const ring = orientedRect(centre, length, depth, angle);
      if (!ring.every((p) => pointInMulti(p, placeable))) continue;
      // Prefer positions well inside the area, so the first tower is not jammed
      // into a corner before the rest are placed.
      const margin = Math.min(...ring.map((p) => distanceInside(p, placeable)));
      out.push({ pt: centre, margin });
    }
  }
  out.sort((p, q) => q.margin - p.margin);
  return out.map((o) => o.pt);
}

function distanceInside(p: Pt, mp: MultiPoly): number {
  let best = Infinity;
  for (const poly of mp) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        best = Math.min(best, distToSeg(p, ring[j]!, ring[i]!));
      }
    }
  }
  return best;
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Clear distance between two identically oriented rectangles: the gap between
 * their faces, not between their centres.
 */
function clearBetween(a: Pt, b: Pt, length: number, depth: number, angle: number): number {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const along = Math.abs(dx * cos + dy * sin) - length;
  const across = Math.abs(-dx * sin + dy * cos) - depth;
  if (along >= 0 && across >= 0) return Math.hypot(along, across);
  return Math.max(along, across);
}

/* -------------------------------------------------------------- the terrain */

function towerTerrain(dem: Dem, ring: Ring, thresholds: FallThresholds): TerrainSummary {
  const values: number[] = [];
  let unsurveyed = 0;
  let total = 0;
  // Sample the footprint on a 2 m lattice in its own frame.
  const [p0, p1, , p3] = ring as [Pt, Pt, Pt, Pt];
  const lengthM = dist(p0, p1);
  const depthM = dist(p0, p3);
  const steps = 2;
  for (let v = steps / 2; v < depthM; v += steps) {
    for (let u = steps / 2; u < lengthM; u += steps) {
      const fu = u / lengthM;
      const fv = v / depthM;
      const x = p0[0] + (p1[0] - p0[0]) * fu + (p3[0] - p0[0]) * fv;
      const y = p0[1] + (p1[1] - p0[1]) * fu + (p3[1] - p0[1]) * fv;
      total++;
      const rl = dem.sample([x, y]);
      if (Number.isFinite(rl)) values.push(rl);
      else unsurveyed++;
    }
  }
  if (values.length === 0) {
    return {
      fall: Number.NaN,
      platformRl: Number.NaN,
      minRl: Number.NaN,
      maxRl: Number.NaN,
      cutM3: 0,
      fillM3: 0,
      unsurveyedShare: 1,
      fallClass: 'unsurveyed',
    };
  }
  values.sort((a, b) => a - b);
  const min = values[0]!;
  const max = values[values.length - 1]!;
  const platform = values[Math.floor(values.length / 2)]!;
  const sampleArea = (lengthM * depthM) / Math.max(1, total);
  let cut = 0;
  let fill = 0;
  for (const v of values) {
    const d = v - platform;
    if (d > 0) cut += d * sampleArea;
    else fill += -d * sampleArea;
  }
  return {
    fall: max - min,
    platformRl: platform,
    minRl: min,
    maxRl: max,
    cutM3: cut,
    fillM3: fill,
    unsurveyedShare: total > 0 ? unsurveyed / total : 0,
    fallClass: classifyFall(max - min, thresholds),
  };
}

function contourAngleOf(dem: Dem, zone: MultiPoly): number {
  const aspectBearing = dominantAspectDeg(dem, zone);
  if (!Number.isFinite(aspectBearing)) return 0;
  return toRad(90 - aspectBearing) + Math.PI / 2;
}

/* ---------------------------------------------------------- the circulation */

function buildCirculation(
  zone: MultiPoly,
  buildable: MultiPoly,
  towers: TowerResult[],
  accessWidth: number,
  fireLaneWidth: number,
): RoadResult[] {
  const out: RoadResult[] = [];
  if (towers.length === 0) return out;

  // One access road threading the towers, sized from the KMBR access table.
  const spine = towers.map((t) => t.centre);
  if (spine.length >= 2) {
    const geom = intersect(bufferPolyline(spine, accessWidth), zone);
    if (geom.length > 0) {
      out.push({
        id: 'access',
        kind: 'access',
        centreline: spine,
        widthM: accessWidth,
        geom,
        lengthM: spine.slice(1).reduce((s, p, i) => s + dist(spine[i]!, p), 0),
      });
    }
  }

  // Fire lanes: a ring of the required width round each tower, which covers the
  // "two adjacent sides" the rule asks for and is what a drawing would show.
  if (fireLaneWidth > 0) {
    for (const t of towers) {
      const outer = offsetMulti([[t.ring]], fireLaneWidth);
      const lane = intersect(difference(outer, [[t.ring]]), buildable);
      if (lane.length === 0) continue;
      out.push({
        id: `fire-${t.id}`,
        kind: 'fire_lane',
        centreline: [],
        widthM: fireLaneWidth,
        geom: lane,
        lengthM: multiPolyArea(lane) / fireLaneWidth,
      });
    }
  }
  return out;
}

function buildOpenSpace(
  buildable: MultiPoly,
  roadGeom: MultiPoly,
  towerGeom: MultiPoly,
  zone: MultiPoly,
): OpenSpaceResult[] {
  const leftovers = difference(buildable, roadGeom, towerGeom);
  const out: OpenSpaceResult[] = [];
  for (const poly of leftovers) {
    const area = multiPolyArea([poly]);
    if (area < 4) continue;
    out.push({
      id: `os${out.length + 1}`,
      geom: [poly],
      areaM2: area,
      kind: 'topup',
      minWidthM: 0,
      countsAsRecreation: area >= 200,
    });
  }
  const steep = difference(zone, buildable);
  for (const poly of steep) {
    const area = multiPolyArea([poly]);
    if (area < 4) continue;
    out.push({
      id: `os${out.length + 1}`,
      geom: [poly],
      areaM2: area,
      kind: 'steep',
      minWidthM: 0,
      countsAsRecreation: false,
    });
  }
  return out;
}

function buildableGeometry(raster: ZoneRaster, zone: MultiPoly): MultiPoly {
  if (raster.steepCells === 0) return zone;
  const squares: MultiPoly = [];
  for (let j = 0; j < raster.ny; j++) {
    for (let i = 0; i < raster.nx; i++) {
      if (raster.at(i, j) !== 2) continue;
      const c = raster.centre(i, j);
      const h = raster.cell / 2;
      squares.push([
        [
          [c[0] - h, c[1] - h],
          [c[0] + h, c[1] - h],
          [c[0] + h, c[1] + h],
          [c[0] - h, c[1] + h],
        ],
      ]);
    }
  }
  return difference(zone, union(...squares.map((p) => [p])));
}

/* --------------------------------------------------------------- the scoring */

export function scoreTowerLayout(
  m: LayoutMetrics,
  minClear: number,
  footprintShareOk: boolean,
  joinedCount: number,
): ScoreBreakdown {
  const ratio = m.targetUnits > 0 ? m.unitCount / m.targetUnits : 0;
  const yieldScore = Math.max(0, 100 - Math.abs(1 - ratio) * 200);

  const earthworkPerTower = m.towerCount > 0 ? (m.cutM3 + m.fillM3) / m.towerCount : 0;
  const earthwork = Math.max(0, 100 - earthworkPerTower / 40);

  // Spacing is the client's headline rule: more clear distance is better, and a
  // join costs the option heavily.
  const spacing = Number.isFinite(minClear)
    ? Math.min(100, Math.max(0, (minClear / 30) * 100)) - joinedCount * 20
    : 100;

  const coverage = footprintShareOk ? 100 : 60;
  const openSpaceQuality = Math.min(100, m.shares.openSpace * 200);
  const roadShare = Math.max(0, 100 - Math.abs(m.shares.roads - 0.12) * 400);

  const total =
    yieldScore * 0.3 +
    Math.max(0, spacing) * 0.26 +
    earthwork * 0.16 +
    coverage * 0.12 +
    openSpaceQuality * 0.1 +
    roadShare * 0.06;

  return {
    yield: yieldScore,
    earthwork,
    orientation: spacing,
    roadShare,
    openSpaceQuality,
    corners: coverage,
    total,
  };
}
