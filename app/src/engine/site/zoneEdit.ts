import type { MultiPoly, Pt, Ring } from '../geom/types';
import type { Zone } from './types';
import { difference, intersect, union } from '../geom/boolean';
import { bboxOfMulti, multiPolyArea, polyArea } from '../geom/planar';
import { M2_PER_ACRE } from '../units';

/**
 * Editing the zoning plan.
 *
 * The client's zoning plan arrives as a fixed input, and PRD §6.2 asks for it to
 * be a starting point instead: draw, split and merge. Edits are kept as a list
 * of operations rather than as edited geometry, so they are small enough to send
 * to the worker, survive a scenario save, and can be undone one at a time. The
 * zone list every engine sees is the original list with the operations applied
 * in order.
 */

export type ZoneEdit =
  | { kind: 'split'; zoneId: string; line: [Pt, Pt] }
  | { kind: 'merge'; zoneIds: string[]; name?: string }
  | { kind: 'create'; id: string; name: string; ring: Ring }
  | { kind: 'rename'; zoneId: string; name: string }
  | { kind: 'delete'; zoneId: string };

export interface EditOutcome {
  zones: Zone[];
  /** What each operation did, or why it could not be applied. */
  notes: string[];
}

/** A zone smaller than this is not a parcel, it is a sliver left by a bad cut. */
export const MIN_ZONE_M2 = 200;

function acres(m2: number): number {
  return m2 / M2_PER_ACRE;
}

function zoneFrom(base: Zone, id: string, name: string, geom: MultiPoly): Zone {
  const m2 = multiPolyArea(geom);
  return {
    id,
    name,
    // An edited zone is drawn by the user, so what was drawn IS what is in
    // scope: there is no separate registered client geometry behind it.
    drawnGeom: geom,
    geom,
    labelAreaAc: acres(m2),
    drawnAreaAc: acres(m2),
    inScopeAc: acres(m2),
    computedInScopeAc: acres(m2),
    confidence: base.confidence,
  };
}

/**
 * Extends a two-point line far enough to cross the whole zone, then uses it as a
 * half-plane: everything on one side is one zone, everything on the other is the
 * other. A user drags a short stroke across a zone and means "cut here", not
 * "cut only where I dragged".
 */
function halfPlanes(line: [Pt, Pt], within: MultiPoly): [MultiPoly, MultiPoly] | null {
  const [a, b] = line;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return null;

  const box = bboxOfMulti(within);
  const reach = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) + 10;
  const ux = dx / length;
  const uy = dy / length;
  // Normal to the cut, pointing left.
  const nx = -uy;
  const ny = ux;

  const p0: Pt = [a[0] - ux * reach, a[1] - uy * reach];
  const p1: Pt = [a[0] + ux * reach, a[1] + uy * reach];
  const side = (sign: 1 | -1): MultiPoly => {
    const ring: Ring = [
      p0,
      p1,
      [p1[0] + nx * reach * sign, p1[1] + ny * reach * sign],
      [p0[0] + nx * reach * sign, p0[1] + ny * reach * sign],
    ];
    return intersect([[ring]], within);
  };
  return [side(1), side(-1)];
}

/** Only the pieces worth keeping, each as its own zone geometry. */
function significantParts(mp: MultiPoly): MultiPoly[] {
  return mp
    .filter((poly) => Math.abs(polyArea(poly)) >= MIN_ZONE_M2)
    .map((poly) => [poly]);
}

