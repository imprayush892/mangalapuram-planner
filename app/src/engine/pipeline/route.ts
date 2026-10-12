import type { Dem } from '../terrain/dem';
import type { Pt } from '../geom/types';
import type { Mask } from './mask';
import { dilate, emptyMask } from './mask';
import { pick } from '../data/config';

/**
 * Road routing on the DEM grid.
 *
 * A least-cost path over the 8-connected 2 m grid. Every step costs its length
 * times the average cost of the two cells (plotable land 1, public space more,
 * waterlogged ground and drains much more, Rule 22 ground impassable) plus a
 * penalty that grows with the square of how far the step's gradient goes over
 * the road's limit. The limit is therefore soft: a road keeps within it
 * wherever the ground allows, and where it cannot it takes the least-bad line
 * and the grade-limited profile below says how much cut and fill that costs.
 */

const STEPS: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export interface RouteRequest {
  dem: Dem;
  /** Cost per cell; Infinity = impassable. */
  cost: Float32Array;
  /** Rise over run the road should keep within (0.125 = 1:8). */
  grade: number;
  /** Penalty weight per metre for a step at twice the limit. */
  overGradePenalty: number;
  sources: Iterable<number>;
  /** Stop at the first of these reached. Omit to explore everything reachable. */
  targets?: Mask;
  /**
   * Cost multiplier for a step in direction (di, dj), grid columns east and rows
   * north: how a road is steered to an orientation (north-south roads). 1 = none.
   */
  dirWeight?: (di: number, dj: number) => number;
}

export interface RouteResult {
  /** Cells from a source to the target reached, or null. */
  path: number[] | null;
  /** Cost from the nearest source to each cell (Infinity where unreached). */
  dist: Float64Array;
  prev: Int32Array;
}

export function route(req: RouteRequest): RouteResult {
  const { dem, cost } = req;
  const { nx, ny } = dem.meta;
  const n = nx * ny;
  const z = dem.values;
  const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heapK: number[] = [];
  const heapD: number[] = [];
  const push = (k: number, d: number): void => {
    heapK.push(k);
    heapD.push(d);
    let i = heapK.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapD[p]! <= heapD[i]!) break;
      [heapK[p], heapK[i]] = [heapK[i]!, heapK[p]!];
      [heapD[p], heapD[i]] = [heapD[i]!, heapD[p]!];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heapK[0]!;
    const lk = heapK.pop()!;
    const ld = heapD.pop()!;
    if (heapK.length > 0) {
      heapK[0] = lk;
      heapD[0] = ld;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heapK.length && heapD[l]! < heapD[s]!) s = l;
        if (r < heapK.length && heapD[r]! < heapD[s]!) s = r;
        if (s === i) break;
        [heapK[s], heapK[i]] = [heapK[i]!, heapK[s]!];
        [heapD[s], heapD[i]] = [heapD[i]!, heapD[s]!];
        i = s;
      }
    }
    return top;
  };

  for (const s of req.sources) {
    if (!Number.isFinite(cost[s]!) || !Number.isFinite(z[s]!)) continue;
    dist[s] = 0;
    push(s, 0);
  }
  const cell = dem.cell;
  while (heapK.length > 0) {
    const k = pop();
    if (done[k]) continue;
    done[k] = 1;
    if (req.targets && req.targets[k]) {
      const path: number[] = [];
      for (let c = k; c >= 0; c = prev[c]!) path.push(c);
      return { path: path.reverse(), dist, prev };
    }
    const i = k % nx;
    const j = (k - i) / nx;
    const dk = dist[k]!;
    for (const [di, dj] of STEPS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nk = nj * nx + ni;
      if (done[nk]) continue;
      const cn = cost[nk]!;
      if (!Number.isFinite(cn)) continue;
      const zn = z[nk]!;
      if (!Number.isFinite(zn)) continue;
      const len = cell * (di !== 0 && dj !== 0 ? Math.SQRT2 : 1);
      const g = Math.abs(zn - z[k]!) / len;
      let step = len * (cost[k]! + cn) * 0.5 * (req.dirWeight ? req.dirWeight(di, dj) : 1);
      if (g > req.grade) {
        const over = (g - req.grade) / req.grade;
        step += len * req.overGradePenalty * over * over;
      }
      const nd = dk + step;
      if (nd < dist[nk]!) {
        dist[nk] = nd;
        prev[nk] = k;
        push(nk, nd);
      }
    }
  }
  return { path: null, dist, prev };
}

