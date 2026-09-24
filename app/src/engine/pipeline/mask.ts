import type { Dem } from '../terrain/dem';
import type { MultiPoly, Poly, Pt, Ring } from '../geom/types';
import { bboxOfMulti, pointInRing, ringSignedArea } from '../geom/planar';

/**
 * Masks on the DEM grid: one byte per 2 m cell, 1 = in.
 *
 * The planning layers are worked out on the grid, where combining them is
 * exact and cheap — a union is an OR, a buffer is a distance transform — and
 * turned into polygons only at the end, by tracing the cell edges. Polygon
 * booleans over tens of thousands of cell squares would be slow and fragile;
 * this is neither.
 */
export type Mask = Uint8Array;

export const emptyMask = (dem: Dem): Mask => new Uint8Array(dem.meta.nx * dem.meta.ny);

export function maskFrom(dem: Dem, test: (k: number) => boolean): Mask {
  const m = emptyMask(dem);
  for (let k = 0; k < m.length; k += 1) if (test(k)) m[k] = 1;
  return m;
}

/**
 * Cells whose centre lies inside the polygons, by scanline: each row's centre
 * line is crossed with every ring edge and filled between pairs of crossings
 * (even-odd, so holes come out as holes). The polygons must not overlap each
 * other, which holds for anything that came out of a union.
 */
export function rasterise(dem: Dem, mp: MultiPoly): Mask {
  const m = emptyMask(dem);
  if (mp.length === 0) return m;
  const b = bboxOfMulti(mp);
  const { x0, y0, cell_m, nx, ny } = dem.meta;
  const j0 = Math.max(0, Math.floor((b.minY - y0) / cell_m));
  const j1 = Math.min(ny - 1, Math.ceil((b.maxY - y0) / cell_m));
  const rings = mp.flat();
  const xs: number[] = [];
  for (let j = j0; j <= j1; j += 1) {
    const y = y0 + cell_m * (j + 0.5);
    xs.length = 0;
    for (const ring of rings) {
      for (let a = 0, c = ring.length - 1; a < ring.length; c = a, a += 1) {
        const p = ring[a]!;
        const q = ring[c]!;
        // Half-open in y so a vertex on the scanline is counted once.
        if (p[1] > y !== q[1] > y) xs.push(p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
      }
    }
    xs.sort((u, v) => u - v);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      // Cells whose centre x lies in [xs[s], xs[s+1]).
      const iFrom = Math.max(0, Math.ceil((xs[s]! - x0) / cell_m - 0.5));
      const iTo = Math.min(nx - 1, Math.ceil((xs[s + 1]! - x0) / cell_m - 0.5) - 1);
      for (let i = iFrom; i <= iTo; i += 1) m[j * nx + i] = 1;
    }
  }
  return m;
}

export function and(a: Mask, b: Mask): Mask {
  const out = new Uint8Array(a.length);
  for (let k = 0; k < a.length; k += 1) out[k] = a[k]! & b[k]!;
  return out;
}

export function or(...masks: Mask[]): Mask {
  const out = new Uint8Array(masks[0]!.length);
  for (const m of masks) for (let k = 0; k < m.length; k += 1) out[k] = out[k]! | m[k]!;
  return out;
}

/** a AND NOT (b OR c ...). */
export function minus(a: Mask, ...b: Mask[]): Mask {
  const out = Uint8Array.from(a);
  for (const m of b) for (let k = 0; k < m.length; k += 1) if (m[k]) out[k] = 0;
  return out;
}

export const count = (m: Mask): number => m.reduce((n, v) => n + v, 0);
export const areaM2 = (dem: Dem, m: Mask): number => count(m) * dem.cell * dem.cell;

/**
 * Exact Euclidean metres from every cell centre to the nearest cell centre
 * where `seed` is 1 (Felzenszwalb and Huttenlocher's separable transform: a
 * lower envelope of parabolas along each column, then each row). A chamfer
 * approximation overshoots diagonals by up to 8%, which shaved the corners of
 * every zone and made opening depend on how many times it was run.
 */
export function distanceTo(dem: Dem, seed: Mask): Float32Array {
  const { nx, ny } = dem.meta;
  const INF = 1e20;
  const g = new Float64Array(nx * ny);
  for (let k = 0; k < g.length; k += 1) g[k] = seed[k] ? 0 : INF;
  const n = Math.max(nx, ny);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const pass = (len: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q += 1) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k -= 1;
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q += 1) {
      while (z[k + 1]! < q) k += 1;
      const dq = q - v[k]!;
      d[q] = dq * dq + f[v[k]!]!;
    }
  };
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) f[j] = g[j * nx + i]!;
    pass(ny);
    for (let j = 0; j < ny; j += 1) g[j * nx + i] = d[j]!;
  }
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) f[i] = g[j * nx + i]!;
    pass(nx);
    for (let i = 0; i < nx; i += 1) out[j * nx + i] = d[i]! >= INF / 2 ? Number.POSITIVE_INFINITY : Math.sqrt(d[i]!) * dem.cell;
  }
  return out;
}

