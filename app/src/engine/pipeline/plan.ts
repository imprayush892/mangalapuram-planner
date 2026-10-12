import type { Dem } from '../terrain/dem';
import type { MultiPoly, Pt, Ring } from '../geom/types';
import type { SiteFeature } from '../site/types';
import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import { bufferPolyline, roadFromEdge, roadStrip } from '../geom/offset';
import { difference, intersect as intersectPolys, union } from '../geom/boolean';
import { multiPolyArea, pointInMulti } from '../geom/planar';
import { coverageFsi, highRise, gapBetweenBuildingsM } from '../rules/kmbr';
import type { Occupancy } from '../rules/kmbr';
import { sftToM2, M2_PER_ACRE } from '../units';
import type { AnalysisResult } from './analysis';
import { parseRatio } from './analysis';
import type { Mask } from './mask';
import { and, areaM2, count, dilate, distanceTo, emptyMask, erode, maskFrom, minus, or, patches, rasterise, toMulti } from './mask';
import { corridor, gradeLimitedProfile, lineLength, pathToLine, route, simplify } from './route';

/**
 * Planning steps 8-16, led by the client's zoning plan (owner, 25 Sep 2026).
 *
 *   0  zones         every zone keeps the use the client's zoning plan gives it;
 *                    only the water and the terrain take ground from it
 *                    (waterlogging, Rule 22 slope, natural drains -> open space)
 *   8  roads         existing roads fixed and checked; primary roads join every
 *                    zone to the network along the gaps and edges between zones,
 *                    never through the school, clubhouse or senior campus;
 *                    in the villa zones, streets along the contours at the
 *                    spacing that fits the most plots and cross streets up the
 *                    slope; every road held to its tier's gradient
 *   9  plots         villa plots on both sides of every road through villa land:
 *                    the main type (2,500-3,000 sq ft) first, a compact one
 *                    (2,000-2,500) where the main one will not fit
 *   10-11 slope      every plot's platform held to 1:5, cut and fill balanced
 *   13-14 buildings  senior, school, clubhouse, commercial and the batching
 *                    plant as compact groups in their zones; apartment towers
 *                    spread over their zone on its lower ground, under the
 *                    airport height limit, none standing in another's view
 *   -  golf          gentle open ground in and beside the clubhouse zone
 *   -  tidy          roads that serve nothing are taken out and their land
 *                    given to green
 *   15-16 massing    everything above, ready to draw in 2D and 3D
 */

export type RoadTier = 'existing' | 'primary' | 'secondary' | 'tertiary';
export type Typology =
  | 'school'
  | 'clubhouse'
  | 'golf'
  | 'senior'
  | 'apartments'
  | 'villas'
  | 'commercial'
  | 'retail'
  | 'office'
  | 'hospital'
  | 'batching'
  | 'reserved'
  | 'future'
  | 'open'
  /** Designated recreational open space (draft model: the model's 8.3 ac, KMBR Rule 31(v)): parks and green pockets. */
  | 'park';
export type BuildingUse = 'school' | 'clubhouse' | 'senior' | 'apartments' | 'commercial' | 'retail' | 'office' | 'hospital' | 'batching';

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
  /** Villa plots fronting it. */
  plots: number;
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
  /** The client zone it lies in, or null outside every zone. */
  zone: string | null;
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
  zone: string;
  /** The plot's type in its category (villas.categories.<A|B|C>.types). */
  kind: VillaKind;
  /** Package 1 of the cashflow (Outflow B9), at its own BUA (category B only). */
  package1: boolean;
  /** Bearing the plot faces (towards its road), degrees clockwise from north. */
  facingDeg: number;
  roadId: string;
  ring: Ring;
  areaM2: number;
  widthM: number;
  depthM: number;
  platform: Platform;
  baseRl: number;
  /** Owner 28 Sep sketch: rear 1.5 m, sides 1.5 m or more, the garden in front. */
  groundFloor: Ring;
  /** On the back and both sides of the ground floor; its front is left as the balcony. */
  upperFloor: Ring;
  /** What G+1 cannot hold, on the roof at the back (owner 28 Sep); null when G+1 is enough. */
  roofRoom: Ring | null;
  groundFloorM2: number;
  upperFloorM2: number;
  roofRoomM2: number;
  /** The ground floor's roof in front of the first floor. */
  balconyM2: number;
  /** Depth of the garden between the road edge of the plot and the house. */
  frontGardenM: number;
  /** The BUA the category sets for this plot, and what the house holds (less only where even the roof room cannot). */
  targetBuiltUpM2: number;
  builtUpM2: number;
  /** Net: BUA over the plot. */
  fsi: number;
  floorHeightM: number;
}

export type VillaCategory = 'A' | 'B' | 'B_count' | 'C' | 'MIX';
/** The plot's type in its category: 'standard' / 'premium', or the draft model's type names ("2,250 sq ft plot"). */
export type VillaKind = string;

export interface PlanBuilding {
  id: string;
  blockId: string;
  zone: string;
  typology: BuildingUse;
  ring: Ring;
  footprintM2: number;
  floors: number;
  heightM: number;
  baseRl: number;
  /** Highest point, lift room and parapet included (KMBR Rule 24(2)), RL and above mean sea level. */
  topRl: number;
  topAmslM: number;
  units: number;
  builtUpM2: number;
  podium?: { ring: Ring; topRl: number; bottomRl: number; heightM: number; levels: number };
  platform?: Platform;
  notes: string[];
}

/** A development parcel: one zone's land for one use, with its FSI worked out. */
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

/** What became of one client zone. */
export interface ZoneReport {
  name: string;
  use: Typology;
  /** Draft model: the phase it is built in (0 for open space, which comes with what it serves). */
  phase?: number;
  areaM2: number;
  buildableM2: number;
  /** Taken from the zone: waterlogged at the planning storm's peak, Rule 22 slope, natural drains. */
  waterM2: number;
  steepM2: number;
  drainM2: number;
  roadsM2: number;
  /** A park (designated open space): its land net of the roads drawn across it, on the exact outlines. */
  openNetM2?: number;
  /** What was built there, in words. */
  holds: string;
}

export interface PlanResult {
  roads: PlanRoad[];
  blocks: PlanBlock[];
  plots: PlanPlot[];
  buildings: PlanBuilding[];
  parcels: PlanParcel[];
  zones: ZoneReport[];
  golf: { areaM2: number; inZoneM2: number; outsideZoneM2: number; onWaterloggedM2: number; maxGrade: number };
  airport: { capAmslM: number; capRl: number; tbmAmslM: number; rooftopM: number };
  /** Which of the six master-plan options this is, and the villa numbers behind it. */
  option: {
    /** The programme the plan is drawn to (planning_rules.yaml options.basis). */
    basis: 'draft_model' | 'client';
    /** Apartment units the towers hold (owner 12 Oct: the plan's own figure, not the model's). */
    apartmentUnits: number;
    villaSizing: VillaCategory;
    roads: 'terrain' | 'north_south';
    /** The draft-model zoning (options.draft_zoning): the model's, green pockets among the villas (D3/D4) or a green chain (D5/D6). */
    zoning: 'model' | 'green_pockets' | 'green_chain';
    /** Villas the category asks for (B: the client's count; A: what the gross FSI allows); 0 when BUA sets it (C). */
    villaTarget: number;
    /** Villa BUA the gross FSI asks for on the villa land. */
    targetBuiltUpM2: number;
    builtUpM2: number;
    /** Gross villa land: the villa zones' labels plus the phase villa land. */
    grossLandM2: number;
    grossFsi: number;
    /** Plotted share of the gross villa land (owner: 80%, 5% either way). */
    plottedShare: number;
    /** Where in each type's range the plots are cut: 0 the smallest, 1 the largest. */
    plotScale: number;
    /** The standard type's plot as cut (premium plots share its depth, wider). */
    plotW: number;
    plotD: number;
    types: { name: VillaKind; plotSft: [number, number]; buaSft: number; plotM2: number; count: number }[];
  };
  /** Design minus ground per DEM cell: + fill, − cut, 0 untouched. */
  earthwork: Float32Array;
  cutM3: number;
  fillM3: number;
  programme: ProgrammeRow[];
  existingRoads: { lengthM: number; overLimitM: number; maxGrade: number; limit: number };
  /** Owner 12 Oct: the land account (on the 2 m grid, so it adds up to the parcel exactly) and its green. */
  land: LandAccount;
  /** Road corridors of every tier, as a mask. */
  roadMask: Mask;
  notes: string[];
  ms: number;
}

/**
 * Owner 12 Oct: every acre of the parcel, once. A zone's land is gross (its own streets in it); the roads are those
 * outside every zone (the client's fixed roads, the existing roads) and the streets drawn across the parks; what no
 * zone and no road takes is green. The green, by the owner's four kinds: (1) the RC, the large public open space
 * (parks from rc_min_m2, and the lakes, owner: water counts as open space); (2) the green within the zoning (pocket
 * gardens and the green link in the villa land); (3) landscape: the small parks, the strips no zone took, and the
 * grounds round the apartment, senior, school and commercial buildings (with their drives and parking); (4) the
 * clubhouse zones, open space too.
 */
export interface LandAccount {
  /** The parcel's outline (73.54 ac): the grid's cells plus the edge strip with no survey level. */
  parcelM2: number;
  /** The parcel's edge the survey does not cover (no level, so nothing is planned on it): counted as landscape. */
  edgeM2: number;
  /** Each zone's gross land, with its programme component. */
  zones: { name: string; component?: string; use: Typology; phase?: number; areaM2: number }[];
  roadsM2: number;
  green: { rcM2: number; lakesM2: number; zoneM2: number; landscapeM2: number; groundsM2: number; clubM2: number };
  /** RC + lakes + zone green + small parks, strips and the edge: the open space no component's land holds (the model's Inputs C38). */
  openSpaceM2: number;
}

export interface PlanInput {
  dem: Dem;
  features: SiteFeature[];
  /**
   * The zoning, clipped to the parcel: the client's plan, or the draft model's zones, which carry
   * their use, phase and programme component (programme line id).
   */
  zones: { name: string; geom: MultiPoly; labelAc?: number; use?: string; phase?: number; component?: string; within?: string; water?: boolean; green?: string }[];
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
  // Two rings can cross like a plus sign with no corner of either inside the other: their edges cross.
  const cross = (p: Pt, q: Pt, r: Pt): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let i = 0; i < a.length; i += 1) {
    const p1 = a[i]!;
    const p2 = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j += 1) {
      const q1 = b[j]!;
      const q2 = b[(j + 1) % b.length]!;
      if (cross(p1, p2, q1) * cross(p1, p2, q2) < 0 && cross(q1, q2, p1) * cross(q1, q2, p2) < 0) return 0;
    }
  }
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
      const L = Math.hypot(ax[0], ax[1]);
      // A repeated corner has no edge, and so no axis to separate on (taking one gave false "clear" answers).
      if (L < 1e-9) continue;
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
  /** Draft model: saleable area of the component (Inputs column J); per unit when divided by units. */
  saleable_sft?: number;
  bua_sft?: number;
  land_ac?: number | Record<string, number>;
  phase?: number;
  name?: string;
  /** Moved off this land by the owner: where it goes instead. */
  deferred?: string;
}

/* ---------------------------------------------------------------- run */

interface RoadRec extends PlanRoad {
  /** Corridor cells inside the parcel. */
  cells: Int32Array;
  /** Cut (−) or fill (+) per corridor cell it grades, kept apart so a road taken out takes its earthwork with it. */
  dzCells: Int32Array;
  dz: Float32Array;
  kept: boolean;
  /** A villa street laid along a row of plots. */
  row: boolean;
  /** A drive laid to a building. */
  access: boolean;
}

interface Cand {
  f: Frame;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  fall: number;
  lo: number;
  hi: number;
  c: Pt;
}

interface Placed {
  ring: Ring;
  cand: Cand;
}

interface DraftPlot {
  facingDeg: number;
  /** The plot's outline: the rectangle, or (row ends, owner 7 Oct) a four-sided plot on the rectangle's core. */
  ring: Ring;
  /** A four-sided end plot's own area (its ring); a rectangle's is w x d. */
  area?: number;
  f: Frame;
  a0: number;
  b0: number;
  w: number;
  d: number;
  road: RoadRec | null;
  zone: string;
  kind: VillaKind;
}

const N4: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Segments bucketed on a grid, for "is anything near this rectangle" questions. */
class SegIndex {
  private readonly cells = new Map<string, { a: Pt; b: Pt; half: number }[]>();
  constructor(private readonly size: number) {}
  private key(i: number, j: number): string {
    return `${i},${j}`;
  }
  add(a: Pt, b: Pt, half: number): void {
    const s = this.size;
    const i0 = Math.floor((Math.min(a[0], b[0]) - half) / s);
    const i1 = Math.floor((Math.max(a[0], b[0]) + half) / s);
    const j0 = Math.floor((Math.min(a[1], b[1]) - half) / s);
    const j1 = Math.floor((Math.max(a[1], b[1]) + half) / s);
    for (let i = i0; i <= i1; i += 1) {
      for (let j = j0; j <= j1; j += 1) {
        const k = this.key(i, j);
        const list = this.cells.get(k);
        if (list) list.push({ a, b, half });
        else this.cells.set(k, [{ a, b, half }]);
      }
    }
  }
  addLine(line: readonly Pt[], half: number): void {
    for (let q = 1; q < line.length; q += 1) this.add(line[q - 1]!, line[q]!, half);
  }
  near(ring: Ring): { a: Pt; b: Pt; half: number }[] {
    const s = this.size;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const seen = new Set<{ a: Pt; b: Pt; half: number }>();
    for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i += 1) {
      for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j += 1) {
        for (const e of this.cells.get(this.key(i, j)) ?? []) seen.add(e);
      }
    }
    return [...seen];
  }
}

/** Rings bucketed by centre, for overlap tests between plots. */
class RingIndex {
  private readonly cells = new Map<string, Ring[]>();
  constructor(private readonly size: number) {}
  /** The grid cells a ring's bounding box covers (a long plot or wedge spans several). */
  private keys(r: Ring): string[] {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of r) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const out: string[] = [];
    for (let i = Math.floor(x0 / this.size); i <= Math.floor(x1 / this.size); i += 1) {
      for (let j = Math.floor(y0 / this.size); j <= Math.floor(y1 / this.size); j += 1) out.push(`${i},${j}`);
    }
    return out;
  }
  add(r: Ring): void {
    for (const k of this.keys(r)) {
      const list = this.cells.get(k);
      if (list) list.push(r);
      else this.cells.set(k, [r]);
    }
  }
  overlaps(r: Ring): boolean {
    for (const k of this.keys(r)) for (const o of this.cells.get(k) ?? []) if (rectsOverlap(o, r)) return true;
    return false;
  }
}

