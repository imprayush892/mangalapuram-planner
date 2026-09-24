import type { Dem } from '../terrain/dem';
import type { MultiPoly, Pt, Ring } from '../geom/types';
import type { SiteFeature } from '../site/types';
import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import { coverageFsi, highRise, gapBetweenBuildingsM } from '../rules/kmbr';
import type { Occupancy } from '../rules/kmbr';
import { sftToM2, M2_PER_ACRE } from '../units';
import type { AnalysisResult } from './analysis';
import { parseRatio } from './analysis';
import type { Mask } from './mask';
import { and, areaM2, count, dilate, emptyMask, erode, maskFrom, or, patches, toMulti } from './mask';
import { corridor, gradeLimitedProfile, lineLength, pathToLine, route } from './route';

/**
 * Planning steps 8-16: from the plotable land to buildings on the ground.
 *
 *   8  roads         existing roads fixed and checked; primary roads reach every
 *                    plotable zone, secondary roads split big zones into blocks,
 *                    tertiary streets serve the villa plots; every road held to
 *                    its tier's gradient, cut and fill where the ground will not do
 *   12 typologies    each block given a use, in the owner's priority order, by
 *                    what its ground and position suit
 *   9  plots         villa blocks cut into plots along contour streets
 *   10 plot slope    every plot's ground fitted with a plane and checked to 1:5
 *   11 cut and fill  a platform at no more than 1:5 for each plot, balanced;
 *                    pads for buildings; the road profiles
 *   13 FSI           villas G 60% + F 40% of the plot; senior and apartment
 *                    buildings sized back from the units the programme asks for
 *   14 placement     buildings placed on the flattest ground that keeps the
 *                    required clear distance; apartment podiums take up the fall
 *   15-16 massing    everything above, ready to draw in 2D and 3D
 *
 * Typologies are settled per block before the villa plots are cut, because a
 * plot's size depends on what it is for.
 */

export type RoadTier = 'existing' | 'primary' | 'secondary' | 'tertiary';
export type Typology = 'school' | 'clubhouse' | 'senior' | 'apartments' | 'villas' | 'open';

export interface PlanRoad {
  id: string;
  tier: RoadTier;
  centreline: Pt[];
  widthM: number;
  geom: MultiPoly;
  lengthM: number;
  /** Tier limit, rise over run. */
  limit: number;
  terrainMaxGrade: number;
  designMaxGrade: number;
  withinLimitAsIs: boolean;
  cutM3: number;
  fillM3: number;
  notes: string[];
}

export interface PlanBlock {
  id: string;
  geom: MultiPoly;
  areaM2: number;
  meanGrade: number;
  /** Share of the block steeper than the 1:5 plot limit. */
  steepShare: number;
  frontage: RoadTier[];
  centroid: Pt;
  typology: Typology;
  why: string[];
  builtUpM2: number;
  fsi: number;
}

export interface Platform {
  existingGrade: number;
  designGrade: number;
  withinLimitAsIs: boolean;
  cutM3: number;
  fillM3: number;
  maxCutM: number;
  maxFillM: number;
}

export interface PlanPlot {
  id: string;
  blockId: string;
  ring: Ring;
  areaM2: number;
  widthM: number;
  depthM: number;
  platform: Platform;
  baseRl: number;
  groundFloor: Ring;
  upperFloor: Ring;
  builtUpM2: number;
  fsi: number;
  floorHeightM: number;
}

export interface PlanBuilding {
  id: string;
  blockId: string;
  typology: Exclude<Typology, 'villas' | 'open'>;
  ring: Ring;
  footprintM2: number;
  floors: number;
  heightM: number;
  baseRl: number;
  units: number;
  builtUpM2: number;
  podium?: { ring: Ring; topRl: number; bottomRl: number; heightM: number; levels: number };
  platform?: Platform;
  notes: string[];
}

/** A development parcel: the blocks one use was given, with its FSI worked out. */
export interface PlanParcel {
  id: string;
  use: Typology;
  blockIds: string[];
  areaM2: number;
  builtUpM2: number;
  /** Built-up area over parcel area (KMBR: total floor area on all floors / plot area). */
  fsi: number;
  buildings: number;
}

export interface ProgrammeRow {
  use: string;
  asked: string;
  placed: string;
  met: boolean;
  note: string;
}

export interface PlanResult {
  roads: PlanRoad[];
  blocks: PlanBlock[];
  plots: PlanPlot[];
  buildings: PlanBuilding[];
  parcels: PlanParcel[];
  /** Design minus ground per DEM cell: + fill, − cut, 0 untouched. */
  earthwork: Float32Array;
  cutM3: number;
  fillM3: number;
  programme: ProgrammeRow[];
  existingRoads: { lengthM: number; overLimitM: number; maxGrade: number; limit: number };
  /** Road corridors of every tier, as a mask. */
  roadMask: Mask;
  notes: string[];
  ms: number;
}

export interface PlanInput {
  dem: Dem;
  features: SiteFeature[];
  kmbr: YamlDoc;
  client: YamlDoc;
  assumptions: YamlDoc;
  planning: YamlDoc;
  programme: YamlDoc;
}

/* ------------------------------------------------------------ helpers */

const num = (doc: YamlDoc, path: string, what = 'planning_rules.yaml'): number => {
  const v = pick<unknown>(doc, path, undefined);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`config/${what} ${path} is missing`);
  return v;
};

interface Frame {
  c: Pt;
  /** Along the contours. */
  u: Pt;
  /** Up the slope. */
  v: Pt;
}

const toWorld = (f: Frame, a: number, b: number): Pt => [
  f.c[0] + f.u[0] * a + f.v[0] * b,
  f.c[1] + f.u[1] * a + f.v[1] * b,
];
const toFrame = (f: Frame, p: Pt): [number, number] => {
  const dx = p[0] - f.c[0];
  const dy = p[1] - f.c[1];
  return [dx * f.u[0] + dy * f.u[1], dx * f.v[0] + dy * f.v[1]];
};

/** The frame a block's streets and buildings line up with: along the contours, up the slope. */
function frameFor(dem: Dem, cells: readonly number[]): Frame {
  const { nx } = dem.meta;
  let sx = 0;
  let sy = 0;
  let gx = 0;
  let gy = 0;
  for (const k of cells) {
    const i = k % nx;
    const j = (k - i) / nx;
    const p = dem.cellCentre(i, j);
    sx += p[0];
    sy += p[1];
    const zl = dem.at(i - 1, j);
    const zr = dem.at(i + 1, j);
    const zd = dem.at(i, j - 1);
    const zu = dem.at(i, j + 1);
    if ([zl, zr, zd, zu].every(Number.isFinite)) {
      gx += (zr - zl) / (2 * dem.cell);
      gy += (zu - zd) / (2 * dem.cell);
    }
  }
  const c: Pt = [sx / cells.length, sy / cells.length];
  const g = Math.hypot(gx, gy);
  const v: Pt = g > 1e-9 ? [gx / g, gy / g] : [0, 1];
  return { c, u: [-v[1], v[0]], v };
}

/** Rectangle in a frame, [a0,a1] x [b0,b1], as a world ring. */
const rectRing = (f: Frame, a0: number, a1: number, b0: number, b1: number): Ring => [
  toWorld(f, a0, b0),
  toWorld(f, a1, b0),
  toWorld(f, a1, b1),
  toWorld(f, a0, b1),
];

/** Points every `step` metres inside the rectangle, inset by half a step. */
function rectSamples(f: Frame, a0: number, a1: number, b0: number, b1: number, step = 1): { p: Pt; a: number; b: number }[] {
  const out: { p: Pt; a: number; b: number }[] = [];
  for (let a = a0 + step / 2; a < a1; a += step) {
    for (let b = b0 + step / 2; b < b1; b += step) out.push({ p: toWorld(f, a, b), a, b });
  }
  return out;
}

function allIn(dem: Dem, mask: Mask, pts: readonly { p: Pt }[]): boolean {
  for (const { p } of pts) {
    const c = dem.cellAt(p);
    if (!c || !mask[c.j * dem.meta.nx + c.i]) return false;
  }
  return true;
}

/**
 * A platform for a rectangle: the ground fitted with a plane, its gradient
 * held to `limit`, levelled so cut and fill balance. Earthwork into `delta`.
 */
