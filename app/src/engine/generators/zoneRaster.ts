import type { MultiPoly, Pt } from '../geom/types';
import { bboxOfMulti, pointInMulti } from '../geom/planar';
import type { Dem } from '../terrain/dem';

export const CELL_OUTSIDE = 0;
export const CELL_BUILDABLE = 1;
export const CELL_STEEP = 2;
export const CELL_NOGO = 3;

/**
 * A 2 m raster of one zone, aligned to the DEM grid. The generators search over
 * hundreds of road layouts, and testing each plot with polygon booleans is far
 * too slow; classifying the zone's cells once and then working in cell space
 * makes a search pass cost a few thousand integer operations.
 *
 * The raster decides what is buildable and measures areas. Plot, road and
 * open-space geometry stays exact.
 */
export class ZoneRaster {
  readonly dem: Dem;
  readonly i0: number;
  readonly j0: number;
  readonly nx: number;
  readonly ny: number;
  readonly cell: number;
  readonly cellAreaM2: number;
  readonly code: Uint8Array;
  /**
   * `code` eroded by one cell: 1 only where the cell and all eight of its
   * neighbours are buildable. A plot whose cell centres are all usable sits at
   * least half a cell clear of the zone boundary and of any Rule 22 ground, so
   * an exact plot rectangle cannot overhang either.
   */
  readonly usable: Uint8Array;
  readonly rl: Float32Array;
  readonly zoneCells: number;
  readonly buildableCells: number;
  readonly steepCells: number;
  readonly unsurveyedCells: number;

  constructor(dem: Dem, zone: MultiPoly, slopeLimitDeg: number, noGo: MultiPoly = []) {
    this.dem = dem;
    this.cell = dem.cell;
    this.cellAreaM2 = dem.cell * dem.cell;
    const b = bboxOfMulti(zone);
    const meta = dem.meta;
    this.i0 = Math.max(0, Math.floor((b.minX - meta.x0) / this.cell) - 1);
    this.j0 = Math.max(0, Math.floor((b.minY - meta.y0) / this.cell) - 1);
    const i1 = Math.min(meta.nx - 1, Math.ceil((b.maxX - meta.x0) / this.cell) + 1);
    const j1 = Math.min(meta.ny - 1, Math.ceil((b.maxY - meta.y0) / this.cell) + 1);
    this.nx = Math.max(0, i1 - this.i0 + 1);
    this.ny = Math.max(0, j1 - this.j0 + 1);

    const n = this.nx * this.ny;
    this.code = new Uint8Array(n);
    this.rl = new Float32Array(n).fill(Number.NaN);
    const slope = dem.slopeGrid();

    let zoneCells = 0;
    let buildable = 0;
    let steep = 0;
    let unsurveyed = 0;
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const centre = this.centre(i, j);
        if (!pointInMulti(centre, zone)) continue;
        zoneCells++;
        const k = j * this.nx + i;
        const v = dem.at(this.i0 + i, this.j0 + j);
        this.rl[k] = v;
        if (!Number.isFinite(v)) unsurveyed++;
        const s = slope[(this.j0 + j) * meta.nx + (this.i0 + i)]!;
        if (Number.isFinite(s) && s > slopeLimitDeg) {
          this.code[k] = CELL_STEEP;
          steep++;
        } else if (noGo.length > 0 && pointInMulti(centre, noGo)) {
          this.code[k] = CELL_NOGO;
        } else {
          // Unsurveyed ground stays buildable but is flagged low-confidence;
          // it is never silently filled.
          this.code[k] = CELL_BUILDABLE;
          buildable++;
        }
      }
    }
    this.zoneCells = zoneCells;
    this.buildableCells = buildable;
    this.steepCells = steep;
    this.unsurveyedCells = unsurveyed;

    this.usable = new Uint8Array(n);
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        if (this.code[j * this.nx + i] !== CELL_BUILDABLE) continue;
        let clear = true;
        for (let dj = -1; dj <= 1 && clear; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (this.at(i + di, j + dj) !== CELL_BUILDABLE) {
              clear = false;
              break;
            }
          }
        }
        if (clear) this.usable[j * this.nx + i] = 1;
      }
    }
  }

  isUsable(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return false;
    return this.usable[j * this.nx + i] === 1;
  }

  /** True where the cell containing this world point is usable. */
  isUsableAt(p: Pt): boolean {
    const c = this.dem.cellAt(p);
    if (!c) return false;
    return this.isUsable(c.i - this.i0, c.j - this.j0);
  }

  centre(i: number, j: number): Pt {
    return this.dem.cellCentre(this.i0 + i, this.j0 + j);
  }

  at(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return CELL_OUTSIDE;
    return this.code[j * this.nx + i]!;
  }

  rlAt(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return Number.NaN;
    return this.rl[j * this.nx + i]!;
  }

  get zoneAreaM2(): number {
    return this.zoneCells * this.cellAreaM2;
  }

  get buildableAreaM2(): number {
    return this.buildableCells * this.cellAreaM2;
  }

  get steepAreaM2(): number {
    return this.steepCells * this.cellAreaM2;
  }

  get unsurveyedAreaM2(): number {
    return this.unsurveyedCells * this.cellAreaM2;
  }
}