/** Cells within `r` metres of the mask. */
export function dilate(dem: Dem, m: Mask, r: number): Mask {
  if (r <= 0) return Uint8Array.from(m);
  const dist = distanceTo(dem, m);
  return maskFrom(dem, (k) => dist[k]! <= r);
}

/** Cells at least `r` metres inside the mask (measured centre to centre from the nearest outside cell). */
export function erode(dem: Dem, m: Mask, r: number): Mask {
  if (r <= 0) return Uint8Array.from(m);
  const outside = maskFrom(dem, (k) => m[k] === 0);
  const dist = distanceTo(dem, outside);
  // A cell's centre sits half a cell from the edge of its outside neighbour.
  return maskFrom(dem, (k) => m[k] === 1 && dist[k]! - dem.cell / 2 >= r);
}

/**
 * Morphological opening with a disc of `width / 2`: keeps only the parts of
 * the mask a `width`-wide disc can reach while staying inside. Anything
 * narrower than `width` — a neck, a sliver, a spur — is removed.
 */
export function openToWidth(dem: Dem, m: Mask, width: number): Mask {
  const r = width / 2;
  // Cells are squares, not points. A disc centred on a core cell fits when
  // no outside square comes within r (erode allows the half cell), and it
  // covers every square it touches: centres up to r + half a cell away. The
  // same allowance both ways makes opening idempotent — opening twice changes
  // nothing — which it must be to mean "wide enough".
  const core = erode(dem, m, r);
  return and(dilate(dem, core, r + dem.cell / 2), m);
}

/** Connected patches (8-neighbour), as cell lists. */
export function patches(dem: Dem, m: Mask): number[][] {
  const { nx, ny } = dem.meta;
  const seen = new Uint8Array(m.length);
  const out: number[][] = [];
  for (let start = 0; start < m.length; start += 1) {
    if (!m[start] || seen[start]) continue;
    const cells: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const k = stack.pop()!;
      cells.push(k);
      const i = k % nx;
      const j = (k - i) / nx;
      for (let dj = -1; dj <= 1; dj += 1) {
        for (let di = -1; di <= 1; di += 1) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
          const nk = nj * nx + ni;
          if (!m[nk] || seen[nk]) continue;
          seen[nk] = 1;
          stack.push(nk);
        }
      }
    }
    out.push(cells);
  }
  return out;
}

/** Drops patches smaller than `minM2`. */
export function dropSmall(dem: Dem, m: Mask, minM2: number): Mask {
  if (minM2 <= 0) return Uint8Array.from(m);
  const out = Uint8Array.from(m);
  const cellArea = dem.cell * dem.cell;
  for (const p of patches(dem, m)) {
    if (p.length * cellArea >= minM2) continue;
    for (const k of p) out[k] = 0;
  }
  return out;
}

/**
 * The mask as polygons, traced along cell edges. Outer rings run
 * anticlockwise, holes clockwise; where two cells touch only at a corner they
 * are kept apart (4-connected), so no ring ever crosses itself.
 */
