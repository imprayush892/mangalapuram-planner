import type { Bbox, MultiPoly, Pt } from '../geom/types';
import { bboxOfMulti, pointInMulti } from '../geom/planar';
import { M2_PER_ACRE, toDeg } from '../units';

export interface DemMeta {
  format: string;
  nodata: string;
  cell_m: number;
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  cell_centre: string;
  coords: string;
  source: string;
  valid_cells: number;
  rl_min: number;
  rl_max: number;
}

export interface DemStats {
  validCells: number;
  totalCells: number;
  areaM2: number;
  rlMin: number;
  rlMax: number;
  rlMean: number;
}

/** Slope/aspect at one cell, computed by Horn's 3x3 method. */
export interface SlopeSample {
  slopeDeg: number;
  /** Compass bearing the ground faces, degrees clockwise from north. NaN when flat. */
  aspectDeg: number;
}

const NA = Number.NaN;

/**
 * The 2 m DEM. Row 0 is the SOUTHERNMOST row, so index j increases northwards
 * (see data/processed/dem_2m.json). Unsurveyed cells are NaN and stay NaN: the
 * engine flags them as low-confidence rather than filling them.
 */
export class Dem {
  readonly meta: DemMeta;
  readonly values: Float32Array;
  private slopeCache: Float32Array | null = null;
  private aspectCache: Float32Array | null = null;

  constructor(meta: DemMeta, values: Float32Array) {
    if (values.length !== meta.nx * meta.ny) {
      throw new Error(`DEM size mismatch: ${values.length} values for ${meta.nx}x${meta.ny}`);
    }
    this.meta = meta;
    this.values = values;
  }

  get cell(): number {
    return this.meta.cell_m;
  }

  get bbox(): Bbox {
    const { x0, y0, nx, ny, cell_m } = this.meta;
    return { minX: x0, minY: y0, maxX: x0 + nx * cell_m, maxY: y0 + ny * cell_m };
  }

  /** Centre coordinate of cell (i, j). */
  cellCentre(i: number, j: number): Pt {
    const { x0, y0, cell_m } = this.meta;
    return [x0 + cell_m * (i + 0.5), y0 + cell_m * (j + 0.5)];
  }

  /** Cell indices containing a point, or null when outside the grid. */
  cellAt(p: Pt): { i: number; j: number } | null {
    const { x0, y0, cell_m, nx, ny } = this.meta;
    const i = Math.floor((p[0] - x0) / cell_m);
    const j = Math.floor((p[1] - y0) / cell_m);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
    return { i, j };
  }

  at(i: number, j: number): number {
    const { nx, ny } = this.meta;
    if (i < 0 || j < 0 || i >= nx || j >= ny) return NA;
    return this.values[j * nx + i]!;
  }

  /** Nearest-cell RL at a point. NaN when unsurveyed or off-grid. */
  sample(p: Pt): number {
    const c = this.cellAt(p);
    return c ? this.at(c.i, c.j) : NA;
  }

  /** Bilinear RL at a point; falls back to nearest-cell when a neighbour is NaN. */
  sampleBilinear(p: Pt): number {
    const { x0, y0, cell_m } = this.meta;
    const fx = (p[0] - x0) / cell_m - 0.5;
    const fy = (p[1] - y0) / cell_m - 0.5;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const v00 = this.at(i, j);
    const v10 = this.at(i + 1, j);
    const v01 = this.at(i, j + 1);
    const v11 = this.at(i + 1, j + 1);
    if (![v00, v10, v01, v11].every(Number.isFinite)) return this.sample(p);
    return (
      v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
    );
  }