/** Walks `prev` back from `to`. */
export function backtrack(prev: Int32Array, to: number): number[] {
  const path: number[] = [];
  for (let c = to; c >= 0; c = prev[c]!) path.push(c);
  return path.reverse();
}

/** Cell path to a polyline through the cell centres, simplified (Douglas-Peucker). */
export function pathToLine(dem: Dem, path: readonly number[], tolerance = 1.5): Pt[] {
  const { nx } = dem.meta;
  const pts: Pt[] = path.map((k) => dem.cellCentre(k % nx, Math.floor(k / nx)));
  return simplify(pts, tolerance);
}

export function simplify(pts: readonly Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return [...pts];
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const A = pts[a]!;
    const B = pts[b]!;
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const L = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i += 1) {
      const P = pts[i]!;
      const d = Math.abs((P[0] - A[0]) * dy - (P[1] - A[1]) * dx) / L;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export const lineLength = (line: readonly Pt[]): number => {
  let L = 0;
  for (let i = 1; i < line.length; i += 1) L += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
  return L;
};

/** Points every `step` metres along a polyline, with their chainage. */
export function stations(line: readonly Pt[], step: number): { p: Pt; s: number }[] {
  const out: { p: Pt; s: number }[] = [];
  if (line.length === 0) return out;
  out.push({ p: line[0]!, s: 0 });
  let s = 0;
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / step));
    for (let t = 1; t <= n; t += 1) {
      out.push({ p: [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n], s: s + (L * t) / n });
    }
    s += L;
  }
  return out;
}

export interface RoadProfile {
  s: number[];
  terrain: number[];
  design: number[];
  /** Steepest terrain gradient over any 10 m along the line. */
  terrainMaxGrade: number;
  designMaxGrade: number;
  /** Where `corridor` records the road's finished levels (least_earthwork with RoadLevels only). */
  levels?: RoadLevels;
}

/**
 * The road's vertical profile: the ground along the centreline, and the design
 * line nearest it that never exceeds `grade` — a forward pass then a backward
 * pass, each holding the line within grade of its neighbour. Where the ground
 * is already within grade the two are the same and there is no earthwork.
 */
export function gradeLimitedProfile(dem: Dem, line: readonly Pt[], grade: number, step = 2, opts?: ProfileOptions): RoadProfile {
  if (opts?.mode === 'least_earthwork') return leastEarthworkProfile(dem, line, grade, step, opts);
  const st = stations(line, step);
  const s = st.map((x) => x.s);
  const terrain = centrelineTerrain(dem, st);
  const design = terrain.slice();
  for (let i = 1; i < design.length; i += 1) {
    const d = (s[i]! - s[i - 1]!) * grade;
    design[i] = Math.min(design[i - 1]! + d, Math.max(design[i - 1]! - d, design[i]!));
  }
  for (let i = design.length - 2; i >= 0; i -= 1) {
    const d = (s[i + 1]! - s[i]!) * grade;
    design[i] = Math.min(design[i + 1]! + d, Math.max(design[i + 1]! - d, design[i]!));
  }
  return { s, terrain, design, terrainMaxGrade: maxGradeOver(s, terrain, 10), designMaxGrade: maxGradeOver(s, design, 10) };
}

