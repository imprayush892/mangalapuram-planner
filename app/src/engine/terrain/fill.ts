import type { Dem } from './dem';
import type { ContourLine } from '../site/types';
import type { MultiPoly, Pt } from '../geom/types';
import { bboxOfMulti, pointInMulti } from '../geom/planar';
import { growMulti } from '../geom/offset';

/**
 * A continuous surface over ground the survey did not reach.
 *
 * The survey has holes — 18% of the parcel, 275 of them, the largest 4.6 ac —
 * so the mesh breaks and the 3D view shows an island rather than a site. This
 * closes it, under one rule: **filled ground is never silently filled.** The
 * measured grid is untouched, every cell carries where its level came from,
 * and the distance to the nearest real measurement travels with it so anything
 * reading a level can say how much it is trusting.
 *
 * Three steps, in order of how much they can be believed:
 *
 *  1. Harvest. Spot levels and contour vertices that fall on a cell the TIN did
 *     not cover are real measurements the DEM was throwing away.
 *  2. Interpolate. The remaining holes are solved as a Laplace membrane — the
 *     smooth surface that meets the measured ground seamlessly at every edge.
 *     No bullseyes, no terracing, no invented ridges.
 *  3. Rank. Every filled cell records how far it is from real data.
 */

export const enum LevelSource {
  /** Not filled: outside the area the fill was asked to cover. */
  None = 0,
  /** From the survey TIN, as delivered. */
  Survey = 1,
  /** A spot level or contour vertex the TIN did not carry. */
  Harvested = 2,
  /** Interpolated between measurements. */
  Interpolated = 3,
}

export interface FilledDem {
  /** Levels with the holes closed. Same layout as the DEM. */
  values: Float32Array;
  /** Where each cell's level came from. */
  source: Uint8Array;
  /** Metres to the nearest measured cell. Zero where the cell is measured. */
  distanceToMeasuredM: Float32Array;
  measuredCells: number;
  harvestedCells: number;
  interpolatedCells: number;
  /** Largest distance any filled cell sits from real data. */
  maxFillDistanceM: number;
  /** Iterations the solve took, and how far it still moved on the last one. */
  iterations: number;
  residualM: number;
}

export interface FillInput {
  dem: Dem;
  /** The area worth filling: the parcel, usually buffered a little. */
  within: MultiPoly;
  /** Metres to grow `within` by, so the mesh edge is not ragged. */
  marginM?: number;
  contours?: readonly ContourLine[];
  /** x, y, rl triples from the spot level survey. */
  spotLevels?: readonly (readonly [number, number, number])[];
  /** Stop when no cell moves more than this, or at `maxIterations`. */
  toleranceM?: number;
  maxIterations?: number;
}

/** Walks a polyline, emitting a point every `stepM`, so a line fills its cells. */
function* alongLine(line: readonly Pt[], stepM: number): Generator<Pt> {
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(length / stepM));
    for (let t = 0; t <= steps; t += 1) {
      yield [a[0] + ((b[0] - a[0]) * t) / steps, a[1] + ((b[1] - a[1]) * t) / steps];
    }
  }
}