function platformFor(
  dem: Dem,
  samples: readonly { p: Pt; a: number; b: number }[],
  limit: number,
  delta: Float32Array,
  flat = false,
): Platform & { level: (a: number, b: number) => number } {
  const zs = samples.map((s) => dem.sampleBilinear(s.p));
  const ok = zs.map(Number.isFinite);
  let n = 0;
  let ma = 0;
  let mb = 0;
  let mz = 0;
  samples.forEach((s, i) => {
    if (!ok[i]) return;
    n += 1;
    ma += s.a;
    mb += s.b;
    mz += zs[i]!;
  });
  if (n === 0) {
    return { existingGrade: 0, designGrade: 0, withinLimitAsIs: true, cutM3: 0, fillM3: 0, maxCutM: 0, maxFillM: 0, level: () => Number.NaN };
  }
  ma /= n;
  mb /= n;
  mz /= n;
  let saa = 0;
  let sab = 0;
  let sbb = 0;
  let saz = 0;
  let sbz = 0;
  samples.forEach((s, i) => {
    if (!ok[i]) return;
    const da = s.a - ma;
    const db = s.b - mb;
    const dz = zs[i]! - mz;
    saa += da * da;
    sab += da * db;
    sbb += db * db;
    saz += da * dz;
    sbz += db * dz;
  });
  const det = saa * sbb - sab * sab;
  let ga = det > 1e-9 ? (saz * sbb - sbz * sab) / det : 0;
  let gb = det > 1e-9 ? (sbz * saa - saz * sab) / det : 0;
  const existing = Math.hypot(ga, gb);
  const design = flat ? 0 : Math.min(existing, limit);
  if (existing > 1e-9) {
    ga *= design / existing;
    gb *= design / existing;
  }
  const level = (a: number, b: number): number => mz + ga * (a - ma) + gb * (b - mb);
  let cut = 0;
  let fill = 0;
  let maxCut = 0;
  let maxFill = 0;
  const { nx } = dem.meta;
  samples.forEach((s, i) => {
    if (!ok[i]) return;
    const d = level(s.a, s.b) - zs[i]!;
    if (d > 0) {
      fill += d;
      maxFill = Math.max(maxFill, d);
    } else {
      cut -= d;
      maxCut = Math.max(maxCut, -d);
    }
    const c = dem.cellAt(s.p);
    if (c) {
      const k = c.j * nx + c.i;
      if (Math.abs(d) > Math.abs(delta[k]!)) delta[k] = d;
    }
  });
  // Samples are one per square metre.
  return {
    existingGrade: existing,
    designGrade: design,
    withinLimitAsIs: existing <= limit,
    cutM3: cut,
    fillM3: fill,
    maxCutM: maxCut,
    maxFillM: maxFill,
    level,
  };
}

/** A platform's numbers without its level function, so the plan can cross to and from a worker. */
const platformOnly = (p: Platform): Platform => ({
  existingGrade: p.existingGrade,
  designGrade: p.designGrade,
  withinLimitAsIs: p.withinLimitAsIs,
  cutM3: p.cutM3,
  fillM3: p.fillM3,
  maxCutM: p.maxCutM,
  maxFillM: p.maxFillM,
});

/** Shortest distance between two convex rings (0 when they touch or overlap). */
function ringGap(a: Ring, b: Ring): number {
  const segDist = (p: Pt, s: Pt, t: Pt): number => {
    const dx = t[0] - s[0];
    const dy = t[1] - s[1];
    const L2 = dx * dx + dy * dy;
    const u = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / L2)) : 0;
    return Math.hypot(p[0] - s[0] - u * dx, p[1] - s[1] - u * dy);
  };
  const inside = (p: Pt, r: Ring): boolean => {
    let hit = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i, i += 1) {
      const A = r[i]!;
      const B = r[j]!;
      if (A[1] > p[1] !== B[1] > p[1] && p[0] < ((B[0] - A[0]) * (p[1] - A[1])) / (B[1] - A[1]) + A[0]) hit = !hit;
    }
    return hit;
  };
  if (a.some((p) => inside(p, b)) || b.some((p) => inside(p, a))) return 0;
  let m = Number.POSITIVE_INFINITY;
  for (const p of a) for (let i = 0; i < b.length; i += 1) m = Math.min(m, segDist(p, b[i]!, b[(i + 1) % b.length]!));
  for (const p of b) for (let i = 0; i < a.length; i += 1) m = Math.min(m, segDist(p, a[i]!, a[(i + 1) % a.length]!));
  return m;
}

/** Shortest distance from a segment to a convex ring (0 when it crosses or lies inside). */
function ringSegmentGap(ring: Ring, a: Pt, b: Pt): number {
  const segDist = (p: Pt, s: Pt, t: Pt): number => {
    const dx = t[0] - s[0];
    const dy = t[1] - s[1];
    const L2 = dx * dx + dy * dy;
    const u = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / L2)) : 0;
    return Math.hypot(p[0] - s[0] - u * dx, p[1] - s[1] - u * dy);
  };
  const cross = (o: Pt, p: Pt, q: Pt): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const inside = (p: Pt): boolean => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const A = ring[i]!;
      const B = ring[j]!;
      if (A[1] > p[1] !== B[1] > p[1] && p[0] < ((B[0] - A[0]) * (p[1] - A[1])) / (B[1] - A[1]) + A[0]) hit = !hit;
    }
    return hit;
  };
  if (inside(a) || inside(b)) return 0;
  let m = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const d1 = cross(a, b, p);
    const d2 = cross(a, b, q);
    const d3 = cross(p, q, a);
    const d4 = cross(p, q, b);
    if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
    m = Math.min(m, segDist(p, a, b), segDist(a, p, q), segDist(b, p, q));
  }
  return m;
}

/** Two convex rings overlap by more than a sliver (separating axis test; touching is fine). */
function rectsOverlap(a: Ring, b: Ring, tol = 0.05): boolean {
  for (const r of [a, b]) {
    for (let i = 0; i < r.length; i += 1) {
      const p = r[i]!;
      const q = r[(i + 1) % r.length]!;
      const ax: Pt = [-(q[1] - p[1]), q[0] - p[0]];
      const L = Math.hypot(ax[0], ax[1]) || 1;
      const proj = (ring: Ring): [number, number] => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of ring) {
          const d = (v[0] * ax[0] + v[1] * ax[1]) / L;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
        return [lo, hi];
      };
      const [a0, a1] = proj(a);
      const [b0, b1] = proj(b);
      if (Math.min(a1, b1) - Math.max(a0, b0) <= tol) return false;
    }
  }
  return true;
}

const scaleRing = (r: Ring, factor: number): Ring => {
  const cx = r.reduce((s, p) => s + p[0], 0) / r.length;
  const cy = r.reduce((s, p) => s + p[1], 0) / r.length;
  return r.map((p) => [cx + (p[0] - cx) * factor, cy + (p[1] - cy) * factor] as Pt);
};

const ringArea = (r: Ring): number => {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i, i += 1) s += (r[j]![0] + r[i]![0]) * (r[j]![1] - r[i]![1]);
  return Math.abs(s) / 2;
};

interface ProgrammeLine {
  id: string;
  use: string;
  units?: number;
  plinth_sft?: number;
  bua_sft?: number;
  land_ac?: number | Record<string, number>;
}

/* ---------------------------------------------------------------- run */