export function runPlan(input: PlanInput, analysis: AnalysisResult): PlanResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { dem, planning } = input;
  const { nx, ny } = dem.meta;
  const n = nx * ny;
  const cellArea = dem.cell * dem.cell;
  const L = analysis.layers;
  const terrain = L.terrain.mask;
  const notes: string[] = [];
  const ac = (m2: number): string => `${(m2 / M2_PER_ACRE).toFixed(2)} ac`;
  const sft = (m2: number): string => Math.round(m2 * 10.7639).toLocaleString('en-IN');

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
  const roadMode = (pick<string>(planning, 'options.road_orientation', 'terrain') === 'north_south' ? 'north_south' : 'terrain') as 'terrain' | 'north_south';
  const nsTol = pick<number>(planning, 'roads.north_south.tolerance_deg', 10);
  const nsW = pick<{ across: number; diagonal: number }>(planning, 'roads.north_south.step_weights', { across: 6, diagonal: 2.5 });
  // North-south roads (Vastu, owner 25 Sep): steps across the axis cost more.
  const dirWeight = roadMode === 'north_south' ? (di: number, dj: number): number => (di === 0 ? 1 : dj === 0 ? nsW.across : nsW.diagonal) : undefined;
  /**
   * A routed path as a line. North-south mode: straight runs kept within the
   * tolerance of north wherever the path allows (each chord within 2 m of the
   * cells it replaces), short jogs only where the path must cross over.
   */
  const lineOf = (path: number[]): Pt[] => {
    if (roadMode !== 'north_south') return pathToLine(dem, path);
    const pts: Pt[] = path.map((k) => dem.cellCentre(k % nx, Math.floor(k / nx)));
    if (pts.length < 3) return pts;
    const fits = (i: number, j: number): boolean => {
      const A = pts[i]!;
      const B = pts[j]!;
      const dx = B[0] - A[0];
      const dy = B[1] - A[1];
      const L = Math.hypot(dx, dy) || 1;
      for (let q = i + 1; q < j; q += 1) {
        const P = pts[q]!;
        if (Math.abs(dx * (A[1] - P[1]) - dy * (A[0] - P[0])) / L > 2.0) return false;
      }
      return true;
    };
    const ns = (i: number, j: number): boolean => {
      const a = Math.abs((Math.atan2(pts[j]![0] - pts[i]![0], pts[j]![1] - pts[i]![1]) * 180) / Math.PI) % 180;
      // North-south runs, or the east-west links a connection needs: never a diagonal.
      return Math.min(a, 180 - a) <= nsTol || Math.abs(a - 90) <= nsTol;
    };
    const out: Pt[] = [pts[0]!];
    let i = 0;
    while (i < pts.length - 1) {
      let bestNs = -1;
      let bestAny = i + 1;
      for (let j = i + 2; j < pts.length; j += 1) {
        if (!fits(i, j)) break;
        bestAny = j;
        if (ns(i, j)) bestNs = j;
      }
      const j = bestNs > i + 1 ? bestNs : bestAny;
      out.push(pts[j]!);
      i = j;
    }
    return out;
  };

  /* ---------------------------------------------- 0 the client's zones */
  const useRules = pick<{ match: string; use: string }[]>(planning, 'zoning.uses', []);
  const zoneUse = (name: string): Typology => {
    const r = useRules.find((u) => name.toUpperCase().includes(String(u.match).toUpperCase()));
    return (r?.use ?? 'open') as Typology;
  };
  interface ZoneInfo {
    labelAc?: number;
    name: string;
    use: Typology;
    /** Draft model: the zone's phase and its programme line (programme_draft_model.yaml id). */
    phase?: number;
    component?: string;
    mask: Mask;
    cells: number[];
    areaM2: number;
  }
  const zoneOf = new Int16Array(n).fill(-1);
  const zones: ZoneInfo[] = input.zones.map((z, zi) => {
    const r = and(rasterise(dem, z.geom), terrain);
    const mask = emptyMask(dem);
    const cells: number[] = [];
    for (let k = 0; k < n; k += 1) {
      if (!r[k] || zoneOf[k]! >= 0) continue;
      zoneOf[k] = zi;
      mask[k] = 1;
      cells.push(k);
    }
    return {
      name: z.name,
      use: z.use ? (z.use as Typology) : zoneUse(z.name),
      mask,
      cells,
      areaM2: cells.length * cellArea,
      labelAc: z.labelAc,
      ...(z.component ? { phase: z.phase, component: z.component } : {}),
    };
  });
  if (zones.every((z) => z.cells.length === 0)) notes.push('no client zone lies in the parcel: nothing to plan');
  const moveCells = (from: ZoneInfo, to: ZoneInfo, test: (k: number) => boolean): number => {
    const keep: number[] = [];
    let moved = 0;
    for (const k of from.cells) {
      if (test(k)) {
        from.mask[k] = 0;
        to.mask[k] = 1;
        to.cells.push(k);
        zoneOf[k] = zones.indexOf(to);
        moved += 1;
      } else keep.push(k);
    }
    from.cells = keep;
    from.areaM2 = keep.length * cellArea;
    to.areaM2 = to.cells.length * cellArea;
    return moved;
  };
  // ---- zoning moves (owner, 25 Sep)
  const clubZone = zones.find((z) => z.use === 'clubhouse' && z.cells.length > 0);
  const originalSenior = zones.filter((z) => z.use === 'senior' && z.cells.length > 0);
  // The clubhouse zone's dry side, across the existing road, takes another use
  // (senior living); the clubhouse keeps the wet side, with the golf.
  const drySideUse = pick<string | null>(planning, 'zoning.clubhouse_dry_side_to', null) as Typology | null;
  if (clubZone && drySideUse) {
    const sides = patches(dem, minus(clubZone.mask, L.existingRoads.mask)).filter((p) => p.length * cellArea >= M2_PER_ACRE);
    if (sides.length >= 2) {
      const wetShare = (p: number[]): number => p.filter((k) => L.waterlogging.mask[k]).length / p.length;
      const dry = [...sides].sort((a, b) => wetShare(a) - wetShare(b))[0]!;
      const inDry = new Set(dry);
      const label = drySideUse === 'senior' ? 'SENIOR LIVING' : drySideUse.toUpperCase();
      const nz: ZoneInfo = { name: `CLUBHOUSE · ${label}`, use: drySideUse, mask: emptyMask(dem), cells: [], areaM2: 0 };
      zones.push(nz);
      moveCells(clubZone, nz, (k) => inDry.has(k));
      notes.push(`${label.toLowerCase()} takes the dry side of the clubhouse zone across the existing road (${(nz.areaM2 / M2_PER_ACRE).toFixed(2)} ac); the clubhouse keeps the other side`);
    }
  }
  // The client's senior zone, all of it, joins the clubhouse as clubhouse, golf and public space.
  if (clubZone && pick<boolean>(planning, 'zoning.senior_zone_to_clubhouse', false)) {
    let moved = 0;
    for (const z of originalSenior) moved += moveCells(z, clubZone, () => true);
    if (moved > 0) notes.push(`the client's senior zone (${((moved * cellArea) / M2_PER_ACRE).toFixed(2)} ac) joins the clubhouse as clubhouse, golf and public space`);
  }

  // ---- land carved from the phase zones: apartments on the lower ground, then
  // villas by an existing road with the best outlook; the rest is to be decided.
  interface Carve {
    zone: string;
    use: Typology;
    ac: number | 'villa_share';
    by: 'low_ground' | 'road_and_view';
  }
  const carves = pick<Carve[]>(planning, 'zoning.phase_land', []);
  if (carves.length > 0) {
    const progLand = pick<number>(planning, 'villas.count_basis.programme_land_ac', 35);
    const villaLabels = zones.filter((z) => z.use === 'villas').reduce((sum, z) => sum + (z.labelAc ?? z.areaM2 / M2_PER_ACRE), 0);
    const villaCarves = carves.filter((cv) => cv.ac === 'villa_share').length;
    const villaShare = villaCarves > 0 ? Math.max(0, progLand - villaLabels) / villaCarves : 0;
    const reach = pick<number>(planning, 'zoning.phase_land_access_reach_m', 80);
    const w = pick<{ access: number; view: number; low: number }>(planning, 'zoning.phase_land_weights', { access: 0.6, view: 0.4, low: 0.7 });
    // Existing roads, inside the site or along its edge.
    const exW = pick<number>(input.client, 'roads.public.width_m', 10);
    const roadAll = emptyMask(dem);
    for (const f of input.features) {
      if (f.kind !== 'existing_road_edge') continue;
      for (const line of f.lines) {
        if (line.length < 2) continue;
        const m = rasterise(dem, roadFromEdge(line, exW));
        for (let k = 0; k < n; k += 1) if (m[k]) roadAll[k] = 1;
      }
    }
    const roadDist = distanceTo(dem, roadAll);
    // Outlook: share of the ground within 250 m at least 5 m below, sampled every 10 m.
    const probes: { x: number; y: number; z: number }[] = [];
    for (let j = 0; j < ny; j += 5) {
      for (let i = 0; i < nx; i += 5) {
        const k = j * nx + i;
        if (!terrain[k]) continue;
        const p = dem.cellCentre(i, j);
        probes.push({ x: p[0], y: p[1], z: dem.values[k]! });
      }
    }
    const outlook = (k: number): number => {
      const i = k % nx;
      const j = (k - i) / nx;
      const p = dem.cellCentre(i, j);
      const z0 = dem.values[k]!;
      let near = 0;
      let below = 0;
      for (const q of probes) {
        const d2 = (q.x - p[0]) ** 2 + (q.y - p[1]) ** 2;
        if (d2 < 400 || d2 > 62500) continue;
        near += 1;
        if (q.z < z0 - 5) below += 1;
      }
      return near > 0 ? below / near : 0;
    };
    const decided = new Set<ZoneInfo>();
    for (const cv of carves) {
      const ph = zones.find((z) => z.name.toUpperCase().startsWith(cv.zone.toUpperCase()) && !z.name.includes('·') && z.cells.length > 0);
      const acres = cv.ac === 'villa_share' ? villaShare : cv.ac;
      if (!ph || acres <= 0) continue;
      const cand = ph.cells.filter((k) => !L.waterlogging.mask[k] && !L.nonBuildable.mask[k] && !L.drains.mask[k] && !L.existingRoads.mask[k]);
      if (cand.length === 0) continue;
      let zlo = Infinity;
      let zhi = -Infinity;
      for (const k of cand) {
        zlo = Math.min(zlo, dem.values[k]!);
        zhi = Math.max(zhi, dem.values[k]!);
      }
      const score = new Map<number, number>();
      for (const k of cand) {
        const access = Math.max(0, 1 - roadDist[k]! / reach);
        const s =
          cv.by === 'low_ground'
            ? w.low * (1 - (dem.values[k]! - zlo) / Math.max(1e-6, zhi - zlo)) + (1 - w.low) * access
            : w.access * access + w.view * outlook(k);
        score.set(k, s);
      }
      // Grow one piece from the best-scoring ground until it holds its land.
      const want = Math.round((acres * M2_PER_ACRE) / cellArea);
      const inCand = new Set(cand);
      const seen = new Set<number>();
      const frontier: number[] = [];
      const push = (k: number): void => {
        if (seen.has(k) || !inCand.has(k)) return;
        seen.add(k);
        frontier.push(k);
      };
      const seed = [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const chosen = new Set<number>();
      if (seed !== undefined) push(seed);
      while (frontier.length > 0 && chosen.size < want) {
        let bi = 0;
        for (let q = 1; q < frontier.length; q += 1) if (score.get(frontier[q]!)! > score.get(frontier[bi]!)!) bi = q;
        const k = frontier.splice(bi, 1)[0]!;
        chosen.add(k);
        const i = k % nx;
        const j = (k - i) / nx;
        for (const [di, dj] of N4) {
          const a = i + di;
          const b = j + dj;
          if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
          push(b * nx + a);
        }
      }
      const label = cv.use === 'villas' ? 'VILLAS' : cv.use === 'apartments' ? 'APARTMENTS' : cv.use.toUpperCase();
      const nz: ZoneInfo = { name: `${ph.name} · ${label}`, use: cv.use, mask: emptyMask(dem), cells: [], areaM2: 0, labelAc: cv.use === 'villas' ? acres : undefined };
      zones.push(nz);
      moveCells(ph, nz, (k) => chosen.has(k));
      decided.add(ph);
      const got = nz.areaM2 / M2_PER_ACRE;
      notes.push(
        got < acres - 0.05
          ? `${nz.name}: only ${got.toFixed(2)} of ${acres.toFixed(2)} ac of buildable land is left in the phase`
          : `${nz.name}: ${got.toFixed(2)} ac, ${cv.by === 'low_ground' ? 'on the lower ground of the phase' : 'by the existing road with the best outlook'}`,
      );
    }
    for (const ph of decided) {
      const left = ph.areaM2 / M2_PER_ACRE;
      ph.name = `${ph.name} · TO BE DECIDED`;
      notes.push(`${ph.name}: ${left.toFixed(2)} ac left, to be decided with the client`);
    }
  }
  // Owner 25 Sep (sketch): a tower site may take the unzoned buildable ground
  // around it into its apartment zone, where the owner drew the tower past the zone's edge.
  for (const ts of pick<{ match: string; at: [number, number]; take_unzoned_m?: number }[]>(planning, 'apartments.tower_sites', [])) {
    if (!ts.take_unzoned_m) continue;
    const az = zones.find((z) => z.use === 'apartments' && z.name.toUpperCase().startsWith(ts.match.toUpperCase()));
    if (!az) continue;
    const zoned = emptyMask(dem);
    for (const z of zones) for (const k of z.cells) zoned[k] = 1;
    const r2 = ts.take_unzoned_m ** 2;
    let took = 0;
    for (let k = 0; k < n; k += 1) {
      if (zoned[k] || !terrain[k] || L.waterlogging.mask[k] || L.nonBuildable.mask[k] || L.drains.mask[k] || L.existingRoads.mask[k]) continue;
      const i = k % nx;
      const p = dem.cellCentre(i, (k - i) / nx);
      if ((p[0] - ts.at[0]) ** 2 + (p[1] - ts.at[1]) ** 2 > r2) continue;
      az.mask[k] = 1;
      az.cells.push(k);
      took += 1;
    }
    az.areaM2 = az.cells.length * cellArea;
    if (took > 0) notes.push(`${az.name}: takes ${((took * cellArea) / M2_PER_ACRE).toFixed(2)} ac of unzoned ground by the owner's tower site (${ts.at[0]}, ${ts.at[1]})`);
  }
  // The ground each zone can build on: not waterlogged at the planning storm's
  // peak, not Rule 22 slope, clear of the natural drains and the built roads.
  const buildable = minus(terrain, L.waterlogging.mask, L.nonBuildable.mask, L.drains.mask, L.existingRoads.mask);
  const landCache = new Map<ZoneInfo, Mask>();
  const zoneLand = (z: ZoneInfo): Mask => {
    let m = landCache.get(z);
    if (!m) {
      m = and(z.mask, buildable);
      landCache.set(z, m);
    }
    return m;
  };
  const cellsOf = (m: Mask): number[] => {
    const out: number[] = [];
    for (let k = 0; k < n; k += 1) if (m[k]) out.push(k);
    return out;
  };

  /* ------------------------------------------------ 8a existing roads */
  const existingTier = pick<string>(planning, 'roads.existing_tier', 'primary') as 'primary' | 'secondary' | 'tertiary';
  const exLimit = lim[existingTier] ?? lim.primary;
  const exWidth = pick<number>(input.client, 'roads.public.width_m', 10);
  const existingLines: Pt[][] = input.features.filter((f) => f.kind === 'existing_road_edge').flatMap((f) => f.lines);
  let exLen = 0;
  let exOver = 0;
  let exMax = 0;
  for (const line of existingLines) {
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

  /* ------------------------------------------------------- cost map */
  // Per metre of road: along a zone's edge 1, through the gaps the zoning plan
  // leaves between zones less, through a zone's middle more, and through the
  // school, clubhouse and senior campuses so much more that a road only goes
  // there to reach them.
  const c = {
    publicSpace: num(planning, 'roads.routing.cost.public_space'),
    wet: num(planning, 'roads.routing.cost.waterlogging'),
    drain: num(planning, 'roads.routing.cost.natural_drain'),
    road: num(planning, 'roads.routing.cost.existing_road'),
  };
  const interiorCost = pick<Record<string, number>>(planning, 'roads.zone_interior_cost', {});
  const edgeBand = num(planning, 'roads.zone_edge_band_m');
  const outsideCost = num(planning, 'roads.outside_zones_cost');
  const isProtected = (u: Typology): boolean => (interiorCost[u] ?? 0) > 5;
  const zoneEdge = emptyMask(dem);
  for (let k = 0; k < n; k += 1) {
    if (!terrain[k]) continue;
    const i = k % nx;
    const j = (k - i) / nx;
    for (const [di, dj] of N4) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const q = b * nx + a;
      if (terrain[q] && zoneOf[q] !== zoneOf[k]) {
        zoneEdge[k] = 1;
        break;
      }
    }
  }
  const edgeDist = distanceTo(dem, zoneEdge);
  const baseCost = new Float32Array(n).fill(Number.POSITIVE_INFINITY);
  for (let k = 0; k < n; k += 1) {
    if (!terrain[k] || L.nonBuildable.mask[k]) continue;
    const zi = zoneOf[k]!;
    let v: number;
    if (zi < 0) v = outsideCost;
    else {
      const u = zones[zi]!.use;
      const inner = interiorCost[u] ?? 2.5;
      v = isProtected(u) ? inner : edgeDist[k]! <= edgeBand ? 1 : inner;
    }
    if (L.publicSpace.mask[k]) v = Math.max(v, c.publicSpace);
    if (L.waterlogging.mask[k]) v = Math.max(v, c.wet);
    if (L.drains.mask[k]) v = Math.max(v, c.drain);
    if (L.existingRoads.mask[k]) v = c.road;
    baseCost[k] = v;
  }
  /** Owner 12 Oct: a villa street's link stays out of the land of the buildings (a clubhouse, the towers, the
   * senior blocks, the school, retail and offices): only villa land, open space and the roads. */
  const villaLinkCost = (): Float32Array => {
    const out = Float32Array.from(baseCost);
    const keepOut = new Set<Typology>(['clubhouse', 'apartments', 'senior', 'school', 'retail', 'office', 'commercial', 'hospital']);
    for (let k = 0; k < n; k += 1) {
      const zi = zoneOf[k]!;
      if (zi >= 0 && keepOut.has(zones[zi]!.use) && !L.existingRoads.mask[k]) out[k] = Number.POSITIVE_INFINITY;
    }
    return out;
  };

  /* ----------------------------------------------------------- roads */
  const roads: RoadRec[] = [];
  const network: Mask = Uint8Array.from(L.existingRoads.mask);
  const scratch = new Float32Array(n);
  const addRoad = (tier: Exclude<RoadTier, 'existing'>, line: Pt[], why: string, row = false, widthM = width[tier]): RoadRec | null => {
    if (line.length < 2 || lineLength(line) < 4) return null;
    const prof = gradeLimitedProfile(dem, line, lim[tier]);
    const cor = corridor(dem, line, widthM, prof, scratch);
    const cells: number[] = [];
    const dzCells: number[] = [];
    const dz: number[] = [];
    for (let k = 0; k < n; k += 1) {
      if (!cor.mask[k]) continue;
      if (scratch[k] !== 0) {
        dzCells.push(k);
        dz.push(scratch[k]!);
        scratch[k] = 0;
      }
      if (terrain[k]) {
        cells.push(k);
        network[k] = 1;
      }
    }
    const rec: RoadRec = {
      id: '',
      tier,
      centreline: line,
      widthM,
      geom: roadStrip(line, widthM),
      lengthM: lineLength(line),
      limit: lim[tier],
      terrainMaxGrade: prof.terrainMaxGrade,
      designMaxGrade: prof.designMaxGrade,
      withinLimitAsIs: prof.terrainMaxGrade <= lim[tier] + 1e-6,
      cutM3: cor.cutM3,
      fillM3: cor.fillM3,
      plots: 0,
      notes: [why],
      cells: Int32Array.from(cells),
      dzCells: Int32Array.from(dzCells),
      dz: Float32Array.from(dz),
      kept: true,
      row,
      access: false,
    };
    roads.push(rec);
    return rec;
  };
  const networkCells = (): number[] => cellsOf(network);
  /** Some cell of `cells` lies within `r` cells of the network. */
  const nearNetwork = (cells: readonly number[], r = 1): boolean => {
    for (const k of cells) {
      const i = k % nx;
      const j = (k - i) / nx;
      for (let dj = -r; dj <= r; dj += 1) {
        for (let di = -r; di <= r; di += 1) {
          const a = i + di;
          const b = j + dj;
          if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
          if (network[b * nx + a]) return true;
        }
      }
    }
    return false;
  };
  const rebuildNetwork = (): void => {
    network.set(L.existingRoads.mask);
    for (const r of roads) if (r.kept) for (const k of r.cells) network[k] = 1;
  };

  /* ------------------------------------------------- 8b primary roads */
  if (count(network) === 0) {
    notes.push('no existing road inside the parcel: the primary network starts from the largest zone');
    const first = [...zones].sort((a, b) => b.areaM2 - a.areaM2)[0];
    const k0 = first ? cellsOf(zoneLand(first))[0] : undefined;
    if (k0 !== undefined) network[k0] = 1;
  }
  // Owner's roads first (roads.owner_routes): laid as drawn, the routed roads then join them.
  // A route may carry its own width (client 12 Oct: the client's 18 m N-S road).
  for (const or of pick<{ tier: Exclude<RoadTier, 'existing'>; why: string; points: Pt[]; width_m?: number }[]>(planning, 'roads.owner_routes', [])) {
    addRoad(or.tier, or.points, or.why, false, or.width_m ?? width[or.tier]);
  }
  const minPiece = num(planning, 'roads.primary_serves_pieces_over_m2');
  let unreached = 0;
  const zoneOrder = zones
    .filter((z) => z.use !== 'reserved' && z.use !== 'future' && z.use !== 'open' && z.use !== 'park' && z.cells.length > 0)
    .sort((a, b) => b.areaM2 - a.areaM2);
  for (const z of zoneOrder) {
    const pieces = patches(dem, zoneLand(z))
      .filter((p) => p.length * cellArea >= minPiece)
      .sort((a, b) => b.length - a.length);
    for (const piece of pieces) {
      if (nearNetwork(piece, 1)) continue;
      const target = emptyMask(dem);
      for (const k of piece) target[k] = 1;
      const r = route({ dem, cost: baseCost, grade: lim.primary, overGradePenalty: penalty, sources: networkCells(), targets: target, dirWeight });
      if (!r.path) {
        unreached += 1;
        continue;
      }
      addRoad('primary', lineOf(r.path), `joins ${z.name} (${ac(piece.length * cellArea)} of buildable land) to the network`);
    }
  }
  if (unreached > 0) notes.push(`${unreached} pieces of zone land could not be reached by any road`);

  /* --------------------------------------- programme and typology sizes */
  const lines = pick<ProgrammeLine[]>(input.programme, 'lines', []);
  const byUse = (use: string): ProgrammeLine[] => lines.filter((l) => l.use === use);
  const units = (use: string): number => byUse(use).reduce((s, l) => s + (l.units ?? 0), 0);
  // A unit's area: its plinth, or (draft model) the component's saleable area over its units.
  const unitSft = (l: ProgrammeLine): number => l.plinth_sft ?? (l.saleable_sft && l.units ? l.saleable_sft / l.units : 0);
  const plinth = (use: string): number => {
    const ls = byUse(use).filter((l) => l.units && unitSft(l) > 0);
    const u = ls.reduce((s, l) => s + l.units!, 0);
    return u > 0 ? ls.reduce((s, l) => s + l.units! * unitSft(l), 0) / u : 0;
  };
  /** The zone's own programme line (draft model: zone component = line id). */
  const progOf = (z: ZoneInfo): ProgrammeLine | undefined => (z.component ? lines.find((l) => l.id === z.component) : undefined);
  const bua = (use: string): number => byUse(use).reduce((s, l) => s + (l.bua_sft ?? 0), 0);

  const seniorUnits = units('senior');
  const seniorPlinthM2 = sftToM2(plinth('senior'));
  const aptUnits = units('apartments');
  const aptPlinthM2 = sftToM2(plinth('apartments'));
  const schoolBuaM2 = sftToM2(bua('school'));
  const clubBuaM2 = sftToM2(bua('club'));
  const commercialBuaM2 = sftToM2(bua('commercial'));
  const conventionLine = byUse('convention')[0] as (ProgrammeLine & { hall_m2?: number }) | undefined;
  const conventionHallM2 = conventionLine?.hall_m2 ?? (conventionLine?.bua_sft ? sftToM2(conventionLine.bua_sft) : 0);

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
    minFloors: num(planning, 'apartments.min_floors'),
    eff: num(planning, 'apartments.plan_efficiency'),
    aspect: num(planning, 'apartments.plate_aspect'),
    clear: num(planning, 'apartments.min_clear_between_buildings_m'),
    setback: num(planning, 'apartments.setback_m'),
    podium: num(planning, 'apartments.podium_margin_m'),
    fh: num(planning, 'apartments.floor_height_m'),
    viewDepth: num(planning, 'apartments.view_clear_depth_m'),
    viewOverlap: num(planning, 'apartments.view_max_overlap_share'),
  };
  const air = {
    amsl: num(planning, 'airport.permissible_top_amsl_m'),
    tbmAmsl: num(planning, 'airport.tbm_amsl_m'),
    tbmRl: num(planning, 'airport.tbm_rl'),
    roof: num(planning, 'airport.rooftop_allowance_m'),
  };
  const capRl = air.amsl - air.tbmAmsl + air.tbmRl;
  const toAmsl = (rl: number): number => rl - air.tbmRl + air.tbmAmsl;
  const senPlate = (sen.upf * seniorPlinthM2) / sen.eff;
  const senPerBuilding = sen.upf * sen.floors;
  const senNeeded = seniorUnits > 0 ? Math.ceil(seniorUnits / senPerBuilding) : 0;
  const towerFootprintSft = pick<number | null>(planning, 'apartments.tower_footprint_sft', null);
  const towersPerZone = pick<number | null>(planning, 'apartments.towers_per_zone', null);
  // Owner 25 Sep: a set number of towers in each apartment zone, and the programme's
  // flats shared equally between all the towers.
  const towersByZone = pick<{ match: string; towers: number }[]>(planning, 'apartments.towers_by_zone', []);
  const unitsTotal = pick<number | null>(planning, 'apartments.units_total', null);
  const towersFor = (name: string): number | null => {
    const r = towersByZone.find((t) => name.toUpperCase().startsWith(t.match.toUpperCase()));
    return r ? r.towers : towersPerZone;
  };
  const towersAll = towersByZone.reduce((sum, t) => sum + t.towers, 0);
  const aptPlate = towerFootprintSft ? sftToM2(towerFootprintSft) : (apt.fpf * aptPlinthM2) / apt.eff;
  const flatsPerFloorSet = pick<number | null>(planning, 'apartments.tower_flats_per_floor', null);
  const towerFloorsSet = pick<number | null>(planning, 'apartments.tower_floors', null);
  const flatsPerFloor = flatsPerFloorSet ?? (towerFootprintSft ? Math.max(1, Math.floor((aptPlate * apt.eff) / aptPlinthM2)) : apt.fpf);
  const kmbrGap = (h: number, floors: number): number => {
    try {
      return gapBetweenBuildingsM(input.kmbr, h, highRise(input.kmbr, h, floors).isHighRise);
    } catch {
      return 0;
    }
  };
  const towerClear = Math.max(apt.clear, kmbrGap(apt.maxFloors * apt.fh, apt.maxFloors));
  const schoolLandAc = schoolLand(lines);
  const wingMax = num(planning, 'amenities.max_wing_plate_m2');
  const wingGap = num(planning, 'amenities.min_clear_between_wings_m');
  const amenitySetback = num(planning, 'amenities.setback_m');
  const comm = {
    occ: pick<string>(planning, 'commercial.occupancy', 'F_commercial') as Occupancy,
    maxFloors: num(planning, 'commercial.max_floors'),
    wingMax: num(planning, 'commercial.max_wing_plate_m2'),
    setback: num(planning, 'commercial.setback_m'),
    hallFh: num(planning, 'commercial.convention_floor_height_m'),
  };
  const plantDims = pick<number[]>(planning, 'batching_plant.plant_footprint_m', []);
  const plantH = num(planning, 'batching_plant.height_m');

  /* -------------------------------------- villa plot sizes (steps 9, 13) */
  // Owner 28 Sep: three villa categories. Each type has a plot range the
  // terrain may use and a BUA that stays fixed whatever the plot within it.
  interface VillaTypeRule {
    name: VillaKind;
    plot_sft: [number, number];
    bua_sft: number;
    /** MIX: the type's share of the units. */
    share?: number;
  }
  const catName = pick<string>(planning, 'options.villa_sizing', 'A');
  const villaSizing: VillaCategory = (['B', 'B_count', 'C', 'MIX'] as const).find((c) => c === catName) ?? 'A';
  const cat = pick<{
    count?: boolean;
    types: VillaTypeRule[];
    package_1?: { zone: string; units: number; bua_sft: number };
    premium_when?: { zones: string[]; outlook_min: number };
    shape?: { max_depth_m: number; depth_per_width: number; min_width_m: number };
    house?: { yards: 'kmbr'; small_plot_row: string; small_plot_max_m2: number; small_bua_max_m2: number };
    types_from_programme?: boolean;
  }>(planning, `villas.categories.${villaSizing}`, { types: [] });
  // Draft model (MIX): the model's plot types, each one size (programme villa_types, Inputs rows 130-133).
  if (cat.types_from_programme) {
    cat.types = pick<{ name: string; share: number; plot_sft: number; bua_sft: number }[]>(input.programme, 'villa_types', []).map((t) => ({
      name: t.name,
      plot_sft: [t.plot_sft, t.plot_sft],
      bua_sft: t.bua_sft,
      share: t.share,
    }));
  }
  const isMix = villaSizing === 'MIX';
  if (cat.types.length === 0) throw new Error(`planning_rules.yaml villas.categories.${villaSizing}: no villa types`);
  // Where in each type's range the plots are cut (runPlanSized searches it): 1 = the largest.
  const plotScale = Math.min(1, Math.max(0, pick<number>(planning, 'villas.plot_scale', 1)));
  const depthPerWidth = num(planning, 'villas.house.shape_depth_per_width');
  const areaOf = (t: VillaTypeRule, s: number): number => sftToM2(t.plot_sft[0] + s * (t.plot_sft[1] - t.plot_sft[0]));
  // The type rows are cut to: 'standard', or (MIX) the type with the largest share.
  const stdRule = isMix ? [...cat.types].sort((a, b) => (b.share ?? 0) - (a.share ?? 0))[0]! : (cat.types.find((t) => t.name === 'standard') ?? cat.types[0]!);
  const minRule = [...cat.types].sort((a, b) => a.plot_sft[0] - b.plot_sft[0])[0]!;
  const ruleOf = (k: VillaKind): VillaTypeRule => cat.types.find((t) => t.name === k) ?? stdRule;
  const premRule = cat.types.find((t) => t.name === 'premium') ?? null;
  // Every type shares the standard plot's depth, so a street serves them alike; a premium plot is wider.
  // The plot shape: the category's own (B3/B4: the earlier narrow, deep count plots), else the
  // shape with the most ground floor inside the owner's yards.
  const fixedDepth = pick<number | null>(planning, `villas.categories.${villaSizing}.plot_depth_m`, null);
  // MIX: once every plot of the model's sizes is laid, an end or edge plot may take in the land left
  // beside or behind it, up to this many times its type's area (owner 7 Oct: 85% of the villa land in plots).
  const mixGrow = pick<number>(planning, `villas.categories.${villaSizing}.max_plot_growth`, 1);
  const shapeOf = (a: number): { w: number; d: number } => {
    // MIX: one plot depth for every type, so a street serves them alike; the width makes the area.
    if (fixedDepth) return { w: a / fixedDepth, d: fixedDepth };
    if (cat.shape) {
      const d0 = Math.min(cat.shape.max_depth_m, Math.sqrt(cat.shape.depth_per_width * a));
      const w = Math.max(cat.shape.min_width_m, a / d0);
      return { w, d: a / w };
    }
    const d = Math.sqrt(depthPerWidth * a);
    return { w: a / d, d };
  };
  const plotD = shapeOf(areaOf(stdRule, plotScale)).d;
  const plotW = areaOf(stdRule, plotScale) / plotD;
  const premW = premRule ? areaOf(premRule, plotScale) / plotD : plotW;
  const widthOf = (k: VillaKind): number => (k === 'premium' ? premW : k === stdRule.name ? plotW : areaOf(ruleOf(k), plotScale) / plotD);
  // A plot may be cut shallower where the land runs out, down to its type's smallest area.
  const minD = sftToM2(stdRule.plot_sft[0]) / plotW;
  const depthsFor = (k: VillaKind): number[] => {
    const t = ruleOf(k);
    const dShort = sftToM2(t.plot_sft[0]) / widthOf(k);
    return dShort < plotD - 0.5 && holdsBua(widthOf(k), dShort, k) ? [plotD, dShort] : [plotD];
  };
  const buaOf = (k: VillaKind): number => sftToM2(ruleOf(k).bua_sft);
  // A plot cut to fit a pocket, or deepened into the strip behind it, stays in its range and within
  // a quarter of the size its row is cut at, so it keeps to its neighbours' scale.
  const maxFlexArea = (t: VillaTypeRule): number => Math.min(sftToM2(t.plot_sft[1]), 1.25 * areaOf(t, plotScale));
  // The gross villa land: the villa zones' labels and the phase villa land (the client's allocation).
  const villaLandAc = zones.filter((z) => z.use === 'villas').reduce((sum, z) => sum + (z.labelAc ?? z.areaM2 / M2_PER_ACRE), 0);
  const grossLandM2 = villaLandAc * M2_PER_ACRE;
  const grossFsi = num(planning, 'villas.gross_fsi');
  const targetBuaM2 = grossFsi * grossLandM2;
  // B, B3/B4 (count): the client's 700 villas at 20 an acre. A (one type): as many as the gross
  // FSI allows at its BUA. C (two types): no count; plots are laid until the BUA reaches the gross FSI.
  const perAcre = pick<number>(planning, 'villas.count_basis.programme_units', 700) / pick<number>(planning, 'villas.count_basis.programme_land_ac', 35);
  // MIX: each villa zone holds its component's units (programme_draft_model.yaml).
  const zoneVillaTarget = new Map<string, number>();
  if (isMix) for (const z of zones) if (z.use === 'villas' && progOf(z)?.units) zoneVillaTarget.set(z.name, progOf(z)!.units!);
  const villaTarget = isMix
    ? [...zoneVillaTarget.values()].reduce((a, b) => a + b, 0)
    : cat.count
      ? Math.round(villaLandAc * perAcre)
      : premRule
        ? 0
        : Math.floor(targetBuaM2 / buaOf('standard'));
  // The house's yards: the owner's (rear fixed, sides at least, KMBR Table 4's front yard in front)
  // or, for the B3/B4 small plots, KMBR Table 4's own yards, by the row the plot and its BUA fall in.
  const kmbrRow = (row: string): number[] => {
    const v = pick<number[]>(input.kmbr, `table4_yards_up_to_10m.${row}`, []);
    if (v.length < 6) throw new Error(`kmbr_rules.yaml table4_yards_up_to_10m.${row}: expected 6 yard values`);
    return v;
  };
  const ownerRow = pick<string>(planning, 'villas.house.front_yard_row', 'A1_A2_any__F_upto200');
  const yardsFor = (plotM2: number, buaM2: number): { front: number; rear: number; side: number; row: string } => {
    if (cat.house?.yards === 'kmbr') {
      const small = plotM2 <= cat.house.small_plot_max_m2 + 1e-9 && buaM2 <= cat.house.small_bua_max_m2 + 1e-9;
      const row = small ? cat.house.small_plot_row : ownerRow;
      const r = kmbrRow(row);
      return { front: r[0]!, rear: r[2]!, side: r[4]!, row };
    }
    return { front: kmbrRow(ownerRow)[0]!, rear: num(planning, 'villas.house.rear_m'), side: num(planning, 'villas.house.side_min_m'), row: ownerRow };
  };
  // The most a house can hold on a w x d plot inside its yards: the ground floor
  // at most its coverage, the first floor and (with the roof room) a second at most as big.
  const coverMax = num(planning, 'villas.house.ground_coverage_max');
  const levelsMax = pick<boolean>(planning, 'villas.house.roof_room', true) ? 3 : 2;
  const houseCap = (w: number, d: number, buaM2: number): number => {
    const y = yardsFor(w * d, buaM2);
    const gw = w - 2 * y.side;
    if (gw <= 0) return 0;
    return gw * Math.max(0, Math.min((coverMax * w * d) / gw, d - y.rear - y.front)) * levelsMax;
  };
  /** A plot on which the house can reach its category's BUA. */
  const holdsBua = (w: number, d: number, k: VillaKind): boolean => houseCap(w, d, buaOf(k)) >= buaOf(k) - 0.5;
  // C: premium where the client zoned it, or with an open outlook (owner 28 Sep: terrain and sales).
  const premiumAt = (() => {
    if (!premRule || !cat.premium_when) return (_p: Pt, _zone: string): boolean => false;
    const pw = cat.premium_when;
    const probes: { x: number; y: number; z: number }[] = [];
    for (let j = 0; j < ny; j += 5) {
      for (let i = 0; i < nx; i += 5) {
        const k = j * nx + i;
        if (!terrain[k]) continue;
        const p = dem.cellCentre(i, j);
        probes.push({ x: p[0], y: p[1], z: dem.values[k]! });
      }
    }
    return (p: Pt, zoneName: string): boolean => {
      if (pw.zones.some((m) => zoneName.toUpperCase().includes(m.toUpperCase()))) return true;
      const z0 = dem.sampleBilinear(p);
      if (!Number.isFinite(z0)) return false;
      let near = 0;
      let below = 0;
      for (const q of probes) {
        const d2 = (q.x - p[0]) ** 2 + (q.y - p[1]) ** 2;
        if (d2 < 400 || d2 > 62500) continue;
        near += 1;
        if (q.z < z0 - 5) below += 1;
      }
      return near > 0 && below / near >= pw.outlook_min;
    };
  })();
  const vfh = num(planning, 'villas.floor_height_m');
  const tw = width.tertiary;

  /* ------------------------------------- 8c streets in the villa zones */
  // The shallowest plot a street can still serve: the smallest type's front and rear yards and the narrowest house.
  const yShallow = yardsFor(sftToM2(minRule.plot_sft[0]), buaOf(minRule.name));
  const shallowD = yShallow.front + yShallow.rear + num(planning, 'villas.house.min_house_side_m');
  const minBlock = num(planning, 'plotable.min_area_m2');
  const crossEvery = num(planning, 'roads.cross_street_every_plots');
  // Back-to-back rows meet (MIX: plots on the street edge, 0.15 m between the backs); 0.5 m otherwise.
  const pitch = 2 * plotD + tw + (isMix ? 0.15 : 0.5);
  const crossPitch = Math.max(crossEvery * plotW, pick<number>(planning, 'roads.cross_street_min_spacing_m', 60)) + width.secondary + 1;
  // A north-south grid keeps its cross streets whatever they cost: that is the option.
  const maxCrossEarth = roadMode === 'north_south' ? Number.POSITIVE_INFINITY : num(planning, 'roads.cross_street_max_earthwork_m3_per_m');
  let droppedCross = 0;
  let droppedEarth = 0;
  const villaZones = zones.filter((z) => z.use === 'villas');
  let villaLand = emptyMask(dem);
  let villaZoneMask = emptyMask(dem);
  for (const z of villaZones) {
    villaLand = or(villaLand, zoneLand(z));
    villaZoneMask = or(villaZoneMask, z.mask);
  }
  // MIX (owner 7 Oct: 85% of the villa land in plots): one street grid runs across villa zones that touch, so
  // no strip is lost where one phase meets the next; each plot still belongs to the zone it stands in.
  // Green pockets in the villa land (owner 7 Oct, open space): the street grid runs on through them, so the
  // streets stay continuous and each pocket fronts a street (KMBR Rule 31(vi): access as if it were a plot); no plot
  // is laid there. (The zoning sizes the pockets for the streets that cross them.)
  let gridLand = villaLand;
  for (const [zi, z] of zones.entries()) if (input.zones[zi]?.within === 'villas') gridLand = or(gridLand, zoneLand(z));
  const gridAreas: { z: ZoneInfo; land: Mask }[] = isMix ? [{ z: villaZones[0]!, land: gridLand }] : villaZones.map((z) => ({ z, land: zoneLand(z) }));
  for (const { z: z0, land } of villaZones.length > 0 ? gridAreas : []) {
    for (const piece of patches(dem, land)) {
      if (piece.length * cellArea < minBlock) continue;
      const z = isMix ? (villaZones.find((q) => piece.some((k) => q.mask[k])) ?? z0) : z0;
      const pm = emptyMask(dem);
      for (const k of piece) pm[k] = 1;
      let f = frameFor(dem, piece);
      if (roadMode === 'north_south') {
        // A grid squared to north, turned by at most the tolerance, at the turn
        // whose north-south streets climb least.
        let best = Infinity;
        for (let t = -nsTol; t <= nsTol + 1e-9; t += nsTol / 2) {
          const th = (t * Math.PI) / 180;
          const fr: Frame = { c: f.c, u: [Math.cos(th), -Math.sin(th)], v: [Math.sin(th), Math.cos(th)] };
          let gsum = 0;
          for (let q = 0; q < piece.length; q += 7) {
            const k = piece[q]!;
            const i = k % nx;
            const j = (k - i) / nx;
            const zl = dem.at(i - 1, j);
            const zr = dem.at(i + 1, j);
            const zd = dem.at(i, j - 1);
            const zu = dem.at(i, j + 1);
            if (![zl, zr, zd, zu].every(Number.isFinite)) continue;
            const gx = (zr - zl) / (2 * dem.cell);
            const gy = (zu - zd) / (2 * dem.cell);
            gsum += Math.abs(gx * fr.v[0] + gy * fr.v[1]);
          }
          if (gsum < best) {
            best = gsum;
            f = fr;
          }
        }
      }
      // MIX (draft model): the grid that fits the most plots, turned within 30 degrees of the contours
      // (north-south: within the Vastu tolerance), by the same count of plot runs either side of each street.
      if (isMix) {
        const countFor = (fr: Frame): number => {
          let u0 = Infinity;
          let u1 = -Infinity;
          let v0 = Infinity;
          let v1 = -Infinity;
          for (const k of piece) {
            const [a, b] = toFrame(fr, dem.cellCentre(k % nx, Math.floor(k / nx)));
            u0 = Math.min(u0, a);
            u1 = Math.max(u1, a);
            v0 = Math.min(v0, b);
            v1 = Math.max(v1, b);
          }
          const inQ = (a: number, b: number): boolean => {
            const cc = dem.cellAt(toWorld(fr, a, b));
            return cc !== null && pm[cc.j * nx + cc.i] === 1;
          };
          const sideQ = (u: number, vs: number, sd: 1 | -1): boolean =>
            inQ(u, vs + sd * (tw / 2 + 0.6)) && inQ(u, vs + sd * (tw / 2 + minD / 2)) && inQ(u, vs + sd * (tw / 2 + minD - 0.6));
          let best = 0;
          for (let phi = 0; phi < pitch; phi += 3) {
            let tot = 0;
            for (let vs = v0 + phi; vs <= v1; vs += pitch) {
              for (const sd of [1, -1] as const) {
                let run = 0;
                for (let u = u0; u <= u1 + 1; u += 1) {
                  if (u <= u1 && inQ(u, vs) && sideQ(u, vs, sd)) run += 1;
                  else {
                    tot += Math.floor(run / plotW);
                    run = 0;
                  }
                }
              }
            }
            best = Math.max(best, tot);
          }
          return best;
        };
        const turnFr = (fr: Frame, deg: number): Frame => {
          const t = (deg * Math.PI) / 180;
          return {
            c: fr.c,
            u: [Math.cos(t) * fr.u[0] + Math.sin(t) * fr.v[0], Math.cos(t) * fr.u[1] + Math.sin(t) * fr.v[1]],
            v: [-Math.sin(t) * fr.u[0] + Math.cos(t) * fr.v[0], -Math.sin(t) * fr.u[1] + Math.cos(t) * fr.v[1]],
          };
        };
        // Every degree, so a grid can square up to a straight zone edge (owner 7 Oct: 85% plots).
        const turns = roadMode === 'north_south' ? [] : Array.from({ length: 61 }, (_, i) => i - 30).filter((d) => d !== 0);
        const base = f;
        let bestN = countFor(base);
        for (const d of turns) {
          const fr = turnFr(base, d);
          const n = countFor(fr);
          if (n > bestN) {
            bestN = n;
            f = fr;
          }
        }
        if (roadMode === 'north_south') {
          // Vastu: north-south (or east-west) within the tolerance; among those whose streets climb no
          // more than a quarter over the gentlest, the most plots (a street straight up the hill is not
          // worth a few plots: it is cut to 1:6 the whole way).
          const climb = (fr: Frame): number => {
            let gsum = 0;
            for (let q = 0; q < piece.length; q += 7) {
              const k = piece[q]!;
              const i = k % nx;
              const j = (k - i) / nx;
              const zl = dem.at(i - 1, j);
              const zr = dem.at(i + 1, j);
              const zd = dem.at(i, j - 1);
              const zu = dem.at(i, j + 1);
              if (![zl, zr, zd, zu].every(Number.isFinite)) continue;
              gsum += Math.abs(((zr - zl) / (2 * dem.cell)) * fr.u[0] + ((zu - zd) / (2 * dem.cell)) * fr.u[1]);
            }
            return gsum;
          };
          const cands: { fr: Frame; n: number; g: number }[] = [];
          for (let t = -nsTol; t <= nsTol + 1e-9; t += 1) {
            const th = (t * Math.PI) / 180;
            for (const fr of [
              { c: f.c, u: [Math.cos(th), -Math.sin(th)] as Pt, v: [Math.sin(th), Math.cos(th)] as Pt },
              { c: f.c, u: [Math.sin(th), Math.cos(th)] as Pt, v: [-Math.cos(th), Math.sin(th)] as Pt },
            ]) {
              cands.push({ fr, n: countFor(fr), g: climb(fr) });
            }
          }
          const gMin = Math.min(...cands.map((c) => c.g));
          bestN = -1;
          for (const c of cands) {
            if (c.g <= 1.25 * gMin + 1e-9 && c.n > bestN) {
              bestN = c.n;
              f = c.fr;
            }
          }
        }
      }
      let umin = Infinity;
      let umax = -Infinity;
      let vmin = Infinity;
      let vmax = -Infinity;
      for (const k of piece) {
        const [a, b] = toFrame(f, dem.cellCentre(k % nx, Math.floor(k / nx)));
        umin = Math.min(umin, a);
        umax = Math.max(umax, a);
        vmin = Math.min(vmin, b);
        vmax = Math.max(vmax, b);
      }
      const inP = (a: number, b: number): boolean => {
        const cc = dem.cellAt(toWorld(f, a, b));
        return cc !== null && pm[cc.j * nx + cc.i] === 1;
      };
      // Cross streets up the slope, at the angle whose rise is the secondary limit. Owner 8 Oct (terrain option):
      // square to the rows instead, and only where the ground along the street is within the secondary limit;
      // elsewhere the rows link to the network at their ends (a slanting cross street cut every row into wedges).
      const g = zoneGrade(dem, piece);
      const squareOnly = roadMode !== 'north_south' && pick<boolean>(planning, 'roads.cross_street_square_only', false);
      const sinA = roadMode === 'north_south' || squareOnly ? 1 : g > lim.secondary ? lim.secondary / g : 1;
      // The ground's rise along the street (the frame's v) at a point, over 10 m.
      const riseAlong = (u: number, v: number): number => {
        const z0 = dem.sampleBilinear(toWorld(f, u, v - 5));
        const z1 = dem.sampleBilinear(toWorld(f, u, v + 5));
        return Number.isFinite(z0) && Number.isFinite(z1) ? Math.abs(z1 - z0) / 10 : Infinity;
      };
      const cot = Math.sqrt(Math.max(0, 1 - sinA * sinA)) / sinA;
      let wmin = Infinity;
      let wmax = -Infinity;
      for (const k of piece) {
        const [x, y] = toFrame(f, dem.cellCentre(k % nx, Math.floor(k / nx)));
        wmin = Math.min(wmin, x - y * cot);
        wmax = Math.max(wmax, x - y * cot);
      }
      const cols = Math.max(1, Math.round((wmax - wmin) / crossPitch));
      const w0 = (wmin + wmax) / 2 - (cols * crossPitch) / 2;
      const crossWhy = roadMode === 'north_south'
        ? `north-south cross street every ${crossEvery} plots, within ${nsTol}° of north (Vastu, owner 25 Sep)`
        : squareOnly
          ? `cross street every ${crossEvery} plots, square to the rows, where the ground along it is within 1:${Math.round(1 / lim.secondary)}`
          : sinA < 1
          ? `cross street every ${crossEvery} plots, climbing at ${Math.round((Math.asin(sinA) * 180) / Math.PI)}° to the contours so the ${(g * 100).toFixed(0)}% ground rises at 1:${Math.round(1 / lim.secondary)}`
          : `cross street every ${crossEvery} plots, straight up ground gentler than the limit`;
      for (let m = 1; m < cols; m += 1) {
        const wc = w0 + m * crossPitch;
        let start = Number.NaN;
        for (let y = vmin - 1; y <= vmax + 2; y += 1) {
          const inside = inP(wc + y * cot, y) && (!squareOnly || riseAlong(wc, y) <= lim.secondary * 1.05);
          if (inside && Number.isNaN(start)) start = y;
          if ((!inside || y > vmax + 1) && !Number.isNaN(start)) {
            // Square-only: long enough to join at least two villa streets (a street and its two rows of plots).
            if (y - start >= (squareOnly ? pitch : 20)) {
              const line: Pt[] = [toWorld(f, wc + start * cot, start), toWorld(f, wc + (y - 1) * cot, y - 1)];
              const prof = gradeLimitedProfile(dem, line, lim.secondary);
              let earth = 0;
              for (let q = 1; q < prof.s.length; q += 1) {
                earth += Math.abs(prof.design[q]! - prof.terrain[q]!) * (prof.s[q]! - prof.s[q - 1]!) * width.secondary;
              }
              if (earth / lineLength(line) <= maxCrossEarth) addRoad('secondary', line, crossWhy);
              else {
                droppedCross += 1;
                droppedEarth += earth;
              }
            }
            start = Number.NaN;
          }
        }
      }
      // Streets along the contours at the spacing (phase) that fits the most
      // plots either side, counted by runs of land deep enough for a plot.
      const sideOk = (u: number, vs: number, s: 1 | -1): boolean =>
        inP(u, vs + s * (tw / 2 + 0.6)) && inP(u, vs + s * (tw / 2 + minD / 2)) && inP(u, vs + s * (tw / 2 + minD - 0.6));
      const streetsAt = (phi: number): number[] => {
        const out: number[] = [];
        for (let vs = vmin + phi; vs <= vmax; vs += pitch) out.push(vs);
        return out;
      };
      const plotsAlong = (vs: number): number => {
        let total = 0;
        for (const s of [1, -1] as const) {
          let run = 0;
          for (let u = umin; u <= umax + 1; u += 1) {
            if (u <= umax && inP(u, vs) && sideOk(u, vs, s)) run += 1;
            else {
              total += Math.floor(run / plotW);
              run = 0;
            }
          }
        }
        return total;
      };
      let bestPhi = 0;
      let bestCount = -1;
      for (let phi = 0; phi < pitch; phi += 2) {
        const got = streetsAt(phi).reduce((s, vs) => s + plotsAlong(vs), 0);
        if (got > bestCount) {
          bestCount = got;
          bestPhi = phi;
        }
      }
      const netAt = (u: number, vs: number): boolean => {
        const cc = dem.cellAt(toWorld(f, u, vs));
        return cc !== null && network[cc.j * nx + cc.i] === 1;
      };
      for (const vs of streetsAt(bestPhi)) {
        let start = Number.NaN;
        for (let u = umin - 1; u <= umax + 2; u += 1) {
          const ok = u <= umax + 1 && inP(u, vs) && (sideOk(u, vs, 1) || sideOk(u, vs, -1));
          if (ok && Number.isNaN(start)) start = u;
          if (!ok && !Number.isNaN(start)) {
            let a0 = start;
            let a1 = u - 1;
            start = Number.NaN;
            if (a1 - a0 < plotW) continue;
            // MIX (owner 7 Oct: 85% in plots): the street runs on into land that tapers, while one side still
            // holds a shallow plot (its yards and the narrowest house), so the taper is plotted, not left.
            if (isMix) {
              const shallowOk = (uu: number): boolean =>
                inP(uu, vs) &&
                ([1, -1] as const).some((sd) => inP(uu, vs + sd * (tw / 2 + 0.6)) && inP(uu, vs + sd * (tw / 2 + shallowD - 0.6)));
              while (shallowOk(a0 - 1) && a0 - 1 >= umin - 1) a0 -= 1;
              while (shallowOk(a1 + 1) && a1 + 1 <= umax + 1) a1 += 1;
            }
            // Carry the street on to meet a road within 12 m at either end.
            let s0 = a0;
            let s1 = a1;
            for (let d = 1; d <= 12 && !netAt(s0, vs); d += 1) if (netAt(a0 - d, vs)) s0 = a0 - d;
            for (let d = 1; d <= 12 && !netAt(s1, vs); d += 1) if (netAt(a1 + d, vs)) s1 = a1 + d;
            addRoad('tertiary', [toWorld(f, s0, vs), toWorld(f, s1, vs)], `villa street along the contours in ${z.name}, plots on both sides`, true);
          }
        }
      }
    }
  }
  if (droppedCross > 0) {
    notes.push(
      `${droppedCross} cross streets left out: grading them to 1:${Math.round(1 / lim.secondary)} would move ${Math.round(droppedEarth).toLocaleString()} m³ (over ${maxCrossEarth} m³ a metre)`,
    );
  }

  // Every street must reach the network the primaries built: a group of
  // streets on its own gets a link (at most 400 m, 1:6), or is taken out.
  {
    const main = emptyMask(dem);
    for (let k = 0; k < n; k += 1) if (L.existingRoads.mask[k]) main[k] = 1;
    for (const r of roads) if (r.tier === 'primary') for (const k of r.cells) main[k] = 1;
    const comps = patches(dem, network);
    const inMain = (comp: number[]): boolean => comp.some((k) => main[k]);
    const linkCost = villaLinkCost();
    let dropped = 0;
    for (const comp of comps.sort((a, b) => b.length - a.length)) {
      if (inMain(comp)) {
        for (const k of comp) main[k] = 1;
        continue;
      }
      const r = route({ dem, cost: linkCost, grade: lim.tertiary, overGradePenalty: penalty, sources: comp, targets: main });
      if (r.path && r.path.length * dem.cell <= 400) {
        const link = addRoad('tertiary', pathToLine(dem, r.path), 'links villa streets to the network');
        for (const k of comp) main[k] = 1;
        if (link) for (const k of link.cells) main[k] = 1;
      } else {
        const inComp = new Set(comp);
        for (const rd of roads) {
          if (rd.kept && rd.tier !== 'primary' && rd.cells.length > 0 && inComp.has(rd.cells[0]!)) {
            rd.kept = false;
            dropped += 1;
          }
        }
      }
    }
    if (dropped > 0) {
      notes.push(`${dropped} villa streets could not be joined to the network within 400 m and were left out`);
      rebuildNetwork();
    }
  }

  // Owner 8 Oct: the villa rows link to the roads round the block at both ends. An end that meets no other road gets
  // a short link (at most 80 m, 1:6 like any villa street); one that cannot have one stays a cul-de-sac (KMBR Rule
  // 31: 250 m at most).
  if (isMix) {
    let linked = 0;
    const dead: number[] = [];
    const endLinkCost = villaLinkCost();
    const reachCells = Math.ceil((width.tertiary / 2 + 2) / dem.cell);
    for (const r of [...roads]) {
      if (!r.kept || !r.row || r.tier !== 'tertiary' || r.centreline.length < 2) continue;
      const own = new Set(r.cells);
      const others = emptyMask(dem);
      for (let k = 0; k < n; k += 1) if (network[k] && !own.has(k)) others[k] = 1;
      let open = 0;
      for (const end of [r.centreline[0]!, r.centreline[r.centreline.length - 1]!]) {
        const c = dem.cellAt(end);
        if (!c) continue;
        let meets = false;
        for (let dj = -reachCells; dj <= reachCells && !meets; dj += 1) {
          for (let di = -reachCells; di <= reachCells && !meets; di += 1) {
            const i = c.i + di;
            const j = c.j + dj;
            if (i >= 0 && j >= 0 && i < nx && j < ny && others[j * nx + i]) meets = true;
          }
        }
        if (meets) continue;
        const rr = route({ dem, cost: endLinkCost, grade: lim.tertiary, overGradePenalty: penalty, sources: [c.j * nx + c.i], targets: others, dirWeight });
        if (rr.path && rr.path.length * dem.cell <= 80) {
          const link = addRoad('tertiary', lineOf(rr.path), "joins a villa street's end to the roads round the block (rows linked at both ends, owner 8 Oct)");
          if (link) {
            linked += 1;
            for (const k of link.cells) network[k] = 1;
            continue;
          }
        }
        open += 1;
      }
      if (open > 0) dead.push(lineLength(r.centreline));
    }
    if (linked > 0) notes.push(`${linked} villa-street ends linked to the roads round their block, so the rows are joined at both ends`);
    if (dead.length > 0) {
      const over = dead.filter((L0) => L0 > 250).length;
      notes.push(`${dead.length} villa streets stay cul-de-sacs, no road within reach at one end${over > 0 ? ` (${over} longer than KMBR's 250 m)` : ', all within the KMBR 250 m'}`);
    }
  }

  /* ---------------------------------- 9 villa plots along every road */
  const segIndex = new SegIndex(25);
  // The site's roads come as their edges (existing_road_edge), not centrelines. MIX (owner 7 Oct: 85% in
  // plots): a plot may front the edge itself; the client basis keeps its half-width clear of each edge.
  const exHalf = isMix ? 0.3 : exWidth / 2;
  for (const line of existingLines) segIndex.addLine(line, exHalf);
  for (const r of roads) if (r.kept) segIndex.addLine(r.centreline, r.widthM / 2);
  const clearOfRoads = (ring: Ring): boolean => {
    for (const sg of segIndex.near(ring)) if (ringSegmentGap(ring, sg.a, sg.b) < sg.half - 0.05) return false;
    return true;
  };
  const plotLand = isMix ? or(villaLand, and(minus(network, L.existingRoads.mask), villaZoneMask)) : or(villaLand, and(network, villaZoneMask));
  // (Open space is read on the 2 m grid here; the plots are trimmed off its exact outline once laid.)
  const landOk = (smp: readonly { p: Pt }[]): boolean => {
    for (const q of smp) {
      const cc = dem.cellAt(q.p);
      if (!cc || !plotLand[cc.j * nx + cc.i]) return false;
    }
    return true;
  };
  const drafts: DraftPlot[] = [];
  const plotIndex = new RingIndex(25);

  // The plot's front line off the road's edge. MIX (owner 7 Oct: 85% in plots): on the edge, so no strip of
  // land runs between every road and the plots along it.
  const frontGap = isMix ? 0.02 : 0.25;
  /** Plots laid so far, by zone and type (MIX keeps each zone on the model's mix). */
  const kindCount = new Map<string, Map<VillaKind, number>>();
  const tryPlot = (f: Frame, a0: number, b0: number, w: number, d: number, road: RoadRec | null, kind: VillaKind): boolean => {
    const ring = rectRing(f, a0, a0 + w, b0, b0 + d);
    const centre = toWorld(f, a0 + w / 2, b0 + d / 2);
    const cc = dem.cellAt(centre);
    if (!cc || !villaLand[cc.j * nx + cc.i]) return false;
    if (plotIndex.overlaps(ring)) return false;
    if (!landOk(rectSamples(f, a0, a0 + w, b0, b0 + d, 1.5)) || !clearOfRoads(ring)) return false;
    plotIndex.add(ring);
    const zi = zoneOf[cc.j * nx + cc.i]!;
    const facingDeg = (((Math.atan2(-f.v[0], -f.v[1]) * 180) / Math.PI) + 360) % 360;
    const zoneName = zi >= 0 ? zones[zi]!.name : '';
    drafts.push({ ring, f, a0, b0, w, d, road, zone: zoneName, facingDeg, kind });
    if (road) road.plots += 1;
    const zc = kindCount.get(zoneName) ?? new Map<VillaKind, number>();
    zc.set(kind, (zc.get(kind) ?? 0) + 1);
    kindCount.set(zoneName, zc);
    return true;
  };
  /**
   * The types a plot at this spot may take, first choice first. Premium where the category has one and
   * the spot earns it (falling back to standard); MIX: the type furthest behind its share in the zone,
   * then the others, so each zone keeps to the model's mix.
   */
  const kindsAt = (p: Pt): VillaKind[] => {
    const cc = dem.cellAt(p);
    const zi = cc ? zoneOf[cc.j * nx + cc.i]! : -1;
    if (isMix) {
      const zc = kindCount.get(zi >= 0 ? zones[zi]!.name : '') ?? new Map<VillaKind, number>();
      const placed = [...zc.values()].reduce((a, b) => a + b, 0);
      const behind = (t: VillaTypeRule): number => (t.share ?? 0) * (placed + 1) - (zc.get(t.name) ?? 0);
      return [...cat.types].sort((a, b) => behind(b) - behind(a)).map((t) => t.name);
    }
    if (!premRule) return ['standard'];
    return premiumAt(p, zi >= 0 ? zones[zi]!.name : '') ? ['premium', 'standard'] : ['standard'];
  };
  const fillAlong = (line: readonly Pt[], half: number, road: RoadRec | null): void => {
    const off = half + frontGap;
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
          // The spot's type decides the plot's width; a premium plot that will not fit falls back to standard.
          const kinds = kindsAt(toWorld(f, side > 0 ? x + plotW / 2 : -(x + plotW / 2), off + plotD / 2));
          let placedW = 0;
          for (const kind of kinds) {
            const w = widthOf(kind);
            if (x + w > len + 1e-6) continue;
            const a0 = side > 0 ? x : -(x + w);
            for (const d of depthsFor(kind)) {
              if (tryPlot(f, a0, off, w, d, road, kind)) {
                placedW = w;
                break;
              }
            }
            if (placedW > 0) break;
          }
          x += placedW > 0 ? placedW : 1;
        }
      }
    }
  };
  // A road routed cell by cell is a staircase of short steps no plot can front:
  // plots are laid along its straightened line instead (within 1.5 m of it).
  const plotLine = (line: readonly Pt[]): Pt[] => simplify(line, 1.5);
  // The villa streets first (they were laid for plots), then every other road.
  for (const r of roads) if (r.kept && r.row) fillAlong(plotLine(r.centreline), r.widthM / 2, r);
  for (const r of roads) if (r.kept && !r.row) fillAlong(plotLine(r.centreline), r.widthM / 2, r);
  for (const line of existingLines) fillAlong(plotLine(line), exHalf, null);

  // Row ends (owner 7 Oct): plots stay rectangles, but at the end of a row, where the land runs out at a
  // slant, the last plot may be four-sided: its front on the street, its back parallel to it, one side
  // square to the street and the other along the edge of the land. MIX (the draft model) only.
  if (isMix) {
    const typeAreas = cat.types.map((t) => ({ t, a: sftToM2(t.plot_sft[0]) }));
    const aMin = 0.85 * Math.min(...typeAreas.map((x) => x.a));
    const aMax = Math.max(1.15, mixGrow) * Math.max(...typeAreas.map((x) => x.a));
    // KMBR Rule 31 (subdivision): every plot at least 4 m of frontage and 6 m of average width.
    const minFront = num(input.kmbr, 'rule31_subdivision.min_frontage_m', 'kmbr_rules.yaml');
    const minAvgW = num(input.kmbr, 'rule31_subdivision.min_avg_width_m', 'kmbr_rules.yaml');
    const free = (fr: Frame, u: number, b: number): boolean => {
      const cc = dem.cellAt(toWorld(fr, u, b));
      return cc !== null && plotLand[cc.j * nx + cc.i] === 1;
    };
    let ends = 0;
    const seeds = [...drafts];
    for (const p of seeds) {
      for (const dir of [1, -1] as const) {
        const u0 = dir > 0 ? p.a0 + p.w : p.a0;
        // How far the land runs on past the plot, at the front and at the back of the row.
        const reach = (b: number): number => {
          let L = 0;
          while (L < 30 && free(p.f, u0 + dir * (L + 0.5), b)) L += 0.5;
          return L;
        };
        let lf = reach(p.b0 + 0.6);
        let lb = reach(p.b0 + p.d - 0.6);
        const lm = reach(p.b0 + p.d / 2);
        // The far side is straight: never longer at mid-depth than the land allows there.
        if (lm < (lf + lb) / 2) {
          const k = lm / Math.max(1e-6, (lf + lb) / 2);
          lf *= k;
          lb *= k;
        }
        if (Math.min(lf, lb) < 0.5 && Math.max(lf, lb) < minFront) continue;
        let area = (p.d * (lf + lb)) / 2;
        if (area > aMax) {
          const cut = (area - aMax) / p.d;
          lf -= cut;
          lb -= cut;
          area = aMax;
        }
        if (area < aMin || lf < minFront || lb < 0) {
          // Too small for a plot of its own: the end plot takes it in, four-sided, within its growth limit.
          if (p.area === undefined && Math.max(lf, lb) >= 0.5) {
            const uIn = dir > 0 ? p.a0 : p.a0 + p.w;
            const grown: Ring = [
              toWorld(p.f, uIn, p.b0),
              toWorld(p.f, u0 + dir * lf, p.b0),
              toWorld(p.f, u0 + dir * lb, p.b0 + p.d),
              toWorld(p.f, uIn, p.b0 + p.d),
            ] as Ring;
            const gArea = (p.d * (2 * p.w + lf + lb)) / 2;
            const strip: Ring = [toWorld(p.f, u0, p.b0), toWorld(p.f, u0 + dir * lf, p.b0), toWorld(p.f, u0 + dir * lb, p.b0 + p.d), toWorld(p.f, u0, p.b0 + p.d)] as Ring;
            if (gArea <= mixGrow * sftToM2(ruleOf(p.kind).plot_sft[0]) && !plotIndex.overlaps(strip) && clearOfRoads(strip)) {
              plotIndex.add(strip);
              p.ring = grown;
              p.area = gArea;
              ends += 1;
            }
          }
          continue;
        }
        const quad = (f2: number, b2: number): Ring =>
          [
            toWorld(p.f, u0, p.b0),
            toWorld(p.f, u0 + dir * f2, p.b0),
            toWorld(p.f, u0 + dir * b2, p.b0 + p.d),
            toWorld(p.f, u0, p.b0 + p.d),
          ] as Ring;
        let ring = quad(lf, lb);
        // Shrink the far side until the plot is clear of the others and of every road; where the land
        // runs out at the back first, the plot keeps 1 m of back and its far side turns on that corner.
        const lbFloor = Math.min(1, lb);
        let tries = 0;
        while ((plotIndex.overlaps(ring) || !clearOfRoads(ring)) && tries < 20) {
          lf -= 0.5;
          lb = Math.max(lbFloor, lb - 0.5);
          ring = quad(lf, lb);
          tries += 1;
        }
        area = (p.d * (lf + lb)) / 2;
        if (tries >= 20 || area < aMin || lf < minFront || lb < 1 || (lf + lb) / 2 < minAvgW) continue;
        // Its type: the one nearest its area, the one furthest behind its share where two are near.
        const zc = kindCount.get(p.zone) ?? new Map<VillaKind, number>();
        const placed = [...zc.values()].reduce((a, b) => a + b, 0);
        const near = typeAreas.filter((x) => area >= 0.85 * x.a && area <= 1.15 * x.a);
        const pickT = (near.length > 0 ? near : [...typeAreas].sort((a, b) => Math.abs(a.a - area) - Math.abs(b.a - area)).slice(0, 1)).sort(
          (a, b) => ((b.t.share ?? 0) * (placed + 1) - (zc.get(b.t.name) ?? 0)) - ((a.t.share ?? 0) * (placed + 1) - (zc.get(a.t.name) ?? 0)),
        )[0]!.t;
        // The house's rectangle in the plot: the full depth at the narrow side's width, or, where the plot
        // is wider at the street, the front part at the width it keeps to that depth, whichever is larger.
        // Wider at the back: the back part, from where it is that wide (its front yard only grows).
        let core = Math.max(0.5, Math.min(lf, lb));
        let coreD = p.d;
        let coreB = p.b0;
        for (let t = shallowD; t <= p.d; t += 0.5) {
          const wt = lf > lb ? lf + ((lb - lf) * t) / p.d : lb + ((lf - lb) * t) / p.d;
          if (wt * t > core * coreD) {
            core = wt;
            coreD = t;
            coreB = lf > lb ? p.b0 : p.b0 + p.d - t;
          }
        }
        drafts.push({
          ring,
          area,
          f: p.f,
          a0: dir > 0 ? u0 : u0 - core,
          b0: coreB,
          w: core,
          d: coreD,
          road: p.road,
          zone: p.zone,
          facingDeg: p.facingDeg,
          kind: pickT.name,
        });
        plotIndex.add(ring);
        if (p.road) p.road.plots += 1;
        zc.set(pickT.name, (zc.get(pickT.name) ?? 0) + 1);
        kindCount.set(p.zone, zc);
        ends += 1;
      }
    }
    // Where the edge of the land cuts across the back of a row, the plot is four-sided the other way:
    // its front on the street, its back along the edge, widened so it keeps its type's area.
    const yMinH = yardsFor(sftToM2(minRule.plot_sft[0]), buaOf(minRule.name));
    const minDepth = yMinH.front + yMinH.rear + num(planning, 'villas.house.min_house_side_m');
    let shallow = 0;
    for (const r of roads) {
      if (!r.kept || !r.row) continue;
      const line = plotLine(r.centreline);
      for (let q = 1; q < line.length; q += 1) {
        const A = line[q - 1]!;
        const B = line[q]!;
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        if (len < 6) continue;
        const t: Pt = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
        const off = r.widthM / 2 + frontGap;
        for (const side of [1, -1] as const) {
          const v: Pt = [-t[1] * side, t[0] * side];
          const f: Frame = side > 0 ? { c: A, u: t, v } : { c: A, u: [-t[0], -t[1]], v };
          const depthAt = (u: number): number => {
            let dd = 0;
            while (dd < plotD && free(f, u, off + dd + 0.5)) dd += 0.5;
            return dd;
          };
          for (let x = 0; x + 4 <= len; ) {
            let placed = 0;
            for (const kind of kindsAt(toWorld(f, side > 0 ? x + plotW / 2 : -(x + plotW / 2), off + plotD / 2))) {
              const target = sftToM2(ruleOf(kind).plot_sft[0]);
              for (let w = widthOf(kind); w <= Math.min(2.2 * widthOf(kind), len - x) && placed === 0; w += 0.5) {
                const ua = side > 0 ? x : -(x + w);
                const ub = ua + w;
                const dl = depthAt(ua + 0.4);
                const dr = depthAt(ub - 0.4);
                if (Math.min(dl, dr) < minDepth || Math.min(dl, dr) >= plotD - 0.5) continue;
                const area = (w * (dl + dr)) / 2;
                if (area < 0.95 * target) continue;
                if (area > 1.15 * target) break;
                const ring: Ring = [toWorld(f, ua, off), toWorld(f, ub, off), toWorld(f, ub, off + dr), toWorld(f, ua, off + dl)];
                if (plotIndex.overlaps(ring) || !clearOfRoads(ring)) continue;
                const cc = dem.cellAt(toWorld(f, ua + w / 2, off + Math.min(dl, dr) / 2));
                if (!cc || !villaLand[cc.j * nx + cc.i]) continue;
                const zi = zoneOf[cc.j * nx + cc.i]!;
                const zoneName = zi >= 0 ? zones[zi]!.name : '';
                const core = Math.min(dl, dr);
                drafts.push({
                  ring,
                  area,
                  f,
                  a0: ua,
                  b0: off,
                  w,
                  d: core,
                  road: r,
                  zone: zoneName,
                  facingDeg: (((Math.atan2(-f.v[0], -f.v[1]) * 180) / Math.PI) + 360) % 360,
                  kind,
                });
                plotIndex.add(ring);
                r.plots += 1;
                const zc = kindCount.get(zoneName) ?? new Map<VillaKind, number>();
                zc.set(kind, (zc.get(kind) ?? 0) + 1);
                kindCount.set(zoneName, zc);
                shallow += 1;
                placed = w;
              }
              if (placed > 0) break;
            }
            x += placed > 0 ? placed : 1;
          }
        }
      }
    }
    if (ends + shallow > 0) {
      notes.push(`${ends + shallow} plots at the ends and edges of rows are four-sided, one side along the edge of the land (owner 7 Oct)`);
    }
  }

  // Second pass (owner 28 Sep): the pockets the first pass left, at row ends,
  // corners and zone edges, filled with plots that flex in width and depth
  // within their type's range, square to the road they front, and free to run
  // past the end of a stretch of road.
  {
    const yMin = yardsFor(sftToM2(minRule.plot_sft[0]), buaOf(minRule.name));
    const hRear = yMin.rear;
    const hSide = yMin.side;
    const frontMinM = yMin.front;
    const minHouse = num(planning, 'villas.house.min_house_side_m');
    const maxAspect = num(planning, 'villas.house.max_plot_aspect');
    const sizes = new Map<VillaKind, { w: number; d: number }[]>();
    const flexSizes = (k: VillaKind): { w: number; d: number }[] => {
      const hit = sizes.get(k);
      if (hit) return hit;
      const t = ruleOf(k);
      const aMin = sftToM2(t.plot_sft[0]);
      const aMax = maxFlexArea(t);
      const out: { w: number; d: number }[] = [];
      // Largest first, so a pocket is used up; every size stays in the type's range.
      for (const a of [aMax, (aMin + aMax) / 2, aMin]) {
        for (let w = Math.sqrt(a * maxAspect); w >= 2 * hSide + minHouse - 1e-9; w -= 0.5) {
          const d = a / w;
          if (d / w > maxAspect || w / d > maxAspect) continue;
          if (d < hRear + frontMinM + minHouse) continue;
          // Only a plot the house can reach its BUA on (a wide, shallow one loses its depth to the yards).
          if (!holdsBua(w, d, k)) continue;
          out.push({ w, d });
        }
      }
      sizes.set(k, out);
      return out;
    };
    const before = drafts.length;
    const fillFlex = (line: readonly Pt[], half: number, road: RoadRec | null): void => {
      const off = half + frontGap;
      for (let q = 1; q < line.length; q += 1) {
        const A = line[q - 1]!;
        const B = line[q]!;
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        if (len < 3) continue;
        const t: Pt = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
        for (const side of [1, -1]) {
          const v: Pt = [-t[1] * side, t[0] * side];
          const f: Frame = side > 0 ? { c: A, u: t, v } : { c: A, u: [-t[0], -t[1]], v };
          // A plot may overhang either end of the stretch by up to 40% of its width.
          for (let x = -0.4 * plotW; x <= len - 0.6 * minHouse; x += 1) {
            const at = toWorld(f, side > 0 ? x + plotW / 2 : -(x + plotW / 2), off + plotD / 2);
            const kinds = kindsAt(at);
            let placedW = 0;
            for (const kind of kinds) {
              for (const s of flexSizes(kind)) {
                if (x + s.w < 0.6 * s.w || x > len - 0.6 * s.w) continue;
                const a0 = side > 0 ? x : -(x + s.w);
                if (tryPlot(f, a0, off, s.w, s.d, road, kind)) {
                  placedW = s.w;
                  break;
                }
              }
              if (placedW > 0) break;
            }
            if (placedW > 0) x += placedW - 1;
          }
        }
      }
    };
    for (const r of roads) if (r.kept) fillFlex(plotLine(r.centreline), r.widthM / 2, r);
    for (const line of existingLines) fillFlex(plotLine(line), exHalf, null);
    if (drafts.length > before) notes.push(`${drafts.length - before} more plots in the pockets at row ends, corners and zone edges, sized within their range to fit`);
  }

  // Third pass (owner 28 Sep: the plot flexes with the terrain, the BUA stays):
  // each plot deepens into the strip of land behind it, up to its type's largest
  // area, so the slivers too narrow for a plot of their own are not left over.
  {
    let deepened = 0;
    for (const p of drafts) {
      const t = ruleOf(p.kind);
      const dMax = (isMix ? mixGrow * sftToM2(t.plot_sft[0]) : maxFlexArea(t)) / p.w;
      if (p.area !== undefined) continue; // a four-sided end plot keeps its shape
      if (dMax < p.d + 0.5) continue;
      for (let dNew = dMax; dNew >= p.d + 0.5; dNew -= 0.5) {
        // Not into a size whose yards leave the house short of its BUA (above KMBR's small-plot limit).
        if (holdsBua(p.w, p.d, p.kind) && !holdsBua(p.w, dNew, p.kind)) continue;
        const strip = rectRing(p.f, p.a0, p.a0 + p.w, p.b0 + p.d, p.b0 + dNew);
        if (plotIndex.overlaps(strip) || !clearOfRoads(strip)) continue;
        if (!landOk(rectSamples(p.f, p.a0, p.a0 + p.w, p.b0 + p.d, p.b0 + dNew, 1.5))) continue;
        plotIndex.add(strip);
        p.d = dNew;
        p.ring = rectRing(p.f, p.a0, p.a0 + p.w, p.b0, p.b0 + dNew);
        deepened += 1;
        break;
      }
    }
    if (deepened > 0) notes.push(`${deepened} plots deepened into the strip behind them, within their range, so it is not left over`);
      // MIX (owner 7 Oct: the model's 85% is plots): where the edge of the land runs at a slant behind a
    // plot, its back follows the edge, so the wedge is the plot's garden, not left over. Still four-sided:
    // the front and both sides as they were, the back along the edge.
    if (isMix) {
      let slanted = 0;
      const freeAt = (fr: Frame, u: number, b: number): boolean => {
        const cc = dem.cellAt(toWorld(fr, u, b));
        return cc !== null && plotLand[cc.j * nx + cc.i] === 1;
      };
      const shoelace = (r: readonly Pt[]): number => {
        let a = 0;
        for (let q = 0; q < r.length; q += 1) {
          const A = r[q]!;
          const B = r[(q + 1) % r.length]!;
          a += A[0] * B[1] - B[0] * A[1];
        }
        return Math.abs(a) / 2;
      };
      // Four corners turning the same way, each side at least 1 m: a true four-sided plot.
      const convex = (r: readonly Pt[]): boolean => {
        let sgn = 0;
        for (let q = 0; q < r.length; q += 1) {
          const A = r[q]!;
          const B = r[(q + 1) % r.length]!;
          const C = r[(q + 2) % r.length]!;
          if (Math.hypot(B[0] - A[0], B[1] - A[1]) < 1) return false;
          const z = (B[0] - A[0]) * (C[1] - B[1]) - (B[1] - A[1]) * (C[0] - B[0]);
          if (Math.abs(z) < 1e-6) continue;
          if (sgn === 0) sgn = Math.sign(z);
          else if (Math.sign(z) !== sgn) return false;
        }
        return true;
      };
      for (const p of drafts) {
        if (p.ring.length !== 4 || !convex(p.ring)) continue;
        const now = p.area ?? p.w * p.d;
        const cap = mixGrow * sftToM2(ruleOf(p.kind).plot_sft[0]) - now;
        if (cap < 4) continue;
        // In the plot's own frame: the front on the street, each side a straight line run on past the back.
        const [F0, F1, B1, B0] = p.ring.map((q) => toFrame(p.f, q)) as [[number, number], [number, number], [number, number], [number, number]];
        const sideAt = (F: [number, number], B: [number, number], b: number): number =>
          Math.abs(B[1] - F[1]) < 1e-6 ? B[0] : F[0] + ((B[0] - F[0]) * (b - F[1])) / (B[1] - F[1]);
        const inward0 = Math.sign(F1[0] - F0[0]) * 0.4;
        const reach = (F: [number, number], B: [number, number], inward: number): number => {
          let L = 0;
          while (L < 30 && freeAt(p.f, sideAt(F, B, B[1] + L + 0.5) + inward, B[1] + L + 0.5)) L += 0.5;
          return L;
        };
        let e0 = reach(F0, B0, inward0);
        let e1 = reach(F1, B1, -inward0);
        if (Math.max(e0, e1) < 1) continue;
        // The back is straight: no deeper at its middle than the land allows there.
        const mid: [number, number] = [(B0[0] + B1[0]) / 2, (B0[1] + B1[1]) / 2];
        let em = 0;
        while (em < 30 && freeAt(p.f, mid[0], mid[1] + em + 0.5)) em += 0.5;
        if (em < (e0 + e1) / 2) {
          const k = em / Math.max(1e-6, (e0 + e1) / 2);
          e0 *= k;
          e1 *= k;
        }
        const corners = (a: number, b: number): [Pt, Pt] => [
          toWorld(p.f, sideAt(F1, B1, B1[1] + b), B1[1] + b),
          toWorld(p.f, sideAt(F0, B0, B0[1] + a), B0[1] + a),
        ];
        const wedge = (a: number, b: number): Ring => [p.ring[3]!, p.ring[2]!, ...corners(a, b)] as Ring;
        // Every point of the wedge (bilinear over its four corners) on land the plots may take.
        const inLand = (w: Ring): boolean => {
          for (let su = 0.05; su < 1; su += 0.1) {
            for (let sv = 0.05; sv < 1; sv += 0.1) {
              const x = (1 - sv) * ((1 - su) * w[0]![0] + su * w[1]![0]) + sv * ((1 - su) * w[3]![0] + su * w[2]![0]);
              const y = (1 - sv) * ((1 - su) * w[0]![1] + su * w[1]![1]) + sv * ((1 - su) * w[3]![1] + su * w[2]![1]);
              const cc = dem.cellAt([x, y]);
              if (!cc || !plotLand[cc.j * nx + cc.i]) return false;
            }
          }
          return true;
        };
        let tries = 0;
        let w = wedge(e0, e1);
        while (
          tries < 60 &&
          Math.max(e0, e1) >= 1 &&
          (shoelace(w) > cap || !convex([p.ring[0]!, p.ring[1]!, w[2]!, w[3]!]) || plotIndex.overlaps(w) || !clearOfRoads(w) || !inLand(w))
        ) {
          e0 = Math.max(0, e0 - 0.5);
          e1 = Math.max(0, e1 - 0.5);
          w = wedge(e0, e1);
          tries += 1;
        }
        if (tries >= 60 || Math.max(e0, e1) < 1) continue;
        // Not into a size whose yards leave the house short of its BUA.
        if (holdsBua(p.w, p.d, p.kind) && !holdsBua(p.w, p.d + Math.min(e0, e1), p.kind)) continue;
        plotIndex.add(w);
        const [c1, c0] = corners(e0, e1);
        p.ring = [p.ring[0]!, p.ring[1]!, c1, c0] as Ring;
        p.area = shoelace(p.ring);
        slanted += 1;
      }
      if (slanted > 0) notes.push(`${slanted} plots take the wedge behind them, their back along the slanting edge of the land (four-sided, owner 7 Oct)`);
    }
  }

  // Later roads must go round the plots.
  const plotCells = rasterise(
    dem,
    drafts.map((p) => [p.ring]),
  );
  for (let k = 0; k < n; k += 1) if (plotCells[k]) baseCost[k] = Number.POSITIVE_INFINITY;

  /* ----------------------------- 13-14 buildings in their own zones */
  // A building stands on its zone's buildable land, off every road.
  const siteLand = (z: ZoneInfo): Mask => minus(zoneLand(z), network);
  const aspects = pick<number[]>(planning, 'amenities.plate_aspects', [2]);
  const candidatesIn = (land: Mask, dims: { L: number; D: number }, inset: number, turnDeg = 0): Cand[] => {
    const cells = cellsOf(land);
    if (cells.length === 0) return [];
    const f0 = frameFor(dem, cells);
    const t = (turnDeg * Math.PI) / 180;
    const f: Frame = turnDeg
      ? {
          c: f0.c,
          u: [Math.cos(t) * f0.u[0] + Math.sin(t) * f0.v[0], Math.cos(t) * f0.u[1] + Math.sin(t) * f0.v[1]],
          v: [-Math.sin(t) * f0.u[0] + Math.cos(t) * f0.v[0], -Math.sin(t) * f0.u[1] + Math.cos(t) * f0.v[1]],
        }
      : f0;
    const ins = erode(dem, land, inset);
    let umin = Infinity;
    let umax = -Infinity;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const k of cells) {
      const [a, b] = toFrame(f, dem.cellCentre(k % nx, Math.floor(k / nx)));
      umin = Math.min(umin, a);
      umax = Math.max(umax, a);
      vmin = Math.min(vmin, b);
      vmax = Math.max(vmax, b);
    }
    const out: Cand[] = [];
    for (const along of [true, false]) {
      const du = along ? dims.L : dims.D;
      const dv = along ? dims.D : dims.L;
      for (let a = umin + du / 2; a <= umax - du / 2; a += 2) {
        for (let b = vmin + dv / 2; b <= vmax - dv / 2; b += 2) {
          const smp = rectSamples(f, a - du / 2, a + du / 2, b - dv / 2, b + dv / 2, 3);
          if (!allIn(dem, ins, smp)) continue;
          let lo = Infinity;
          let hi = -Infinity;
          for (const q of smp) {
            const z = dem.sampleBilinear(q.p);
            if (!Number.isFinite(z)) continue;
            lo = Math.min(lo, z);
            hi = Math.max(hi, z);
          }
          if (!Number.isFinite(lo)) continue;
          out.push({ f, a0: a - du / 2, a1: a + du / 2, b0: b - dv / 2, b1: b + dv / 2, fall: hi - lo + (along ? 0 : 0.5), lo, hi, c: toWorld(f, a, b) });
        }
      }
    }
    return out;
  };
  const ringOf = (cd: Cand): Ring => rectRing(cd.f, cd.a0, cd.a1, cd.b0, cd.b1);
  /**
   * Up to `want` buildings as one compact group: the flattest spot first, then
   * each next one as close to the group as the clear distance allows, on flat
   * ground. `fixed` are already standing and count for spacing and the group.
   */
  const pickCompact = (cands: Cand[], want: number, clear: number, fixed: Placed[] = []): Placed[] => {
    const chosen: Placed[] = [];
    const all = (): Placed[] => [...fixed, ...chosen];
    while (chosen.length < want) {
      const group = all();
      const gx = group.length > 0 ? group.reduce((s, p) => s + p.cand.c[0], 0) / group.length : 0;
      const gy = group.length > 0 ? group.reduce((s, p) => s + p.cand.c[1], 0) / group.length : 0;
      let best: Cand | null = null;
      let bestRing: Ring | null = null;
      let bestS = Infinity;
      for (const cd of cands) {
        const s = group.length === 0 ? cd.fall : Math.hypot(cd.c[0] - gx, cd.c[1] - gy) + 10 * cd.fall;
        if (s >= bestS) continue;
        const ring = ringOf(cd);
        if (group.some((o) => ringGap(o.ring, ring) < clear)) continue;
        best = cd;
        bestRing = ring;
        bestS = s;
      }
      if (!best || !bestRing) break;
      chosen.push({ ring: bestRing, cand: best });
    }
    return chosen;
  };
  const fitAmenity = (
    z: ZoneInfo,
    occ: Occupancy,
    buaM2: number,
    maxFloors: number,
    plateMax: number,
    setback: number,
    fromFloors = 1,
    plateAspects: number[] = aspects,
    gap = wingGap,
  ): { floors: number; wings: Placed[]; wingPlate: number; key: string; coverage: number } | null => {
    const cf = coverageFsi(input.kmbr, occ);
    const land = siteLand(z);
    // One building's wings stand together on one piece of land, no road between them (largest piece first);
    // only if no piece holds them all may they take the zone's land as a whole.
    const lands: Mask[] = patches(dem, land)
      .sort((x, y) => y.length - x.length)
      .map((piece) => {
        const m = emptyMask(dem);
        for (const k of piece) m[k] = 1;
        return m;
      });
    if (lands.length > 1) lands.push(land);
    let first = Math.max(1, fromFloors);
    while (first < maxFloors && buaM2 / first > (cf.coveragePct / 100) * z.areaM2) first += 1;
    // Square to the land's own frame at every floor count first; only a zone that holds none of
    // those (narrow or skewed) tries the wings turned.
    for (const turns of [[0], [90, 15, 30, 45, 60, 75, 105, 120, 135, 150, 165]]) {
      for (let floors = first; floors <= maxFloors; floors += 1) {
        const plate = buaM2 / floors;
        const nW = Math.max(1, Math.ceil(plate / plateMax));
        const wingPlate = plate / nW;
        for (const turn of turns) {
          for (const asp of plateAspects) {
            for (const piece of lands.length > 0 ? lands : [land]) {
              const wings = pickCompact(candidatesIn(piece, plateDims(wingPlate, asp), setback, turn), nW, gap);
              if (wings.length === nW) return { floors, wings, wingPlate, key: cf.key, coverage: cf.coveragePct };
            }
          }
        }
      }
    }
    return null;
  };

  interface DraftBuilding {
    zone: ZoneInfo;
    use: BuildingUse;
    placed: Placed;
    footprintM2: number;
    floors: number;
    floorH: number;
    units: number;
    builtUpM2: number;
    notes: string[];
    podium?: { ring: Ring; topRl: number; bottomRl: number };
    flat: boolean;
  }
  // ---- villa views (owner 25 Sep): villas sell on their outlook, so no tower
  // stands in it where the zone leaves a choice. Lookouts every 10 m over the
  // villa land, from the first floor; a direction has a view when ground well
  // below is seen over the terrain within the reach.
  const vv = pick<{ eye_m: number; drop_m: number; reach_m: number; weight_m_per_pct: number } | null>(planning, 'apartments.villa_views', null);
  const VIEW_BINS = 72;
  const lookouts: { x: number; y: number; bins: Uint8Array }[] = [];
  let viewTotal = 0;
  if (vv) {
    const villaLand = emptyMask(dem);
    for (const z of zones) if (z.use === 'villas') for (const k of z.cells) if (!L.waterlogging.mask[k] && !L.nonBuildable.mask[k]) villaLand[k] = 1;
    const stepC = 2; // cells, 4 m
    const reachC = vv.reach_m / dem.cell;
    for (let j = 0; j < ny; j += 5) {
      for (let i = 0; i < nx; i += 5) {
        const k0 = j * nx + i;
        if (!villaLand[k0]) continue;
        const z0 = dem.values[k0]!;
        const ze = z0 + vv.eye_m;
        const bins = new Uint8Array(VIEW_BINS);
        for (let b = 0; b < VIEW_BINS; b += 1) {
          const a = (2 * Math.PI * b) / VIEW_BINS;
          const di = Math.sin(a);
          const dj = Math.cos(a);
          let horizon = -Infinity;
          for (let d = 10 / dem.cell; d <= reachC; d += stepC) {
            const ii = Math.round(i + di * d);
            const jj = Math.round(j + dj * d);
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) break;
            const k = jj * nx + ii;
            if (!terrain[k]) continue;
            const zz = dem.values[k]!;
            if (!Number.isFinite(zz)) continue;
            const ang = (zz - ze) / d;
            if (ang >= horizon && zz <= z0 - vv.drop_m) bins[b] = 1;
            horizon = Math.max(horizon, ang);
          }
          viewTotal += bins[b]!;
        }
        const p = dem.cellCentre(i, j);
        lookouts.push({ x: p[0], y: p[1], bins });
      }
    }
  }
  /** Share (%) of all the villas' view that a building on this ring would hide. */
  const villaViewHidden = (ring: Ring): number => {
    if (!vv || viewTotal === 0) return 0;
    let cx = 0;
    let cy = 0;
    for (const q of ring) {
      cx += q[0];
      cy += q[1];
    }
    cx /= ring.length;
    cy /= ring.length;
    let hidden = 0;
    const binW = (2 * Math.PI) / VIEW_BINS;
    for (const o of lookouts) {
      const dc = Math.hypot(cx - o.x, cy - o.y);
      if (dc < 15 || dc > vv.reach_m + 40) continue;
      const mid = Math.atan2(cx - o.x, cy - o.y);
      let lo = 0;
      let hi = 0;
      for (const q of ring) {
        let da = Math.atan2(q[0] - o.x, q[1] - o.y) - mid;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        lo = Math.min(lo, da);
        hi = Math.max(hi, da);
      }
      for (let b = Math.floor((mid + lo) / binW); b <= Math.floor((mid + hi) / binW); b += 1) {
        if (o.bins[((b % VIEW_BINS) + VIEW_BINS) % VIEW_BINS]) hidden += 1;
      }
    }
    return (100 * hidden) / viewTotal;
  };
  // Owner 25 Sep: tower sites set on the owner's sketch; the tower goes on the nearest ground that takes it.
  const towerSites = pick<{ match: string; at: [number, number] }[]>(planning, 'apartments.tower_sites', []);

  const draftsB: DraftBuilding[] = [];
  let seniorLeft = senNeeded;
  let aptUnitsLeft = aptUnits;
  let commercialDone = false;
  let conventionDone = false as boolean;
  for (const z of zones) {
    if (z.cells.length === 0) continue;
    const zp = progOf(z);
    if (z.use === 'senior' && (zp ? (zp.units ?? 0) > 0 : seniorLeft > 0)) {
      // Draft model: the zone holds its component's units; client basis: the programme's, zone by zone.
      let zoneUnits = zp ? (zp.units ?? 0) : 0;
      const want = zp ? Math.ceil(zoneUnits / senPerBuilding) : seniorLeft;
      let got: Placed[] = [];
      for (const turn of zp ? [0, 30, 60, 90, 120, 150] : [0]) {
        for (const asp of [sen.aspect, ...aspects.filter((x) => x !== sen.aspect)]) {
          const g = pickCompact(candidatesIn(siteLand(z), plateDims(senPlate, asp), sen.setback, turn), want, sen.clear);
          if (g.length > got.length) got = g;
        }
        if (got.length >= want) break;
      }
      // Draft model: where fewer buildings fit than G+3 needs, those that fit go up (to the most floors allowed).
      const senMaxFloors = pick<number>(planning, 'senior_living.max_floors', sen.floors);
      const perBuilding = zp && got.length > 0 && got.length < want ? sen.upf * Math.min(senMaxFloors, Math.ceil(zoneUnits / (got.length * sen.upf))) : senPerBuilding;
      if (zp && got.length * perBuilding < (zp.units ?? 0)) notes.push(`${z.name}: ${got.length * perBuilding} of ${zp.units} senior units fit`);
      for (const pl of got) {
        let u: number;
        if (zp) {
          u = Math.min(perBuilding, zoneUnits);
          zoneUnits -= u;
        } else {
          u = Math.min(senPerBuilding, seniorUnits - (senNeeded - seniorLeft) * senPerBuilding);
          seniorLeft -= 1;
        }
        const fl = zp ? Math.max(sen.floors, Math.ceil(u / sen.upf)) : sen.floors;
        draftsB.push({
          zone: z,
          use: 'senior',
          placed: pl,
          footprintM2: senPlate,
          floors: fl,
          floorH: sen.fh,
          units: Math.max(0, u),
          builtUpM2: senPlate * fl,
          notes: [
            `${u} units: ${sen.upf} a floor × ${fl} floors (G+${fl - 1}); plate ${senPlate.toFixed(0)} m² = ${sen.upf} × ${sft(seniorPlinthM2)} sq ft ÷ ${sen.eff}`,
            `in the ${z.name} zone, grouped; ${sen.clear} m clear of the others`,
          ],
          flat: true,
        });
      }
    }
    const zSchool = zp?.bua_sft ? sftToM2(zp.bua_sft) : schoolBuaM2;
    if (z.use === 'school' && zSchool > 0 && (zp || !draftsB.some((b) => b.use === 'school'))) {
      const fit = fitAmenity(z, 'B_school', zSchool, 4, wingMax, amenitySetback);
      if (!fit) notes.push(`the school's ${sft(zSchool)} sq ft does not fit in the ${z.name} zone's buildable land`);
      else {
        fit.wings.forEach((w, i) =>
          draftsB.push({
            zone: z,
            use: 'school',
            placed: w,
            footprintM2: fit.wingPlate,
            floors: fit.floors,
            floorH: 4,
            units: 0,
            builtUpM2: fit.wingPlate * fit.floors,
            notes: [
              `wing ${i + 1} of ${fit.wings.length}: ${sft(zSchool)} sq ft in all over ${fit.floors} floors, one campus`,
              `${fit.key}: coverage up to ${fit.coverage}%; wings ${wingGap} m apart (planning_rules.yaml amenities)`,
            ],
            flat: true,
          }),
        );
      }
    }
    const zClub = zp?.bua_sft ? sftToM2(zp.bua_sft) : clubBuaM2;
    if (z.use === 'clubhouse' && zClub > 0 && (zp || !draftsB.some((b) => b.use === 'clubhouse'))) {
      const fit = fitAmenity(z, 'D1_recreational', zClub, pick<number>(planning, 'clubhouse.max_floors', 2), wingMax, amenitySetback);
      if (!fit) notes.push(`the clubhouse does not fit in the ${z.name} zone's buildable land`);
      else {
        fit.wings.forEach((w, i) =>
          draftsB.push({
            zone: z,
            use: 'clubhouse',
            placed: w,
            footprintM2: fit.wingPlate,
            floors: fit.floors,
            floorH: 4,
            units: 0,
            builtUpM2: fit.wingPlate * fit.floors,
            notes: [
              `wing ${i + 1} of ${fit.wings.length}: ${sft(zClub)} sq ft in all over ${fit.floors} floors`,
              `${fit.key}: coverage up to ${fit.coverage}%${zp ? '' : '; the golf course lies round it'}`,
            ],
            flat: true,
          }),
        );
      }
    }
    if (z.use === 'commercial' && !commercialDone && commercialBuaM2 > 0) {
      commercialDone = true;
      // The commercial blocks and the convention hall beside them: the blocks
      // go up a floor at a time until the hall fits too.
      let fit = fitAmenity(z, comm.occ, commercialBuaM2, comm.maxFloors, comm.wingMax, comm.setback);
      let hall: Placed[] = [];
      const firstFit = fit;
      while (fit && conventionHallM2 > 0) {
        for (const asp of aspects) {
          hall = pickCompact(candidatesIn(siteLand(z), plateDims(conventionHallM2, asp), comm.setback), 1, wingGap, fit.wings);
          if (hall.length > 0) break;
        }
        if (hall.length > 0 || fit.floors >= comm.maxFloors) break;
        const next = fitAmenity(z, comm.occ, commercialBuaM2, comm.maxFloors, comm.wingMax, comm.setback, fit.floors + 1);
        if (!next) break;
        fit = next;
      }
      // No floor count makes room for a separate hall: keep the lowest blocks and host it.
      if (hall.length === 0) fit = firstFit;
      if (!fit) notes.push(`the commercial ${sft(commercialBuaM2)} sq ft does not fit in the ${z.name} zone within ${comm.maxFloors} floors`);
      const wings = fit?.wings ?? [];
      if (fit) {
        const f0 = fit;
        wings.forEach((w, i) =>
          draftsB.push({
            zone: z,
            use: 'commercial',
            placed: w,
            footprintM2: f0.wingPlate,
            floors: f0.floors,
            floorH: 4,
            units: 0,
            builtUpM2: f0.wingPlate * f0.floors,
            notes: [
              `commercial block ${i + 1} of ${wings.length}: ${sft(commercialBuaM2)} sq ft in all over ${f0.floors} floors`,
              `${f0.key}: coverage up to ${f0.coverage}%`,
            ],
            flat: true,
          }),
        );
      }
      if (conventionHallM2 > 0) {
        if (hall[0]) {
          conventionDone = true;
          draftsB.push({
            zone: z,
            use: 'commercial',
            placed: hall[0],
            footprintM2: conventionHallM2,
            floors: 1,
            floorH: comm.hallFh,
            units: 0,
            builtUpM2: conventionHallM2,
            notes: [`convention hall ${conventionHallM2.toFixed(0)} m² (programme.yaml convention), one floor ${comm.hallFh} m high`],
            flat: true,
          });
        } else {
          // No room for it on its own: the programme lets the commercial block
          // host it (programme.yaml convention host), on its ground floor.
          const host = draftsB.find((d) => d.zone === z && d.use === 'commercial');
          if (host) {
            conventionDone = true;
            const h = host.floors * host.floorH + comm.hallFh;
            host.floors += 1;
            host.floorH = h / host.floors;
            host.builtUpM2 += conventionHallM2;
            host.notes.push(
              `hosts the ${conventionHallM2.toFixed(0)} m² convention hall on its ground floor (${comm.hallFh} m high), the commercial floors above it: no room for a separate hall`,
            );
          } else notes.push('the convention hall does not fit in the commercial zone');
        }
      }
    }
    if ((z.use === 'hospital' || z.use === 'retail' || z.use === 'office') && zp?.bua_sft) {
      const r = pick<{ occupancy: Occupancy; max_floors: number; floor_height_m: number; wing_max_m2?: number; aspects?: number[]; wing_gap_m?: number } | null>(
        planning,
        `blocks.${z.use}`,
        null,
      );
      if (!r) throw new Error(`planning_rules.yaml blocks.${z.use} is missing`);
      const want = sftToM2(zp.bua_sft);
      const fit = fitAmenity(z, r.occupancy, want, r.max_floors, r.wing_max_m2 ?? comm.wingMax, comm.setback, 1, r.aspects ?? aspects, r.wing_gap_m ?? wingGap);
      if (!fit) {
        const free = cellsOf(siteLand(z)).length * cellArea;
        const clear = cellsOf(erode(dem, siteLand(z), comm.setback)).length * cellArea;
        notes.push(
          `${z.name}: ${sft(want)} sq ft does not fit within ${r.max_floors} floors on its ${ac(free)} of buildable land off the roads (${ac(clear)} inside the ${comm.setback} m yards)`,
        );
      }
      else {
        fit.wings.forEach((w, i) =>
          draftsB.push({
            zone: z,
            use: z.use as BuildingUse,
            placed: w,
            footprintM2: fit.wingPlate,
            floors: fit.floors,
            floorH: r.floor_height_m,
            units: 0,
            builtUpM2: fit.wingPlate * fit.floors,
            notes: [
              `block ${i + 1} of ${fit.wings.length}: ${sft(want)} sq ft in all (programme ${zp.id}) over ${fit.floors} floors`,
              `${fit.key}: coverage up to ${fit.coverage}%`,
            ],
            flat: true,
          }),
        );
      }
    }
    if (z.use === 'batching' && plantDims.length === 2 && !draftsB.some((b) => b.use === 'batching')) {
      const cands = candidatesIn(siteLand(z), { L: Math.max(plantDims[0]!, plantDims[1]!), D: Math.min(plantDims[0]!, plantDims[1]!) }, 1);
      const got = pickCompact(cands, 1, 0);
      if (got[0]) {
        draftsB.push({
          zone: z,
          use: 'batching',
          placed: got[0],
          footprintM2: plantDims[0]! * plantDims[1]!,
          floors: 1,
          floorH: plantH,
          units: 0,
          builtUpM2: 0,
          notes: [
            `batching plant ${plantDims[0]} × ${plantDims[1]} m, ${plantH} m to the top of the silos (planning_rules.yaml batching_plant, ASSUMPTION)`,
            'temporary works: the yard is the rest of the zone; it goes when building is done',
          ],
          flat: true,
        });
      } else notes.push(`the batching plant does not fit on the ${z.name} zone's buildable land`);
    }
    if (z.use === 'apartments' && (zp ? (zp.units ?? 0) > 0 : aptUnitsLeft > 0 || towersFor(z.name))) {
      const zoneTowers = towersFor(z.name);
      // Towers on the lower ground, spread over the zone, none in another's
      // view, each under the airport height limit, within FSI on the zone.
      /** Towers of one plan shape: lower ground first, spread, staggered, under the airport limit. */
      const planTowers = (dims: { L: number; D: number }, viewW: number): DraftBuilding[] => {
        const out: DraftBuilding[] = [];
        let unitsLeft = zp ? (zp.units ?? 0) : zoneTowers ? Number.POSITIVE_INFINITY : aptUnitsLeft;
        const want = zoneTowers ?? Number.POSITIVE_INFINITY;
        // A set number of towers: floors from the tower's share of the flats when
        // the programme's total is set, else an equal share of the zone's FSI.
        const perTower = unitsTotal && towersAll > 0 ? unitsTotal / towersAll : 0;
        const floorsByFsi = !zoneTowers
          ? Number.POSITIVE_INFINITY
          : towerFloorsSet
            ? towerFloorsSet
            : perTower > 0
            ? Math.ceil(perTower / flatsPerFloor)
            : Math.floor((apt.fsi * z.areaM2) / (zoneTowers * aptPlate));
        const P = apt.podium;
        let cands = candidatesIn(siteLand(z), dims, apt.setback + P);
        // A set number of towers on a tight zone: where the frame of the land holds none, turn the
        // tower off the contours in 15 degree steps until one fits.
        for (const turn of [15, 30, 45, 60, 75]) {
          if (!(zoneTowers || zp) || cands.length > 0) break;
          cands = candidatesIn(siteLand(z), dims, apt.setback + P, turn);
        }
        // Owner 12 Oct: a draft-model zone on a narrow strip of land: the towers it needs may stand turned off the
        // contours where that is what fits (every flat placed).
        if (zp && (zp.units ?? 0) > 0) {
          for (const turn of [15, 30, 45, 60, 75]) cands = cands.concat(candidatesIn(siteLand(z), dims, apt.setback + P, turn));
        }
        type T = Cand & { ring: Ring; pod: Ring; pLo: number; pHi: number; floorsCap: number; bc: number; hid: number };
        const pins = towerSites.filter((ts) => z.name.toUpperCase().startsWith(ts.match.toUpperCase())).map((ts) => ts.at);
        const towers: T[] = [];
        for (const cd of cands) {
          const pod = rectRing(cd.f, cd.a0 - P, cd.a1 + P, cd.b0 - P, cd.b1 + P);
          let pLo = Infinity;
          let pHi = -Infinity;
          for (const q of rectSamples(cd.f, cd.a0 - P, cd.a1 + P, cd.b0 - P, cd.b1 + P, 3)) {
            const zz = dem.sampleBilinear(q.p);
            if (!Number.isFinite(zz)) continue;
            pLo = Math.min(pLo, zz);
            pHi = Math.max(pHi, zz);
          }
          if (!Number.isFinite(pHi)) continue;
          const floorsCap = Math.min(apt.maxFloors, Math.floor((capRl - pHi - air.roof) / apt.fh));
          if (floorsCap < apt.minFloors) continue;
          const ring = ringOf(cd);
          towers.push({ ...cd, ring, pod, pLo, pHi, floorsCap, bc: (cd.b0 + cd.b1) / 2, hid: villaViewHidden(pod) });
        }
        const minHi = towers.reduce((m, t) => Math.min(m, t.pHi), Infinity);
        const spreadCap = 2 * (dims.L + 2 * P) + towerClear;
        let budget = perTower > 0 || towerFloorsSet ? Number.POSITIVE_INFINITY : apt.fsi * z.areaM2;
        const chosen: T[] = [];
        let relaxed = 0;
        for (;;) {
          if (unitsLeft <= 0 || chosen.length >= want) break;
          let best: T | null = null;
          let bestS = -Infinity;
          let fallback: T | null = null;
          let fallbackS = -Infinity;
          for (const t of towers) {
            let minD = Infinity;
            let bad = false;
            let blocksView = false;
            for (const o of chosen) {
              // Podiums may run together (KMBR: no gap rule between buildings on
              // one podium); the towers keep their clear distance.
              if (ringGap(o.ring, t.ring) < towerClear) {
                bad = true;
                break;
              }
              // The view: within the view depth up or down the slope, towers are
              // staggered, overlapping along the contours by no more than the share allowed.
              const overlapU = Math.min(t.a1, o.a1) - Math.max(t.a0, o.a0);
              if (overlapU > apt.viewOverlap * Math.min(t.a1 - t.a0, o.a1 - o.a0) && Math.abs(t.bc - o.bc) < apt.viewDepth) blocksView = true;
              minD = Math.min(minD, Math.hypot(t.c[0] - o.c[0], t.c[1] - o.c[1]));
            }
            if (bad) continue;
            // Spread counts up to the spacing that leaves room for another tower
            // between; beyond it the lower ground wins, so the zone still fills.
            // An owner's site first: the nearest ground that takes the tower. Else
            // the lower ground, spread, hiding as little of the villas' view as it can.
            const pin = pins[chosen.length];
            const s = pin
              ? -Math.hypot(t.c[0] - pin[0], t.c[1] - pin[1])
              : (chosen.length === 0 ? -t.pHi : Math.min(minD, spreadCap) - 2 * (t.pHi - minHi)) - viewW * t.hid;
            if ((!blocksView || pin) && s > bestS) {
              bestS = s;
              best = t;
            }
            if (blocksView && s > fallbackS) {
              fallbackS = s;
              fallback = t;
            }
          }
          // A set number of towers: where staggering leaves no room, the view rule gives way.
          // (Owner 12 Oct: so too where a draft-model zone still has flats to place.)
          if (!best && (zoneTowers || (zp && unitsLeft > 0)) && fallback) {
            best = fallback;
            relaxed += 1;
          }
          if (!best) break;
          const floors = Math.min(best.floorsCap, Math.floor(budget / aptPlate), Math.ceil(unitsLeft / flatsPerFloor), floorsByFsi);
          if (floors < apt.minFloors) break;
          chosen.push(best);
          const pinned = pins[chosen.length - 1];
          budget -= aptPlate * floors;
          const u = Math.min(unitsLeft, floors * flatsPerFloor);
          unitsLeft -= u;
          const podH = Math.max(0, best.pHi - best.pLo);
          const capped = floors === best.floorsCap && best.floorsCap < apt.maxFloors;
          out.push({
            zone: z,
            use: 'apartments',
            placed: { ring: best.ring, cand: best },
            footprintM2: dims.L * dims.D,
            floors,
            floorH: apt.fh,
            units: u,
            builtUpM2: aptPlate * floors,
            notes: [
              `${u} flats: ${flatsPerFloor} a floor × ${floors} floors; plate ${aptPlate.toFixed(0)} m² (${Math.round(aptPlate * 10.7639).toLocaleString('en-IN')} sq ft)`,
              capped
                ? `held to ${floors} floors by the airport limit: top ${(best.pHi + floors * apt.fh + air.roof).toFixed(1)} RL against ${capRl.toFixed(1)} RL (${air.amsl} m AMSL)`
                : `top ${(best.pHi + floors * apt.fh + air.roof).toFixed(1)} RL, under the airport limit of ${capRl.toFixed(1)} RL (${air.amsl} m AMSL)`,
              `podium follows the ground: ${podH.toFixed(1)} m from its low side to the tower floor; no flat platform cut`,
              pinned
                ? `on the owner's site (${pinned[0].toFixed(0)}, ${pinned[1].toFixed(0)}), ${Math.hypot(best.c[0] - pinned[0], best.c[1] - pinned[1]).toFixed(0)} m from it; ${towerClear.toFixed(0)} m clear of the others`
                : `on the lower ground of the zone; staggered: within ${apt.viewDepth} m up or down the slope no tower hides more than ${Math.round(apt.viewOverlap * 100)}% of its width; ${towerClear.toFixed(0)} m clear of the others`,
              ...(vv ? [`hides ${best.hid.toFixed(1)}% of the villas' view (first-floor lookouts every 10 m, ${vv.reach_m} m out)`] : []),
            ],
            podium: { ring: best.pod, topRl: best.pHi, bottomRl: best.pLo },
            flat: false,
          });
        }
        (out as DraftBuilding[] & { relaxed?: number }).relaxed = relaxed;
        return out;
      };
      // The count and the flats come first; then the least of the villas' view hidden.
      let bestPlan: DraftBuilding[] = [];
      const hidOf = (b: DraftBuilding): number => villaViewHidden(b.podium?.ring ?? b.placed.ring);
      const score = (p: DraftBuilding[]): number => (zoneTowers ? p.length * 1e6 : 0) + p.reduce((s, b) => s + 100 * b.units - hidOf(b), 0);
      for (const viewW of vv ? [vv.weight_m_per_pct, 0] : [0]) {
        for (const asp of [apt.aspect, ...aspects.filter((x) => x !== apt.aspect && x >= 1.5)]) {
          const got = planTowers(plateDims(aptPlate, asp), viewW);
          if (score(got) > score(bestPlan)) bestPlan = got;
        }
      }
      for (const b of bestPlan) {
        draftsB.push(b);
        aptUnitsLeft -= b.units;
      }
      const relaxedN = (bestPlan as DraftBuilding[] & { relaxed?: number }).relaxed ?? 0;
      if (relaxedN > 0) notes.push(`${z.name}: ${relaxedN} tower${relaxedN > 1 ? 's' : ''} could not be fully staggered for views and stand partly behind another`);
      if (zoneTowers && bestPlan.length < zoneTowers) {
        notes.push(`${z.name}: ${bestPlan.length} of ${zoneTowers} towers of ${Math.round(aptPlate * 10.7639).toLocaleString('en-IN')} sq ft fit with their setbacks, clear distance and views`);
      }
    }
  }
  if (seniorLeft > 0 && !zones.some((z) => z.use === 'senior' && progOf(z))) notes.push(`${seniorLeft} senior buildings (G+${sen.floors - 1}) do not fit in the senior living zone's buildable land`);

  // A drive to every building that no road reaches. It stops at the building's edge (its centreline half its
  // width plus a metre off the wall) and goes round every building on the way, not through one.
  const reachM = 12;
  const driveOff = width.secondary / 2 + 1;
  const allBuilt = rasterise(
    dem,
    draftsB.map((q) => [q.podium?.ring ?? q.placed.ring]),
  );
  const keepClear = dilate(dem, allBuilt, driveOff - 0.5);
  // ...and keeps its half width off the villa plots (routing alone only keeps its centreline off them), with 2 m
  // more for the line straightened from the routed cells (1.5 m) and the cells themselves.
  const plotsClear = dilate(dem, rasterise(dem, drafts.map((p) => [p.ring])), width.secondary / 2 + 2);
  const distToRing = (q: Pt, ring: Ring): number => {
    let m = Infinity;
    for (let i = 0; i < ring.length; i += 1) {
      const A = ring[i]!;
      const B = ring[(i + 1) % ring.length]!;
      const dx = B[0] - A[0];
      const dy = B[1] - A[1];
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2)) : 0;
      m = Math.min(m, Math.hypot(q[0] - A[0] - t * dx, q[1] - A[1] - t * dy));
    }
    return m;
  };
  // One drive serves a campus: the wings of a school, a hospital, a clubhouse or a senior enclave share it (their
  // own paths link them); each apartment tower has its own.
  const reachedGroup = new Set<string>();
  const groupOf = (b: DraftBuilding): string | null => (b.use === 'apartments' ? null : `${b.zone.name}|${b.use}`);
  for (const b of draftsB) {
    const ring = b.podium?.ring ?? b.placed.ring;
    const own = rasterise(dem, [[ring]]);
    const near = cellsOf(dilate(dem, own, reachM));
    const grp = groupOf(b);
    if (nearNetwork(near, 0)) {
      if (grp) reachedGroup.add(grp);
      continue;
    }
    if (grp && reachedGroup.has(grp)) continue;
    // A campus's drive goes to whichever of its wings is nearest, not between them to the first one listed.
    const wings = grp ? draftsB.filter((q) => groupOf(q) === grp).map((q) => q.podium?.ring ?? q.placed.ring) : [ring];
    const groupMask = rasterise(dem, wings.map((w) => [w]));
    const target = and(dilate(dem, groupMask, 3), terrain);
    const ownClear = dilate(dem, groupMask, driveOff - 0.5);
    const cost = Float32Array.from(baseCost);
    for (let k = 0; k < n; k += 1) if (target[k]) cost[k] = Math.min(Number.isFinite(cost[k]!) ? cost[k]! : 5, 5);
    for (let k = 0; k < n; k += 1) if ((keepClear[k] && !ownClear[k]) || plotsClear[k]) cost[k] = Number.POSITIVE_INFINITY;
    const r = route({ dem, cost, grade: lim.secondary, overGradePenalty: penalty, sources: networkCells().filter((k) => !plotsClear[k]), targets: target, dirWeight });
    if (!r.path) {
      notes.push(`no drive can be built to a ${b.use} building in ${b.zone.name}`);
      continue;
    }
    // The drive stops short of the wall: its centreline half its width and a metre off.
    const line = lineOf(r.path);
    if (line.length < 2) {
      // The network already touches the building's edge: no drive to lay.
      if (grp) reachedGroup.add(grp);
      continue;
    }
    const distToWings = (q: Pt): number => Math.min(...wings.map((w) => distToRing(q, w)));
    while (line.length > 2 && distToWings(line[line.length - 1]!) < driveOff) line.pop();
    const last = line[line.length - 1]!;
    const prev = line[line.length - 2]!;
    const dLast = distToWings(last);
    if (dLast < driveOff) {
      // Pull the end back along the last step until it is clear.
      const dPrev = distToWings(prev);
      const t = dPrev > dLast ? Math.min(1, (driveOff - dLast) / (dPrev - dLast)) : 1;
      line[line.length - 1] = [last[0] + (prev[0] - last[0]) * t, last[1] + (prev[1] - last[1]) * t];
    }
    const rd = addRoad('secondary', line, `drive to the ${b.use} building${b.use === 'apartments' ? "'s podium" : ''} in ${b.zone.name}`);
    if (grp) reachedGroup.add(grp);
    if (rd) {
      rd.access = true;
      for (const k of rd.cells) baseCost[k] = Math.min(baseCost[k]!, c.road);
    }
  }

  /* ------------------------------------- tidy: no roads to nowhere */
  {
    const minPlots = num(planning, 'roads.min_plots_per_street');
    let bMask = emptyMask(dem);
    for (const b of draftsB) bMask = or(bMask, rasterise(dem, [[b.podium?.ring ?? b.placed.ring]]));
    const nearBuildings = dilate(dem, bMask, 25);
    const serves = (r: RoadRec): boolean => {
      if (r.access) return true;
      if (r.plots >= (r.row ? minPlots : 1)) return true;
      for (const k of r.cells) if (nearBuildings[k]) return true;
      return false;
    };
    const owner = new Map<number, number[]>();
    roads.forEach((r, ri) => {
      for (const k of r.cells) {
        const list = owner.get(k);
        if (list) list.push(ri);
        else owner.set(k, [ri]);
      }
    });
    const neighbours = (ri: number): Set<number> => {
      const out = new Set<number>();
      for (const k of roads[ri]!.cells) {
        const i = k % nx;
        const j = (k - i) / nx;
        for (let dj = -1; dj <= 1; dj += 1) {
          for (let di = -1; di <= 1; di += 1) {
            const a = i + di;
            const b = j + dj;
            if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
            const q = b * nx + a;
            if (L.existingRoads.mask[q]) out.add(-1);
            for (const o of owner.get(q) ?? []) if (o !== ri && roads[o]!.kept) out.add(o);
          }
        }
      }
      return out;
    };
    let removed = 0;
    for (let changed = true; changed; ) {
      changed = false;
      roads.forEach((r, ri) => {
        if (!r.kept || serves(r)) return;
        if (neighbours(ri).size <= 1) {
          r.kept = false;
          removed += 1;
          changed = true;
        }
      });
    }
    if (removed > 0) {
      notes.push(`${removed} roads that served nothing (a villa street with under ${minPlots} plots, a link or primary to land left unused) taken out; their land is green`);
      rebuildNetwork();
    }
  }
  const keptDrafts = drafts.filter((p) => !p.road || p.road.kept);
  // Plots beyond the category's target go, the steepest first: A and B stop at
  // their count, C at the BUA the gross FSI asks for.
  {
    const gAt = (p: DraftPlot): number => {
      const c0 = toWorld(p.f, p.a0 + p.w / 2, p.b0 + p.d / 2);
      const cc = dem.cellAt(c0);
      return cc ? analysis.gradient[cc.j * nx + cc.i] ?? 0 : 0;
    };
    const steepFirst = [...keptDrafts].sort((a, b) => gAt(b) - gAt(a));
    const gone = new Set<DraftPlot>();
    let merged = 0;
    const carried: string[] = [];
    const fill = isMix && pick<boolean>(planning, `villas.categories.${villaSizing}.fill`, false);
    if (fill) {
      // Owner 8 Oct: every villa the land holds is laid; nothing is trimmed to the model's counts. Owner 12 Oct: up to
      // the zoning's count (villas.count_by_zoning): the steepest plots over it are left green.
      const zk = ((x) => (x === 'green_pockets' || x === 'green_chain' ? x : 'model'))(pick<string>(planning, 'options.draft_zoning', 'model'));
      const hi = pick<[number, number]>(planning, `villas.count_by_zoning.${zk}`, [0, Infinity])[1];
      const over = keptDrafts.length - hi;
      if (over > 0) {
        for (const p of steepFirst.slice(0, over)) gone.add(p);
        carried.push(`${over} plots over the ${hi} villas the zoning asks for are left green, the steepest first (owner 12 Oct)`);
      }
      // and no villa zone over villas.max_per_acre (owner 12 Oct: 15 an acre at most)
      const perAc = num(planning, 'villas.max_per_acre');
      let capped = 0;
      for (const z of zones.filter((q) => q.use === 'villas')) {
        const inZone = steepFirst.filter((p) => p.zone === z.name && !gone.has(p));
        const extra = inZone.length - Math.floor((z.areaM2 / 4046.8564224) * perAc);
        for (const p of inZone.slice(0, Math.max(0, extra))) gone.add(p);
        capped += Math.max(0, extra);
      }
      if (capped > 0) carried.push(`${capped} plots over ${perAc} an acre in their villa zone are left green, the steepest first (owner 12 Oct)`);
    } else if (isMix) {
      // Each zone stops at its component's units. Owner 7 Oct (85% of the villa land in plots): a plot over the
      // count is not left empty; its row neighbours share it, each still a rectangle, within the growth limit.
      // The plots that can be shared go first (steepest first); a plot no neighbour can take goes as before.
      const live = new Set(keptDrafts);
      const capOf = (q: DraftPlot): number => mixGrow * sftToM2(ruleOf(q.kind).plot_sft[0]);
      const rowMate = (p: DraftPlot, side: -1 | 1): DraftPlot | undefined =>
        keptDrafts.find(
          (q) =>
            q !== p &&
            live.has(q) &&
            q.area === undefined &&
            q.f === p.f &&
            Math.abs(q.b0 - p.b0) < 0.01 &&
            Math.abs(q.d - p.d) < 0.01 &&
            (side < 0 ? Math.abs(q.a0 + q.w - p.a0) < 0.05 : Math.abs(p.a0 + p.w - q.a0) < 0.05),
        );
      const share = (p: DraftPlot): boolean => {
        if (p.area !== undefined) return false;
        const L = rowMate(p, -1);
        const R = rowMate(p, 1);
        const fits = (q: DraftPlot | undefined, extra: number): boolean => !!q && (q.w + extra) * q.d <= capOf(q) + 1e-6;
        let toL = 0;
        let toR = 0;
        if (fits(L, p.w / 2) && fits(R, p.w / 2)) [toL, toR] = [p.w / 2, p.w / 2];
        else if (fits(L, p.w)) toL = p.w;
        else if (fits(R, p.w)) toR = p.w;
        else return false;
        if (L && toL > 0) {
          L.w += toL;
          L.ring = rectRing(L.f, L.a0, L.a0 + L.w, L.b0, L.b0 + L.d);
        }
        if (R && toR > 0) {
          R.a0 -= toR;
          R.w += toR;
          R.ring = rectRing(R.f, R.a0, R.a0 + R.w, R.b0, R.b0 + R.d);
        }
        return true;
      };
      // Owner 7 Oct: the model's 320 villas are the township's; a phase whose land holds more than its count
      // makes up the phases that fall short (the plan reports which phase carries which villas).
      const countIn = (zn: string): number => keptDrafts.filter((p) => p.zone === zn).length;
      let spare = [...zoneVillaTarget].reduce((t, [zn, want]) => t + Math.max(0, want - countIn(zn)), 0);
      for (const [zn, t] of zoneVillaTarget) {
        const inZone = steepFirst.filter((p) => p.zone === zn);
        const extra = Math.min(Math.max(0, inZone.length - t), spare);
        spare -= extra;
        if (extra > 0) carried.push(`${zn.charAt(0)}${zn.slice(1).toLowerCase()} holds ${extra} villas over its count of ${t}, making up the phases short of theirs`);
        let over = inZone.length - t - extra;
        for (const p of inZone) {
          if (over <= 0) break;
          if (!share(p)) continue;
          gone.add(p);
          live.delete(p);
          merged += 1;
          over -= 1;
        }
        for (const p of inZone) {
          if (over <= 0) break;
          if (gone.has(p)) continue;
          gone.add(p);
          live.delete(p);
          over -= 1;
        }
      }
    } else if (villaTarget > 0) {
      for (const p of steepFirst.slice(0, Math.max(0, keptDrafts.length - villaTarget))) gone.add(p);
    } else {
      let bua = keptDrafts.reduce((s, p) => s + buaOf(p.kind), 0);
      for (const p of steepFirst) {
        if (bua - buaOf(p.kind) < targetBuaM2) continue;
        gone.add(p);
        bua -= buaOf(p.kind);
      }
    }
    if (gone.size > 0) {
      for (const p of gone) if (p.road) p.road.plots -= 1;
      const keep = keptDrafts.filter((p) => !gone.has(p));
      keptDrafts.length = 0;
      keptDrafts.push(...keep);
    }
    for (const c of carried) notes.push(c);
    if (merged > 0) notes.push(`${merged} plots over a zone's count are shared by their row neighbours, which widen and stay rectangles (owner 7 Oct: 85% of the villa land in plots)`);
  }
  if (keptDrafts.length < drafts.length) notes.push(`${drafts.length - keptDrafts.length} plots on streets taken out, or over a zone's count, are not laid`);

  // MIX (owner 7 Oct: 85% of the villa land in plots; five sides allowed where a row meets the fixed edge of the
  // land): each pocket of villa land no plot or road took joins the plot beside it that shares the longest edge
  // with it, where the two make one convex plot of at most five sides within the growth limit. Pockets on
  // waterlogged ground or a natural drain stay open.
  // A closed ring without its repeated end, and without the points that sit on a straight run (within tol).
  const closedSimplify = (r: Ring, tol: number): Ring => {
    let pts: Pt[] = [...r];
    if (pts.length > 1 && Math.hypot(pts[0]![0] - pts[pts.length - 1]![0], pts[0]![1] - pts[pts.length - 1]![1]) < 1e-9) pts.pop();
    for (let changed = true; changed && pts.length > 3; ) {
      changed = false;
      for (let q = 0; q < pts.length && pts.length > 3; q += 1) {
        const A = pts[(q + pts.length - 1) % pts.length]!;
        const B = pts[q]!;
        const C = pts[(q + 1) % pts.length]!;
        const len = Math.hypot(C[0] - A[0], C[1] - A[1]);
        const off = len < 1e-9 ? 0 : Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / len;
        if (off < tol || Math.hypot(B[0] - A[0], B[1] - A[1]) < 0.05) {
          pts = pts.filter((_, k) => k !== q);
          changed = true;
        }
      }
    }
    return pts as Ring;
  };
  const convexRing = (r: readonly Pt[]): boolean => {
    let sgn = 0;
    for (let q = 0; q < r.length; q += 1) {
      const A = r[q]!;
      const B = r[(q + 1) % r.length]!;
      const C = r[(q + 2) % r.length]!;
      if (Math.hypot(B[0] - A[0], B[1] - A[1]) < 1) return false;
      const z = (B[0] - A[0]) * (C[1] - B[1]) - (B[1] - A[1]) * (C[0] - B[0]);
      if (Math.abs(z) < 1e-6) continue;
      if (sgn === 0) sgn = Math.sign(z);
      else if (Math.sign(z) !== sgn) return false;
    }
    return true;
  };
  if (isMix && keptDrafts.length > 0) {
    let joined = 0;
    const capOf = (q: DraftPlot): number => mixGrow * sftToM2(ruleOf(q.kind).plot_sft[0]);
    const keepOut = or(L.waterlogging.mask, L.drains.mask);
    const roadPolys: MultiPoly = [];
    for (const r of roads) if (r.kept) roadPolys.push(...r.geom);
    for (const line of existingLines) roadPolys.push(...bufferPolyline(line, 2 * exHalf));
    // The land past each plot along its own lines: behind it, and beyond either end of it.
    const reachOut = 30;
    const extents = (q: DraftPlot): Ring[] => {
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (const P of q.ring) {
        const [u, v] = toFrame(q.f, P);
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
      return [
        rectRing(q.f, u0, u1, v1 - 0.05, v1 + reachOut),
        rectRing(q.f, u1 - 0.05, u1 + reachOut, v0, v1 + reachOut),
        rectRing(q.f, u0 - reachOut, u0 + 0.05, v0, v1 + reachOut),
      ];
    };
    for (const zi of zones.map((z, i) => (z.use === 'villas' ? i : -1)).filter((i) => i >= 0)) {
      const zg = input.zones[zi]!.geom;
      const zName = zones[zi]!.name;
      const near = keptDrafts.filter((q) => q.zone === zName || pointInMulti(q.ring[0]!, zg));
      // Every plot comes off, whichever zone it counts in: one grid runs across the zones, so a plot may cross a line.
      let left = difference(zg, roadPolys, keptDrafts.map((q) => [q.ring] as Ring[]));
      for (const q of near) {
        for (const ext of extents(q)) {
          if (left.length === 0) break;
          const now = q.area ?? q.w * q.d;
          const room = capOf(q) - now;
          if (room < 2) break;
          const parts = intersectPolys(left, [[ext]]);
          for (const poly of parts) {
            const piece = closedSimplify(poly[0]!, 0.6);
            if (piece.length < 3) continue;
            const pa = ringArea(piece);
            if (pa < 2) continue;
            if (pa > room) continue;
            let wet = 0;
            for (const P of piece) {
              const cc = dem.cellAt(P);
              if (cc && keepOut[cc.j * nx + cc.i]) wet += 1;
            }
            if (wet > 0) continue;
            const u = union([[q.ring]], [[piece]]);
            if (u.length !== 1 || u[0]!.length !== 1) continue;
            const ring = closedSimplify(u[0]![0]!, 0.6);
            if (ring.length < 4 || ring.length > 5 || !convexRing(ring)) continue;
            const area = ringArea(ring);
            if (area > capOf(q) || Math.abs(area - (now + pa)) > 0.05 * (now + pa) + 1) continue;
            // Straightening the outline must not reach into a neighbour or a road.
            if (keptDrafts.some((o) => o !== q && rectsOverlap(o.ring, ring, 0.1)) || !clearOfRoads(ring)) continue;
            q.ring = ring;
            q.area = area;
            left = difference(left, [[piece]]);
            joined += 1;
            break;
          }
        }
      }
    }
    if (joined > 0) notes.push(`${joined} pockets of villa land join the plot beside them (each still one plot of four or five sides, owner 7 Oct)`);
  }

  // Open space (owner 7 Oct) on its exact outline: a plot the 2 m grid let reach into a green pocket is trimmed
  // off it: a rectangle loses depth from the back or width from a side, any other plot is cut along the pocket's
  // edge if it stays one convex plot of four or five sides; a plot that cannot be trimmed goes.
  if (isMix) {
    const opens = zones.map((z, i) => (z.use === 'park' ? input.zones[i]!.geom : null)).filter((g): g is MultiPoly => g !== null);
    const into = (r: Ring): number => opens.reduce((t, g) => t + multiPolyArea(intersectPolys([[r]], g)), 0);
    let trimmed = 0;
    const gone = new Set<DraftPlot>();
    for (const q of keptDrafts) {
      if (into(q.ring) < 0.05) continue;
      let ok = false;
      const minA = 0.84 * sftToM2(ruleOf(q.kind).plot_sft[0]);
      if (q.area === undefined) {
        for (let cut = 0.25; cut <= 4 && !ok; cut += 0.25) {
          for (const [a0, w, d] of [
            [q.a0, q.w, q.d - cut],
            [q.a0 + cut, q.w - cut, q.d],
            [q.a0, q.w - cut, q.d],
          ] as [number, number, number][]) {
            if (w * d < minA || w < 6) continue;
            const r = rectRing(q.f, a0, a0 + w, q.b0, q.b0 + d);
            if (into(r) < 0.05) {
              Object.assign(q, { a0, w, d, ring: r });
              ok = true;
              break;
            }
          }
        }
      } else {
        const cutR = difference([[q.ring]], ...opens);
        if (cutR.length === 1 && cutR[0]!.length === 1) {
          const r = closedSimplify(cutR[0]![0]!, 0.15);
          if (r.length >= 4 && r.length <= 5 && convexRing(r) && ringArea(r) >= minA) {
            q.ring = r;
            q.area = ringArea(r);
            ok = true;
          }
        }
      }
      if (ok) trimmed += 1;
      else gone.add(q);
    }
    if (gone.size > 0) {
      const keep = keptDrafts.filter((q) => !gone.has(q));
      keptDrafts.length = 0;
      keptDrafts.push(...keep);
    }
    if (trimmed + gone.size > 0) notes.push(`${trimmed} plots trimmed off the green pockets' edges${gone.size > 0 ? `, ${gone.size} taken out` : ''} (open space, owner 7 Oct)`);
  }

  /* ------------------------------------------------------------ golf */
  const golfMax = parseRatio(pick(planning, 'clubhouse.golf.max_grade', null), 'clubhouse.golf.max_grade');
  const golfReach = num(planning, 'clubhouse.golf.reach_from_zone_m');
  const golfMin = num(planning, 'clubhouse.golf.min_patch_m2');
  let golf = emptyMask(dem);
  let clubZoneMask = emptyMask(dem);
  for (const z of zones) if (z.use === 'clubhouse') clubZoneMask = or(clubZoneMask, z.mask);
  if (count(clubZoneMask) > 0) {
    let clubBuild = emptyMask(dem);
    for (const b of draftsB) if (b.use === 'clubhouse') clubBuild = or(clubBuild, rasterise(dem, [[b.placed.ring]]));
    const clubParcel = dilate(dem, clubBuild, amenitySetback + wingGap / 2);
    // Open space: ground no zone can build on, and land outside every zone.
    const open = maskFrom(dem, (k) => terrain[k] === 1 && (!buildable[k] || zoneOf[k]! < 0));
    let cand = or(clubZoneMask, and(open, dilate(dem, clubZoneMask, golfReach)));
    cand = minus(cand, network, L.drains.mask, L.nonBuildable.mask, clubParcel, plotCells);
    cand = and(cand, maskFrom(dem, (k) => analysis.gradient[k]! <= golfMax));
    const touch = dilate(dem, clubZoneMask, dem.cell);
    for (const p of patches(dem, cand)) {
      if (p.length * cellArea < golfMin || !p.some((k) => touch[k])) continue;
      for (const k of p) golf[k] = 1;
    }
  }
  const golfArea = count(golf) * cellArea;
  const golfIn = count(and(golf, clubZoneMask)) * cellArea;
  const golfWet = count(and(golf, L.waterlogging.mask)) * cellArea;

  /* ------------------------------------------- blocks: the land by use */
  type BlockDraft = PlanBlock & { cells: number[] };
  const blocks: BlockDraft[] = [];
  const blockOf = new Int32Array(n).fill(-1);
  const tierAt = new Int8Array(n).fill(-1); // 0 existing, 1 primary, 2 secondary, 3 tertiary
  const tierCode: Record<RoadTier, number> = { existing: 0, primary: 1, secondary: 2, tertiary: 3 };
  for (let k = 0; k < n; k += 1) if (L.existingRoads.mask[k]) tierAt[k] = 0;
  for (const r of roads) {
    if (!r.kept) continue;
    for (const k of r.cells) if (tierAt[k]! < 0 || tierAt[k]! > tierCode[r.tier]) tierAt[k] = tierCode[r.tier];
  }
  const tierNames: RoadTier[] = ['existing', 'primary', 'secondary', 'tertiary'];
  const gradeText = (g: number): string => `1:${(1 / Math.max(g, 1e-3)).toFixed(0)}`;
  const addBlock = (cells: number[], typology: Typology, zone: string | null, why: string[]): void => {
    if (cells.length * cellArea < 16) return;
    const mask = emptyMask(dem);
    for (const k of cells) mask[k] = 1;
    let g = 0;
    let gn = 0;
    let steep = 0;
    const front = new Set<number>();
    for (const k of cells) {
      const v = analysis.gradient[k]!;
      if (Number.isFinite(v)) {
        g += v;
        gn += 1;
        if (v > plotLimit) steep += 1;
      }
      const i = k % nx;
      const j = (k - i) / nx;
      for (const [di, dj] of N4) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const t = tierAt[b * nx + a]!;
        if (t >= 0 && t <= 2) front.add(t);
      }
    }
    const id = `B${blocks.length + 1}`;
    for (const k of cells) blockOf[k] = blocks.length;
    blocks.push({
      id,
      cells,
      geom: toMulti(dem, mask, true),
      areaM2: cells.length * cellArea,
      meanGrade: gn > 0 ? g / gn : 0,
      steepShare: gn > 0 ? steep / gn : 0,
      frontage: [...front].sort().map((t) => tierNames[t]!),
      centroid: centroidOf(dem, mask),
      typology,
      zone,
      why,
      builtUpM2: 0,
      fsi: 0,
    });
  };
  const taken = Uint8Array.from(network);
  for (let k = 0; k < n; k += 1) if (golf[k]) taken[k] = 1;
  const keptPlotCells = rasterise(
    dem,
    keptDrafts.map((p) => [p.ring]),
  );
  // Zone land, by the zone's use.
  for (const z of zones) {
    if (z.cells.length === 0) continue;
    const land = minus(zoneLand(z), taken);
    for (const piece of patches(dem, land)) {
      let typ: Typology = z.use;
      const why = [`client zoning plan: ${z.name}`];
      if (z.use === 'villas') {
        const hasPlot = piece.some((k) => keptPlotCells[k]);
        if (!hasPlot) {
          typ = 'open';
          why.push('villa land no plot fits or no road reaches: green');
        } else why.push('villa plots along the streets');
      } else if (z.use === 'reserved') why.push('reserved for the hospital, deferred until the land is acquired: nothing placed');
      else if (z.use === 'future') why.push('future phase: not planned at this stage (owner 25 Sep)');
      else if (z.use === 'batching') why.push('batching plant yard: temporary works for construction');
      for (const k of piece) taken[k] = 1;
      addBlock(piece, typ, z.name, why);
    }
  }
  for (const piece of patches(dem, golf)) {
    const zi = zoneOf[piece[0]!]!;
    addBlock(piece, 'golf', zi >= 0 ? zones[zi]!.name : null, [
      'golf course, part of the clubhouse (owner 25 Sep)',
      `gentle ground only: no steeper than ${gradeText(golfMax)} (planning_rules.yaml clubhouse.golf)`,
    ]);
  }
  // Everything else is open space, with the reason it could not be built on.
  const rest = minus(terrain, taken);
  for (const piece of patches(dem, rest)) {
    let wet = 0;
    let steepC = 0;
    let drain = 0;
    let outside = 0;
    for (const k of piece) {
      if (L.waterlogging.mask[k]) wet += 1;
      else if (L.nonBuildable.mask[k]) steepC += 1;
      else if (L.drains.mask[k]) drain += 1;
      else if (zoneOf[k]! < 0) outside += 1;
    }
    const why =
      wet >= Math.max(steepC, drain, outside) && wet > 0
        ? `waterlogged at the peak of the ${analysis.stormMm} mm storm (Rule 22(3)): open space`
        : steepC >= Math.max(drain, outside) && steepC > 0
          ? `${analysis.limits.nonBuildableLabel}: open space`
          : drain >= outside && drain > 0
            ? 'natural drain kept clear (Rule 22(4)): open space'
            : outside > 0
              ? 'outside every client zone: open space'
              : 'land left over: open space';
    const zi = zoneOf[piece[0]!]!;
    addBlock(piece, 'open', zi >= 0 ? zones[zi]!.name : null, [why]);
  }

  /* ------------------------- 10-11, 13 plots and buildings on the ground */
  const delta = new Float32Array(n);
  // Owner 28 Sep sketch: rear yard fixed, sides at least the minimum, the garden
  // in front at least KMBR Table 4's front yard. The ground floor takes up to its
  // coverage; the first floor sits on the back and both sides of it, the rest of
  // the ground floor's roof in front being its balcony; a bigger first floor grows
  // toward the road, up to the whole ground floor; what G+1 cannot hold goes into
  // a room on the roof, at the back (option a).
  const hs = {
    cover: num(planning, 'villas.house.ground_coverage_max'),
    roof: pick<boolean>(planning, 'villas.house.roof_room', true),
  };
  const pkg = cat.package_1 ?? null;
  let pkgLeft = pkg?.units ?? 0;
  const yardRows = new Set<string>();
  let retyped = 0;
  // Owner 12 Oct: no plot under a building of another use (a plot reshaped at the edge of the villa land can reach
  // over it): such a plot is left out.
  {
    const clash = keptDrafts.filter((d) => draftsB.some((b) => multiPolyArea(intersectPolys([[d.ring]], [[b.placed.ring]])) > 1));
    if (clash.length > 0) {
      const out = new Set(clash);
      const keep = keptDrafts.filter((d) => !out.has(d));
      keptDrafts.length = 0;
      keptDrafts.push(...keep);
      notes.push(`${clash.length} plots at the edge of the villa land reached under another use's building and are left out`);
    }
  }
  const plots: PlanPlot[] = keptDrafts.map((d, i) => {
    const smp = rectSamples(d.f, d.a0, d.a0 + d.w, d.b0, d.b0 + d.d, 1);
    const pf = platformFor(dem, smp, plotLimit, delta);
    const area = d.area ?? d.w * d.d;
    const centre = toWorld(d.f, d.a0 + d.w / 2, d.b0 + d.d / 2);
    const cc = dem.cellAt(centre);
    const bi = cc ? blockOf[cc.j * nx + cc.i]! : -1;
    const inPkg = pkg !== null && pkgLeft > 0 && d.zone.toUpperCase().startsWith(pkg.zone.toUpperCase());
    if (inPkg) pkgLeft -= 1;
    // The house in the plot's frame: a along the road, b from the road (front) to the back.
    const houseFor = (tgt: number) => {
      const yy = yardsFor(area, tgt);
      const gw = Math.max(0, d.w - 2 * yy.side);
      const gd = gw > 0 ? Math.max(0, Math.min((hs.cover * area) / gw, d.d - yy.rear - yy.front)) : 0;
      const ground = gw * gd;
      const first = Math.min(ground, Math.max(0, tgt - ground));
      const roofM2 = hs.roof ? Math.min(ground, Math.max(0, tgt - ground - first)) : 0;
      return { y: yy, gw, gd, ground, first, roofM2, holds: ground + first + roofM2 >= tgt - 0.5 };
    };
    let target = inPkg ? sftToM2(pkg!.bua_sft) : buaOf(d.kind);
    let h = houseFor(target);
    // MIX (owner 7 Oct): a row-end plot whose house cannot reach its villa's BUA (its straight core is narrow)
    // takes the largest of the model's villas it can hold, so every villa meets its own BUA.
    if (isMix && !inPkg && !h.holds) {
      for (const t of [...cat.types].sort((x, z) => buaOf(z.name) - buaOf(x.name))) {
        if (buaOf(t.name) >= target) continue;
        const ht = houseFor(buaOf(t.name));
        if (ht.holds) {
          d.kind = t.name;
          target = buaOf(t.name);
          h = ht;
          retyped += 1;
          break;
        }
      }
    }
    const { y, gw, gd, ground, first, roofM2 } = h;
    yardRows.add(`${y.row} (front ${y.front} m, rear ${y.rear} m, sides ${y.side} m)`);
    const bBack = d.b0 + d.d - y.rear;
    const a0 = d.a0 + y.side;
    const a1 = d.a0 + d.w - y.side;
    const fd = gw > 0 ? first / gw : 0;
    const rd = gw > 0 ? roofM2 / gw : 0;
    const bua = ground + first + roofM2;
    return {
      id: `P${i + 1}`,
      blockId: bi >= 0 ? blocks[bi]!.id : '',
      zone: d.zone,
      kind: d.kind,
      package1: inPkg,
      facingDeg: d.facingDeg,
      roadId: '',
      ring: d.ring,
      areaM2: area,
      widthM: d.w,
      depthM: d.d,
      platform: platformOnly(pf),
      baseRl: pf.level(d.a0 + d.w / 2, d.b0 + d.d / 2),
      groundFloor: rectRing(d.f, a0, a1, bBack - gd, bBack),
      upperFloor: rectRing(d.f, a0, a1, bBack - fd, bBack),
      roofRoom: roofM2 > 0.5 ? rectRing(d.f, a0, a1, bBack - rd, bBack) : null,
      groundFloorM2: ground,
      upperFloorM2: first,
      roofRoomM2: roofM2,
      balconyM2: ground - first,
      frontGardenM: d.d - y.rear - gd,
      targetBuiltUpM2: target,
      builtUpM2: bua,
      fsi: bua / area,
      floorHeightM: vfh,
    };
  });
  if (retyped > 0) notes.push(`${retyped} row-end plots take a smaller villa of the model's mix, the largest their house can hold (owner 7 Oct)`);
  const shortOfBua = plots.filter((p) => p.builtUpM2 < p.targetBuiltUpM2 - 0.5).length;
  if (shortOfBua > 0) notes.push(`${shortOfBua} villas cannot reach their BUA even with a roof room: their plots are too small for the yards`);
  const withRoof = plots.filter((p) => p.roofRoomM2 > 0.5).length;
  if (withRoof > 0) {
    const full = plots.filter((p) => p.roofRoomM2 >= p.groundFloorM2 - 0.5 && p.roofRoomM2 > 0.5).length;
    notes.push(
      `${withRoof} of ${plots.length} villas need a second floor or roof room to reach their BUA (${full} a full second floor, G+2): G+1 inside the yards cannot hold it; yards: ${[...yardRows].join('; ')}`,
    );
  }

  const counters: Record<BuildingUse, number> = { school: 0, clubhouse: 0, senior: 0, apartments: 0, commercial: 0, retail: 0, office: 0, hospital: 0, batching: 0 };
  const prefix: Record<BuildingUse, string> = { school: 'SCH', clubhouse: 'CLUB', senior: 'S', apartments: 'T', commercial: 'COM', retail: 'RET', office: 'OFF', hospital: 'HOS', batching: 'BP' };
  const buildings: PlanBuilding[] = draftsB.map((b) => {
    counters[b.use] += 1;
    const cc = dem.cellAt(b.placed.cand.c);
    const bi = cc ? blockOf[cc.j * nx + cc.i]! : -1;
    const id = `${prefix[b.use]}${b.use === 'senior' || b.use === 'apartments' ? '' : '-'}${counters[b.use]}`;
    const heightM = b.floors * b.floorH;
    if (b.podium) {
      const topRl = b.podium.topRl + heightM + air.roof;
      const podH = Math.max(0, b.podium.topRl - b.podium.bottomRl);
      return {
        id,
        blockId: bi >= 0 ? blocks[bi]!.id : '',
        zone: b.zone.name,
        typology: b.use,
        ring: b.placed.ring,
        footprintM2: b.footprintM2,
        floors: b.floors,
        heightM,
        baseRl: b.podium.topRl,
        topRl,
        topAmslM: toAmsl(topRl),
        units: b.units,
        builtUpM2: b.builtUpM2,
        podium: { ring: b.podium.ring, topRl: b.podium.topRl, bottomRl: b.podium.bottomRl, heightM: podH, levels: Math.ceil(podH / b.floorH) },
        notes: b.notes,
      };
    }
    const pf = platformFor(dem, rectSamples(b.placed.cand.f, b.placed.cand.a0, b.placed.cand.a1, b.placed.cand.b0, b.placed.cand.b1, 1), 0, delta, b.flat);
    const baseRl = pf.level(0, 0);
    const topRl = baseRl + heightM + (b.use === 'batching' ? 0 : air.roof);
    return {
      id,
      blockId: bi >= 0 ? blocks[bi]!.id : '',
      zone: b.zone.name,
      typology: b.use,
      ring: b.placed.ring,
      footprintM2: b.footprintM2,
      floors: b.floors,
      heightM,
      baseRl,
      topRl,
      topAmslM: toAmsl(topRl),
      units: b.units,
      builtUpM2: b.builtUpM2,
      platform: platformOnly(pf),
      notes: b.notes,
    };
  });
  for (const b of buildings) {
    if (b.topRl > capRl + 1e-6) notes.push(`${b.id} reaches ${b.topAmslM.toFixed(1)} m AMSL, over the airport limit of ${air.amsl} m`);
  }

  // Roads: ids in order, their earthwork into the total where it is the larger.
  const keptRoads = roads.filter((r) => r.kept);
  const tierCount: Record<string, number> = {};
  for (const r of keptRoads) {
    tierCount[r.tier] = (tierCount[r.tier] ?? 0) + 1;
    r.id = `${r.tier}-${tierCount[r.tier]}`;
    for (let q = 0; q < r.dzCells.length; q += 1) {
      const k = r.dzCells[q]!;
      const d = r.dz[q]!;
      if (Math.abs(d) > Math.abs(delta[k]!)) delta[k] = d;
    }
  }
  keptDrafts.forEach((d, i) => {
    plots[i]!.roadId = d.road?.id ?? 'existing';
  });

  for (const b of blocks) {
    const inPlots = plots.filter((p) => p.blockId === b.id);
    const inBuildings = buildings.filter((x) => x.blockId === b.id);
    b.builtUpM2 = inPlots.reduce((s, p) => s + p.builtUpM2, 0) + inBuildings.reduce((s, x) => s + x.builtUpM2, 0);
    b.fsi = b.areaM2 > 0 ? b.builtUpM2 / b.areaM2 : 0;
    if (b.typology === 'villas') {
      b.why = [...b.why.filter((w) => w !== 'villa plots along the streets'), `${inPlots.length} plots; mean ground ${gradeText(b.meanGrade)}`];
      if (inPlots.length === 0) {
        b.typology = 'open';
        b.why.push('no plot lies in it: green');
      }
    }
  }

  /* --------------------------------------------- FSI per zone parcel */
  const parcels: PlanParcel[] = [];
  for (const z of zones) {
    if (z.cells.length === 0 || z.use === 'open' || z.use === 'park' || z.use === 'reserved' || z.use === 'future') continue;
    const ids = new Set(blocks.filter((b) => b.zone === z.name).map((b) => b.id));
    if (z.use === 'villas') {
      const ps = plots.filter((p) => p.zone === z.name);
      if (ps.length === 0) continue;
      parcels.push({
        id: z.name,
        use: 'villas',
        blockIds: [...ids],
        areaM2: ps.reduce((s, p) => s + p.areaM2, 0),
        builtUpM2: ps.reduce((s, p) => s + p.builtUpM2, 0),
        fsi: ps.reduce((s, p) => s + p.builtUpM2, 0) / Math.max(1, ps.reduce((s, p) => s + p.areaM2, 0)),
        buildings: ps.length,
      });
      continue;
    }
    const bs = buildings.filter((b) => b.zone === z.name);
    const built = bs.reduce((s, b) => s + b.builtUpM2, 0);
    parcels.push({ id: z.name, use: z.use, blockIds: [...ids], areaM2: z.areaM2, builtUpM2: built, fsi: z.areaM2 > 0 ? built / z.areaM2 : 0, buildings: bs.length });
  }

  /* ------------------------------------------------- zone reports */
  const newRoadMask = minus(network, L.existingRoads.mask);
  const roadPolysAll: MultiPoly = roads.filter((r) => r.kept).flatMap((r) => r.geom);
  const zoneReports: ZoneReport[] = zones.filter((z) => z.cells.length > 0).map((z) => {
    const inZ = (m: Mask): number => {
      let s = 0;
      for (const k of z.cells) if (m[k]) s += 1;
      return s * cellArea;
    };
    const ps = plots.filter((p) => p.zone === z.name);
    const bs = buildings.filter((b) => b.zone === z.name);
    let holds: string;
    if (z.use === 'villas' && isMix) {
      const want = zoneVillaTarget.get(z.name);
      holds = `${ps.length}${want ? ` of ${want}` : ''} villa plots (${cat.types.map((t) => `${ps.filter((p) => p.kind === t.name).length} x ${t.name}`).join(', ')})`;
    } else if (z.use === 'villas') {
      const std = ps.filter((p) => p.kind === 'standard').length;
      holds = `${ps.length} villa plots (${std} standard, ${ps.length - std} compact)`;
    } else if (z.use === 'park' || z.use === 'open') holds = 'open space: recreational, nothing built (KMBR Rule 31(v))';
    else if (z.use === 'reserved') holds = 'reserved (hospital, deferred)';
    else if (z.use === 'future') holds = 'future phase, not planned now';
    else if (z.use === 'clubhouse') holds = `${bs.length} clubhouse wings; golf ${ac(inZ(golf))} in the zone`;
    else if (bs.length === 0) holds = z.cells.length === 0 ? 'outside the parcel' : 'nothing placed';
    else {
      // Owner 12 Oct: every figure is the plan's own: the flats the towers hold, not the model's count.
      const u = bs.reduce((s, b) => s + b.units, 0);
      holds = `${bs.length} buildings${u > 0 ? `, ${u} units` : ''}, ${sft(bs.reduce((s, b) => s + b.builtUpM2, 0))} sq ft built up`;
    }
    return {
      name: z.name,
      use: z.use,
      ...(z.phase !== undefined ? { phase: z.phase } : {}),
      areaM2: z.areaM2,
      buildableM2: inZ(buildable),
      waterM2: inZ(L.waterlogging.mask),
      steepM2: inZ(minus(L.nonBuildable.mask, L.waterlogging.mask)),
      drainM2: inZ(minus(L.drains.mask, L.waterlogging.mask, L.nonBuildable.mask)),
      roadsM2: inZ(newRoadMask),
      ...(z.use === 'park'
        ? (() => {
            const g = input.zones[zones.indexOf(z)]!.geom;
            return { openNetM2: multiPolyArea(g) - multiPolyArea(intersectPolys(g, roadPolysAll)) };
          })()
        : {}),
      holds,
    };
  });

  /* ------------------------------------------------- land account (owner 12 Oct) */
  const rcMin = num(planning, 'open_space.rc_min_m2');
  let outRoad = 0;
  let outGreen = 0;
  let parcelCells = 0;
  for (let k = 0; k < n; k += 1) {
    if (!terrain[k]) continue;
    parcelCells += 1;
    if (zoneOf[k]! >= 0) continue;
    if (network[k]) outRoad += 1;
    else outGreen += 1;
  }
  const green = { rcM2: 0, lakesM2: 0, zoneM2: 0, landscapeM2: outGreen * cellArea, groundsM2: 0, clubM2: 0 };
  let parkRoads = 0;
  const buildsOn = new Set<Typology>(['apartments', 'senior', 'school', 'retail', 'office', 'commercial', 'hospital']);
  for (const [zi, z] of zones.entries()) {
    const iz = input.zones[zi]!;
    if (z.use === 'park' || z.use === 'open') {
      const rep = zoneReports.find((r) => r.name === z.name);
      const net = rep?.openNetM2 ?? z.areaM2;
      parkRoads += z.areaM2 - net;
      if (iz.water) green.lakesM2 += net;
      else if (iz.within) green.zoneM2 += net;
      else if (iz.green !== 'landscape' && net >= rcMin) green.rcM2 += net;
      else green.landscapeM2 += net;
    } else if (z.use === 'clubhouse') green.clubM2 += z.areaM2;
    else if (buildsOn.has(z.use)) {
      const foot = buildings.filter((b) => b.zone === z.name).reduce((a, b) => a + b.footprintM2, 0);
      let rd = 0;
      for (const k of z.cells) if (network[k]) rd += 1;
      green.groundsM2 += Math.max(0, z.areaM2 - foot - rd * cellArea);
    }
  }
  const edgeM2 = Math.max(0, (analysis.parcelPolyM2 ?? 0) - parcelCells * cellArea);
  green.landscapeM2 += edgeM2;
  const land: LandAccount = {
    parcelM2: parcelCells * cellArea + edgeM2,
    edgeM2,
    zones: zones
      .filter((z) => z.cells.length > 0)
      .map((z) => ({ name: z.name, ...(z.component ? { component: z.component } : {}), use: z.use, ...(z.phase !== undefined ? { phase: z.phase } : {}), areaM2: z.areaM2 })),
    roadsM2: outRoad * cellArea + parkRoads,
    green,
    openSpaceM2: green.rcM2 + green.lakesM2 + green.zoneM2 + green.landscapeM2,
  };

  /* ------------------------------------------------------ programme */
  const maxPerAcre = num(planning, 'villas.max_per_acre');
  const villaBua = plots.reduce((s, p) => s + p.builtUpM2, 0);
  const plottedShare = grossLandM2 > 0 ? plots.reduce((s, p) => s + p.areaM2, 0) / grossLandM2 : 0;
  const split = pick<{ plots: number; tolerance: number }>(planning, 'villas.land_split', { plots: 0.8, tolerance: 0.05 });
  if (Math.abs(plottedShare - split.plots) > split.tolerance + 1e-9) {
    notes.push(
      `plots cover ${Math.round(plottedShare * 100)}% of the gross villa land, outside the target of ${Math.round(split.plots * 100)}% ± ${Math.round(split.tolerance * 100)}%`,
    );
  }
  const typeNote = cat.types
    .map((t) => {
      const k = plots.filter((p) => p.kind === t.name).length;
      return `${k} ${t.name} (plot ${sft(areaOf(t, plotScale))} sq ft in ${t.plot_sft[0].toLocaleString('en-IN')}-${t.plot_sft[1].toLocaleString('en-IN')}, BUA ${t.bua_sft.toLocaleString('en-IN')} sq ft)`;
    })
    .join(', ');
  const seniorBuilt = buildings.filter((x) => x.typology === 'senior').reduce((s, x) => s + x.units, 0);
  const aptBuilt = buildings.filter((x) => x.typology === 'apartments').reduce((s, x) => s + x.units, 0);
  const towers = buildings.filter((x) => x.typology === 'apartments');
  const aptParcel = parcels.find((p) => p.use === 'apartments');
  const has = (u: BuildingUse): boolean => buildings.some((x) => x.typology === u);
  // The convention hall is counted on its own line, whether it stands alone or a block hosts it.
  const commercialBuilt =
    buildings.filter((x) => x.typology === 'commercial').reduce((s, x) => s + x.builtUpM2, 0) - (conventionDone ? conventionHallM2 : 0);
  const programme: ProgrammeRow[] = [
    {
      use: 'Villas',
      // The category's own target: B the client's count, A what the gross FSI allows, C the BUA.
      asked: villaTarget > 0 ? `${villaTarget} units` : `${sft(targetBuaM2)} sq ft BUA (gross FSI ${grossFsi})`,
      placed: `${plots.length} plots, ${sft(villaBua)} sq ft BUA`,
      met: villaTarget > 0 ? plots.length >= villaTarget : villaBua >= targetBuaM2 * 0.999,
      note: `category ${villaSizing}: ${typeNote}${pkg ? `; ${pkg.units - pkgLeft} of Package 1 at ${pkg.bua_sft.toLocaleString('en-IN')} sq ft` : ''}; gross FSI ${(villaBua / Math.max(1, grossLandM2)).toFixed(2)} on ${ac(grossLandM2)}; in the villa and phase zones`,
    },
    {
      use: 'Senior living',
      asked: `${seniorUnits} units`,
      placed: `${seniorBuilt} units in ${buildings.filter((x) => x.typology === 'senior').length} buildings`,
      met: seniorBuilt >= seniorUnits,
      note: `G+${sen.floors - 1}, ${sen.upf} units a floor, in the senior living zone`,
    },
    {
      use: 'Apartments',
      asked: `${aptUnits} units`,
      placed: `${aptBuilt} units in ${towers.length} towers`,
      met: aptBuilt >= aptUnits,
      note: `FSI ${aptParcel ? aptParcel.fsi.toFixed(2) : '0'} of ${apt.fsi} on the apartment zone; tallest ${towers.reduce((m, t) => Math.max(m, t.floors), 0)} floors, airport limit ${air.amsl} m AMSL`,
    },
    {
      use: 'School',
      asked: `${sft(schoolBuaM2)} sq ft`,
      placed: has('school') ? 'placed, one campus' : 'not placed',
      met: has('school'),
      note: `in the school zone; ${schoolLandAc} ac core campus asked`,
    },
    {
      use: 'Clubhouse and golf',
      asked: `${sft(clubBuaM2)} sq ft`,
      placed: has('clubhouse') ? `placed; golf ${ac(golfArea)}` : 'not placed',
      met: has('clubhouse'),
      note: `golf on gentle open ground: ${ac(golfIn)} in the clubhouse zone, ${ac(golfArea - golfIn)} of open space beside it (${ac(golfWet)} of it waterlogged at the peak)`,
    },
    {
      use: 'Commercial',
      asked: `${sft(commercialBuaM2)} sq ft`,
      placed: has('commercial') ? `${sft(commercialBuilt)} sq ft` : 'not placed',
      met: commercialBuilt >= commercialBuaM2 - 1,
      note: 'in the commercial and convention zone',
    },
    {
      use: 'Convention hall',
      asked: conventionHallM2 > 0 ? `${conventionHallM2.toFixed(0)} m²` : '—',
      placed: conventionDone ? 'placed' : 'not placed',
      met: conventionDone || conventionHallM2 === 0,
      note: buildings.some((b) => b.notes.some((t) => t.includes('convention hall on its ground floor')))
        ? 'on the ground floor of a commercial block (no room for its own building)'
        : 'its own building beside the commercial blocks',
    },
    {
      use: 'Batching plant',
      asked: 'the client zone',
      placed: has('batching') ? 'placed' : 'not placed',
      met: has('batching'),
      note: 'temporary works yard',
    },
  ];
  // Draft model: one row per component, each against its own zone.
  const compZones = zones.filter((z) => progOf(z));
  if (compZones.length > 0) {
    programme.length = 0;
    for (const z of compZones) {
      const l = progOf(z)!;
      const bs = buildings.filter((b) => b.zone === z.name);
      const ps = plots.filter((p) => p.zone === z.name);
      // Owner 12 Oct: the name, no component code
      const label = `${z.name.charAt(0)}${z.name.slice(1).toLowerCase()}`;
      if (z.use === 'villas') {
        const bua = ps.reduce((a, p) => a + p.builtUpM2, 0);
        // Owner 12 Oct: as many as the land holds, up to villas.max_per_acre on the zone's land (the model's
        // counts no longer apply); a count of the model's, where a line still has one, is the ask.
        const zac = z.areaM2 / 4046.8564224;
        const cap = Math.floor(zac * maxPerAcre);
        programme.push({
          use: label,
          asked: l.units ? `${l.units} villas` : `up to ${cap} villas (${maxPerAcre} an acre on ${zac.toFixed(2)} ac)`,
          placed: `${ps.length} plots, ${sft(bua)} sq ft BUA`,
          met: l.units ? ps.length >= l.units : ps.length <= cap,
          note: `${(ps.length / Math.max(zac, 1e-9)).toFixed(1)} an acre; ${cat.types.map((t) => `${ps.filter((p) => p.kind === t.name).length} x ${t.name}`).join(', ')}`,
        });
      } else if (l.units && z.use === 'apartments') {
        // Owner 12 Oct: the flats the towers hold, against the model's; a shortfall shows.
        const u = bs.reduce((a, b) => a + b.units, 0);
        programme.push({
          use: label,
          asked: `${l.units} units`,
          placed: `${u} units in ${bs.length} buildings`,
          met: u >= l.units,
          note: `tallest ${bs.reduce((m, b) => Math.max(m, b.floors), 0)} floors, under the airport limit of ${air.amsl} m AMSL${u < l.units ? `; ${l.units - u} short` : ''}`,
        });
      } else if (l.units) {
        const u = bs.reduce((a, b) => a + b.units, 0);
        programme.push({
          use: label,
          asked: `${l.units} units`,
          placed: `${u} units in ${bs.length} buildings`,
          met: u >= l.units,
          note: `tallest ${bs.reduce((m, b) => Math.max(m, b.floors), 0)} floors`,
        });
      } else {
        const built = bs.reduce((a, b) => a + b.builtUpM2, 0);
        programme.push({
          use: label,
          asked: `${(l.bua_sft ?? 0).toLocaleString('en-IN')} sq ft`,
          placed: bs.length > 0 ? `${sft(built)} sq ft in ${bs.length} blocks, ${bs.reduce((m, b) => Math.max(m, b.floors), 0)} floors` : 'not placed',
          met: built >= sftToM2(l.bua_sft ?? 0) * 0.99,
          note: `${z.use}, phase ${l.phase ?? z.phase ?? '-'}`,
        });
      }
    }
  }
  // A component the owner has moved off this land (draft model: the hospital, to the 26 ac deferred land).
  if (compZones.length > 0) {
    for (const l of lines) {
      if (!l.deferred) continue;
      programme.push({
        use: `${(l.name ?? l.use).split(":")[0]}`,
        asked: l.bua_sft ? `${l.bua_sft.toLocaleString('en-IN')} sq ft` : `${l.units ?? 0} units`,
        placed: 'not in these 73 ac',
        met: true,
        note: l.deferred,
      });
    }
  }
  if (compZones.some((z) => z.use === 'villas')) {
    // Owner 12 Oct: the count each zoning aims for (planning_rules.yaml villas.count_by_zoning).
    const zoningKey = ((x) => (x === 'green_pockets' || x === 'green_chain' ? x : 'model'))(pick<string>(planning, 'options.draft_zoning', 'model'));
    const [lo, hi] = pick<[number, number]>(planning, `villas.count_by_zoning.${zoningKey}`, [0, Infinity]);
    const vac = compZones.filter((z) => z.use === 'villas').reduce((a, z) => a + z.areaM2, 0) / 4046.8564224;
    programme.push({
      use: 'Villas · all phases',
      asked: `${lo}–${hi} villas`,
      placed: `${plots.length} villas on ${vac.toFixed(2)} ac, ${(plots.length / Math.max(vac, 1e-9)).toFixed(1)} an acre`,
      met: plots.length >= lo && plots.length <= hi,
      note: `owner 12 Oct; at most ${maxPerAcre} an acre`,
    });
  }
  const unzoned = compZones.length > 0 ? [] : ['hotel', 'office'].filter((u) => byUse(u).length > 0);
  if (unzoned.length > 0) {
    programme.push({
      use: 'Not placed',
      asked: unzoned.map((u) => (u === 'office' ? 'business hub' : u)).join(', '),
      placed: '—',
      met: false,
      note: 'the client zoning plan has no zone for them',
    });
  }
  if (compZones.length === 0 && byUse('hospital').length > 0) {
    programme.push({ use: 'Hospital', asked: 'deferred', placed: 'zone reserved', met: true, note: 'waits for the deferred land (programme.yaml)' });
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
    roads: keptRoads.map((r) => ({
      id: r.id,
      tier: r.tier,
      centreline: r.centreline,
      widthM: r.widthM,
      geom: r.geom,
      lengthM: r.lengthM,
      limit: r.limit,
      terrainMaxGrade: r.terrainMaxGrade,
      designMaxGrade: r.designMaxGrade,
      withinLimitAsIs: r.withinLimitAsIs,
      cutM3: r.cutM3,
      fillM3: r.fillM3,
      plots: plots.filter((p) => p.roadId === r.id).length,
      notes: r.notes,
    })),
    blocks: blocks.map(({ cells: _c, ...b }) => b),
    plots,
    buildings,
    parcels,
    zones: zoneReports,
    golf: { areaM2: golfArea, inZoneM2: golfIn, outsideZoneM2: golfArea - golfIn, onWaterloggedM2: golfWet, maxGrade: golfMax },
    airport: { capAmslM: air.amsl, capRl, tbmAmslM: air.tbmAmsl, rooftopM: air.roof },
    option: {
      basis: pick<string>(planning, 'options.basis', 'client') === 'draft_model' ? 'draft_model' : 'client',
      apartmentUnits: buildings.filter((b) => b.typology === 'apartments').reduce((a, b) => a + b.units, 0),
      villaSizing,
      roads: roadMode,
      zoning: ((z) => (z === 'green_pockets' || z === 'green_chain' ? z : 'model'))(pick<string>(planning, 'options.draft_zoning', 'model')),
      villaTarget,
      targetBuiltUpM2: targetBuaM2,
      builtUpM2: villaBua,
      grossLandM2,
      grossFsi: grossLandM2 > 0 ? villaBua / grossLandM2 : 0,
      plottedShare,
      plotScale,
      plotW,
      plotD,
      types: cat.types.map((t) => ({
        name: t.name,
        plotSft: t.plot_sft,
        buaSft: t.bua_sft,
        plotM2: areaOf(t, plotScale),
        count: plots.filter((p) => p.kind === t.name).length,
      })),
    },
    earthwork: delta,
    cutM3: cut,
    fillM3: fill,
    programme,
    land,
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

export const _test = { ringGap, platformFor, plateDims, ringArea, areaM2 };

/** A copy of a rules document with one dotted path set. */
export function withPath(doc: YamlDoc, path: string, value: unknown): YamlDoc {
  const out = structuredClone(doc) as Record<string, unknown>;
  const keys = path.split('.');
  let cur: Record<string, unknown> = out;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
  return out as YamlDoc;
}

/**
 * The plan with its villas sized to the category (owner 28 Sep): the plots are
 * cut as large as their type's range allows while the villa land still holds
 * the category's target (B the client's count, A the count the gross FSI
 * allows at its BUA, C the gross FSI's BUA). The point in the range is found by
 * halving; where even the smallest plots fall short, the plan says by how much.
 */
export function runPlanSized(input: PlanInput, analysis: AnalysisResult): PlanResult {
  const steps = pick<number>(input.planning, 'villas.sizing_steps', 6);
  const run = (s: number): PlanResult => runPlan({ ...input, planning: withPath(input.planning, 'villas.plot_scale', s) }, analysis);
  // The draft model's plots are set sizes, not ranges: nothing to search.
  if (pick<string>(input.planning, 'options.villa_sizing', 'A') === 'MIX') {
    const r = run(1);
    if (r.option.villaTarget > 0 && r.plots.length < r.option.villaTarget) {
      r.notes.push(`the villa zones hold ${r.plots.length} of the model's ${r.option.villaTarget} villas at its plot sizes`);
    }
    return r;
  }
  const meets = (r: PlanResult): boolean =>
    r.option.villaTarget > 0 ? r.plots.length >= r.option.villaTarget : r.option.builtUpM2 >= r.option.targetBuiltUpM2 * 0.999;
  let best = run(1);
  if (meets(best)) return best;
  const low = run(0);
  if (!meets(low)) {
    low.notes.push(
      low.option.villaTarget > 0
        ? `even the smallest plots give only ${low.plots.length} of ${low.option.villaTarget} villas on the villa land`
        : `even the smallest plots give only ${Math.round(low.option.builtUpM2 * 10.7639).toLocaleString('en-IN')} of ${Math.round(low.option.targetBuiltUpM2 * 10.7639).toLocaleString('en-IN')} sq ft of villa BUA`,
    );
    return low;
  }
  best = low;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < steps; k += 1) {
    const mid = (lo + hi) / 2;
    const r = run(mid);
    if (meets(r)) {
      lo = mid;
      best = r;
    } else hi = mid;
  }
  return best;
}