/** Ground along the stations; an unsurveyed station takes its neighbour's level. */
function centrelineTerrain(dem: Dem, st: readonly { p: Pt }[]): number[] {
  const terrain = st.map((x) => dem.sampleBilinear(x.p));
  for (let i = 0; i < terrain.length; i += 1) {
    if (!Number.isFinite(terrain[i]!)) terrain[i] = i > 0 ? terrain[i - 1]! : Number.NaN;
  }
  for (let i = terrain.length - 2; i >= 0; i -= 1) {
    if (!Number.isFinite(terrain[i]!)) terrain[i] = terrain[i + 1]!;
  }
  return terrain;
}

/** Steepest gradient of `zs` over any `window` metres of chainage `s`. */
function maxGradeOver(s: readonly number[], zs: readonly number[], window: number): number {
  let m = 0;
  let j = 0;
  for (let i = 0; i < zs.length; i += 1) {
    while (j < zs.length && s[j]! - s[i]! < window) j += 1;
    if (j >= zs.length) break;
    m = Math.max(m, Math.abs(zs[j]! - zs[i]!) / (s[j]! - s[i]!));
  }
  return m;
}

/* ------------------------------------------------ least-earthwork profile */

export type ProfileMode = 'grade_limited' | 'least_earthwork';

export interface ProfileOptions {
  /** 'grade_limited' (default): the forward/backward pass above. 'least_earthwork': the cheapest line within grade. */
  mode: ProfileMode;
  /** Carriageway width the earthwork is taken over (m). */
  widthM: number;
  /** Rs a m³ of cut (design below the ground) and of fill (design above it). */
  cutRs: number;
  fillRs: number;
  /** Rs a metre of road, per side, for each metre the verge steps from the ground beyond `wallFreeM` (0 = no wall term). */
  wallRsPerM: number;
  /** A step at the verge up to this is graded, not walled (m). */
  wallFreeM: number;
  /** Design levels the road must meet at its first / last station (a junction already fixed). */
  fixedStart?: number;
  fixedEnd?: number;
  /**
   * The finished levels of the roads laid so far: an end of this road that meets one
   * takes its level (unless fixedStart / fixedEnd say otherwise), and `corridor`
   * adds this road's levels to it.
   */
  levels?: RoadLevels;
}

/**
 * The finished level of every road cell laid so far (NaN off the roads). Built
 * roads are kept as they are, at the ground; a new road's corridor writes its
 * design levels, the larger cut or fill winning where corridors overlap (as the
 * plan merges the roads' earthwork).
 */
export class RoadLevels {
  readonly level: Float32Array;
  constructor(private readonly dem: Dem, builtRoads?: Mask) {
    this.level = new Float32Array(dem.values.length).fill(Number.NaN);
    if (builtRoads) for (let k = 0; k < builtRoads.length; k += 1) if (builtRoads[k]) this.level[k] = dem.values[k]!;
  }
  /** The level of the road cell nearest `p` within `r` cells, or undefined. */
  at(p: Pt, r = 1): number | undefined {
    const c = this.dem.cellAt(p);
    if (!c) return undefined;
    const { nx, ny } = this.dem.meta;
    let best = Number.POSITIVE_INFINITY;
    let out: number | undefined;
    for (let dj = -r; dj <= r; dj += 1) {
      for (let di = -r; di <= r; di += 1) {
        const i = c.i + di;
        const j = c.j + dj;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const v = this.level[j * nx + i]!;
        if (!Number.isFinite(v)) continue;
        const cc = this.dem.cellCentre(i, j);
        const d = Math.hypot(cc[0] - p[0], cc[1] - p[1]);
        if (d < best) {
          best = d;
          out = v;
        }
      }
    }
    return out;
  }
  record(k: number, lv: number): void {
    const z = this.dem.values[k]!;
    const cur = this.level[k]!;
    if (!Number.isFinite(cur) || Math.abs(lv - z) > Math.abs(cur - z)) this.level[k] = lv;
  }
}

/**
 * Profile options from the rules: roads.profile_mode (planning_rules.yaml) and
 * the earthwork and wall rates (assumptions.yaml earthwork_costs). The wall
 * term is the convex stand-in for the RCC wall a verge step needs: nothing up to
 * wall_min_step_m, then rising at the chord of the a*H + b*H^2 concrete between
 * that step and a metre more.
 */