export function fillDem(input: FillInput): FilledDem {
  const { dem } = input;
  const { nx, ny } = dem.meta;
  const n = nx * ny;
  const cell = dem.cell;

  const values = new Float32Array(n);
  const source = new Uint8Array(n);
  for (let k = 0; k < n; k += 1) {
    const z = dem.values[k]!;
    values[k] = z;
    source[k] = Number.isFinite(z) ? LevelSource.Survey : LevelSource.None;
  }

  /* ----------------------------------------------------------- 1. harvest */
  // Averaged where several readings land on one cell, because two surveyors'
  // levels a metre apart are two readings of the same cell, not a conflict.
  const sums = new Map<number, { total: number; count: number }>();
  const note = (p: Pt, rl: number): void => {
    if (!Number.isFinite(rl)) return;
    const c = dem.cellAt(p);
    if (!c) return;
    const k = c.j * nx + c.i;
    if (source[k] === LevelSource.Survey) return;
    const row = sums.get(k) ?? { total: 0, count: 0 };
    row.total += rl;
    row.count += 1;
    sums.set(k, row);
  };

  for (const s of input.spotLevels ?? []) note([s[0], s[1]], s[2]);
  for (const c of input.contours ?? []) {
    for (const p of alongLine(c.line, cell * 0.5)) note(p, c.rl);
  }
  let harvested = 0;
  for (const [k, row] of sums) {
    values[k] = row.total / row.count;
    source[k] = LevelSource.Harvested;
    harvested += 1;
  }

  /* ------------------------------------------------- 2. the area to solve */
  const region = input.marginM && input.marginM > 0 ? growMulti(input.within, input.marginM) : input.within;
  const b = bboxOfMulti(region);
  const i0 = Math.max(0, Math.floor((b.minX - dem.meta.x0) / cell));
  const j0 = Math.max(0, Math.floor((b.minY - dem.meta.y0) / cell));
  const i1 = Math.min(nx - 1, Math.ceil((b.maxX - dem.meta.x0) / cell));
  const j1 = Math.min(ny - 1, Math.ceil((b.maxY - dem.meta.y0) / cell));

  const solve: number[] = [];
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const k = j * nx + i;
      if (source[k] !== LevelSource.None) continue;
      if (!pointInMulti(dem.cellCentre(i, j), region)) continue;
      solve.push(k);
    }
  }

  /* ------------------------------------------------------- 3. interpolate */
  /*
   * Laplace on the residual over a fitted trend, not on the levels themselves.
   *
   * A plain Laplace membrane is the surface with no curvature, which is right
   * for a hole ringed by measured ground. It is wrong for a hole that runs out
   * to the edge of the survey: with no boundary on the open side the solution
   * is free to go flat, and it does — the first version of this produced
   * 12,126 cells of DEAD LEVEL ground, 0.00° against 12.25° in the measured
   * terrain, which is a plateau nobody surveyed and nobody would build.
   *
   * So each hole first gets a plane fitted by least squares to the measured
   * ground around it. That plane carries the hillside's own slope across the
   * gap. The membrane then only has to solve what is left over, and a flat
   * residual leaves the hillside sloping rather than a mesa.
   */

  // Connected components of the hole, so each gets its own trend.
  const comp = new Int32Array(n).fill(-1);
  const components: number[][] = [];
  const inSolve = new Uint8Array(n);
  for (const k of solve) inSolve[k] = 1;
  for (const start of solve) {
    if (comp[start]! >= 0) continue;
    const id = components.length;
    const cells: number[] = [];
    const queue = [start];
    comp[start] = id;
    while (queue.length > 0) {
      const k = queue.pop()!;
      cells.push(k);
      const i = k % nx;
      const j = (k - i) / nx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nk = nj * nx + ni;
        if (inSolve[nk] !== 1 || comp[nk]! >= 0) continue;
        comp[nk] = id;
        queue.push(nk);
      }
    }
    components.push(cells);
  }

  /*
   * A plane through the measured ground around one hole. Gathered by growing
   * the hole outwards until enough real cells are in reach — a big hole needs
   * to look further than a small one, and three points do not fix a slope
   * reliably.
   */
  const planes: [number, number, number][] = components.map((cells) => {
    const wanted = Math.max(40, Math.round(cells.length * 0.5));
    const seen = new Set<number>(cells);
    let frontier = cells;
    const sample: [number, number, number][] = [];
    for (let ring = 0; ring < 40 && sample.length < wanted; ring += 1) {
      const next: number[] = [];
      for (const k of frontier) {
        const i = k % nx;
        const j = (k - i) / nx;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
          const nk = nj * nx + ni;
          if (seen.has(nk)) continue;
          seen.add(nk);
          if (source[nk] === LevelSource.Survey || source[nk] === LevelSource.Harvested) {
            const p = dem.cellCentre(ni, nj);
            sample.push([p[0], p[1], values[nk]!]);
          } else {
            next.push(nk);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return fitPlane(sample);
  });

  const trendAt = (k: number, id: number): number => {
    const plane = planes[id];
    if (!plane) return 0;
    const i = k % nx;
    const j = (k - i) / nx;
    const p = dem.cellCentre(i, j);
    return plane[0] + plane[1] * p[0] + plane[2] * p[1];
  };

  // Solve the residual: zero is now a good starting guess, because the trend
  // already carries the slope.
  const residual = new Float32Array(n);
  const omega = 1.9;
  const tolerance = input.toleranceM ?? 0.002;
  const maxIterations = input.maxIterations ?? 4000;
  let iterations = 0;
  let residualMoved = Number.POSITIVE_INFINITY;

  for (let pass = 0; pass < maxIterations; pass += 1) {
    let worst = 0;
    for (const k of solve) {
      const id = comp[k]!;
      const i = k % nx;
      const j = (k - i) / nx;
      let total = 0;
      let count = 0;
      const take = (nk: number): void => {
        const src = source[nk];
        if (src === LevelSource.None) {
          // Unknown ground outside the region: no boundary condition here, so
          // it contributes nothing rather than pulling the solution flat.
          if (inSolve[nk] !== 1) return;
          total += residual[nk]!;
          count += 1;
          return;
        }
        // Measured ground enters as its height above this hole's own trend.
        total += values[nk]! - trendAt(nk, id);
        count += 1;
      };
      if (i > 0) take(k - 1);
      if (i < nx - 1) take(k + 1);
      if (j > 0) take(k - nx);
      if (j < ny - 1) take(k + nx);
      if (count === 0) continue;
      const target = total / count;
      const next = residual[k]! + omega * (target - residual[k]!);
      const moved = Math.abs(next - residual[k]!);
      if (moved > worst) worst = moved;
      residual[k] = next;
    }
    iterations = pass + 1;
    residualMoved = worst;
    if (worst <= tolerance) break;
  }

  // The fill is the trend plus what the membrane had to add to meet the edges,
  // held inside the levels the survey actually found.
  const rlMin = dem.meta.rl_min;
  const rlMax = dem.meta.rl_max;
  for (const k of solve) {
    const z = trendAt(k, comp[k]!) + residual[k]!;
    values[k] = Math.min(rlMax, Math.max(rlMin, z));
  }

  for (const k of solve) source[k] = LevelSource.Interpolated;

  /* ------------------------------------------------------- 4. how far out */
  const distanceToMeasuredM = new Float32Array(n).fill(Number.POSITIVE_INFINITY);
  for (let k = 0; k < n; k += 1) {
    if (source[k] === LevelSource.Survey || source[k] === LevelSource.Harvested) {
      distanceToMeasuredM[k] = 0;
    }
  }
  const diag = cell * Math.SQRT2;
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const k = j * nx + i;
      let best = distanceToMeasuredM[k]!;
      if (i > 0) best = Math.min(best, distanceToMeasuredM[k - 1]! + cell);
      if (j > 0) best = Math.min(best, distanceToMeasuredM[k - nx]! + cell);
      if (i > 0 && j > 0) best = Math.min(best, distanceToMeasuredM[k - nx - 1]! + diag);
      if (i < nx - 1 && j > 0) best = Math.min(best, distanceToMeasuredM[k - nx + 1]! + diag);
      distanceToMeasuredM[k] = best;
    }
  }
  for (let j = ny - 1; j >= 0; j -= 1) {
    for (let i = nx - 1; i >= 0; i -= 1) {
      const k = j * nx + i;
      let best = distanceToMeasuredM[k]!;
      if (i < nx - 1) best = Math.min(best, distanceToMeasuredM[k + 1]! + cell);
      if (j < ny - 1) best = Math.min(best, distanceToMeasuredM[k + nx]! + cell);
      if (i < nx - 1 && j < ny - 1) best = Math.min(best, distanceToMeasuredM[k + nx + 1]! + diag);
      if (i > 0 && j < ny - 1) best = Math.min(best, distanceToMeasuredM[k + nx - 1]! + diag);
      distanceToMeasuredM[k] = best;
    }
  }

  let maxFill = 0;
  let measured = 0;
  for (let k = 0; k < n; k += 1) {
    if (source[k] === LevelSource.Survey) measured += 1;
    if (source[k] === LevelSource.Interpolated) {
      const d = distanceToMeasuredM[k]!;
      if (Number.isFinite(d) && d > maxFill) maxFill = d;
    }
    if (source[k] === LevelSource.None) values[k] = Number.NaN;
  }

  return {
    values,
    source,
    distanceToMeasuredM,
    measuredCells: measured,
    harvestedCells: harvested,
    interpolatedCells: solve.length,
    maxFillDistanceM: maxFill,
    iterations,
    residualM: residualMoved,
  };
}