export function runPlan(input: PlanInput, analysis: AnalysisResult): PlanResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { dem, planning } = input;
  const { nx } = dem.meta;
  const n = nx * dem.meta.ny;
  const cellArea = dem.cell * dem.cell;
  const L = analysis.layers;
  const notes: string[] = [];
  const delta = new Float32Array(n);

  const lim = {
    primary: parseRatio(pick(planning, 'roads.max_gradient.primary', null), 'roads.max_gradient.primary'),
    secondary: parseRatio(pick(planning, 'roads.max_gradient.secondary', null), 'roads.max_gradient.secondary'),
    tertiary: parseRatio(pick(planning, 'roads.max_gradient.tertiary', null), 'roads.max_gradient.tertiary'),
  };
  const width = {
    primary: num(planning, 'roads.width_m.primary'),
    secondary: num(planning, 'roads.width_m.secondary'),
    tertiary: num(planning, 'roads.width_m.tertiary'),
  };
  const plotLimit = analysis.limits.plotMax;
  const penalty = num(planning, 'roads.routing.over_grade_penalty');

  /* ------------------------------------------------ 8a existing roads */
  const existingTier = pick<string>(planning, 'roads.existing_tier', 'primary') as 'primary' | 'secondary' | 'tertiary';
  const exLimit = lim[existingTier] ?? lim.primary;
  let exLen = 0;
  let exOver = 0;
  let exMax = 0;
  for (const f of input.features) {
    if (f.kind !== 'existing_road_edge') continue;
    for (const line of f.lines) {
      for (let a = 1; a < line.length; a += 1) {
        const p = line[a - 1]!;
        const q = line[a]!;
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const zp = dem.sampleBilinear(p);
        const zq = dem.sampleBilinear(q);
        if (!(len > 2) || !Number.isFinite(zp) || !Number.isFinite(zq)) continue;
        const g = Math.abs(zq - zp) / len;
        exLen += len;
        exMax = Math.max(exMax, g);
        if (g > exLimit) exOver += len;
      }
    }
  }

  /* ------------------------------------------------------- cost map */
  const c = {
    publicSpace: num(planning, 'roads.routing.cost.public_space'),
    wet: num(planning, 'roads.routing.cost.waterlogging'),
    drain: num(planning, 'roads.routing.cost.natural_drain'),
    road: num(planning, 'roads.routing.cost.existing_road'),
  };
  const baseCost = new Float32Array(n).fill(Number.POSITIVE_INFINITY);
  for (let k = 0; k < n; k += 1) {
    if (!L.terrain.mask[k]) continue;
    if (L.nonBuildable.mask[k]) continue;
    let v = 1;
    if (L.publicSpace.mask[k]) v = c.publicSpace;
    if (L.waterlogging.mask[k]) v = c.wet;
    if (L.drains.mask[k]) v = c.drain;
    if (L.existingRoads.mask[k]) v = c.road;
    baseCost[k] = v;
  }

  const roads: PlanRoad[] = [];
  let network: Mask = Uint8Array.from(L.existingRoads.mask);
  const addRoad = (tier: Exclude<RoadTier, 'existing'>, path: number[], why: string): Mask | null => {
    if (path.length < 2) return null;
    const line = pathToLine(dem, path);
    if (lineLength(line) < 4) return null;
    const prof = gradeLimitedProfile(dem, line, lim[tier]);
    const cor = corridor(dem, line, width[tier], prof, delta);
    const corMask = and(cor.mask, L.terrain.mask);
    roads.push({
      id: `${tier}-${roads.filter((r) => r.tier === tier).length + 1}`,
      tier,
      centreline: line,
      widthM: width[tier],
      geom: toMulti(dem, corMask),
      lengthM: lineLength(line),
      limit: lim[tier],
      terrainMaxGrade: prof.terrainMaxGrade,
      designMaxGrade: prof.designMaxGrade,
      withinLimitAsIs: prof.terrainMaxGrade <= lim[tier] + 1e-6,
      cutM3: cor.cutM3,
      fillM3: cor.fillM3,
      notes: [why],
    });
    network = or(network, corMask);
    return corMask;
  };

  /* ------------------------------------------------- 8b primary roads */
  const zones = patches(dem, L.plotable.mask).sort((a, b) => b.length - a.length);
  if (count(network) === 0) {
    notes.push('no existing road inside the parcel: the primary network starts from the largest zone');
    const first = zones[0];
    if (first) for (const k of first.slice(0, 1)) network[k] = 1;
  }
  let unreached = 0;
  for (const zone of zones) {
    const zmask = emptyMask(dem);
    for (const k of zone) zmask[k] = 1;
    if (count(and(dilate(dem, network, dem.cell), zmask)) > 0) continue;
    const sources: number[] = [];
    for (let k = 0; k < n; k += 1) if (network[k]) sources.push(k);
    const r = route({ dem, cost: baseCost, grade: lim.primary, overGradePenalty: penalty, sources, targets: zmask });
    if (!r.path) {
      unreached += 1;
      continue;
    }
    addRoad('primary', r.path, `joins a ${((zone.length * cellArea) / M2_PER_ACRE).toFixed(1)} ac plotable zone to the network`);
  }
  if (unreached > 0) notes.push(`${unreached} plotable zones could not be reached by any road and are left unplanned`);

  /* --------------------------------------- programme and typology sizes */
  const lines = pick<ProgrammeLine[]>(input.programme, 'lines', []);
  const byUse = (use: string): ProgrammeLine[] => lines.filter((l) => l.use === use);
  const units = (use: string): number => byUse(use).reduce((s, l) => s + (l.units ?? 0), 0);
  const plinth = (use: string): number => {
    const ls = byUse(use).filter((l) => l.units && l.plinth_sft);
    const u = ls.reduce((s, l) => s + l.units!, 0);
    return u > 0 ? ls.reduce((s, l) => s + l.units! * l.plinth_sft!, 0) / u : 0;
  };
  const bua = (use: string): number => byUse(use).reduce((s, l) => s + (l.bua_sft ?? 0), 0);

  const seniorUnits = units('senior');
  const seniorPlinthM2 = sftToM2(plinth('senior'));
  const aptUnits = units('apartments');
  const aptPlinthM2 = sftToM2(plinth('apartments'));
  const villaUnits = units('villas');
  const schoolBuaM2 = sftToM2(bua('school'));
  const clubBuaM2 = sftToM2(bua('club'));

  const sen = {
    floors: num(planning, 'senior_living.min_floors'),
    upf: num(planning, 'senior_living.units_per_floor'),
    eff: num(planning, 'senior_living.plan_efficiency'),
    aspect: num(planning, 'senior_living.plate_aspect'),
    clear: num(planning, 'senior_living.min_clear_between_buildings_m'),
    setback: num(planning, 'senior_living.setback_m'),
    fh: num(planning, 'senior_living.floor_height_m'),
  };
  const apt = {
    fsi: num(planning, 'apartments.fsi_max'),
    fpf: num(planning, 'apartments.flats_per_floor'),
    maxFloors: num(planning, 'apartments.max_floors'),
    eff: num(planning, 'apartments.plan_efficiency'),
    aspect: num(planning, 'apartments.plate_aspect'),
    clear: num(planning, 'apartments.min_clear_between_buildings_m'),
    setback: num(planning, 'apartments.setback_m'),
    podium: num(planning, 'apartments.podium_margin_m'),
    fh: num(planning, 'apartments.floor_height_m'),
  };
  const senPlate = (sen.upf * seniorPlinthM2) / sen.eff;
  const senPerBuilding = sen.upf * sen.floors;
  const senNeeded = seniorUnits > 0 ? Math.ceil(seniorUnits / senPerBuilding) : 0;
  const senDims = plateDims(senPlate, sen.aspect);
  const aptPlate = (apt.fpf * aptPlinthM2) / apt.eff;
  const aptPerTower = apt.fpf * apt.maxFloors;
  const aptNeeded = aptUnits > 0 ? Math.ceil(aptUnits / aptPerTower) : 0;
  const aptDims = plateDims(aptPlate, apt.aspect);
  const kmbrGap = (h: number, floors: number): number => {
    try {
      return gapBetweenBuildingsM(input.kmbr, h, highRise(input.kmbr, h, floors).isHighRise);
    } catch {
      return 0;
    }
  };
  const towerH = apt.maxFloors * apt.fh;
  const towerClear = Math.max(apt.clear, kmbrGap(towerH, apt.maxFloors));

  const schoolLandAc = schoolLand(lines);
  const schoolLandM2 = schoolLandAc * M2_PER_ACRE;
  const clubLandM2 = num(planning, 'clubhouse.building_land_ac') * M2_PER_ACRE;
  const schoolMaxGrade = parseRatio(pick(planning, 'school.max_mean_grade', '1:8'), 'school.max_mean_grade');
  const wingMax = num(planning, 'amenities.max_wing_plate_m2');
  const wingGap = num(planning, 'amenities.min_clear_between_wings_m');
  const amenitySetback = num(planning, 'amenities.setback_m');

  const villaArea = sftToM2(num(planning, 'villas.design_built_area_sft'));
  const vFsi = num(planning, 'villas.fsi');
  const plotArea = villaArea / vFsi;
  const plotW = num(planning, 'villas.min_plot_side_m');
  const plotD = Math.max(plotW, plotArea / plotW);
  const gfShare = num(planning, 'villas.ground_floor_share_of_plot');
  const ffShare = num(planning, 'villas.first_floor_share_of_plot');
  const vfh = num(planning, 'villas.floor_height_m');
  const tw = width.tertiary;

  /* -------------------------------------------- 8c the contour grid */
  // In each plotable zone: villa streets along the contours, two plot depths
  // and a street apart, and secondary cross streets up the slope every
  // `cross_street_every_plots` plots. The cells between them are the blocks.
  const minBlock = num(planning, 'plotable.min_area_m2');
  const crossEvery = num(planning, 'roads.cross_street_every_plots');
  const pitch = 2 * plotD + tw + 0.5;
  const crossPitch = crossEvery * plotW + width.secondary + 1;

  const addRoadLine = (tier: Exclude<RoadTier, 'existing'>, line: Pt[], why: string): Mask | null => {
    if (line.length < 2 || lineLength(line) < 4) return null;
    const prof = gradeLimitedProfile(dem, line, lim[tier]);
    const cor = corridor(dem, line, width[tier], prof, delta);
    const corMask = and(cor.mask, L.terrain.mask);
    roads.push({
      id: `${tier}-${roads.filter((r) => r.tier === tier).length + 1}`,
      tier,
      centreline: line,
      widthM: width[tier],
      geom: toMulti(dem, corMask),
      lengthM: lineLength(line),
      limit: lim[tier],
      terrainMaxGrade: prof.terrainMaxGrade,
      designMaxGrade: prof.designMaxGrade,
      withinLimitAsIs: prof.terrainMaxGrade <= lim[tier] + 1e-6,
      cutM3: cor.cutM3,
      fillM3: cor.fillM3,
      notes: [why],
    });
    network = or(network, corMask);
    return corMask;
  };

  type GridBlock = PlanBlock & {
    cells: number[];
    mask: Mask;
    zone: number;
    k: number;
    m: number;
    f: Frame;
    v0: number;
  };
  const blocks: GridBlock[] = [];
  const zoneFrames: { f: Frame; v0: number; w0: number; cot: number; cells: number[] }[] = [];
  // A cross street whose grading would move more earth than this per metre is
  // left out: the blocks either side join into one longer block, still
  // reached along the contour streets.
  const maxCrossEarth = num(planning, 'roads.cross_street_max_earthwork_m3_per_m');
  let droppedCross = 0;
  let droppedEarth = 0;
  const reached = dilate(dem, network, dem.cell * 2);
  zones.forEach((zone, zi) => {
    if (zone.length * cellArea < minBlock) return;
    if (!zone.some((k) => reached[k])) return;
    const zmask = emptyMask(dem);
    for (const k of zone) zmask[k] = 1;
    const f = frameFor(dem, zone);
    // Cross streets climb at the secondary limit where the ground is steeper
    // than it: straight up would need deep cuts, so they run at the angle
    // whose rise is the limit (grade x sin(angle) = limit).
    const g = zoneGrade(dem, zone);
    const sinA = g > lim.secondary ? lim.secondary / g : 1;
    const cot = Math.sqrt(Math.max(0, 1 - sinA * sinA)) / sinA;
    let wmin = Infinity;
    let wmax = -Infinity;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const k of zone) {
      const [x, y] = toFrame(f, dem.cellCentre(k % nx, Math.floor(k / nx)));
      wmin = Math.min(wmin, x - y * cot);
      wmax = Math.max(wmax, x - y * cot);
      vmin = Math.min(vmin, y);
      vmax = Math.max(vmax, y);
    }
    const cols = Math.max(1, Math.round((wmax - wmin) / crossPitch));
    const w0 = (wmin + wmax) / 2 - (cols * crossPitch) / 2;
    zoneFrames[zi] = { f, v0: vmin, w0, cot, cells: zone };
    const why =
      sinA < 1
        ? `cross street every ${crossEvery} plots, climbing at ${Math.round((Math.asin(sinA) * 180) / Math.PI)}° to the contours so the ${(g * 100).toFixed(0)}% ground rises at the 1:${Math.round(1 / lim.secondary)} limit`
        : `cross street every ${crossEvery} plots, straight up ground gentler than the limit`;
    // Cross streets on the interior column lines, where they run through the zone.
    for (let m = 1; m < cols; m += 1) {
      const wc = w0 + m * crossPitch;
      let start = Number.NaN;
      for (let y = vmin - 1; y <= vmax + 2; y += 1) {
        const cc = dem.cellAt(toWorld(f, wc + y * cot, y));
        const inside = cc ? zmask[cc.j * nx + cc.i] === 1 : false;
        if (inside && Number.isNaN(start)) start = y;
        if ((!inside || y > vmax + 1) && !Number.isNaN(start)) {
          if (y - start >= 20) {
            const line: Pt[] = [toWorld(f, wc + start * cot, start), toWorld(f, wc + (y - 1) * cot, y - 1)];
            const prof = gradeLimitedProfile(dem, line, lim.secondary);
            let earth = 0;
            for (let q = 1; q < prof.s.length; q += 1) {
              earth += Math.abs(prof.design[q]! - prof.terrain[q]!) * (prof.s[q]! - prof.s[q - 1]!) * width.secondary;
            }
            if (earth / lineLength(line) <= maxCrossEarth) addRoadLine('secondary', line, why);
            else {
              droppedCross += 1;
              droppedEarth += earth;
            }
          }
          start = Number.NaN;
        }
      }
    }
  });
  if (droppedCross > 0) {
    notes.push(
      `${droppedCross} cross streets left out: grading them to 1:${Math.round(1 / lim.secondary)} would move ${Math.round(droppedEarth).toLocaleString()} m³ (over ${maxCrossEarth} m³ a metre)`,
    );
  }
  // Cells into blocks by their grid cell, less the roads.
  const byKey = new Map<string, number[]>();
  zones.forEach((zone, zi) => {
    const zf = zoneFrames[zi];
    if (!zf) return;
    for (const k of zone) {
      if (network[k]) continue;
      const [x, y] = toFrame(zf.f, dem.cellCentre(k % nx, Math.floor(k / nx)));
      const m = Math.floor((x - y * zf.cot - zf.w0) / crossPitch);
      const kk = Math.floor((y - zf.v0) / pitch);
      const key = `${zi}:${kk}:${m}`;
      const list = byKey.get(key);
      if (list) list.push(k);
      else byKey.set(key, [k]);
    }
  });
  const nearNetForFront = dilate(dem, network, dem.cell * 1.5);
  const tierMaskOf = (tier: RoadTier): Mask => {
    if (tier === 'existing') return L.existingRoads.mask;
    let m = emptyMask(dem);
    for (const r of roads) if (r.tier === tier) m = or(m, maskFromGeom(dem, r, L.terrain.mask));
    return m;
  };
  const tierMasks: Record<'existing' | 'primary' | 'secondary', Mask> = {
    existing: tierMaskOf('existing'),
    primary: tierMaskOf('primary'),
    secondary: tierMaskOf('secondary'),
  };
  for (const [key, cells] of byKey) {
    const [zi, kk, m] = key.split(':').map(Number) as [number, number, number];
    const zf = zoneFrames[zi]!;
    const km = emptyMask(dem);
    for (const k of cells) km[k] = 1;
    for (const part of patches(dem, km)) {
      if (part.length * cellArea < minBlock) continue;
      const mask = emptyMask(dem);
      for (const k of part) mask[k] = 1;
      let g = 0;
      let gn = 0;
      let steep = 0;
      for (const k of part) {
        const v = analysis.gradient[k]!;
        if (!Number.isFinite(v)) continue;
        g += v;
        gn += 1;
        if (v > plotLimit) steep += 1;
      }
      const around = dilate(dem, mask, dem.cell * 1.5);
      const frontage = (['existing', 'primary', 'secondary'] as const).filter((t) => count(and(around, tierMasks[t])) > 0);
      void nearNetForFront;
      blocks.push({
        id: `B${blocks.length + 1}`,
        cells: part,
        mask,
        zone: zi,
        k: kk,
        m,
        f: zf.f,
        v0: zf.v0,
        geom: toMulti(dem, mask),
        areaM2: part.length * cellArea,
        meanGrade: gn > 0 ? g / gn : 0,
        steepShare: gn > 0 ? steep / gn : 0,
        frontage: [...frontage],
        centroid: centroidOf(dem, mask),
        typology: 'villas',
        why: [],
        builtUpM2: 0,
        fsi: 0,
      });
    }
  }

  /* --------------------------------------------- 12 typologies by block */
  const wetPatches = patches(dem, L.publicSpace.mask).sort((a, b) => b.length - a.length);
  const biggestPublic = emptyMask(dem);
  for (const k of wetPatches[0] ?? []) biggestPublic[k] = 1;
  const nearPublic = dilate(dem, biggestPublic, 12);
  const siteC = centroidOf(dem, L.terrain.mask);
  const gradeText = (g: number): string => `1:${(1 / Math.max(g, 1e-3)).toFixed(0)}`;
  const hasFront = (b: PlanBlock, tiers: RoadTier[]): boolean => b.frontage.some((t) => tiers.includes(t));
  const isFree = (b: GridBlock): boolean => b.typology === 'villas' && b.why.length === 0;
  const neighbours = (b: GridBlock): GridBlock[] =>
    blocks.filter(
      (o) =>
        o !== b &&
        o.zone === b.zone &&
        ((o.m === b.m && Math.abs(o.k - b.k) === 1) || (o.k === b.k && Math.abs(o.m - b.m) === 1)),
    );
  /** Grow a group of free blocks from a seed, nearest-ranked neighbours first, until it has `area`. */
  const grow = (seed: GridBlock, area: number, rank: (b: GridBlock) => number): GridBlock[] => {
    const group = [seed];
    let got = seed.areaM2;
    while (got < area) {
      const front = group
        .flatMap(neighbours)
        .filter((o) => isFree(o) && !group.includes(o))
        .sort((a, b) => rank(a) - rank(b));
      const next = front[0];
      if (!next) break;
      group.push(next);
      got += next.areaM2;
    }
    return group;
  };
  type Parcel = { id: string; cells: number[]; mask: Mask; areaM2: number; blocks: GridBlock[] };
  const parcelOf = (group: GridBlock[], id: string): Parcel => {
    let mask = emptyMask(dem);
    const cells: number[] = [];
    for (const b of group) {
      mask = or(mask, b.mask);
      cells.push(...b.cells);
    }
    return { id, cells, mask, areaM2: group.reduce((s, b) => s + b.areaM2, 0), blocks: group };
  };

  type Placed = { ring: Ring; samples: { p: Pt; a: number; b: number }[] };
  /**
   * Up to `want` buildings of `dims` in a parcel: on a 2 m lattice in the
   * parcel's own frame, long side along the contours or across them, kept
   * `setback` (+ `extra`) inside, flattest ground first, never nearer than
   * `clear` to another.
   */
  const place = (
    b: { cells: number[]; mask: Mask },
    dims: { L: number; D: number },
    setback: number,
    clear: number,
    want: number,
    extra: number,
  ): Placed[] => {
    if (want <= 0) return [];
    const f = frameFor(dem, b.cells);
    const inset = erode(dem, b.mask, setback + extra);
    let umin = Infinity;
    let umax = -Infinity;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const k of b.cells) {
      const [a, bb] = toFrame(f, dem.cellCentre(k % nx, Math.floor(k / nx)));
      umin = Math.min(umin, a);
      umax = Math.max(umax, a);
      vmin = Math.min(vmin, bb);
      vmax = Math.max(vmax, bb);
    }
    const cands: { a0: number; a1: number; b0: number; b1: number; fall: number }[] = [];
    for (const along of [true, false]) {
      const du = along ? dims.L : dims.D;
      const dv = along ? dims.D : dims.L;
      for (let a = umin + du / 2; a <= umax - du / 2; a += 2) {
        for (let bb = vmin + dv / 2; bb <= vmax - dv / 2; bb += 2) {
          const smp = rectSamples(f, a - du / 2, a + du / 2, bb - dv / 2, bb + dv / 2, 2);
          if (!allIn(dem, inset, smp)) continue;
          let lo = Infinity;
          let hi = -Infinity;
          for (const q of smp) {
            const z = dem.sampleBilinear(q.p);
            if (!Number.isFinite(z)) continue;
            lo = Math.min(lo, z);
            hi = Math.max(hi, z);
          }
          cands.push({ a0: a - du / 2, a1: a + du / 2, b0: bb - dv / 2, b1: bb + dv / 2, fall: hi - lo + (along ? 0 : 0.5) });
        }
      }
    }
    cands.sort((x, y) => x.fall - y.fall);
    const chosen: Placed[] = [];
    for (const cnd of cands) {
      if (chosen.length >= want) break;
      const ring = rectRing(f, cnd.a0, cnd.a1, cnd.b0, cnd.b1);
      if (chosen.some((o) => ringGap(o.ring, ring) < clear)) continue;
      chosen.push({ ring, samples: rectSamples(f, cnd.a0, cnd.a1, cnd.b0, cnd.b1, 1) });
    }
    return chosen;
  };

  const fitAmenity = (
    p: Parcel,
    occ: Occupancy,
    buaM2: number,
    maxFloors: number,
  ): { floors: number; wings: Placed[]; wingPlate: number; key: string; coverage: number } | null => {
    const cf = coverageFsi(input.kmbr, occ);
    let floors = 1;
    while (floors < maxFloors && buaM2 / floors > (cf.coveragePct / 100) * p.areaM2) floors += 1;
    for (; floors <= maxFloors; floors += 1) {
      const plate = buaM2 / floors;
      const nW = Math.max(1, Math.ceil(plate / wingMax));
      const wingPlate = plate / nW;
      const wings = place(p, plateDims(wingPlate, 2), amenitySetback, wingGap, nW, 0);
      if (wings.length === nW) return { floors, wings, wingPlate, key: cf.key, coverage: cf.coveragePct };
    }
    return null;
  };

  const parcels: { parcel: Parcel; use: Typology; placed: Placed[]; fit?: NonNullable<ReturnType<typeof fitAmenity>> }[] = [];
  const priority = pick<string[]>(planning, 'typology_priority', ['school', 'clubhouse', 'senior', 'apartments', 'villas']);
  let clubCentroid: Pt | null = null;
  const assign = (group: GridBlock[], use: Typology, why: string[]): void => {
    for (const b of group) {
      b.typology = use;
      b.why = why;
    }
  };
  const tryAmenity = (
    use: 'school' | 'clubhouse',
    occ: Occupancy,
    buaM2: number,
    maxFloors: number,
    landM2: number,
    seedRank: (b: GridBlock) => number,
    why: (p: Parcel) => string[],
  ): boolean => {
    const seeds = blocks.filter(isFree).sort((a, b) => seedRank(a) - seedRank(b));
    for (const seed of seeds) {
      for (const target of [landM2, landM2 * 1.5, landM2 * 2.2, landM2 * 3.5]) {
        const group = grow(seed, target, (b) => b.meanGrade);
        const p = parcelOf(group, `${use}`);
        const fit = fitAmenity(p, occ, buaM2, maxFloors);
        if (!fit) continue;
        assign(group, use, why(p));
        parcels.push({ parcel: p, use, placed: fit.wings, fit });
        if (use === 'clubhouse') clubCentroid = centroidOf(dem, p.mask);
        return true;
      }
    }
    return false;
  };

  for (const use of priority) {
    if (use === 'school' && schoolBuaM2 > 0) {
      const ok = tryAmenity(
        'school',
        'B_school',
        schoolBuaM2,
        4,
        schoolLandM2,
        (b) => (hasFront(b, ['existing', 'primary']) ? 0 : 5) + b.meanGrade / schoolMaxGrade,
        (p) => [
          `campus of ${(p.areaM2 / M2_PER_ACRE).toFixed(1)} ac for ${schoolLandAc} ac asked (programme.yaml school core_campus)`,
          'grown from the gentlest block with primary frontage, for buses and drop-off',
        ],
      );
      if (!ok) notes.push('no group of blocks holds the school campus and building');
    }
    if (use === 'clubhouse' && clubBuaM2 > 0) {
      const ok = tryAmenity(
        'clubhouse',
        'D1_recreational',
        clubBuaM2,
        2,
        clubLandM2,
        (b) =>
          (count(and(b.mask, nearPublic)) > 0 ? 0 : 5) + Math.hypot(b.centroid[0] - siteC[0], b.centroid[1] - siteC[1]) / 200,
        () => [
          `${(clubBuaM2 * 10.7639).toFixed(0)} sq ft of clubhouse (programme.yaml, use: club)`,
          'beside the largest public-space patch, which takes the mini golf and landscape, and central',
        ],
      );
      if (!ok) notes.push('no group of blocks holds the clubhouse');
    }
    if (use === 'senior' && senNeeded > 0) {
      let left = senNeeded;
      const perBuilding = (senDims.L + sen.clear) * (senDims.D + sen.clear);
      for (let round = 0; round < 60 && left > 0; round += 1) {
        const cc = clubCentroid;
        const seed = blocks
          .filter(isFree)
          .sort((a, b) => {
            const sc = (x: GridBlock): number =>
              x.meanGrade / plotLimit + (cc ? Math.hypot(x.centroid[0] - cc[0], x.centroid[1] - cc[1]) / 300 : 0);
            return sc(a) - sc(b);
          })[0];
        if (!seed) break;
        const group = grow(seed, left * perBuilding * 1.3, (b) => b.meanGrade);
        const p = parcelOf(group, `senior-${round + 1}`);
        const got = place(p, senDims, sen.setback, sen.clear, left, 0);
        if (got.length === 0) {
          seed.why = ['no senior building fits here'];
          seed.typology = 'villas';
          continue;
        }
        left -= got.length;
        assign(group, 'senior', [
          `senior living: ${seniorUnits} units need ${senNeeded} buildings of ${senPerBuilding}; this group holds ${got.length}`,
          `gentle ground (mean ${gradeText(p.blocks.reduce((s, b) => s + b.meanGrade * b.areaM2, 0) / p.areaM2)}) for step-free movement` + (cc ? ', near the clubhouse' : ''),
        ]);
        parcels.push({ parcel: p, use: 'senior', placed: got });
      }
      for (const b of blocks) if (b.why[0] === 'no senior building fits here') b.why = [];
      if (left > 0) notes.push(`${left} senior buildings found no room`);
    }
    if (use === 'apartments' && aptNeeded > 0) {
      let left = aptNeeded;
      const perTower = Math.max(
        (aptPlate * apt.maxFloors) / apt.fsi,
        (aptDims.L + 2 * apt.podium + towerClear) * (aptDims.D + 2 * apt.podium + towerClear),
      );
      for (let round = 0; round < 80 && left > 0; round += 1) {
        const seed = blocks
          .filter(isFree)
          .sort((a, b) => {
            const sc = (x: GridBlock): number => -x.meanGrade / plotLimit + (hasFront(x, ['existing', 'primary']) ? 0 : 0.5);
            return sc(a) - sc(b);
          })[0];
        if (!seed) break;
        const group = grow(seed, left * perTower, (b) => -b.meanGrade);
        const p = parcelOf(group, `apartments-${round + 1}`);
        const fsiCap = Math.floor((apt.fsi * p.areaM2) / (aptPlate * apt.maxFloors));
        const got = place(p, aptDims, apt.setback, towerClear, Math.min(left, fsiCap), apt.podium);
        if (got.length === 0) {
          seed.why = ['no tower fits here'];
          continue;
        }
        left -= got.length;
        assign(group, 'apartments', [
          `apartments: ${aptUnits} units need ${aptNeeded} towers; this group holds ${got.length} within FSI ${apt.fsi}`,
          `undulating ground (mean ${gradeText(p.blocks.reduce((s, b) => s + b.meanGrade * b.areaM2, 0) / p.areaM2)}): podiums take up the fall where villa plots would need earthwork`,
        ]);
        parcels.push({ parcel: p, use: 'apartments', placed: got });
      }
      for (const b of blocks) if (b.why[0] === 'no tower fits here') b.why = [];
      if (left > 0) notes.push(`${left} apartment towers found no room`);
    }
  }
  // Every parcel must reach a road: one with no frontage gets a secondary
  // connector from the network, held to 1:7.
  for (const pc of parcels) {
    const touch = count(and(pc.parcel.mask, dilate(dem, network, dem.cell * 1.5))) > 0;
    if (touch) continue;
    const sources: number[] = [];
    for (let k = 0; k < n; k += 1) if (network[k]) sources.push(k);
    const r = route({ dem, cost: baseCost, grade: lim.secondary, overGradePenalty: penalty, sources, targets: pc.parcel.mask });
    if (r.path) addRoad('secondary', r.path, `gives the ${pc.use} parcel its road access`);
    else notes.push(`the ${pc.use} parcel ${pc.parcel.id} has no road access that can be built`);
  }

  // A group grows until its buildings fit; blocks no building stands on go
  // back to the villas, keeping the land each use must hold on its own:
  // FSI for apartments, the campus for the school, the building land for
  // the clubhouse, a building's share with its clearance for senior living.
  for (const pc of parcels) {
    const holds = new Set<number>();
    for (const pl of pc.placed) {
      for (const q of pl.samples) {
        const cc = dem.cellAt(q.p);
        if (cc) {
          const bi = blocks.indexOf(pc.parcel.blocks.find((b) => b.mask[cc.j * nx + cc.i] === 1) as GridBlock);
          if (bi >= 0) holds.add(bi);
        }
      }
    }
    const keepArea =
      pc.use === 'apartments'
        ? (pc.placed.length * aptPlate * apt.maxFloors) / apt.fsi
        : pc.use === 'school'
          ? schoolLandM2
          : pc.use === 'clubhouse'
            ? clubLandM2
            : pc.placed.length * (senDims.L + sen.clear) * (senDims.D + sen.clear);
    let area = pc.parcel.areaM2;
    const spare = pc.parcel.blocks
      .filter((b) => !holds.has(blocks.indexOf(b)))
      .sort((a, b) => a.areaM2 - b.areaM2);
    const released: GridBlock[] = [];
    for (const b of spare) {
      if (area - b.areaM2 < keepArea) continue;
      area -= b.areaM2;
      b.typology = 'villas';
      b.why = [];
      released.push(b);
    }
    if (released.length > 0) pc.parcel.blocks = pc.parcel.blocks.filter((b) => !released.includes(b));
  }

  for (const b of blocks) {
    if (b.typology === 'villas' && b.why.length === 0) {
      b.why = [
        'villas take the land the other uses leave (planning_rules.yaml typology_priority)',
        `mean ground ${gradeText(b.meanGrade)}; ${(b.steepShare * 100).toFixed(0)}% steeper than the 1:5 plot limit`,
      ];
    }
  }

  /* ------------------------------- 9-11, 13 villa streets, plots, platforms */
  const plots: PlanPlot[] = [];
  const placedRings: Ring[] = [];
  const roadSegs: { a: Pt; b: Pt; half: number }[] = [];
  const addSegs = (line: readonly Pt[], half: number): void => {
    for (let q = 1; q < line.length; q += 1) roadSegs.push({ a: line[q - 1]!, b: line[q]!, half });
  };
  const exWidth = pick<number>(input.client, 'roads.public.width_m', 10);
  for (const r of roads) addSegs(r.centreline, r.widthM / 2);
  for (const f of input.features) if (f.kind === 'existing_road_edge') for (const line of f.lines) addSegs(line, exWidth / 2);
  const clearOfRoads = (ring: Ring): boolean => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    for (const sg of roadSegs) {
      const h = sg.half - 0.05;
      if (Math.max(sg.a[0], sg.b[0]) < minX - h || Math.min(sg.a[0], sg.b[0]) > maxX + h) continue;
      if (Math.max(sg.a[1], sg.b[1]) < minY - h || Math.min(sg.a[1], sg.b[1]) > maxY + h) continue;
      if (ringSegmentGap(ring, sg.a, sg.b) < h) return false;
    }
    return true;
  };
  // Land is tested cell by cell, but the grid runs at an angle to the 2 m
  // raster, so a plot filling its row band exactly always clips a cell of the
  // next row. Rows test against all villa land; overlaps between plots are
  // caught exactly, by geometry, in addPlot.
  const landOk = (land: Mask, smp: readonly { p: Pt }[]): boolean => {
    for (const q of smp) {
      const cc = dem.cellAt(q.p);
      if (!cc || !land[cc.j * nx + cc.i]) return false;
    }
    return true;
  };
  const blockIndex = new Int32Array(n).fill(-1);
  blocks.forEach((b, i) => {
    for (const k of b.cells) blockIndex[k] = i;
  });
  const addPlot = (f: Frame, a0: number, b0: number): boolean => {
    const ring = rectRing(f, a0, a0 + plotW, b0, b0 + plotD);
    const centre = toWorld(f, a0 + plotW / 2, b0 + plotD / 2);
    const cc = dem.cellAt(centre);
    const bi = cc ? blockIndex[cc.j * nx + cc.i]! : -1;
    if (bi < 0 || blocks[bi]!.typology !== 'villas') return false;
    if (placedRings.some((o) => rectsOverlap(o, ring)) || !clearOfRoads(ring)) return false;
    const smp = rectSamples(f, a0, a0 + plotW, b0, b0 + plotD, 1);
    const pf = platformFor(dem, smp, plotLimit, delta);
    plots.push({
      id: `P${plots.length + 1}`,
      blockId: blocks[bi]!.id,
      ring,
      areaM2: plotW * plotD,
      widthM: plotW,
      depthM: plotD,
      platform: {
        existingGrade: pf.existingGrade,
        designGrade: pf.designGrade,
        withinLimitAsIs: pf.withinLimitAsIs,
        cutM3: pf.cutM3,
        fillM3: pf.fillM3,
        maxCutM: pf.maxCutM,
        maxFillM: pf.maxFillM,
      },
      baseRl: pf.level(a0 + plotW / 2, b0 + plotD / 2),
      groundFloor: scaleRing(ring, Math.sqrt(gfShare)),
      upperFloor: scaleRing(ring, Math.sqrt(ffShare)),
      builtUpM2: plotW * plotD * (gfShare + ffShare),
      fsi: gfShare + ffShare,
      floorHeightM: vfh,
    });
    placedRings.push(ring);
    return true;
  };

  let villaLand = emptyMask(dem);
  for (const b of blocks) if (b.typology === 'villas') villaLand = or(villaLand, b.mask);

  // One street through the middle of each run of villa blocks along a grid row.
  const rows = new Map<string, GridBlock[]>();
  for (const b of blocks) {
    if (b.typology !== 'villas') continue;
    const key = `${b.zone}:${b.k}`;
    const list = rows.get(key);
    if (list) list.push(b);
    else rows.set(key, [b]);
  }
  for (const [key, row] of rows) {
    const [zi] = key.split(':').map(Number) as [number];
    const zf = zoneFrames[zi]!;
    const f = zf.f;
    const vs = zf.v0 + (row[0]!.k + 0.5) * pitch;
    let rowMask = emptyMask(dem);
    for (const b of row) rowMask = or(rowMask, b.mask);
    const land = or(villaLand, network);
    let umin = Infinity;
    let umax = -Infinity;
    for (const b of row) {
      for (const k of b.cells) {
        const [x] = toFrame(f, dem.cellCentre(k % nx, Math.floor(k / nx)));
        umin = Math.min(umin, x);
        umax = Math.max(umax, x);
      }
    }
    // Runs of the street line through the row's own land.
    const runs: [number, number][] = [];
    let start = Number.NaN;
    for (let x = umin - 1; x <= umax + 2; x += 1) {
      const cc = dem.cellAt(toWorld(f, x, vs));
      const inside = cc ? rowMask[cc.j * nx + cc.i] === 1 : false;
      if (inside && Number.isNaN(start)) start = x;
      if ((!inside || x > umax + 1) && !Number.isNaN(start)) {
        runs.push([start, x - 1]);
        start = Number.NaN;
      }
    }
    for (const [a0, a1] of runs) {
      if (a1 - a0 < plotW) continue;
      // Stretch the street to meet the road network at either end, if it is close.
      let s0 = a0;
      let s1 = a1;
      const netNear = (x: number): boolean => {
        const cc = dem.cellAt(toWorld(f, x, vs));
        return cc ? network[cc.j * nx + cc.i] === 1 : false;
      };
      for (let d = 1; d <= 12 && !netNear(s0); d += 1) if (netNear(a0 - d)) s0 = a0 - d;
      for (let d = 1; d <= 12 && !netNear(s1); d += 1) if (netNear(a1 + d)) s1 = a1 + d;
      const joined = netNear(s0) || netNear(s1);
      const line: Pt[] = [toWorld(f, s0, vs), toWorld(f, s1, vs)];
      let linkPath: number[] | null = null;
      if (!joined) {
        const cost = Float32Array.from(baseCost);
        for (let k = 0; k < n; k += 1) {
          if (network[k]) cost[k] = 0.5;
          else if (Number.isFinite(cost[k]!) && !villaLand[k]) cost[k] = cost[k]! * 2;
        }
        const src = [line[0]!, line[1]!]
          .map((p) => dem.cellAt(p))
          .filter((cc): cc is { i: number; j: number } => cc !== null)
          .map((cc) => cc.j * nx + cc.i)
          .filter((k) => Number.isFinite(cost[k]!));
        const r = route({ dem, cost, grade: lim.tertiary, overGradePenalty: penalty, sources: src, targets: network });
        if (!r.path || r.path.length * dem.cell > 400) continue;
        linkPath = r.path;
      }
      const prof = gradeLimitedProfile(dem, line, lim.tertiary);
      const cor = corridor(dem, line, tw, prof, delta);
      const streetMask = and(cor.mask, L.terrain.mask);
      roads.push({
        id: `tertiary-${roads.filter((r) => r.tier === 'tertiary').length + 1}`,
        tier: 'tertiary',
        centreline: line,
        widthM: tw,
        geom: toMulti(dem, streetMask),
        lengthM: lineLength(line),
        limit: lim.tertiary,
        terrainMaxGrade: prof.terrainMaxGrade,
        designMaxGrade: prof.designMaxGrade,
        withinLimitAsIs: prof.terrainMaxGrade <= lim.tertiary + 1e-6,
        cutM3: cor.cutM3,
        fillM3: cor.fillM3,
        notes: ['villa street along the contours, a row of plots either side'],
      });
      network = or(network, streetMask);
      if (linkPath) {
        const lk = pathToLine(dem, linkPath);
        addRoadLine('tertiary', lk, 'links a villa street to the network');
        addSegs(lk, tw / 2);
      }
      // Plots either side, sliding along the street to the first place each fits.
      for (const side of [1, -1] as const) {
        const b0 = side > 0 ? vs + tw / 2 + 0.25 : vs - tw / 2 - 0.25 - plotD;
        for (let x = a0 - plotW / 2; x + plotW <= a1 + plotW / 2; ) {
          const smp = rectSamples(f, x, x + plotW, b0, b0 + plotD, 1.5);
          if (landOk(land, smp) && addPlot(f, x, b0)) x += plotW;
          else x += 1;
        }
      }
      addSegs(line, tw / 2 - 0.3);
    }
  }

  // Then the edges: plots fronting the primary, secondary and existing roads
  // wherever villa land is left along them.
  const fronts: { line: Pt[]; off: number }[] = [
    ...roads.filter((r) => r.tier === 'primary' || r.tier === 'secondary').map((r) => ({ line: r.centreline, off: r.widthM / 2 + 0.25 })),
    ...input.features.filter((f) => f.kind === 'existing_road_edge').flatMap((f) => f.lines.map((line) => ({ line, off: exWidth / 2 + 0.25 }))),
  ];
  const villaPlusRoads = or(villaLand, network);
  let frontageCount = 0;
  for (const { line, off } of fronts) {
    for (let q = 1; q < line.length; q += 1) {
      const A = line[q - 1]!;
      const B = line[q]!;
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (len < plotW) continue;
      const t: Pt = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
      for (const side of [1, -1]) {
        const v: Pt = [-t[1] * side, t[0] * side];
        const f: Frame = side > 0 ? { c: A, u: t, v } : { c: A, u: [-t[0], -t[1]], v };
        for (let x = 0; x + plotW <= len + 1e-6; ) {
          const a0 = side > 0 ? x : -(x + plotW);
          const smp = rectSamples(f, a0, a0 + plotW, off, off + plotD, 1.5);
          if (landOk(villaPlusRoads, smp) && addPlot(f, a0, off)) {
            frontageCount += 1;
            x += plotW;
          } else x += 1;
        }
      }
    }
  }
  if (frontageCount > 0) notes.push(`${frontageCount} villa plots front the primary, secondary and existing roads directly`);

  for (const b of blocks) {
    if (b.typology !== 'villas') continue;
    const inBlock = plots.filter((p) => p.blockId === b.id);
    b.builtUpM2 = inBlock.reduce((acc, p) => acc + p.builtUpM2, 0);
    b.fsi = b.areaM2 > 0 ? b.builtUpM2 / b.areaM2 : 0;
    if (inBlock.length === 0) {
      b.typology = 'open';
      b.why = [...b.why, 'no villa plot fits this block: kept as open space'];
    } else b.why = [...b.why, `${inBlock.length} plots`];
  }

  /* ------------------------------------ 13-14 buildings from the placements */
  const buildings: PlanBuilding[] = [];
  let seniorPlaced = 0;
  let aptPlaced = 0;
  for (const { parcel, use, placed, fit } of parcels) {
    if (use === 'senior') {
      for (const pl of placed) {
        const u = Math.min(senPerBuilding, seniorUnits - seniorPlaced);
        if (u <= 0) break;
        seniorPlaced += u;
        const pf = platformFor(dem, pl.samples, 0, delta, true);
        buildings.push({
          id: `S${buildings.filter((x) => x.typology === 'senior').length + 1}`,
          blockId: blockOfRing(pl.ring, parcel.blocks),
          typology: 'senior',
          ring: pl.ring,
          footprintM2: senPlate,
          floors: sen.floors,
          heightM: sen.floors * sen.fh,
          baseRl: pf.level(0, 0),
          units: u,
          builtUpM2: senPlate * sen.floors,
          platform: platformOnly(pf),
          notes: [
            `${u} units: ${sen.upf} a floor × ${sen.floors} floors (G+${sen.floors - 1}); plate ${senPlate.toFixed(0)} m² = ${sen.upf} × ${(seniorPlinthM2 * 10.7639).toFixed(0)} sq ft ÷ ${sen.eff}`,
            `on a level pad; ${sen.clear} m clear of every other senior building`,
          ],
        });
      }
    }
    if (use === 'apartments') {
      for (const pl of placed) {
        const u = Math.min(aptPerTower, aptUnits - aptPlaced);
        if (u <= 0) break;
        aptPlaced += u;
        const podiumRing = scaleRingBy(pl.ring, apt.podium);
        let lo = Infinity;
        let hi = -Infinity;
        for (const smp of ringSamples(podiumRing, 2)) {
          const z = dem.sampleBilinear(smp);
          if (!Number.isFinite(z)) continue;
          lo = Math.min(lo, z);
          hi = Math.max(hi, z);
        }
        const podH = Math.max(0, hi - lo);
        const floors = Math.ceil(u / apt.fpf);
        buildings.push({
          id: `T${buildings.filter((x) => x.typology === 'apartments').length + 1}`,
          blockId: blockOfRing(pl.ring, parcel.blocks),
          typology: 'apartments',
          ring: pl.ring,
          footprintM2: aptPlate,
          floors,
          heightM: floors * apt.fh,
          baseRl: hi,
          units: u,
          builtUpM2: aptPlate * floors,
          podium: { ring: podiumRing, topRl: hi, bottomRl: lo, heightM: podH, levels: Math.ceil(podH / apt.fh) },
          notes: [
            `${u} flats: ${apt.fpf} a floor × ${floors} floors; plate ${aptPlate.toFixed(0)} m²`,
            `podium follows the ground: ${podH.toFixed(1)} m from its low side to the tower floor (${Math.ceil(podH / apt.fh)} levels); no flat platform cut`,
            `${towerClear.toFixed(0)} m clear of every other tower (client 12 m; KMBR for a ${towerH} m building)`,
          ],
        });
      }
    }
    if ((use === 'school' || use === 'clubhouse') && fit) {
      const buaM2 = use === 'school' ? schoolBuaM2 : clubBuaM2;
      fit.wings.forEach((w, i) => {
        const pf = platformFor(dem, w.samples, 0, delta, true);
        buildings.push({
          id: `${use === 'school' ? 'SCH' : 'CLUB'}-${i + 1}`,
          blockId: blockOfRing(w.ring, parcel.blocks),
          typology: use,
          ring: w.ring,
          footprintM2: fit.wingPlate,
          floors: fit.floors,
          heightM: fit.floors * 4,
          baseRl: pf.level(0, 0),
          units: 0,
          builtUpM2: fit.wingPlate * fit.floors,
          platform: platformOnly(pf),
          notes: [
            `wing ${i + 1} of ${fit.wings.length}: ${(buaM2 * 10.7639).toFixed(0)} sq ft in all over ${fit.floors} floors`,
            `${fit.key}: coverage up to ${fit.coverage}%; wings ${wingGap} m apart (planning_rules.yaml amenities)`,
          ],
        });
      });
    }
  }
  for (const b of blocks) {
    if (b.typology === 'villas' || b.typology === 'open') continue;
    const inBlock = buildings.filter((x) => x.blockId === b.id);
    b.builtUpM2 = inBlock.reduce((acc, x) => acc + x.builtUpM2, 0);
    b.fsi = b.areaM2 > 0 ? b.builtUpM2 / b.areaM2 : 0;
  }

  /** Which of a parcel's blocks holds most of a ring. */
  function blockOfRing(ring: Ring, group: GridBlock[]): string {
    const c = ring.reduce((acc, p) => [acc[0] + p[0] / ring.length, acc[1] + p[1] / ring.length] as Pt, [0, 0] as Pt);
    const cc = dem.cellAt(c);
    if (cc) {
      const bi = blockIndex[cc.j * nx + cc.i]!;
      if (bi >= 0) return blocks[bi]!.id;
    }
    return group[0]?.id ?? '';
  }

  /* ------------------------------------------------ 13 FSI per parcel */
  const parcelSummary: PlanParcel[] = parcels.map((pc) => {
    const ids = new Set(pc.parcel.blocks.map((b) => b.id));
    const inside = buildings.filter((x) => ids.has(x.blockId));
    const area = pc.parcel.blocks.reduce((acc, b) => acc + b.areaM2, 0);
    const built = inside.reduce((acc, x) => acc + x.builtUpM2, 0);
    return {
      id: pc.parcel.id,
      use: pc.use,
      blockIds: [...ids],
      areaM2: area,
      builtUpM2: built,
      fsi: area > 0 ? built / area : 0,
      buildings: inside.length,
    };
  });
  for (const b of blocks) {
    if (b.typology !== 'villas') continue;
    const inBlock = plots.filter((x) => x.blockId === b.id);
    if (inBlock.length === 0) continue;
    parcelSummary.push({
      id: `villas-${b.id}`,
      use: 'villas',
      blockIds: [b.id],
      areaM2: inBlock.reduce((acc, x) => acc + x.areaM2, 0),
      builtUpM2: inBlock.reduce((acc, x) => acc + x.builtUpM2, 0),
      fsi: gfShare + ffShare,
      buildings: inBlock.length,
    });
  }

  /* ------------------------------------------------------ programme */
  const villaPlaced = plots.length;
  const seniorBuilt = buildings.filter((x) => x.typology === 'senior').reduce((s, x) => s + x.units, 0);
  const aptBuilt = buildings.filter((x) => x.typology === 'apartments').reduce((s, x) => s + x.units, 0);
  const programme: ProgrammeRow[] = [
    {
      use: 'Villas',
      asked: `${villaUnits} units`,
      placed: `${villaPlaced} plots`,
      met: villaPlaced >= villaUnits,
      note: `${plotW} × ${plotD.toFixed(1)} m plots, ${(plotArea * 10.7639).toFixed(0)} sq ft built (FSI ${vFsi})`,
    },
    {
      use: 'Senior living',
      asked: `${seniorUnits} units`,
      placed: `${seniorBuilt} units in ${buildings.filter((x) => x.typology === 'senior').length} buildings`,
      met: seniorBuilt >= seniorUnits,
      note: `G+${sen.floors - 1}, ${sen.upf} units a floor`,
    },
    {
      use: 'Apartments',
      asked: `${aptUnits} units`,
      placed: `${aptBuilt} units in ${buildings.filter((x) => x.typology === 'apartments').length} towers`,
      met: aptBuilt >= aptUnits,
      note: `${apt.fpf} flats a floor, up to ${apt.maxFloors} floors, FSI ≤ ${apt.fsi} per block`,
    },
    {
      use: 'School',
      asked: `${(schoolBuaM2 * 10.7639).toFixed(0)} sq ft`,
      placed: buildings.some((x) => x.typology === 'school') ? 'placed' : 'not placed',
      met: buildings.some((x) => x.typology === 'school'),
      note: `${schoolLandAc} ac campus`,
    },
    {
      use: 'Clubhouse',
      asked: `${(clubBuaM2 * 10.7639).toFixed(0)} sq ft`,
      placed: buildings.some((x) => x.typology === 'clubhouse') ? 'placed' : 'not placed',
      met: buildings.some((x) => x.typology === 'clubhouse'),
      note: 'mini golf in the public space beside it',
    },
  ];
  const skipped = ['commercial', 'hotel', 'office', 'hospital', 'convention'].filter((u) => byUse(u).length > 0);
  if (skipped.length > 0) {
    programme.push({
      use: 'Not placed by the pipeline',
      asked: skipped.join(', '),
      placed: '—',
      met: false,
      note: 'outside the owner workflow (planning_rules.yaml typology_priority)',
    });
  }

  let cut = 0;
  let fill = 0;
  for (let k = 0; k < n; k += 1) {
    const d = delta[k]!;
    if (d > 0) fill += d * cellArea;
    else cut -= d * cellArea;
  }

  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return {
    roads,
    blocks: blocks.map((b) => ({
      id: b.id,
      geom: b.geom,
      areaM2: b.areaM2,
      meanGrade: b.meanGrade,
      steepShare: b.steepShare,
      frontage: b.frontage,
      centroid: b.centroid,
      typology: b.typology,
      why: b.why,
      builtUpM2: b.builtUpM2,
      fsi: b.fsi,
    })),
    plots,
    buildings,
    parcels: parcelSummary,
    earthwork: delta,
    cutM3: cut,
    fillM3: fill,
    programme,
    existingRoads: { lengthM: exLen, overLimitM: exOver, maxGrade: exMax, limit: exLimit },
    roadMask: network,
    notes,
    ms,
  };
}