export function profileOptions(planning: unknown, assumptions: unknown, widthM: number, levels?: RoadLevels): ProfileOptions {
  const mode: ProfileMode = pick<string>(planning, 'roads.profile_mode', 'grade_limited') === 'least_earthwork' ? 'least_earthwork' : 'grade_limited';
  const ewc = (k: string, d: number): number => pick<number>(assumptions, `earthwork_costs.${k}`, d);
  const [wa, wb] = pick<[number, number]>(assumptions, 'earthwork_costs.wall_concrete_m3_per_m', [0.38, 0.04]);
  const h0 = ewc('wall_min_step_m', 0.5);
  const h1 = h0 + 1;
  const wallRsPerM = ewc('rcc_wall_rs_per_m3', 21500) * (wa * h1 + wb * h1 * h1);
  return { mode, widthM, cutRs: ewc('excavation_rs_per_m3', 350), fillRs: ewc('backfill_rs_per_m3', 300), wallRsPerM, wallFreeM: h0, levels };
}

/** Stations as `stations` makes them, each with the unit direction of the segment it lies on. */
function stationsWithDir(line: readonly Pt[], step: number): { p: Pt; s: number; u: Pt }[] {
  const out: { p: Pt; s: number; u: Pt }[] = [];
  if (line.length === 0) return out;
  if (line.length === 1) return [{ p: line[0]!, s: 0, u: [1, 0] }];
  let s = 0;
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u: Pt = L > 0 ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [1, 0];
    if (i === 1) out.push({ p: a, s: 0, u });
    const n = Math.max(1, Math.ceil(L / step));
    for (let t = 1; t <= n; t += 1) {
      out.push({ p: [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n], s: s + (L * t) / n, u });
    }
    s += L;
  }
  return out;
}

/** Weighted breakpoints in a heap (max-heap for sign 1, min-heap for -1), all shifted by `shift`. */
class Breaks {
  private readonly x: number[] = [];
  private readonly w: number[] = [];
  shift = 0;
  constructor(private readonly sign: 1 | -1) {}
  get size(): number {
    return this.x.length;
  }
  top(): number {
    return this.x[0]! + this.shift;
  }
  topW(): number {
    return this.w[0]!;
  }
  setTopW(w: number): void {
    this.w[0] = w;
  }
  push(xAbs: number, w: number): void {
    const { x, sign } = this;
    x.push(xAbs - this.shift);
    this.w.push(w);
    let i = x.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (sign * (x[p]! - x[i]!) >= 0) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): void {
    const { x, w, sign } = this;
    const lx = x.pop()!;
    const lw = w.pop()!;
    if (x.length === 0) return;
    x[0] = lx;
    w[0] = lw;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let b = i;
      if (l < x.length && sign * (x[l]! - x[b]!) > 0) b = l;
      if (r < x.length && sign * (x[r]! - x[b]!) > 0) b = r;
      if (b === i) break;
      this.swap(i, b);
      i = b;
    }
  }
  private swap(i: number, j: number): void {
    const { x, w } = this;
    [x[i], x[j]] = [x[j]!, x[i]!];
    [w[i], w[j]] = [w[j]!, w[i]!];
  }
}

/**
 * The least-earthwork profile: design levels z_i that minimise
 *   sum_i ds_i * [ across the carriageway, cutRs * cut + fillRs * fill
 *                  + each side, wallRsPerM * (verge step from the ground beyond wallFreeM) ]
 * subject to |z_{i+1} - z_i| <= grade * (s_{i+1} - s_i), and meeting fixedStart /
 * fixedEnd where given. Every term is convex and piecewise linear in z, so the
 * dynamic programme over the stations is exact on continuous levels (the "slope
 * trick"): the cost-to-here is two heaps of weighted breakpoints either side of
 * its minimum, the grade limit shifts the lower heap down and the upper one up by
 * grade * ds, and the levels come back by walking backwards, each station taking
 * the part of its best range that the next station's level allows (the level
 * nearest the ground on a tie). O(n log n) in the stations.
 *
 * The ground is sampled across the carriageway about every cell and on the ground
 * just beyond each verge, so cross-fall counts as `corridor` counts it.
 */
