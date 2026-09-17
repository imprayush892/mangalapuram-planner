import type { MultiPoly, Pt, Ring } from '../geom/types';
import { bboxOfMulti, pointInMulti, polyArea } from '../geom/planar';
import { union } from '../geom/boolean';
import type { Dem } from './dem';
import type { TerrainSummary } from '../generators/types';

/**
 * Turns DEM cells that satisfy a predicate into polygons, by emitting each
 * qualifying cell as a square and unioning them. Coarse, but the cells are 2 m
 * and every consumer offsets or clips the result afterwards.
 */
export function cellsToMulti(
  dem: Dem,
  within: MultiPoly,
  predicate: (i: number, j: number) => boolean,
): MultiPoly {
  const b = bboxOfMulti(within);
  if (!Number.isFinite(b.minX)) return [];
  const { x0, y0, cell_m, nx, ny } = dem.meta;
  const iMin = Math.max(0, Math.floor((b.minX - x0) / cell_m));
  const iMax = Math.min(nx - 1, Math.ceil((b.maxX - x0) / cell_m));
  const jMin = Math.max(0, Math.floor((b.minY - y0) / cell_m));
  const jMax = Math.min(ny - 1, Math.ceil((b.maxY - y0) / cell_m));

  const squares: MultiPoly = [];
  for (let j = jMin; j <= jMax; j++) {
    for (let i = iMin; i <= iMax; i++) {
      if (!predicate(i, j)) continue;
      const cx = x0 + cell_m * i;
      const cy = y0 + cell_m * j;
      if (!pointInMulti([cx + cell_m / 2, cy + cell_m / 2], within)) continue;
      squares.push([
        [
          [cx, cy],
          [cx + cell_m, cy],
          [cx + cell_m, cy + cell_m],
          [cx, cy + cell_m],
        ] as Ring,
      ]);
    }
  }
  if (squares.length === 0) return [];
  return union(...squares.map((p) => [p]));
}

/** Ground steeper than the Rule 22 limit, as polygons. */
export function steepGround(dem: Dem, within: MultiPoly, slopeLimitDeg: number): MultiPoly {
  const slope = dem.slopeGrid();
  return cellsToMulti(dem, within, (i, j) => {
    const s = slope[j * dem.meta.nx + i]!;
    return Number.isFinite(s) && s > slopeLimitDeg;
  });
}

/** Ground over a gentler threshold, used to seed open space (SPEC 6.1.6). */
export function slopeOver(dem: Dem, within: MultiPoly, slopeDeg: number): MultiPoly {
  const slope = dem.slopeGrid();
  return cellsToMulti(dem, within, (i, j) => {
    const s = slope[j * dem.meta.nx + i]!;
    return Number.isFinite(s) && s > slopeDeg;
  });
}

/** Unsurveyed ground: allowed to build on, but flagged low-confidence. */
export function unsurveyedGround(dem: Dem, within: MultiPoly): MultiPoly {
  return cellsToMulti(dem, within, (i, j) => !Number.isFinite(dem.at(i, j)));
}

/**
 * D8 flow accumulation over the DEM, in cells. Channels are the cells whose
 * accumulated upslope area is above a threshold — the drainage lines the open
 * space should follow.
 */
export function flowAccumulation(dem: Dem): Float32Array {
  const { nx, ny } = dem.meta;
  const n = nx * ny;
  const acc = new Float32Array(n).fill(1);
  const order: number[] = [];
  for (let k = 0; k < n; k++) if (Number.isFinite(dem.values[k]!)) order.push(k);
  // Process from high to low so every cell's inflow is settled before it drains.
  order.sort((a, b) => dem.values[b]! - dem.values[a]!);

  const receiver = new Int32Array(n).fill(-1);
  const NEIGHBOURS: [number, number][] = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];
  for (const k of order) {
    const i = k % nx;
    const j = (k - i) / nx;
    const z = dem.values[k]!;
    let bestDrop = 0;
    let best = -1;
    for (const [di, dj] of NEIGHBOURS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nz = dem.values[nj * nx + ni]!;
      if (!Number.isFinite(nz)) continue;
      const drop = (z - nz) / Math.hypot(di, dj);
      if (drop > bestDrop) {
        bestDrop = drop;
        best = nj * nx + ni;
      }
    }
    receiver[k] = best;
  }
  for (const k of order) {
    const r = receiver[k]!;
    if (r >= 0) acc[r]! += acc[k]!;
  }
  return acc;
}