/* ------------------------------------------------------ small helpers */

function schoolLand(lines: ProgrammeLine[]): number {
  const s = lines.find((l) => l.use === 'school');
  if (!s || s.land_ac === undefined) return 0;
  if (typeof s.land_ac === 'number') return s.land_ac;
  return s.land_ac['core_campus'] ?? 0;
}

/** Magnitude of the mean ground gradient over a set of cells (rise over run). */
function zoneGrade(dem: Dem, cells: readonly number[]): number {
  const { nx } = dem.meta;
  let gx = 0;
  let gy = 0;
  let c = 0;
  for (const k of cells) {
    const i = k % nx;
    const j = (k - i) / nx;
    const zl = dem.at(i - 1, j);
    const zr = dem.at(i + 1, j);
    const zd = dem.at(i, j - 1);
    const zu = dem.at(i, j + 1);
    if (![zl, zr, zd, zu].every(Number.isFinite)) continue;
    gx += (zr - zl) / (2 * dem.cell);
    gy += (zu - zd) / (2 * dem.cell);
    c += 1;
  }
  return c > 0 ? Math.hypot(gx / c, gy / c) : 0;
}

function plateDims(area: number, aspect: number): { L: number; D: number } {
  const D = Math.sqrt(area / aspect);
  return { L: D * aspect, D };
}

