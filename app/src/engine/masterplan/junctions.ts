import type { MultiPoly, Pt } from '../geom/types';
import type { RoadResult } from '../generators/types';
import type { CirculationRoad } from './circulation';
import { bufferPolyline } from '../geom/offset';
import { intersect, union } from '../geom/boolean';
import { distToSegment, multiPolyArea } from '../geom/planar';

/**
 * Where the roads meet.
 *
 * Two things were missing once the master plan existed. Each zone laid its own
 * grid and the circulation was merely kept out of it, so an internal road
 * stopped a few metres short of the collector that was supposed to serve it and
 * nothing joined them. And KMBR Rule 31 sets a splay at every junction, which
 * the config had carried since the first build and no engine had ever applied.
 *
 * This module does both: it runs a stub from an internal road that stops short
 * of the network to the road it should meet, and it cuts the Rule 31 splay at
 * every junction it finds.
 */

export interface Junction {
  point: Pt;
  /** Widths of the two roads meeting here, wider first. */
  widthsM: [number, number];
  /** Splay the rule requires, from the wider road. */
  splayM: number;
  kind: 'internal-internal' | 'internal-circulation' | 'circulation-circulation';
}

export interface JunctionResult {
  junctions: Junction[];
  /** Splay geometry at every junction, as one shape. */
  splays: MultiPoly;
  /** Stub roads added to join a zone's grid to the network. */
  stubs: CirculationRoad[];
  notes: string[];
}

export interface SplayRule {
  roadsLe10M: number;
  roadsGt10M: number;
}

/** A road, whichever tier it belongs to, reduced to what a junction needs. */
interface RoadLine {
  id: string;
  centreline: Pt[];
  widthM: number;
  circulation: boolean;
  zoneId?: string;
}

const dist = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Where two segments cross, or null. Endpoints touching count as a crossing. */
function segmentCross(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / denom;
  const u = ((b1[0] - a1[0]) * d1y - (b1[1] - a1[1]) * d1x) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [a1[0] + t * d1x, a1[1] + t * d1y];
}

/** Nearest point on a polyline to `p`, and how far away it is. */
function nearestOn(line: readonly Pt[], p: Pt): { point: Pt; distance: number } {
  let best: { point: Pt; distance: number } = { point: line[0] ?? p, distance: Infinity };
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2)) : 0;
    const q: Pt = [a[0] + t * vx, a[1] + t * vy];
    const d = dist(p, q);
    if (d < best.distance) best = { point: q, distance: d };
  }
  return best;
}

/**
 * The splay at one junction: the rule chamfers the corner of each quadrant, so
 * the land the junction needs is the square of side `splay` around the crossing,
 * less the two road bodies that already cover most of it. Taking the square and
 * letting the union with the roads absorb the overlap gives the same result and
 * survives roads meeting at any angle, which a per-quadrant triangle does not.
 */
function splayAt(j: Junction): MultiPoly {
  const r = j.splayM + Math.max(j.widthsM[0], j.widthsM[1]) / 2;
  const [x, y] = j.point;
  // An octagon approximates the chamfered corner better than a square and keeps
  // the drawn junction from growing spikes at an oblique crossing.
  const ring: Pt[] = [];
  for (let k = 0; k < 8; k += 1) {
    const a = (Math.PI / 4) * k + Math.PI / 8;
    ring.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
  }
  return [[ring]];
}

export interface JunctionInput {
  /** Internal roads, per zone. */
  zoneRoads: { zoneId: string; roads: RoadResult[] }[];
  circulation: CirculationRoad[];
  splayRule: SplayRule;
  /** Stub a road to the network when its end is within this of one. */
  stubReachM: number;
  /** Clip everything to the parcel. */
  parcel: MultiPoly;
  /**
   * Plots and buildings already placed. A stub is laid only where its corridor
   * is clear of them: the road network may not be completed by driving over a
   * villa, and a zone that cannot be reached without taking one is reported
   * instead.
   */
  obstacles: MultiPoly;
}

