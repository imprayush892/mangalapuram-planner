import type { MultiPoly, Pt } from '../geom/types';
import { pointInMulti } from '../geom/planar';
import { M2_PER_ACRE, toDeg } from '../units';

export interface TinFaceStats {
  faces: number;
  planAreaM2: number;
  surfaceAreaM2: number;
  /** surface / plan; 1.0 is dead flat. */
  rugosity: number;
  meanSlopeDeg: number;
}

/**
 * The parcel-clipped survey TIN (data/raw/survey/*.obj, copied to
 * public/data/terrain/terrain_tin.obj by scripts/sync-data.mjs).
 *
 * The TIN — not the resampled DEM — is what the survey evaluation measured, so
 * the golden slope-band acreages are reproduced from facets here.
 */
export class Tin {
  readonly vertices: Float64Array;
  readonly faces: Uint32Array;

  constructor(vertices: Float64Array, faces: Uint32Array) {
    this.vertices = vertices;
    this.faces = faces;
  }

  get vertexCount(): number {
    return this.vertices.length / 3;
  }

  get faceCount(): number {
    return this.faces.length / 3;
  }

  vertex(index: number): [number, number, number] {
    const k = index * 3;
    return [this.vertices[k]!, this.vertices[k + 1]!, this.vertices[k + 2]!];
  }

  rlRange(): { min: number; max: number; summit: Pt; summitRl: number } {
    let min = Infinity;
    let max = -Infinity;
    let summit: Pt = [0, 0];
    for (let v = 0; v < this.vertexCount; v++) {
      const z = this.vertices[v * 3 + 2]!;
      if (z < min) min = z;
      if (z > max) {
        max = z;
        summit = [this.vertices[v * 3]!, this.vertices[v * 3 + 1]!];
      }
    }
    return { min, max, summit, summitRl: max };
  }

  /**
   * Per-facet plan area and slope. `within` restricts to facets whose centroid
   * lies inside the given polygons.
   */
  facets(within?: MultiPoly): { planArea: Float64Array; slopeDeg: Float64Array; surfaceArea: Float64Array } {
    const n = this.faceCount;
    const planArea = new Float64Array(n);
    const slopeDeg = new Float64Array(n);
    const surfaceArea = new Float64Array(n);
    for (let f = 0; f < n; f++) {
      const a = this.vertex(this.faces[f * 3]!);
      const b = this.vertex(this.faces[f * 3 + 1]!);
      const c = this.vertex(this.faces[f * 3 + 2]!);
      if (within) {
        const centroid: Pt = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
        if (!pointInMulti(centroid, within)) continue;
      }
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uz = b[2] - a[2];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      const vz = c[2] - a[2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const nLen = Math.hypot(nx, ny, nz);
      planArea[f] = Math.abs(nz) / 2;
      surfaceArea[f] = nLen / 2;
      slopeDeg[f] = toDeg(Math.atan2(Math.hypot(nx, ny), Math.abs(nz)));
    }
    return { planArea, slopeDeg, surfaceArea };
  }

  /** Plan-area acres per slope band, the measure the survey report published. */
  slopeBandsAc(edges: readonly number[], within?: MultiPoly): number[] {
    const { planArea, slopeDeg } = this.facets(within);
    const out = new Array<number>(Math.max(0, edges.length - 1)).fill(0);
    for (let f = 0; f < planArea.length; f++) {
      const area = planArea[f]!;
      if (area <= 0) continue;
      const s = slopeDeg[f]!;
      for (let b = 0; b < out.length; b++) {
        if (s >= edges[b]! && s < edges[b + 1]!) {
          out[b]! += area / M2_PER_ACRE;
          break;
        }
      }
    }
    return out;
  }

  stats(within?: MultiPoly): TinFaceStats {
    const { planArea, slopeDeg, surfaceArea } = this.facets(within);
    let plan = 0;
    let surface = 0;
    let slopeSum = 0;
    let n = 0;
    for (let f = 0; f < planArea.length; f++) {
      if (planArea[f]! <= 0) continue;
      plan += planArea[f]!;
      surface += surfaceArea[f]!;
      slopeSum += slopeDeg[f]! * planArea[f]!;
      n++;
    }
    return {
      faces: n,
      planAreaM2: plan,
      surfaceAreaM2: surface,
      rugosity: plan > 0 ? surface / plan : Number.NaN,
      meanSlopeDeg: plan > 0 ? slopeSum / plan : Number.NaN,
    };
  }
}

/** Minimal Wavefront OBJ reader: `v` and triangular `f` records only. */
export function parseObj(text: string): Tin {
  const verts: number[] = [];
  const faces: number[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length < 2) continue;
    const line = rawLine.trimStart();
    if (line.startsWith('v ')) {
      const parts = line.split(/\s+/);
      verts.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (line.startsWith('f ')) {
      const parts = line.split(/\s+/).slice(1);
      const idx = parts.map((p) => Number(p.split('/')[0]) - 1);
      // Triangulate as a fan so quads survive, though this TIN is all triangles.
      for (let k = 2; k < idx.length; k++) faces.push(idx[0]!, idx[k - 1]!, idx[k]!);
    }
  }
  return new Tin(Float64Array.from(verts), Uint32Array.from(faces));
}