function centroidOf(dem: Dem, mask: Mask): Pt {
  const { nx } = dem.meta;
  let sx = 0;
  let sy = 0;
  let c = 0;
  for (let k = 0; k < mask.length; k += 1) {
    if (!mask[k]) continue;
    const p = dem.cellCentre(k % nx, Math.floor(k / nx));
    sx += p[0];
    sy += p[1];
    c += 1;
  }
  return c > 0 ? [sx / c, sy / c] : [0, 0];
}

/** A road's corridor as a mask, rebuilt from its centreline and width. */
function maskFromGeom(dem: Dem, r: PlanRoad, within: Mask): Mask {
  const { nx } = dem.meta;
  const centre = emptyMask(dem);
  for (let i = 1; i < r.centreline.length; i += 1) {
    const a = r.centreline[i - 1]!;
    const b = r.centreline[i]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (dem.cell / 2)));
    for (let t = 0; t <= steps; t += 1) {
      const cc = dem.cellAt([a[0] + ((b[0] - a[0]) * t) / steps, a[1] + ((b[1] - a[1]) * t) / steps]);
      if (cc) centre[cc.j * nx + cc.i] = 1;
    }
  }
  return and(dilate(dem, centre, r.widthM / 2), within);
}

/** A ring grown outward by `d` metres, keeping its rectangle shape. */
function scaleRingBy(r: Ring, d: number): Ring {
  // Each corner moves out along both of its edges, so every side moves out by d.
  const out: Pt[] = [];
  for (let i = 0; i < r.length; i += 1) {
    const p = r[i]!;
    const prev = r[(i - 1 + r.length) % r.length]!;
    const next = r[(i + 1) % r.length]!;
    const e1 = norm([p[0] - prev[0], p[1] - prev[1]]);
    const e2 = norm([p[0] - next[0], p[1] - next[1]]);
    out.push([p[0] + (e1[0] + e2[0]) * d, p[1] + (e1[1] + e2[1]) * d]);
  }
  return out;
}

const norm = (v: Pt): Pt => {
  const L = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / L, v[1] / L];
};

function ringSamples(r: Ring, step: number): Pt[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of r) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const inside = (p: Pt): boolean => {
    let hit = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i, i += 1) {
      const A = r[i]!;
      const B = r[j]!;
      if (A[1] > p[1] !== B[1] > p[1] && p[0] < ((B[0] - A[0]) * (p[1] - A[1])) / (B[1] - A[1]) + A[0]) hit = !hit;
    }
    return hit;
  };
  const out: Pt[] = [];
  for (let y = minY; y <= maxY; y += step) for (let x = minX; x <= maxX; x += step) if (inside([x, y])) out.push([x, y]);
  return out;
}

export const _test = { ringGap, platformFor, plateDims, scaleRingBy, ringArea, maskFrom, areaM2 };
