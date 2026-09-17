import { Clipper, EndType, FillRule, JoinType, Path64, Paths64, Point64 } from 'clipper2-js';
import type { MultiPoly, Pt, Ring } from './types';
import { openRing, polyArea } from './planar';

/**
 * Clipper2 works on integers. Local metres scaled by 1000 gives millimetre
 * resolution, which is well below any dimension this project cares about and
 * leaves ~9e12 headroom on the site's few-hundred-metre coordinates.
 */
const SCALE = 1000;

const toPaths = (mp: MultiPoly): Paths64 => {
  const paths = new Paths64();
  for (const poly of mp) {
    for (const ring of poly) {
      const path = new Path64();
      for (const [x, y] of ring) path.push(new Point64(Math.round(x * SCALE), Math.round(y * SCALE)));
      paths.push(path);
    }
  }
  return paths;
};

/**
 * Clipper returns a flat path list; positive rings are outers and negative
 * rings are holes. Reassemble by nesting each hole in the smallest outer whose
 * bounding box contains it (adequate for the simple shapes this engine makes).
 */
function fromPaths(paths: Paths64): MultiPoly {
  const outers: { ring: Ring; area: number }[] = [];
  const holes: Ring[] = [];
  for (const path of paths) {
    const ring = openRing(path.map((p) => [p.x / SCALE, p.y / SCALE] as Pt));
    if (ring.length < 3) continue;
    if (Clipper.isPositive(path)) outers.push({ ring, area: Math.abs(Clipper.area(path)) / SCALE ** 2 });
    else holes.push(ring);
  }
  const result: MultiPoly = outers
    .sort((a, b) => b.area - a.area)
    .map(({ ring }) => [ring] as Ring[]);
  for (const hole of holes) {
    const pt = hole[0]!;
    let bestIdx = -1;
    let bestArea = Infinity;
    result.forEach((poly, i) => {
      const area = polyArea(poly);
      if (area < bestArea && pointInside(pt, poly[0]!)) {
        bestIdx = i;
        bestArea = area;
      }
    });
    if (bestIdx >= 0) result[bestIdx]!.push(hole);
  }
  return result.filter((poly) => polyArea(poly) > 1e-9);
}

function pointInside(pt: Pt, ring: Ring): boolean {
  const [x, y] = pt;
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Offset a polygon set. Negative `delta` shrinks (the usual case here: setbacks,
 * yards, the 6 m inward zone offset). Miter joins keep plot and tower corners
 * square, which is what a DXF consumer expects.
 */
export function offsetMulti(mp: MultiPoly, delta: number, join: JoinType = JoinType.Miter): MultiPoly {
  if (mp.length === 0) return [];
  if (delta === 0) return mp;
  const out = Clipper.InflatePaths(toPaths(mp), delta * SCALE, join, EndType.Polygon, 2);
  return fromPaths(out);
}

/** Buffer an open polyline into a strip of the given total width. */
export function bufferPolyline(line: readonly Pt[], width: number, square = true): MultiPoly {
  if (line.length < 2 || width <= 0) return [];
  const paths = new Paths64();
  const path = new Path64();
  for (const [x, y] of line) path.push(new Point64(Math.round(x * SCALE), Math.round(y * SCALE)));
  paths.push(path);
  const out = Clipper.InflatePaths(
    paths,
    (width / 2) * SCALE,
    JoinType.Miter,
    square ? EndType.Butt : EndType.Round,
    2,
  );
  return fromPaths(out);
}

/** Union via Clipper (used where polygon-clipping's robustness is not enough). */
export function unionStrict(mp: MultiPoly): MultiPoly {
  if (mp.length === 0) return [];
  return fromPaths(Clipper.Union(toPaths(mp), undefined, FillRule.NonZero));
}

export { JoinType };
