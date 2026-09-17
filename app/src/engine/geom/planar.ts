import type { Bbox, MultiPoly, Poly, Pt, Ring } from './types';

/** Signed area of a ring: positive when the ring winds counter-clockwise. */
export function ringSignedArea(ring: Ring): number {
  let s = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    s += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return s / 2;
}

export const ringArea = (ring: Ring): number => Math.abs(ringSignedArea(ring));

/** Polygon area = outer ring minus holes. */
export function polyArea(poly: Poly): number {
  if (poly.length === 0) return 0;
  return poly.reduce((sum, ring, i) => sum + (i === 0 ? ringArea(ring) : -ringArea(ring)), 0);
}

export const multiPolyArea = (mp: MultiPoly): number => mp.reduce((s, p) => s + polyArea(p), 0);

export function ringPerimeter(ring: Ring): number {
  let p = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) p += dist(ring[j]!, ring[i]!);
  return p;
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const dist2 = (a: Pt, b: Pt): number => (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;

export function ensureOrientation(ring: Ring, counterClockwise: boolean): Ring {
  const ccw = ringSignedArea(ring) > 0;
  return ccw === counterClockwise ? ring : [...ring].reverse();
}

/** Drops a duplicated closing vertex, as GeoJSON rings carry one. */
export function openRing(ring: Ring): Ring {
  if (ring.length < 2) return [...ring];
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  return first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : [...ring];
}

export function bboxOf(pts: readonly Pt[]): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxOfPoly(poly: Poly): Bbox {
  return bboxOf(poly[0] ?? []);
}

export function bboxOfMulti(mp: MultiPoly): Bbox {
  return bboxOf(mp.flatMap((p) => p[0] ?? []));
}

export function bboxUnion(a: Bbox, b: Bbox): Bbox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export const bboxWidth = (b: Bbox): number => b.maxX - b.minX;
export const bboxHeight = (b: Bbox): number => b.maxY - b.minY;
export const bboxCentre = (b: Bbox): Pt => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** Even-odd ray cast. Points exactly on an edge may return either result. */
export function pointInRing(pt: Pt, ring: Ring): boolean {
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

export function pointInPoly(pt: Pt, poly: Poly): boolean {
  const outer = poly[0];
  if (!outer || !pointInRing(pt, outer)) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(pt, poly[i]!)) return false;
  return true;
}

export const pointInMulti = (pt: Pt, mp: MultiPoly): boolean => mp.some((p) => pointInPoly(pt, p));

/** Area-weighted centroid of a polygon (holes subtract). */
export function polyCentroid(poly: Poly): Pt {
  let cx = 0;
  let cy = 0;
  let a = 0;
  poly.forEach((ring, idx) => {
    const sign = idx === 0 ? 1 : -1;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xj, yj] = ring[j]!;
      const [xi, yi] = ring[i]!;
      const cross = xj * yi - xi * yj;
      a += sign * cross;
      cx += sign * (xj + xi) * cross;
      cy += sign * (yj + yi) * cross;
    }
  });
  if (Math.abs(a) < 1e-12) {
    const outer = poly[0] ?? [];
    const b = bboxOf(outer);
    return bboxCentre(b);
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function multiCentroid(mp: MultiPoly): Pt {
  let cx = 0;
  let cy = 0;
  let total = 0;
  for (const p of mp) {
    const a = polyArea(p);
    const [x, y] = polyCentroid(p);
    cx += x * a;
    cy += y * a;
    total += a;
  }
  if (total === 0) return bboxCentre(bboxOfMulti(mp));
  return [cx / total, cy / total];
}

/** Shortest distance from a point to a segment. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function distToRing(p: Pt, ring: Ring): number {
  let best = Infinity;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = distToSegment(p, ring[j]!, ring[i]!);
    if (d < best) best = d;
  }
  return best;
}

/** Distance to the boundary of a multipolygon; negative-free (unsigned). */
export function distToMultiBoundary(p: Pt, mp: MultiPoly): number {
  let best = Infinity;
  for (const poly of mp) for (const ring of poly) best = Math.min(best, distToRing(p, ring));
  return best;
}

export function rotatePt(p: Pt, angleRad: number, about: Pt = [0, 0]): Pt {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const dx = p[0] - about[0];
  const dy = p[1] - about[1];
  return [about[0] + dx * c - dy * s, about[1] + dx * s + dy * c];
}

export const rotateRing = (ring: Ring, angleRad: number, about: Pt = [0, 0]): Ring =>
  ring.map((p) => rotatePt(p, angleRad, about));

export function translateRing(ring: Ring, dx: number, dy: number): Ring {
  return ring.map(([x, y]) => [x + dx, y + dy] as Pt);
}

/** Axis-aligned rectangle ring, counter-clockwise. */
export function rectRing(x: number, y: number, w: number, h: number): Ring {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/** Rectangle centred on `c`, of size w x h, rotated by `angleRad`. */
export function orientedRect(c: Pt, w: number, h: number, angleRad: number): Ring {
  return rectRing(-w / 2, -h / 2, w, h).map((p) => {
    const r = rotatePt(p, angleRad);
    return [r[0] + c[0], r[1] + c[1]] as Pt;
  });
}

/**
 * Minimum-area enclosing rectangle via rotating calipers on the convex hull.
 * Used to give any zone a "long axis" for road-direction candidates.
 */
export function minAreaRect(pts: readonly Pt[]): { centre: Pt; width: number; height: number; angle: number } {
  const hull = convexHull(pts);
  if (hull.length < 3) {
    const b = bboxOf(pts);
    return { centre: bboxCentre(b), width: bboxWidth(b), height: bboxHeight(b), angle: 0 };
  }
  let best = { centre: [0, 0] as Pt, width: 0, height: 0, angle: 0, area: Infinity };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const rotated = hull.map((p) => rotatePt(p, -angle));
    const bb = bboxOf(rotated);
    const area = bboxWidth(bb) * bboxHeight(bb);
    if (area < best.area) {
      const c = rotatePt(bboxCentre(bb), angle);
      best = { centre: c, width: bboxWidth(bb), height: bboxHeight(bb), angle, area };
    }
  }
  return { centre: best.centre, width: best.width, height: best.height, angle: best.angle };
}

/** Andrew's monotone chain. Returns a counter-clockwise hull. */
export function convexHull(pts: readonly Pt[]): Ring {
  if (pts.length < 3) return [...pts];
  const sorted = [...pts].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (input: Pt[]): Pt[] => {
    const out: Pt[] = [];
    for (const p of input) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(sorted), ...build(sorted.reverse())];
}

/** Sample points on a regular grid inside a multipolygon. */
export function gridPointsInMulti(mp: MultiPoly, spacing: number, origin: Pt = [0, 0]): Pt[] {
  const b = bboxOfMulti(mp);
  const out: Pt[] = [];
  const startX = Math.ceil((b.minX - origin[0]) / spacing) * spacing + origin[0];
  const startY = Math.ceil((b.minY - origin[1]) / spacing) * spacing + origin[1];
  for (let y = startY; y <= b.maxY; y += spacing) {
    for (let x = startX; x <= b.maxX; x += spacing) {
      const p: Pt = [x, y];
      if (pointInMulti(p, mp)) out.push(p);
    }
  }
  return out;
}