export function leastEarthworkProfile(dem: Dem, line: readonly Pt[], grade: number, step: number, opts: ProfileOptions): RoadProfile {
  const st = stationsWithDir(line, step);
  const s = st.map((x) => x.s);
  const terrain = centrelineTerrain(dem, st);
  const n = st.length;
  if (n === 0 || !Number.isFinite(terrain[0]!)) {
    return { s, terrain, design: terrain.slice(), terrainMaxGrade: 0, designMaxGrade: 0 };
  }
  const w = Math.max(0, opts.widthM);
  const m = Math.max(1, Math.round(w / dem.cell));
  const verge = w / 2 + dem.cell / 2;
  const lower = new Breaks(1);
  const upper = new Breaks(-1);
  const EPS = 1e-9;
  /** Moves weight `amt` from the top of `from` to `to`. */
  const spill = (from: Breaks, to: Breaks, amt: number): void => {
    let rem = amt;
    while (rem > EPS && from.size > 0) {
      const x = from.top();
      const tw = from.topW();
      if (tw <= rem + EPS) {
        from.pop();
        to.push(x, tw);
        rem -= tw;
      } else {
        from.setTopW(tw - rem);
        to.push(x, rem);
        rem = 0;
      }
    }
  };
  /** Adds a * max(0, z - t). */
  const addAbove = (t: number, a: number): void => {
    if (!(a > 0)) return;
    if (lower.size === 0 || t >= lower.top()) upper.push(t, a);
    else {
      lower.push(t, a);
      spill(lower, upper, a);
    }
  };
  /** Adds b * max(0, t - z). */
  const addBelow = (t: number, b: number): void => {
    if (!(b > 0)) return;
    if (upper.size === 0 || t <= upper.top()) lower.push(t, b);
    else {
      upper.push(t, b);
      spill(upper, lower, b);
    }
  };
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  const HARD = 1e12;
  const fixedAt = (i: number): number | undefined => {
    const f = i === 0 ? opts.fixedStart : i === n - 1 ? opts.fixedEnd : undefined;
    return f !== undefined && Number.isFinite(f) ? f : undefined;
  };
  // An end on a road already laid meets its level, softly: a step there over wallFreeM is a wall the
  // width of this road, priced as the verges are.
  const joins = [opts.levels?.at(st[0]!.p), opts.levels?.at(st[n - 1]!.p)];
  const joinAt = (i: number): number | undefined => (i === 0 ? joins[0] : i === n - 1 ? joins[1] : undefined);
  for (let i = 0; i < n; i += 1) {
    if (i > 0) {
      const d = (s[i]! - s[i - 1]!) * grade;
      lower.shift -= d;
      upper.shift += d;
    }
    const ds = ((i + 1 < n ? s[i + 1]! : s[i]!) - (i > 0 ? s[i - 1]! : s[i]!)) / 2;
    const { p, u } = st[i]!;
    const nx = -u[1];
    const ny = u[0];
    // Earth across the carriageway.
    const share = (w / m) * ds;
    for (let k = 0; k < m; k += 1) {
      const o = -w / 2 + ((k + 0.5) * w) / m;
      let t = dem.sampleBilinear([p[0] + nx * o, p[1] + ny * o]);
      if (!Number.isFinite(t)) t = terrain[i]!;
      addAbove(t, opts.fillRs * share);
      addBelow(t, opts.cutRs * share);
    }
    // The verge against the ground beyond it: a wall where they part by more than wallFreeM.
    if (opts.wallRsPerM > 0) {
      for (const side of [-1, 1]) {
        const t = dem.sampleBilinear([p[0] + nx * side * verge, p[1] + ny * side * verge]);
        if (!Number.isFinite(t)) continue;
        addAbove(t + opts.wallFreeM, opts.wallRsPerM * ds);
        addBelow(t - opts.wallFreeM, opts.wallRsPerM * ds);
      }
    }
    const f = fixedAt(i);
    if (f !== undefined) {
      addAbove(f, HARD);
      addBelow(f, HARD);
    } else {
      const jl = joinAt(i);
      if (jl !== undefined) {
        addAbove(jl + opts.wallFreeM, opts.wallRsPerM * w);
        addBelow(jl - opts.wallFreeM, opts.wallRsPerM * w);
      }
    }
    lo[i] = lower.size > 0 ? lower.top() : Number.NEGATIVE_INFINITY;
    hi[i] = upper.size > 0 ? upper.top() : Number.POSITIVE_INFINITY;
  }
  const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
  const design = new Array<number>(n);
  const last = n - 1;
  design[last] = fixedAt(last) ?? clamp(terrain[last]!, lo[last]!, hi[last]!);
  for (let i = last - 1; i >= 0; i -= 1) {
    const d = (s[i + 1]! - s[i]!) * grade;
    const a = design[i + 1]! - d;
    const b = design[i + 1]! + d;
    const blo = Math.max(a, lo[i]!);
    const bhi = Math.min(b, hi[i]!);
    design[i] = blo <= bhi ? clamp(terrain[i]!, blo, bhi) : hi[i]! < a ? a : b;
  }
  const out: RoadProfile = { s, terrain, design, terrainMaxGrade: maxGradeOver(s, terrain, 10), designMaxGrade: maxGradeOver(s, design, 10) };
  if (opts.levels) out.levels = opts.levels;
  return out;
}

