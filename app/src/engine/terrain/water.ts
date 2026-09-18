import type { Dem } from './dem';
import type { MultiPoly, Pt } from '../geom/types';
import type { SiteFeature } from '../site/types';
import { cellsToMulti } from './analysis';

/**
 * The hydrology the plan is organised around.
 *
 * Water-led planning needs more than the drainage lines we already draw. It
 * needs to know, for every cell: which catchment it drains through, how far it
 * is from water, how wet it is, and whether it sits in a hollow that fills.
 * Those four fields are what let a use be placed BY its relationship to water
 * rather than have water drawn in afterwards.
 *
 * Everything here is derived from the DEM the survey gave us, so an unsurveyed
 * cell stays unknown: it is never assumed dry.
 */

export interface WaterModel {
  /** Catchment id per cell, -1 where unknown. */
  catchment: Int32Array;
  /** Cells draining through each catchment outlet, by id. */
  catchmentSizes: number[];
  /** Outlet cell index per catchment. */
  outlets: number[];
  /** Metres to the nearest water: a channel, a drain or a pond edge. NaN unknown. */
  distanceToWaterM: Float32Array;
  /**
   * Topographic wetness index, ln(upslope area / tan slope). High means water
   * collects; low means it sheds. The standard measure of where ground is wet.
   */
  wetness: Float32Array;
  /** Cells that drain into a hollow with no outlet below them. */
  ponding: Uint8Array;
  /** Flow accumulation, kept so callers need not recompute it. */
  accumulation: Float32Array;
  /** Cell index of each channel cell, for drawing and for distance. */
  channelCells: Int32Array;
  nx: number;
  ny: number;
  /** Highest wetness found, so a score can be normalised against the site. */
  maxWetness: number;
}

export interface WaterInput {
  dem: Dem;
  /** Cells with at least this much upslope area count as a channel. */
  minUpslopeCells: number;
  /** Drains and pond edges from the survey, which are water whatever the DEM says. */
  features: SiteFeature[];
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/** Steepest-descent receiver per cell, -1 where the cell is a local minimum. */
function receivers(dem: Dem): { receiver: Int32Array; order: number[] } {
  const { nx, ny } = dem.meta;
  const n = nx * ny;
  const order: number[] = [];
  for (let k = 0; k < n; k += 1) if (Number.isFinite(dem.values[k]!)) order.push(k);
  order.sort((a, b) => dem.values[b]! - dem.values[a]!);

  const receiver = new Int32Array(n).fill(-1);
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
  return { receiver, order };
}

/**
 * Multi-source distance transform over the grid, in metres.
 *
 * A simple two-pass chamfer is enough here: the grid is 2 m and the distances
 * feed a score, not a setting-out drawing.
 */
function distanceField(nx: number, ny: number, cell: number, seeds: Iterable<number>): Float32Array {
  const out = new Float32Array(nx * ny).fill(Number.POSITIVE_INFINITY);
  for (const k of seeds) if (k >= 0 && k < out.length) out[k] = 0;
  const diag = cell * Math.SQRT2;

  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const k = j * nx + i;
      let best = out[k]!;
      if (i > 0) best = Math.min(best, out[k - 1]! + cell);
      if (j > 0) best = Math.min(best, out[k - nx]! + cell);
      if (i > 0 && j > 0) best = Math.min(best, out[k - nx - 1]! + diag);
      if (i < nx - 1 && j > 0) best = Math.min(best, out[k - nx + 1]! + diag);
      out[k] = best;
    }
  }
  for (let j = ny - 1; j >= 0; j -= 1) {
    for (let i = nx - 1; i >= 0; i -= 1) {
      const k = j * nx + i;
      let best = out[k]!;
      if (i < nx - 1) best = Math.min(best, out[k + 1]! + cell);
      if (j < ny - 1) best = Math.min(best, out[k + nx]! + cell);
      if (i < nx - 1 && j < ny - 1) best = Math.min(best, out[k + nx + 1]! + diag);
      if (i > 0 && j < ny - 1) best = Math.min(best, out[k + nx - 1]! + diag);
      out[k] = best;
    }
  }
  return out;
}