/** Drainage channels as polygons, from flow accumulation. */
export function drainageChannels(
  dem: Dem,
  within: MultiPoly,
  accumulation: Float32Array,
  minUpslopeCells: number,
): MultiPoly {
  return cellsToMulti(dem, within, (i, j) => accumulation[j * dem.meta.nx + i]! >= minUpslopeCells);
}

export interface FallThresholds {
  build_as_drawn: number;
  absorb_in_plinth: number;
  stepped_plinth: number;
  split_level: number;
}

export function classifyFall(fall: number, thresholds: FallThresholds): string {
  if (!Number.isFinite(fall)) return 'unsurveyed';
  if (fall <= thresholds.build_as_drawn) return 'build_as_drawn';
  if (fall <= thresholds.absorb_in_plinth) return 'absorb_in_plinth';
  if (fall <= thresholds.stepped_plinth) return 'stepped_plinth';
  if (fall <= thresholds.split_level) return 'split_level';
  return 'over_split_level';
}

/**
 * Terrain under a shape: fall, platform RL (median) and the cut and fill to
 * bring the shape to that platform.
 */
export function terrainSummary(dem: Dem, shape: MultiPoly, thresholds: FallThresholds): TerrainSummary {
  const t = dem.terrainIn(shape);
  const areaM2 = shape.reduce((s, p) => s + polyArea(p), 0);
  if (t.count === 0) {
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
  const cellArea = dem.cell * dem.cell;
  let cut = 0;
  let fill = 0;
  const b = bboxOfMulti(shape);
  const iMin = Math.max(0, Math.floor((b.minX - dem.meta.x0) / dem.cell));
  const iMax = Math.min(dem.meta.nx - 1, Math.ceil((b.maxX - dem.meta.x0) / dem.cell));
  const jMin = Math.max(0, Math.floor((b.minY - dem.meta.y0) / dem.cell));
  const jMax = Math.min(dem.meta.ny - 1, Math.ceil((b.maxY - dem.meta.y0) / dem.cell));
  for (let j = jMin; j <= jMax; j++) {
    for (let i = iMin; i <= iMax; i++) {
      const v = dem.at(i, j);
      if (!Number.isFinite(v)) continue;
      if (!pointInMulti(dem.cellCentre(i, j), shape)) continue;
      const d = v - t.median;
      if (d > 0) cut += d * cellArea;
      else fill += -d * cellArea;
    }
  }
  return {
    fall: t.fall,
    platformRl: t.median,
    minRl: t.min,
    maxRl: t.max,
    cutM3: cut,
    fillM3: fill,
    unsurveyedShare: areaM2 > 0 ? (t.nanCount * cellArea) / areaM2 : 0,
    fallClass: classifyFall(t.fall, thresholds),
  };
}

/**
 * Dominant aspect of the ground inside a shape, as a bearing. Roads laid
 * perpendicular to it run along the contours.
 */
export function dominantAspectDeg(dem: Dem, shape: MultiPoly): number {
  const aspect = dem.aspectGrid();
  const slope = dem.slopeGrid();
  const b = bboxOfMulti(shape);
  let sx = 0;
  let sy = 0;
  const iMin = Math.max(0, Math.floor((b.minX - dem.meta.x0) / dem.cell));
  const iMax = Math.min(dem.meta.nx - 1, Math.ceil((b.maxX - dem.meta.x0) / dem.cell));
  const jMin = Math.max(0, Math.floor((b.minY - dem.meta.y0) / dem.cell));
  const jMax = Math.min(dem.meta.ny - 1, Math.ceil((b.maxY - dem.meta.y0) / dem.cell));
  for (let j = jMin; j <= jMax; j++) {
    for (let i = iMin; i <= iMax; i++) {
      const k = j * dem.meta.nx + i;
      const a = aspect[k]!;
      const s = slope[k]!;
      if (!Number.isFinite(a) || !Number.isFinite(s)) continue;
      if (!pointInMulti(dem.cellCentre(i, j), shape)) continue;
      // Weight by slope: flat ground has no meaningful aspect.
      const rad = (a * Math.PI) / 180;
      sx += Math.sin(rad) * s;
      sy += Math.cos(rad) * s;
    }
  }
  if (sx === 0 && sy === 0) return Number.NaN;
  return ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360;
}

/** Retaining face area between two platforms, priced per m2 elsewhere. */
export const retainingFaceM2 = (stepM: number, lengthM: number): number => Math.abs(stepM) * lengthM;

export const cellCentreOf = (dem: Dem, i: number, j: number): Pt => dem.cellCentre(i, j);