export function buildJunctions(input: JunctionInput): JunctionResult {
  const lines: RoadLine[] = [
    ...input.circulation.map((r) => ({
      id: r.id,
      centreline: r.centreline,
      widthM: r.widthM,
      circulation: true,
    })),
    ...input.zoneRoads.flatMap(({ zoneId, roads }) =>
      roads
        .filter((r) => r.centreline.length >= 2)
        .map((r) => ({ id: `${zoneId}:${r.id}`, centreline: r.centreline, widthM: r.widthM, circulation: false, zoneId })),
    ),
  ];

  /* ------------------------------------------------------------------ stubs */
  const stubs: CirculationRoad[] = [];
  const blocked: { zoneId?: string; takenM2: number }[] = [];
  const circulationLines = lines.filter((l) => l.circulation);
  let stubCount = 0;

  for (const line of lines) {
    if (line.circulation) continue;
    for (const end of [line.centreline[0]!, line.centreline[line.centreline.length - 1]!]) {
      let best: { point: Pt; distance: number } | null = null;
      for (const c of circulationLines) {
        const near = nearestOn(c.centreline, end);
        const clear = near.distance - c.widthM / 2 - line.widthM / 2;
        if (clear <= 0) {
          // Already meets it.
          best = null;
          break;
        }
        if (clear <= input.stubReachM && (!best || near.distance < best.distance)) best = near;
      }
      if (!best) continue;
      const corridor = bufferPolyline([end, best.point], line.widthM);
      const geom = intersect(corridor, input.parcel);
      if (geom.length === 0) continue;
      const takes = multiPolyArea(intersect(geom, input.obstacles));
      if (takes > 1) {
        blocked.push({ zoneId: line.zoneId, takenM2: takes });
        continue;
      }
      stubCount += 1;
      stubs.push({
        id: `stub-${stubCount}`,
        tier: 'collector',
        centreline: [end, best.point],
        widthM: line.widthM,
        geom,
        lengthM: dist(end, best.point),
        zoneId: line.zoneId,
        riseM: 0,
        maxGradePct: 0,
        notes: ['joins an internal road to the road network'],
      });
    }
  }

  const allLines: RoadLine[] = [
    ...lines,
    ...stubs.map((s) => ({ id: s.id, centreline: s.centreline, widthM: s.widthM, circulation: true })),
  ];

  /* -------------------------------------------------------------- junctions */
  const junctions: Junction[] = [];
  const seen = new Set<string>();
  const splayFor = (w: number): number =>
    w > 10 ? input.splayRule.roadsGt10M : input.splayRule.roadsLe10M;

  for (let i = 0; i < allLines.length; i += 1) {
    for (let k = i + 1; k < allLines.length; k += 1) {
      const a = allLines[i]!;
      const b = allLines[k]!;
      let point: Pt | null = null;
      for (let m = 1; m < a.centreline.length && !point; m += 1) {
        for (let n = 1; n < b.centreline.length && !point; n += 1) {
          point = segmentCross(a.centreline[m - 1]!, a.centreline[m]!, b.centreline[n - 1]!, b.centreline[n]!);
        }
      }
      if (!point) {
        // A T-junction: one road's end sits on the other's body.
        for (const end of [a.centreline[0]!, a.centreline[a.centreline.length - 1]!]) {
          const near = nearestOn(b.centreline, end);
          if (near.distance <= (a.widthM + b.widthM) / 2) {
            point = near.point;
            break;
          }
        }
      }
      if (!point) continue;

      // One junction per place: two roads crossing twice within a few metres
      // is one junction, not two.
      const key = `${Math.round(point[0] / 5)}:${Math.round(point[1] / 5)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const wide = Math.max(a.widthM, b.widthM);
      const narrow = Math.min(a.widthM, b.widthM);
      junctions.push({
        point,
        widthsM: [wide, narrow],
        splayM: splayFor(wide),
        kind:
          a.circulation && b.circulation
            ? 'circulation-circulation'
            : a.circulation || b.circulation
              ? 'internal-circulation'
              : 'internal-internal',
      });
    }
  }

  const splays = junctions.length > 0
    ? intersect(union(...junctions.map(splayAt)), input.parcel)
    : [];

  const notes: string[] = [];
  notes.push(
    `${junctions.length} junctions, splayed ${input.splayRule.roadsLe10M} m on roads up to 10 m and ${input.splayRule.roadsGt10M} m above (KMBR Rule 31)`,
  );
  if (stubs.length > 0) {
    notes.push(`${stubs.length} stub roads join the zone grids to the network`);
  }
  const blockedZones = new Set(blocked.map((b) => b.zoneId).filter(Boolean));
  for (const zoneId of blockedZones) {
    if (stubs.some((st) => st.zoneId === zoneId)) continue;
    notes.push(
      `${zoneId}: an internal road stops short of the network and the only line to it would run over plots, so no stub was laid`,
    );
  }
  const orphan = input.zoneRoads.filter(
    ({ zoneId, roads }) =>
      roads.length > 0 &&
      !stubs.some((s) => s.zoneId === zoneId) &&
      !junctions.some((j) => j.kind === 'internal-circulation'),
  );
  for (const o of orphan) {
    notes.push(`${o.zoneId}: internal roads do not reach the road network`);
  }

  return { junctions, splays, stubs, notes };
}

/** Distance from a point to the nearest point on any of these centrelines. */
export function distanceToRoads(p: Pt, lines: readonly (readonly Pt[])[]): number {
  let best = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      best = Math.min(best, distToSegment(p, line[i - 1]!, line[i]!));
    }
  }
  return best;
}