  stats(): DemStats {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let n = 0;
    for (const v of this.values) {
      if (!Number.isFinite(v)) continue;
      n++;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return {
      validCells: n,
      totalCells: this.values.length,
      areaM2: n * this.cell * this.cell,
      rlMin: n ? min : NA,
      rlMax: n ? max : NA,
      rlMean: n ? sum / n : NA,
    };
  }

  /**
   * Horn's method over the 3x3 neighbourhood. Cells whose neighbourhood touches
   * a NaN return NaN rather than a slope computed against missing ground.
   */
  private computeSlopeAspect(): void {
    const { nx, ny, cell_m } = this.meta;
    const slope = new Float32Array(nx * ny).fill(NA);
    const aspect = new Float32Array(nx * ny).fill(NA);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const z = [
          this.at(i - 1, j + 1), this.at(i, j + 1), this.at(i + 1, j + 1),
          this.at(i - 1, j),     this.at(i, j),     this.at(i + 1, j),
          this.at(i - 1, j - 1), this.at(i, j - 1), this.at(i + 1, j - 1),
        ];
        if (!z.every(Number.isFinite)) continue;
        const dzdx = (z[2]! + 2 * z[5]! + z[8]! - (z[0]! + 2 * z[3]! + z[6]!)) / (8 * cell_m);
        const dzdy = (z[0]! + 2 * z[1]! + z[2]! - (z[6]! + 2 * z[7]! + z[8]!)) / (8 * cell_m);
        const k = j * nx + i;
        slope[k] = toDeg(Math.atan(Math.hypot(dzdx, dzdy)));
        const bearing = toDeg(Math.atan2(dzdy, -dzdx));
        aspect[k] = ((90 - bearing) % 360 + 360) % 360;
      }
    }
    this.slopeCache = slope;
    this.aspectCache = aspect;
  }

  slopeGrid(): Float32Array {
    if (!this.slopeCache) this.computeSlopeAspect();
    return this.slopeCache!;
  }

  aspectGrid(): Float32Array {
    if (!this.aspectCache) this.computeSlopeAspect();
    return this.aspectCache!;
  }

  slopeAt(p: Pt): SlopeSample {
    const c = this.cellAt(p);
    if (!c) return { slopeDeg: NA, aspectDeg: NA };
    const k = c.j * this.meta.nx + c.i;
    return { slopeDeg: this.slopeGrid()[k]!, aspectDeg: this.aspectGrid()[k]! };
  }

  /**
   * Area in each slope band, in acres. `withinMulti` restricts the count to
   * cells whose centre falls inside the given polygons.
   */
  slopeBandsAc(edges: readonly number[], withinMulti?: MultiPoly): number[] {
    const slope = this.slopeGrid();
    const cellAc = (this.cell * this.cell) / M2_PER_ACRE;
    const out = new Array<number>(Math.max(0, edges.length - 1)).fill(0);
    this.forEachCell((i, j, k) => {
      const s = slope[k]!;
      if (!Number.isFinite(s)) return;
      if (withinMulti && !pointInMulti(this.cellCentre(i, j), withinMulti)) return;
      for (let b = 0; b < out.length; b++) {
        if (s >= edges[b]! && s < edges[b + 1]!) {
          out[b]! += cellAc;
          break;
        }
      }
    });
    return out;
  }

  private forEachCell(fn: (i: number, j: number, k: number) => void): void {
    const { nx, ny } = this.meta;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) fn(i, j, j * nx + i);
  }

  /**
   * Moving-window fall (max - min RL) over a plot-sized window, the measure the
   * survey evaluation used to judge how much of the site takes a plot without a
   * level change. `minValidFraction` lets a window straddle the survey edge.
   */
  windowFallGrid(windowX: number, windowY: number, minValidFraction = 0.75): Float32Array {
    const { nx, ny, cell_m } = this.meta;
    // Smallest cell window that fully contains the plot window: a 11.4 x 14.2 m
    // plot needs 6 x 8 cells (12 x 16 m) on the 2 m grid.
    const wx = Math.max(1, Math.ceil(windowX / cell_m));
    const wy = Math.max(1, Math.ceil(windowY / cell_m));
    const needed = minValidFraction * wx * wy;
    const halfX = Math.floor(wx / 2);
    const halfY = Math.floor(wy / 2);
    const out = new Float32Array(nx * ny).fill(NA);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!Number.isFinite(this.at(i, j))) continue;
        let min = Infinity;
        let max = -Infinity;
        let count = 0;
        for (let dj = 0; dj < wy; dj++) {
          for (let di = 0; di < wx; di++) {
            const v = this.at(i - halfX + di, j - halfY + dj);
            if (!Number.isFinite(v)) continue;
            count++;
            if (v < min) min = v;
            if (v > max) max = v;
          }
        }
        if (count >= needed) out[j * nx + i] = max - min;
      }
    }
    return out;
  }

  /** Acres per fall band, from `windowFallGrid`. */
  fallBandsAc(
    edges: readonly number[],
    windowX: number,
    windowY: number,
    minValidFraction = 0.75,
  ): { bands: number[]; totalAc: number; medianFall: number } {
    const fall = this.windowFallGrid(windowX, windowY, minValidFraction);
    const cellAc = (this.cell * this.cell) / M2_PER_ACRE;
    const bands = new Array<number>(Math.max(0, edges.length - 1)).fill(0);
    const values: number[] = [];
    for (const f of fall) {
      if (!Number.isFinite(f)) continue;
      values.push(f);
      for (let b = 0; b < bands.length; b++) {
        if (f >= edges[b]! && f < edges[b + 1]!) {
          bands[b]! += cellAc;
          break;
        }
      }
    }
    values.sort((a, b) => a - b);
    const median = values.length ? values[Math.floor(values.length / 2)]! : NA;
    return { bands, totalAc: values.length * cellAc, medianFall: median };
  }

  /** Per-cell fall, min, max, median and NaN share inside a polygon. */
  terrainIn(mp: MultiPoly): {
    count: number;
    nanCount: number;
    min: number;
    max: number;
    median: number;
    fall: number;
    meanSlopeDeg: number;
  } {
    const b = bboxOfMulti(mp);
    const vals: number[] = [];
    const slopes: number[] = [];
    let nan = 0;
    const iMin = Math.max(0, Math.floor((b.minX - this.meta.x0) / this.cell));
    const iMax = Math.min(this.meta.nx - 1, Math.ceil((b.maxX - this.meta.x0) / this.cell));
    const jMin = Math.max(0, Math.floor((b.minY - this.meta.y0) / this.cell));
    const jMax = Math.min(this.meta.ny - 1, Math.ceil((b.maxY - this.meta.y0) / this.cell));
    const slope = this.slopeGrid();
    for (let j = jMin; j <= jMax; j++) {
      for (let i = iMin; i <= iMax; i++) {
        if (!pointInMulti(this.cellCentre(i, j), mp)) continue;
        const v = this.at(i, j);
        if (!Number.isFinite(v)) {
          nan++;
          continue;
        }
        vals.push(v);
        const s = slope[j * this.meta.nx + i]!;
        if (Number.isFinite(s)) slopes.push(s);
      }
    }
    if (vals.length === 0) {
      return { count: 0, nanCount: nan, min: NA, max: NA, median: NA, fall: NA, meanSlopeDeg: NA };
    }
    vals.sort((a, c) => a - c);
    const min = vals[0]!;
    const max = vals[vals.length - 1]!;
    return {
      count: vals.length,
      nanCount: nan,
      min,
      max,
      median: vals[Math.floor(vals.length / 2)]!,
      fall: max - min,
      meanSlopeDeg: slopes.length ? slopes.reduce((s, v) => s + v, 0) / slopes.length : NA,
    };
  }
}

/** Parses the raw little-endian float32 grid described by dem_2m.json. */
export function demFromBuffer(meta: DemMeta, buffer: ArrayBuffer): Dem {
  const expected = meta.nx * meta.ny * 4;
  if (buffer.byteLength !== expected) {
    throw new Error(`dem_2m.f32: expected ${expected} bytes, got ${buffer.byteLength}`);
  }
  const view = new DataView(buffer);
  const values = new Float32Array(meta.nx * meta.ny);
  for (let k = 0; k < values.length; k++) values[k] = view.getFloat32(k * 4, true);
  return new Dem(meta, values);
}
