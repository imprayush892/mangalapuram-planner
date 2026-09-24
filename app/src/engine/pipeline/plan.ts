import type { Dem } from '../terrain/dem';
import type { MultiPoly, Pt, Ring } from '../geom/types';
import type { SiteFeature } from '../site/types';
import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import { bufferPolyline } from '../geom/offset';
import { coverageFsi, highRise, gapBetweenBuildingsM } from '../rules/kmbr';
import type { Occupancy } from '../rules/kmbr';
import { sftToM2, M2_PER_ACRE } from '../units';
import type { AnalysisResult } from './analysis';
import { parseRatio } from './analysis';
import type { Mask } from './mask';
import { and, areaM2, count, dilate, distanceTo, emptyMask, erode, maskFrom, minus, or, patches, rasterise, toMulti } from './mask';
import { corridor, gradeLimitedProfile, lineLength, pathToLine, route } from './route';

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
  | 'batching'
  | 'reserved'
  | 'future'
  | 'open';
export type BuildingUse = 'school' | 'clubhouse' | 'senior' | 'apartments' | 'commercial' | 'batching';

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
  /** Main type (villas.built_area_sft) or the compact fill-in (villas.compact_built_area_sft). */
  kind: 'standard' | 'compact';
  /** Bearing the plot faces (towards its road), degrees clockwise from north. */
  facingDeg: number;
  roadId: string;
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
  areaM2: number;
  buildableM2: number;
  /** Taken from the zone: waterlogged at the planning storm's peak, Rule 22 slope, natural drains. */
  waterM2: number;
  steepM2: number;
  drainM2: number;
  roadsM2: number;
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
  /** Which of the four master-plan options this is, and the villa numbers behind it. */
  option: { villaSizing: 'rules' | 'count'; roads: 'terrain' | 'north_south'; villaTarget: number; plotW: number; plotD: number };
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
  /** The client's zoning plan, clipped to the parcel. */
  zones: { name: string; geom: MultiPoly; labelAc?: number }[];
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
  ring: Ring;
  f: Frame;
  a0: number;
  b0: number;
  w: number;
  d: number;
  road: RoadRec | null;
  zone: string;
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
  private at(r: Ring): [number, number] {
    const cx = r.reduce((s, p) => s + p[0], 0) / r.length;
    const cy = r.reduce((s, p) => s + p[1], 0) / r.length;
    return [Math.floor(cx / this.size), Math.floor(cy / this.size)];
  }
  add(r: Ring): void {
    const [i, j] = this.at(r);
    const k = `${i},${j}`;
    const list = this.cells.get(k);
    if (list) list.push(r);
    else this.cells.set(k, [r]);
  }
  overlaps(r: Ring): boolean {
    const [i, j] = this.at(r);
    for (let di = -1; di <= 1; di += 1) {
      for (let dj = -1; dj <= 1; dj += 1) {
        for (const o of this.cells.get(`${i + di},${j + dj}`) ?? []) if (rectsOverlap(o, r)) return true;
      }
    }
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
    return { name: z.name, use: zoneUse(z.name), mask, cells, areaM2: cells.length * cellArea, labelAc: z.labelAc };
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
        const m = rasterise(dem, bufferPolyline(line, exW));
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

  /* ----------------------------------------------------------- roads */
  const roads: RoadRec[] = [];
  const network: Mask = Uint8Array.from(L.existingRoads.mask);
  const scratch = new Float32Array(n);
  const addRoad = (tier: Exclude<RoadTier, 'existing'>, line: Pt[], why: string, row = false): RoadRec | null => {
    if (line.length < 2 || lineLength(line) < 4) return null;
    const prof = gradeLimitedProfile(dem, line, lim[tier]);
    const cor = corridor(dem, line, width[tier], prof, scratch);
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
      widthM: width[tier],
      geom: bufferPolyline(line, width[tier]),
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
  const minPiece = num(planning, 'roads.primary_serves_pieces_over_m2');
  let unreached = 0;
  const zoneOrder = zones
    .filter((z) => z.use !== 'reserved' && z.use !== 'future' && z.use !== 'open' && z.cells.length > 0)
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
  const vFsi = num(planning, 'villas.fsi');
  const villaSizing = (pick<string>(planning, 'options.villa_sizing', 'rules') === 'count' ? 'count' : 'rules') as 'rules' | 'count';
  const countPlot = pick<{ w: number; d: number } | null>(planning, 'villas.count_plot', null);
  const byCount = villaSizing === 'count' && countPlot !== null;
  const plotW = byCount ? countPlot!.w : num(planning, 'villas.min_plot_side_m');
  const mainMinM2 = sftToM2(num(planning, 'villas.built_area_sft.min')) / vFsi;
  const mainMaxM2 = sftToM2(num(planning, 'villas.built_area_sft.max')) / vFsi;
  const compactMinM2 = sftToM2(num(planning, 'villas.compact_built_area_sft.min')) / vFsi;
  const compactMaxM2 = sftToM2(num(planning, 'villas.compact_built_area_sft.max')) / vFsi;
  const designM2 = sftToM2(num(planning, 'villas.design_built_area_sft')) / vFsi;
  const plotD = byCount ? countPlot!.d : Math.max(plotW, designM2 / plotW);
  const mainMinD = byCount ? countPlot!.d : Math.max(plotW, mainMinM2 / plotW + 0.01);
  const mainMaxD = byCount ? countPlot!.d : mainMaxM2 / plotW;
  const depthsMain = byCount ? [countPlot!.d] : [...new Set([plotD, (plotD + mainMinD) / 2, mainMinD])].filter((d) => d >= plotW && d <= mainMaxD + 1e-9);
  const compactD = Math.max(plotW, compactMinM2 / plotW);
  const depthsCompact = !byCount && compactD <= compactMaxM2 / plotW + 1e-9 && compactD < mainMinD ? [compactD] : [];
  // Owner 25 Sep: the villa count is the programme's density on the villa zones' own area.
  const perAcre = pick<number>(planning, 'villas.count_basis.programme_units', 700) / pick<number>(planning, 'villas.count_basis.programme_land_ac', 35);
  const villaTarget = Math.round(zones.filter((z) => z.use === 'villas').reduce((sum, z) => sum + (z.labelAc ?? z.areaM2 / M2_PER_ACRE), 0) * perAcre);
  const gfShare = num(planning, 'villas.ground_floor_share_of_plot');
  const ffShare = num(planning, 'villas.first_floor_share_of_plot');
  const vfh = num(planning, 'villas.floor_height_m');
  const tw = width.tertiary;

  /* ------------------------------------- 8c streets in the villa zones */
  const minBlock = num(planning, 'plotable.min_area_m2');
  const crossEvery = num(planning, 'roads.cross_street_every_plots');
  const pitch = 2 * plotD + tw + 0.5;
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
  for (const z of villaZones) {
    for (const piece of patches(dem, zoneLand(z))) {
      if (piece.length * cellArea < minBlock) continue;
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
      // Cross streets up the slope, at the angle whose rise is the secondary limit.
      const g = zoneGrade(dem, piece);
      const sinA = roadMode === 'north_south' ? 1 : g > lim.secondary ? lim.secondary / g : 1;
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
        : sinA < 1
          ? `cross street every ${crossEvery} plots, climbing at ${Math.round((Math.asin(sinA) * 180) / Math.PI)}° to the contours so the ${(g * 100).toFixed(0)}% ground rises at 1:${Math.round(1 / lim.secondary)}`
          : `cross street every ${crossEvery} plots, straight up ground gentler than the limit`;
      for (let m = 1; m < cols; m += 1) {
        const wc = w0 + m * crossPitch;
        let start = Number.NaN;
        for (let y = vmin - 1; y <= vmax + 2; y += 1) {
          const inside = inP(wc + y * cot, y);
          if (inside && Number.isNaN(start)) start = y;
          if ((!inside || y > vmax + 1) && !Number.isNaN(start)) {
            if (y - start >= 20) {
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
        inP(u, vs + s * (tw / 2 + 0.6)) && inP(u, vs + s * (tw / 2 + mainMinD / 2)) && inP(u, vs + s * (tw / 2 + mainMinD - 0.6));
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
            const a0 = start;
            const a1 = u - 1;
            start = Number.NaN;
            if (a1 - a0 < plotW) continue;
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
    const linkCost = Float32Array.from(baseCost);
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

  /* ---------------------------------- 9 villa plots along every road */
  const segIndex = new SegIndex(25);
  for (const line of existingLines) segIndex.addLine(line, exWidth / 2);
  for (const r of roads) if (r.kept) segIndex.addLine(r.centreline, r.widthM / 2);
  const clearOfRoads = (ring: Ring): boolean => {
    for (const sg of segIndex.near(ring)) if (ringSegmentGap(ring, sg.a, sg.b) < sg.half - 0.05) return false;
    return true;
  };
  const plotLand = or(villaLand, and(network, villaZoneMask));
  const landOk = (smp: readonly { p: Pt }[]): boolean => {
    for (const q of smp) {
      const cc = dem.cellAt(q.p);
      if (!cc || !plotLand[cc.j * nx + cc.i]) return false;
    }
    return true;
  };
  const drafts: DraftPlot[] = [];
  const plotIndex = new RingIndex(25);
  const tryPlot = (f: Frame, a0: number, b0: number, d: number, road: RoadRec | null): boolean => {
    const ring = rectRing(f, a0, a0 + plotW, b0, b0 + d);
    const centre = toWorld(f, a0 + plotW / 2, b0 + d / 2);
    const cc = dem.cellAt(centre);
    if (!cc || !villaLand[cc.j * nx + cc.i]) return false;
    if (!landOk(rectSamples(f, a0, a0 + plotW, b0, b0 + d, 1.5))) return false;
    if (plotIndex.overlaps(ring) || !clearOfRoads(ring)) return false;
    plotIndex.add(ring);
    const zi = zoneOf[cc.j * nx + cc.i]!;
    const facingDeg = (((Math.atan2(-f.v[0], -f.v[1]) * 180) / Math.PI) + 360) % 360;
    drafts.push({ ring, f, a0, b0, w: plotW, d, road, zone: zi >= 0 ? zones[zi]!.name : '', facingDeg });
    if (road) road.plots += 1;
    return true;
  };
  const fillAlong = (line: readonly Pt[], half: number, road: RoadRec | null): void => {
    const off = half + 0.25;
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
          let placed = false;
          for (const d of [...depthsMain, ...depthsCompact]) {
            if (tryPlot(f, a0, off, d, road)) {
              placed = true;
              break;
            }
          }
          x += placed ? plotW : 1;
        }
      }
    }
  };
  // The villa streets first (they were laid for plots), then every other road.
  for (const r of roads) if (r.kept && r.row) fillAlong(r.centreline, r.widthM / 2, r);
  for (const r of roads) if (r.kept && !r.row) fillAlong(r.centreline, r.widthM / 2, r);
  for (const line of existingLines) fillAlong(line, exWidth / 2, null);

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
  const candidatesIn = (land: Mask, dims: { L: number; D: number }, inset: number): Cand[] => {
    const cells = cellsOf(land);
    if (cells.length === 0) return [];
    const f = frameFor(dem, cells);
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
  ): { floors: number; wings: Placed[]; wingPlate: number; key: string; coverage: number } | null => {
    const cf = coverageFsi(input.kmbr, occ);
    const land = siteLand(z);
    let floors = Math.max(1, fromFloors);
    while (floors < maxFloors && buaM2 / floors > (cf.coveragePct / 100) * z.areaM2) floors += 1;
    for (; floors <= maxFloors; floors += 1) {
      const plate = buaM2 / floors;
      const nW = Math.max(1, Math.ceil(plate / plateMax));
      const wingPlate = plate / nW;
      for (const asp of aspects) {
        const wings = pickCompact(candidatesIn(land, plateDims(wingPlate, asp), setback), nW, wingGap);
        if (wings.length === nW) return { floors, wings, wingPlate, key: cf.key, coverage: cf.coveragePct };
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
    if (z.use === 'senior' && seniorLeft > 0) {
      let got: Placed[] = [];
      for (const asp of [sen.aspect, ...aspects.filter((x) => x !== sen.aspect)]) {
        const g = pickCompact(candidatesIn(siteLand(z), plateDims(senPlate, asp), sen.setback), seniorLeft, sen.clear);
        if (g.length > got.length) got = g;
      }
      for (const pl of got) {
        const u = Math.min(senPerBuilding, seniorUnits - (senNeeded - seniorLeft) * senPerBuilding);
        seniorLeft -= 1;
        draftsB.push({
          zone: z,
          use: 'senior',
          placed: pl,
          footprintM2: senPlate,
          floors: sen.floors,
          floorH: sen.fh,
          units: Math.max(0, u),
          builtUpM2: senPlate * sen.floors,
          notes: [
            `${u} units: ${sen.upf} a floor × ${sen.floors} floors (G+${sen.floors - 1}); plate ${senPlate.toFixed(0)} m² = ${sen.upf} × ${sft(seniorPlinthM2)} sq ft ÷ ${sen.eff}`,
            `in the client's ${z.name} zone, grouped; ${sen.clear} m clear of the others`,
          ],
          flat: true,
        });
      }
    }
    if (z.use === 'school' && schoolBuaM2 > 0 && !draftsB.some((b) => b.use === 'school')) {
      const fit = fitAmenity(z, 'B_school', schoolBuaM2, 4, wingMax, amenitySetback);
      if (!fit) notes.push(`the school's ${sft(schoolBuaM2)} sq ft does not fit in the ${z.name} zone's buildable land`);
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
              `wing ${i + 1} of ${fit.wings.length}: ${sft(schoolBuaM2)} sq ft in all over ${fit.floors} floors, one campus`,
              `${fit.key}: coverage up to ${fit.coverage}%; wings ${wingGap} m apart (planning_rules.yaml amenities)`,
            ],
            flat: true,
          }),
        );
      }
    }
    if (z.use === 'clubhouse' && clubBuaM2 > 0 && !draftsB.some((b) => b.use === 'clubhouse')) {
      const fit = fitAmenity(z, 'D1_recreational', clubBuaM2, pick<number>(planning, 'clubhouse.max_floors', 2), wingMax, amenitySetback);
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
              `wing ${i + 1} of ${fit.wings.length}: ${sft(clubBuaM2)} sq ft in all over ${fit.floors} floors`,
              `${fit.key}: coverage up to ${fit.coverage}%; the golf course lies round it`,
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
    if (z.use === 'apartments' && (aptUnitsLeft > 0 || towersFor(z.name))) {
      const zoneTowers = towersFor(z.name);
      // Towers on the lower ground, spread over the zone, none in another's
      // view, each under the airport height limit, within FSI on the zone.
      /** Towers of one plan shape: lower ground first, spread, staggered, under the airport limit. */
      const planTowers = (dims: { L: number; D: number }, viewW: number): DraftBuilding[] => {
        const out: DraftBuilding[] = [];
        let unitsLeft = zoneTowers ? Number.POSITIVE_INFINITY : aptUnitsLeft;
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
        const cands = candidatesIn(siteLand(z), dims, apt.setback + P);
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
          if (!best && zoneTowers && fallback) {
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
  if (seniorLeft > 0) notes.push(`${seniorLeft} senior buildings (G+${sen.floors - 1}) do not fit in the senior living zone's buildable land`);

  // A drive to every building that no road reaches.
  const reachM = 12;
  for (const b of draftsB) {
    const ring = b.podium?.ring ?? b.placed.ring;
    const own = rasterise(dem, [[ring]]);
    const near = cellsOf(dilate(dem, own, reachM));
    if (nearNetwork(near, 0)) continue;
    const target = and(dilate(dem, own, 3), terrain);
    const cost = Float32Array.from(baseCost);
    for (let k = 0; k < n; k += 1) if (target[k]) cost[k] = Math.min(Number.isFinite(cost[k]!) ? cost[k]! : 5, 5);
    const r = route({ dem, cost, grade: lim.secondary, overGradePenalty: penalty, sources: networkCells(), targets: target, dirWeight });
    if (!r.path) {
      notes.push(`no drive can be built to a ${b.use} building in ${b.zone.name}`);
      continue;
    }
    const rd = addRoad('secondary', lineOf(r.path), `drive to the ${b.use} building${b.use === 'apartments' ? "'s podium" : ''} in ${b.zone.name}`);
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
  // Sizing by count: plots beyond the target go, the steepest first.
  if (byCount && keptDrafts.length > villaTarget) {
    const gAt = (p: DraftPlot): number => {
      const c0 = toWorld(p.f, p.a0 + p.w / 2, p.b0 + p.d / 2);
      const cc = dem.cellAt(c0);
      return cc ? analysis.gradient[cc.j * nx + cc.i] ?? 0 : 0;
    };
    const surplus = [...keptDrafts].sort((a, b) => gAt(b) - gAt(a)).slice(0, keptDrafts.length - villaTarget);
    const gone = new Set(surplus);
    for (const p of surplus) if (p.road) p.road.plots -= 1;
    const keep = keptDrafts.filter((p) => !gone.has(p));
    keptDrafts.length = 0;
    keptDrafts.push(...keep);
  }
  if (keptDrafts.length < drafts.length) notes.push(`${drafts.length - keptDrafts.length} plots on streets taken out went with them`);

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
  const plots: PlanPlot[] = keptDrafts.map((d, i) => {
    const smp = rectSamples(d.f, d.a0, d.a0 + d.w, d.b0, d.b0 + d.d, 1);
    const pf = platformFor(dem, smp, plotLimit, delta);
    const area = d.w * d.d;
    const centre = toWorld(d.f, d.a0 + d.w / 2, d.b0 + d.d / 2);
    const cc = dem.cellAt(centre);
    const bi = cc ? blockOf[cc.j * nx + cc.i]! : -1;
    return {
      id: `P${i + 1}`,
      blockId: bi >= 0 ? blocks[bi]!.id : '',
      zone: d.zone,
      kind: byCount || area >= mainMinM2 - 0.5 ? 'standard' : 'compact',
      facingDeg: d.facingDeg,
      roadId: '',
      ring: d.ring,
      areaM2: area,
      widthM: d.w,
      depthM: d.d,
      platform: platformOnly(pf),
      baseRl: pf.level(d.a0 + d.w / 2, d.b0 + d.d / 2),
      groundFloor: scaleRing(d.ring, Math.sqrt(gfShare)),
      upperFloor: scaleRing(d.ring, Math.sqrt(ffShare)),
      builtUpM2: area * (gfShare + ffShare),
      fsi: gfShare + ffShare,
      floorHeightM: vfh,
    };
  });

  const counters: Record<BuildingUse, number> = { school: 0, clubhouse: 0, senior: 0, apartments: 0, commercial: 0, batching: 0 };
  const prefix: Record<BuildingUse, string> = { school: 'SCH', clubhouse: 'CLUB', senior: 'S', apartments: 'T', commercial: 'COM', batching: 'BP' };
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
    if (z.cells.length === 0 || z.use === 'open' || z.use === 'reserved' || z.use === 'future') continue;
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
        fsi: gfShare + ffShare,
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
  const zoneReports: ZoneReport[] = zones.filter((z) => z.cells.length > 0).map((z) => {
    const inZ = (m: Mask): number => {
      let s = 0;
      for (const k of z.cells) if (m[k]) s += 1;
      return s * cellArea;
    };
    const ps = plots.filter((p) => p.zone === z.name);
    const bs = buildings.filter((b) => b.zone === z.name);
    let holds: string;
    if (z.use === 'villas') {
      const std = ps.filter((p) => p.kind === 'standard').length;
      holds = `${ps.length} villa plots (${std} standard, ${ps.length - std} compact)`;
    } else if (z.use === 'reserved') holds = 'reserved (hospital, deferred)';
    else if (z.use === 'future') holds = 'future phase, not planned now';
    else if (z.use === 'clubhouse') holds = `${bs.length} clubhouse wings; golf ${ac(inZ(golf))} in the zone`;
    else if (bs.length === 0) holds = z.cells.length === 0 ? 'outside the parcel' : 'nothing placed';
    else {
      const u = bs.reduce((s, b) => s + b.units, 0);
      holds = `${bs.length} buildings${u > 0 ? `, ${u} units` : ''}, ${sft(bs.reduce((s, b) => s + b.builtUpM2, 0))} sq ft built up`;
    }
    return {
      name: z.name,
      use: z.use,
      areaM2: z.areaM2,
      buildableM2: inZ(buildable),
      waterM2: inZ(L.waterlogging.mask),
      steepM2: inZ(minus(L.nonBuildable.mask, L.waterlogging.mask)),
      drainM2: inZ(minus(L.drains.mask, L.waterlogging.mask, L.nonBuildable.mask)),
      roadsM2: inZ(newRoadMask),
      holds,
    };
  });

  /* ------------------------------------------------------ programme */
  const std = plots.filter((p) => p.kind === 'standard').length;
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
      asked: `${villaUnits} units`,
      placed: `${plots.length} plots`,
      met: plots.length >= villaUnits,
      note: `${std} standard (${sft(mainMinM2)}-${sft(mainMaxM2)} sq ft), ${plots.length - std} compact (${sft(compactD * plotW)} sq ft); in the villa and phase zones`,
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
  const unzoned = ['hotel', 'office'].filter((u) => byUse(u).length > 0);
  if (unzoned.length > 0) {
    programme.push({
      use: 'Not placed',
      asked: unzoned.map((u) => (u === 'office' ? 'business hub' : u)).join(', '),
      placed: '—',
      met: false,
      note: 'the client zoning plan has no zone for them',
    });
  }
  if (byUse('hospital').length > 0) {
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
    option: { villaSizing, roads: roadMode, villaTarget, plotW, plotD },
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

export const _test = { ringGap, platformFor, plateDims, ringArea, areaM2 };

/** A copy of a rules document with one dotted path set. */
function withPath(doc: YamlDoc, path: string, value: unknown): YamlDoc {
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
 * Villas sized by count (owner 25 Sep): the villa zones carry the programme's
 * density on their own area, and the plot is the largest that still fits that
 * many. Plot area is searched by halving; the shape keeps the client's
 * proportion (at most 1:2.5) and depth.
 */
export function runPlanToCount(input: PlanInput, analysis: AnalysisResult): PlanResult {
  const sz = pick<{ max_aspect: number; max_depth_m: number; min_width_m: number; min_area_m2: number; max_area_m2: number; steps: number }>(input.planning, 'villas.count_sizing', {
    max_aspect: 2.5,
    max_depth_m: 18,
    min_width_m: 6,
    min_area_m2: 80,
    max_area_m2: 280,
    steps: 7,
  });
  const dims = (a: number): { w: number; d: number } => {
    const d = Math.min(sz.max_depth_m, Math.sqrt(sz.max_aspect * a));
    const w = Math.max(sz.min_width_m, a / d);
    return { w, d: a / w };
  };
  const base = withPath(input.planning, 'options.villa_sizing', 'count');
  const run = (a: number): PlanResult => runPlan({ ...input, planning: withPath(base, 'villas.count_plot', dims(a)) }, analysis);
  let lo = sz.min_area_m2;
  let hi = sz.max_area_m2;
  let best = run(lo);
  const target = best.option.villaTarget;
  if (best.plots.length < target) {
    best.notes.push(`even ${lo} m² plots give only ${best.plots.length} of ${target} villas on the villa zones`);
    return best;
  }
  for (let s = 0; s < sz.steps; s += 1) {
    const mid = (lo + hi) / 2;
    const r = run(mid);
    if (r.plots.length >= target) {
      lo = mid;
      best = r;
    } else hi = mid;
  }
  return best;
}