export function buildWaterModel(input: WaterInput): WaterModel {
  const { dem } = input;
  const { nx, ny } = dem.meta;
  const n = nx * ny;
  const cell = dem.cell;
  const cellArea = cell * cell;

  const { receiver, order } = receivers(dem);

  /* ------------------------------------------------- flow and catchments */
  const accumulation = new Float32Array(n).fill(1);
  for (const k of order) {
    const r = receiver[k]!;
    if (r >= 0) accumulation[r]! += accumulation[k]!;
  }

  // A catchment is everything draining to one local minimum. Walking the
  // receiver chain from each cell lands on that minimum, so labelling the
  // minima and then flowing the labels downslope-first assigns every cell.
  const catchment = new Int32Array(n).fill(-1);
  const outlets: number[] = [];
  for (const k of order) {
    if (receiver[k]! < 0) {
      catchment[k] = outlets.length;
      outlets.push(k);
    }
  }
  // `order` runs high to low, so a cell's receiver is not yet labelled when we
  // reach it; walking it in reverse settles the low cells first.
  for (let idx = order.length - 1; idx >= 0; idx -= 1) {
    const k = order[idx]!;
    if (catchment[k]! >= 0) continue;
    const r = receiver[k]!;
    if (r >= 0) catchment[k] = catchment[r]!;
  }
  const catchmentSizes = new Array<number>(outlets.length).fill(0);
  for (let k = 0; k < n; k += 1) {
    const c = catchment[k]!;
    if (c >= 0) catchmentSizes[c]! += 1;
  }

  /* ------------------------------------------------------------- wetness */
  const slope = dem.slopeGrid();
  const wetness = new Float32Array(n).fill(Number.NaN);
  let maxWetness = 0;
  for (let k = 0; k < n; k += 1) {
    const s = slope[k]!;
    if (!Number.isFinite(s)) continue;
    // A perfectly flat cell would divide by zero; half a degree is the floor
    // a 2 m DEM can resolve anyway.
    const tan = Math.max(Math.tan((Math.max(s, 0.5) * Math.PI) / 180), 1e-4);
    const w = Math.log((accumulation[k]! * cellArea) / tan);
    wetness[k] = w;
    if (w > maxWetness) maxWetness = w;
  }

  /* ------------------------------------------- water cells and distance */
  const waterSeeds = new Set<number>();
  const channelList: number[] = [];
  for (let k = 0; k < n; k += 1) {
    if (accumulation[k]! >= input.minUpslopeCells) {
      waterSeeds.add(k);
      channelList.push(k);
    }
  }
  // The survey's own drains and ponds are water whatever the DEM says.
  for (const f of input.features) {
    if (f.kind !== 'drain' && f.kind !== 'pond_edge') continue;
    for (const line of f.lines) {
      for (let i = 1; i < line.length; i += 1) {
        const a = line[i - 1]!;
        const b = line[i]!;
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / cell));
        for (let t = 0; t <= steps; t += 1) {
          const p: Pt = [a[0] + ((b[0] - a[0]) * t) / steps, a[1] + ((b[1] - a[1]) * t) / steps];
          const c = dem.cellAt(p);
          if (c) waterSeeds.add(c.j * nx + c.i);
        }
      }
    }
  }
  const distanceToWaterM = distanceField(nx, ny, cell, waterSeeds);

  /* ------------------------------------------------------------- ponding */
  // A hollow is a local minimum that is not on the parcel edge; the cells that
  // drain into one will hold water before they drain anywhere else.
  const ponding = new Uint8Array(n);
  for (let c = 0; c < outlets.length; c += 1) {
    const k = outlets[c]!;
    const i = k % nx;
    const j = (k - i) / nx;
    const onEdge = i === 0 || j === 0 || i === nx - 1 || j === ny - 1;
    if (onEdge) continue;
    // Only hollows big enough to matter: a single-cell pit is DEM noise.
    if ((catchmentSizes[c] ?? 0) < 25) continue;
    for (let m = 0; m < n; m += 1) if (catchment[m] === c) ponding[m] = 1;
  }

  return {
    catchment,
    catchmentSizes,
    outlets,
    distanceToWaterM,
    wetness,
    ponding,
    accumulation,
    channelCells: Int32Array.from(channelList),
    nx,
    ny,
    maxWetness,
  };
}

/** Land within `bufferM` of water: the strip a water-led plan keeps clear. */
export function waterBuffer(dem: Dem, water: WaterModel, within: MultiPoly, bufferM: number): MultiPoly {
  if (bufferM <= 0) return [];
  return cellsToMulti(dem, within, (i, j) => water.distanceToWaterM[j * water.nx + i]! <= bufferM);
}

/** Ground that ponds, as polygons — the other half of a water no-build. */
export function pondingGround(dem: Dem, water: WaterModel, within: MultiPoly): MultiPoly {
  return cellsToMulti(dem, within, (i, j) => water.ponding[j * water.nx + i] === 1);
}

export interface WaterStats {
  /** 0 (dry, sheds) to 1 (wet, collects), averaged over the shape. */
  wetnessRank: number;
  /** Mean metres to water. */
  meanDistanceToWaterM: number;
  /** Nearest water from anywhere in the shape. */
  minDistanceToWaterM: number;
  /** Share of the shape that ponds. */
  pondingShare: number;
  /** Share within the buffer distance of water. */
  nearWaterShare: number;
  /** How many catchments the shape spans: more means it cannot drain as one. */
  catchments: number;
  /** Share of cells the DEM does not cover. */
  unknownShare: number;
}