export function applyZoneEdits(zones: Zone[], edits: readonly ZoneEdit[]): EditOutcome {
  let out = [...zones];
  const notes: string[] = [];
  let created = 0;

  for (const edit of edits) {
    if (edit.kind === 'rename') {
      const i = out.findIndex((z) => z.id === edit.zoneId);
      if (i < 0) {
        notes.push(`rename: no zone ${edit.zoneId}`);
        continue;
      }
      out[i] = { ...out[i]!, name: edit.name };
      continue;
    }

    if (edit.kind === 'delete') {
      const zone = out.find((z) => z.id === edit.zoneId);
      if (!zone) {
        notes.push(`delete: no zone ${edit.zoneId}`);
        continue;
      }
      out = out.filter((z) => z.id !== edit.zoneId);
      notes.push(`${zone.name} removed; its ${zone.computedInScopeAc.toFixed(2)} ac is unzoned`);
      continue;
    }

    if (edit.kind === 'create') {
      const geom: MultiPoly = [[edit.ring]];
      const m2 = multiPolyArea(geom);
      if (m2 < MIN_ZONE_M2) {
        notes.push(`create: ${Math.round(m2)} m² is below the ${MIN_ZONE_M2} m² minimum`);
        continue;
      }
      // A new zone takes only land no other zone holds, so zones never overlap.
      const existing = out.length > 0 ? union(...out.map((z) => z.geom)) : [];
      const free = existing.length > 0 ? difference(geom, existing) : geom;
      const parts = significantParts(free);
      if (parts.length === 0) {
        notes.push(`create: ${edit.name} lies entirely inside zones that already exist`);
        continue;
      }
      const base = out[0];
      if (!base) {
        notes.push('create: nothing to base a new zone on');
        continue;
      }
      parts.forEach((part, i) => {
        created += 1;
        out.push(
          zoneFrom(base, `${edit.id}${parts.length > 1 ? `-${i + 1}` : ''}`, edit.name, part),
        );
      });
      const takenM2 = m2 - multiPolyArea(free);
      notes.push(
        `${edit.name} drawn at ${acres(multiPolyArea(free)).toFixed(2)} ac${takenM2 > 1 ? `, after ${acres(takenM2).toFixed(2)} ac already held by other zones was left out` : ''}`,
      );
      continue;
    }

    if (edit.kind === 'merge') {
      const parts = out.filter((z) => edit.zoneIds.includes(z.id));
      if (parts.length < 2) {
        notes.push('merge: needs two zones that still exist');
        continue;
      }
      const geom = union(...parts.map((z) => z.geom));
      const base = parts[0]!;
      created += 1;
      const merged = zoneFrom(
        base,
        `merged-${created}`,
        edit.name ?? parts.map((z) => z.name).join(' + '),
        geom,
      );
      out = out.filter((z) => !edit.zoneIds.includes(z.id));
      out.push(merged);
      const touching = geom.length === 1;
      notes.push(
        `${parts.map((z) => z.name).join(' + ')} merged into ${merged.computedInScopeAc.toFixed(2)} ac${touching ? '' : ' — the pieces do not touch, so the zone is in two parts'}`,
      );
      continue;
    }

    // split
    const zone = out.find((z) => z.id === edit.zoneId);
    if (!zone) {
      notes.push(`split: no zone ${edit.zoneId}`);
      continue;
    }
    const halves = halfPlanes(edit.line, zone.geom);
    if (!halves) {
      notes.push(`split: the line across ${zone.name} has no length`);
      continue;
    }
    const parts = [...significantParts(halves[0]), ...significantParts(halves[1])];
    if (parts.length < 2) {
      notes.push(`split: the line does not cross ${zone.name}, or leaves a piece under ${MIN_ZONE_M2} m²`);
      continue;
    }
    out = out.filter((z) => z.id !== zone.id);
    parts.forEach((part, i) => {
      out.push(zoneFrom(zone, `${zone.id}-${i + 1}`, `${zone.name} ${i + 1}`, part));
    });
    notes.push(
      `${zone.name} split into ${parts.length}: ${parts.map((p) => `${acres(multiPolyArea(p)).toFixed(2)} ac`).join(', ')}`,
    );
  }

  return { zones: out, notes };
}

/**
 * Whether a zone is worth planning at all. The siting engine vetoes a use on a
 * zone; this vetoes the zone itself, which is what makes a user-drawn boundary
 * safe to accept.
 */
export interface ZoneValidity {
  zoneId: string;
  ok: boolean;
  reasons: string[];
}

export function validateZones(zones: Zone[], parcel: MultiPoly): ZoneValidity[] {
  return zones.map((zone) => {
    const reasons: string[] = [];
    const m2 = multiPolyArea(zone.geom);
    if (m2 < MIN_ZONE_M2) reasons.push(`${Math.round(m2)} m² is below the ${MIN_ZONE_M2} m² minimum`);
    const outside = multiPolyArea(difference(zone.geom, parcel));
    if (outside > m2 * 0.01) {
      reasons.push(`${acres(outside).toFixed(2)} ac lies outside the in-scope parcel`);
    }
    if (zone.geom.length > 1) {
      reasons.push(`in ${zone.geom.length} separate pieces; each is laid out on its own`);
    }
    return { zoneId: zone.id, ok: reasons.length === 0, reasons };
  });
}

/** Land inside the parcel that no zone holds. */
export function unzonedLand(zones: Zone[], parcel: MultiPoly): { geom: MultiPoly; areaAc: number } {
  const held = zones.length > 0 ? union(...zones.map((z) => z.geom)) : [];
  const geom = held.length > 0 ? difference(parcel, held) : parcel;
  return { geom, areaAc: acres(multiPolyArea(geom)) };
}
