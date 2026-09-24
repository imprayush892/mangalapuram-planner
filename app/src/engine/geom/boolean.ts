import * as pcModule from 'polygon-clipping';
import type * as PC from 'polygon-clipping';
import type { MultiPoly, Poly, Pt, Ring } from './types';
import { openRing, polyArea } from './planar';

// The bundler and the test runner hand over the functions as named exports; a
// plain Node import of the package's CommonJS build gives them only as the
// default export (the plan prebuild runs that way).
const pc = ((pcModule as unknown as { default?: typeof pcModule }).default ?? pcModule) as typeof pcModule;

/** polygon-clipping wants closed rings; our rings are open. */
const closeRing = (ring: Ring): PC.Ring => {
  const out = ring.map(([x, y]) => [x, y] as PC.Pair);
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) out.push([first[0], first[1]]);
  return out;
};

const toPc = (mp: MultiPoly): PC.MultiPolygon => mp.map((poly) => poly.map(closeRing));

const fromPc = (mp: PC.MultiPolygon): MultiPoly =>
  mp
    .map((poly) => poly.map((ring) => openRing(ring.map(([x, y]) => [x, y] as Pt))).filter((r) => r.length >= 3))
    .filter((poly) => poly.length > 0 && polyArea(poly) > 1e-9);

/** Guards the boolean ops: polygon-clipping throws on degenerate input. */
function guard(fn: () => PC.MultiPolygon, fallback: MultiPoly): MultiPoly {
  try {
    return fromPc(fn());
  } catch {
    return fallback;
  }
}

export function union(...parts: MultiPoly[]): MultiPoly {
  const nonEmpty = parts.filter((p) => p.length > 0);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return nonEmpty[0]!;
  const [first, ...rest] = nonEmpty.map(toPc) as [PC.MultiPolygon, ...PC.MultiPolygon[]];
  return guard(() => pc.union(first, ...rest), nonEmpty.flat());
}

export function intersect(a: MultiPoly, b: MultiPoly): MultiPoly {
  if (a.length === 0 || b.length === 0) return [];
  return guard(() => pc.intersection(toPc(a), toPc(b)), []);
}

export function difference(a: MultiPoly, ...b: MultiPoly[]): MultiPoly {
  if (a.length === 0) return [];
  const clips = b.filter((p) => p.length > 0).map(toPc);
  if (clips.length === 0) return a;
  return guard(() => pc.difference(toPc(a), ...(clips as [PC.MultiPolygon, ...PC.MultiPolygon[]])), a);
}

export const asMulti = (poly: Poly): MultiPoly => [poly];
export const ringAsMulti = (ring: Ring): MultiPoly => [[ring]];