/** Hydrology of one shape, read off the model. */
export function waterStatsFor(
  dem: Dem,
  water: WaterModel,
  within: MultiPoly,
  bufferM: number,
): WaterStats {
  const { nx } = water;
  let cells = 0;
  let unknown = 0;
  let wetSum = 0;
  let distSum = 0;
  let minDist = Number.POSITIVE_INFINITY;
  let ponds = 0;
  let near = 0;
  const catchments = new Set<number>();

  const b = boundsOf(within);
  const cell = dem.cell;
  for (let y = b.minY; y <= b.maxY; y += cell) {
    for (let x = b.minX; x <= b.maxX; x += cell) {
      const c = dem.cellAt([x, y]);
      if (!c) continue;
      if (!pointInside(within, [x, y])) continue;
      const k = c.j * nx + c.i;
      cells += 1;
      const w = water.wetness[k]!;
      if (!Number.isFinite(w)) {
        unknown += 1;
        continue;
      }
      wetSum += w;
      const d = water.distanceToWaterM[k]!;
      if (Number.isFinite(d)) {
        distSum += d;
        if (d < minDist) minDist = d;
        if (d <= bufferM) near += 1;
      }
      if (water.ponding[k] === 1) ponds += 1;
      const cat = water.catchment[k]!;
      if (cat >= 0) catchments.add(cat);
    }
  }

  const known = Math.max(1, cells - unknown);
  return {
    wetnessRank: water.maxWetness > 0 ? Math.max(0, Math.min(1, wetSum / known / water.maxWetness)) : 0,
    meanDistanceToWaterM: distSum / known,
    minDistanceToWaterM: Number.isFinite(minDist) ? minDist : Number.NaN,
    pondingShare: ponds / known,
    nearWaterShare: near / known,
    catchments: catchments.size,
    unknownShare: cells > 0 ? unknown / cells : 1,
  };
}

function boundsOf(mp: MultiPoly): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of mp) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

function pointInside(mp: MultiPoly, p: Pt): boolean {
  let inside = false;
  for (const poly of mp) {
    for (let r = 0; r < poly.length; r += 1) {
      const ring = poly[r]!;
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const a = ring[i]!;
        const b = ring[j]!;
        if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
          hit = !hit;
        }
      }
      // The first ring is the outline; the rest are holes.
      if (r === 0) inside = hit;
      else if (hit) inside = false;
    }
  }
  return inside;
}

/**
 * How much of a set of built shapes sits on wet ground, and how much of the
 * zone's channel network they leave alone.
 *
 * Point-in-polygon per cell is fine for a handful of towers or blocks. The
 * villa generator has hundreds of plots and uses its own grid arithmetic
 * instead, but reports the same two numbers, so a layout can be compared
 * whatever built it.
 */
export interface BuiltWaterMetrics {
  /** Share of built cells on ground that ponds or is in the top wetness band. */
  wetShare: number;
  /** Share of the zone's channel cells with nothing built on them. */
  channelsClear: number;
}

/** A cell is wet where it ponds, or where wetness is in the top fifth of the site. */
export function isWetCell(water: WaterModel, k: number): boolean {
  if (water.ponding[k] === 1) return true;
  const w = water.wetness[k]!;
  return Number.isFinite(w) && water.maxWetness > 0 && w >= water.maxWetness * 0.8;
}

export function builtWaterMetrics(
  dem: Dem,
  water: WaterModel,
  zone: MultiPoly,
  built: MultiPoly[],
): BuiltWaterMetrics {
  const cell = dem.cell;
  const b = boundsOf(zone);
  let builtCells = 0;
  let wetBuilt = 0;
  let channelCells = 0;
  let channelBuilt = 0;

  for (let y = b.minY; y <= b.maxY; y += cell) {
    for (let x = b.minX; x <= b.maxX; x += cell) {
      const p: Pt = [x, y];
      if (!pointInside(zone, p)) continue;
      const c = dem.cellAt(p);
      if (!c) continue;
      const k = c.j * water.nx + c.i;
      const onChannel = water.distanceToWaterM[k]! <= cell;
      const onBuilt = built.some((shape) => pointInside(shape, p));
      if (onChannel) {
        channelCells += 1;
        if (onBuilt) channelBuilt += 1;
      }
      if (onBuilt) {
        builtCells += 1;
        if (isWetCell(water, k)) wetBuilt += 1;
      }
    }
  }

  return {
    wetShare: builtCells > 0 ? wetBuilt / builtCells : 0,
    // Nothing to keep clear is not a failure: a zone with no channel scores full.
    channelsClear: channelCells > 0 ? 1 - channelBuilt / channelCells : 1,
  };
}
