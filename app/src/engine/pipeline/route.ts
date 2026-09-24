import type { Dem } from '../terrain/dem';
import type { Pt } from '../geom/types';
import type { Mask } from './mask';
import { dilate, emptyMask } from './mask';

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
}

/**
 * The road's vertical profile: the ground along the centreline, and the design
 * line nearest it that never exceeds `grade` — a forward pass then a backward
 * pass, each holding the line within grade of its neighbour. Where the ground
 * is already within grade the two are the same and there is no earthwork.
 */
export function gradeLimitedProfile(dem: Dem, line: readonly Pt[], grade: number, step = 2): RoadProfile {
  const st = stations(line, step);
  const s = st.map((x) => x.s);
  const terrain = st.map((x) => dem.sampleBilinear(x.p));
  for (let i = 0; i < terrain.length; i += 1) {
    if (!Number.isFinite(terrain[i]!)) terrain[i] = i > 0 ? terrain[i - 1]! : Number.NaN;
  }
  for (let i = terrain.length - 2; i >= 0; i -= 1) {
    if (!Number.isFinite(terrain[i]!)) terrain[i] = terrain[i + 1]!;
  }
  const design = terrain.slice();
  for (let i = 1; i < design.length; i += 1) {
    const d = (s[i]! - s[i - 1]!) * grade;
    design[i] = Math.min(design[i - 1]! + d, Math.max(design[i - 1]! - d, design[i]!));
  }
  for (let i = design.length - 2; i >= 0; i -= 1) {
    const d = (s[i + 1]! - s[i]!) * grade;
    design[i] = Math.min(design[i + 1]! + d, Math.max(design[i + 1]! - d, design[i]!));
  }
  const maxOver = (zs: number[], window: number): number => {
    let m = 0;
    let j = 0;
    for (let i = 0; i < zs.length; i += 1) {
      while (j < zs.length && s[j]! - s[i]! < window) j += 1;
      if (j >= zs.length) break;
      m = Math.max(m, Math.abs(zs[j]! - zs[i]!) / (s[j]! - s[i]!));
    }
    return m;
  };
  return { s, terrain, design, terrainMaxGrade: maxOver(terrain, 10), designMaxGrade: maxOver(design, 10) };
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
    const d = lv - zc;
    if (d > 0) fill += d * area;
    else cut -= d * area;
    if (Math.abs(d) > Math.abs(delta[k]!)) delta[k] = d;
  }
  return { mask, cutM3: cut, fillM3: fill };
}