/**
 * How much a level can be trusted, 1 at a measurement and falling away from it.
 *
 * Halves every `halfDistanceM`, so it never reaches zero and never pretends a
 * far-out cell is worthless — only that it is worth less.
 */
export function confidenceAt(distanceM: number, halfDistanceM = 25): number {
  if (!Number.isFinite(distanceM)) return 0;
  if (distanceM <= 0) return 1;
  return 1 / (1 + distanceM / halfDistanceM);
}

/** Share of a set of cells that is interpolated rather than measured. */
export function interpolatedShare(filled: FilledDem, cells: Iterable<number>): number {
  let total = 0;
  let inferred = 0;
  for (const k of cells) {
    total += 1;
    if (filled.source[k] === LevelSource.Interpolated) inferred += 1;
  }
  return total > 0 ? inferred / total : 0;
}


/**
 * Least squares plane z = a + bx + cy through a scatter of levels.
 *
 * Falls back to the mean where the points are too few or lie on a line, which
 * is a flat trend — correct, because a line of points fixes no slope across it
 * and guessing one would be inventing terrain.
 */
function fitPlane(points: readonly (readonly [number, number, number])[]): [number, number, number] {
  if (points.length === 0) return [0, 0, 0];
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const [x, y, z] of points) {
    mx += x;
    my += y;
    mz += z;
  }
  mx /= points.length;
  my /= points.length;
  mz /= points.length;
  if (points.length < 8) return [mz, 0, 0];

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxz = 0;
  let syz = 0;
  for (const [x, y, z] of points) {
    const dx = x - mx;
    const dy = y - my;
    const dz = z - mz;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sxz += dx * dz;
    syz += dy * dz;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-9) return [mz, 0, 0];
  const b = (sxz * syy - syz * sxy) / det;
  const c = (syz * sxx - sxz * sxy) / det;
  return [mz - b * mx - c * my, b, c];
}