/**
 * The road's corridor as a mask, and its earthwork into `delta` (design minus
 * ground per cell: positive fill, negative cut; the larger magnitude wins
 * where corridors overlap). Returns cut and fill in m³.
 */
export function corridor(
  dem: Dem,
  line: readonly Pt[],
  widthM: number,
  profile: RoadProfile,
  delta: Float32Array,
): { mask: Mask; cutM3: number; fillM3: number } {
  const { nx, ny } = dem.meta;
  const centre = emptyMask(dem);
  const st = stations(line, dem.cell / 2);
  for (const { p } of st) {
    const c = dem.cellAt(p);
    if (c) centre[c.j * nx + c.i] = 1;
  }
  const mask = dilate(dem, centre, widthM / 2);
  // Design level per corridor cell from the nearest profile station.
  const best = new Float32Array(nx * ny).fill(Number.POSITIVE_INFINITY);
  const level = new Float32Array(nx * ny).fill(Number.NaN);
  const reach = Math.ceil(widthM / 2 / dem.cell) + 1;
  const ps = stations(line, 2);
  for (let q = 0; q < ps.length && q < profile.design.length; q += 1) {
    const c = dem.cellAt(ps[q]!.p);
    if (!c) continue;
    for (let dj = -reach; dj <= reach; dj += 1) {
      for (let di = -reach; di <= reach; di += 1) {
        const i = c.i + di;
        const j = c.j + dj;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const k = j * nx + i;
        if (!mask[k]) continue;
        const cc = dem.cellCentre(i, j);
        const d = Math.hypot(cc[0] - ps[q]!.p[0], cc[1] - ps[q]!.p[1]);
        if (d < best[k]!) {
          best[k] = d;
          level[k] = profile.design[q]!;
        }
      }
    }
  }
  let cut = 0;
  let fill = 0;
  const area = dem.cell * dem.cell;
  for (let k = 0; k < mask.length; k += 1) {
    if (!mask[k]) continue;
    const zc = dem.values[k]!;
    const lv = level[k]!;
    if (!Number.isFinite(zc) || !Number.isFinite(lv)) continue;
    profile.levels?.record(k, lv);
    const d = lv - zc;
    if (d > 0) fill += d * area;
    else cut -= d * area;
    if (Math.abs(d) > Math.abs(delta[k]!)) delta[k] = d;
  }
  return { mask, cutM3: cut, fillM3: fill };
}