export function toMulti(dem: Dem, m: Mask, smooth = false): MultiPoly {
  const { nx, ny, x0, y0, cell_m } = dem.meta;
  const on = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < nx && j < ny && m[j * nx + i] === 1;
  // Vertices are lattice corners (i, j) with key j * (nx + 1) + i.
  const W = nx + 1;
  const out = new Map<number, number[]>(); // start corner -> end corners
  const addEdge = (a: number, b: number): void => {
    const list = out.get(a);
    if (list) list.push(b);
    else out.set(a, [b]);
  };
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      if (!on(i, j)) continue;
      // Inside on the left of every edge.
      if (!on(i, j - 1)) addEdge(j * W + i, j * W + i + 1); // bottom, eastward
      if (!on(i + 1, j)) addEdge(j * W + i + 1, (j + 1) * W + i + 1); // right, northward
      if (!on(i, j + 1)) addEdge((j + 1) * W + i + 1, (j + 1) * W + i); // top, westward
      if (!on(i - 1, j)) addEdge((j + 1) * W + i, j * W + i); // left, southward
    }
  }

  const rings: Ring[] = [];
  const corner = (key: number): Pt => [x0 + cell_m * (key % W), y0 + cell_m * Math.floor(key / W)];
  const step = (a: number, b: number): [number, number] => [(b % W) - (a % W), Math.floor(b / W) - Math.floor(a / W)];
  // Every corner has as many edges out as in, so a walk always closes.
  for (const startKey of [...out.keys()]) {
    while (out.get(startKey)!.length > 0) {
      const ring: number[] = [startKey];
      let cur = out.get(startKey)!.pop()!;
      let dir = step(startKey, cur);
      while (cur !== startKey) {
        ring.push(cur);
        const next = out.get(cur)!;
        let pick = 0;
        if (next.length > 1) {
          // A corner pinch: turn left, hugging the cell being walked round.
          const idx = next.findIndex((e) => {
            const s = step(cur, e);
            return s[0] === -dir[1] && s[1] === dir[0];
          });
          pick = idx >= 0 ? idx : 0;
        }
        const nxt = next.splice(pick, 1)[0]!;
        dir = step(cur, nxt);
        cur = nxt;
      }
      const r = simplify(ring.map(corner));
      rings.push(smooth ? smoothRing(r, cell_m) : r);
    }
  }

  const outers: { ring: Ring; area: number; holes: Ring[] }[] = [];
  const holes: Ring[] = [];
  for (const r of rings) {
    if (r.length < 3) continue;
    const a = ringSignedArea(r);
    if (a > 0) outers.push({ ring: r, area: a, holes: [] });
    else if (a < 0) holes.push(r);
  }
  outers.sort((p, q) => p.area - q.area);
  for (const h of holes) {
    // A hole's corners sit inside its outer ring; the smallest ring holding one is its owner.
    const probe = h[0]!;
    const inner = midpointInside(h);
    const owner = outers.find((o) => pointInRing(inner ?? probe, o.ring));
    if (owner) owner.holes.push(h);
  }
  return outers.map((o): Poly => [o.ring, ...o.holes]);
}

/** A point just inside a clockwise hole ring's edge — i.e. in the region it bounds. */
function midpointInside(h: Ring): Pt | null {
  const a = h[0]!;
  const b = h[1]!;
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len === 0) return null;
  // For a clockwise ring the filled side (the outer polygon's interior) is on
  // the left of the walking direction: step a hair that way.
  return [mx - ((b[1] - a[1]) / len) * 1e-3, my + ((b[0] - a[0]) / len) * 1e-3];
}

/**
 * A traced ring without its 2 m staircase, for drawing: every corner is cut
 * back to the middle of its edges (so a run of cell steps becomes a straight
 * diagonal), then straightened within a third of a cell. Orientation is kept,
 * so outers and holes still sort by the sign of their area.
 */
export function smoothRing(r: Ring, cell: number): Ring {
  const n = r.length;
  if (n < 4) return r;
  const cut: Pt[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = r[(i - 1 + n) % n]!;
    const c = r[i]!;
    const q = r[(i + 1) % n]!;
    const lp = Math.hypot(p[0] - c[0], p[1] - c[1]);
    const lq = Math.hypot(q[0] - c[0], q[1] - c[1]);
    const t = Math.min(cell / 2, lp / 2, lq / 2);
    if (lp > 0) cut.push([c[0] + ((p[0] - c[0]) * t) / lp, c[1] + ((p[1] - c[1]) * t) / lp]);
    if (lq > 0) cut.push([c[0] + ((q[0] - c[0]) * t) / lq, c[1] + ((q[1] - c[1]) * t) / lq]);
  }
  const out = dpRing(cut, cell / 3);
  return out.length >= 3 ? out : r;
}

function dpOpen(pts: readonly Pt[], tol: number): Pt[] {
  if (pts.length < 3) return [...pts];
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
    const L = Math.hypot(dx, dy);
    let best = -1;
    let far = 0;
    for (let i = a + 1; i < b; i += 1) {
      const P = pts[i]!;
      const d = L > 0 ? Math.abs(dx * (A[1] - P[1]) - dy * (A[0] - P[0])) / L : Math.hypot(P[0] - A[0], P[1] - A[1]);
      if (d > far) {
        far = d;
        best = i;
      }
    }
    if (best >= 0 && far > tol) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

function dpRing(pts: readonly Pt[], tol: number): Pt[] {
  if (pts.length < 5) return [...pts];
  // Split at the point furthest from the first, so both halves are open lines.
  let far = 0;
  let fd = -1;
  for (let i = 1; i < pts.length; i += 1) {
    const d = Math.hypot(pts[i]![0] - pts[0]![0], pts[i]![1] - pts[0]![1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const a = dpOpen(pts.slice(0, far + 1), tol);
  const b = dpOpen([...pts.slice(far), pts[0]!], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Drops corners where the edge carries straight on. */
function simplify(pts: Pt[]): Ring {
  const n = pts.length;
  if (n < 4) return pts;
  const out: Pt[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = pts[(i - 1 + n) % n]!;
    const c = pts[i]!;
    const q = pts[(i + 1) % n]!;
    const cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]);
    if (Math.abs(cross) > 1e-9) out.push(c);
  }
  return out;
}
