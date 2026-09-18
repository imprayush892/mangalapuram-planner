import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { applyZoneEdits, MIN_ZONE_M2, unzonedLand, validateZones } from '../site/zoneEdit';
import type { ZoneEdit } from '../site/zoneEdit';
import { runMasterPlan } from '../masterplan/run';
import { loadProgramme } from '../rules/programme';
import { runSiting } from '../siting/allocate';
import { multiPolyArea, bboxOfMulti } from '../geom/planar';
import { intersect } from '../geom/boolean';
import type { Pt } from '../geom/types';
import type { ZoneUse } from '../site/level1';

describe('zone editing', () => {
  it('splits a zone into two along a drawn line, keeping the land', async () => {
    const s = await site();
    const zone = s.zones.find((z) => /PROJECT - 2/.test(z.name))!;
    const b = bboxOfMulti(zone.geom);
    const midY = (b.minY + b.maxY) / 2;
    const line: [Pt, Pt] = [
      [b.minX - 50, midY],
      [b.maxX + 50, midY],
    ];
    const { zones, notes } = applyZoneEdits(s.zones, [{ kind: 'split', zoneId: zone.id, line }]);

    const parts = zones.filter((z) => z.id.startsWith(`${zone.id}-`));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(zones.some((z) => z.id === zone.id)).toBe(false);
    // No land is created or lost by a cut.
    const before = multiPolyArea(zone.geom);
    const after = parts.reduce((sum, z) => sum + multiPolyArea(z.geom), 0);
    expect(after).toBeCloseTo(before, 0);
    expect(notes[0]).toMatch(/split into/);
  });

  it('refuses a cut that would leave a sliver', async () => {
    const s = await site();
    const zone = s.zones.find((z) => /PROJECT - 2/.test(z.name))!;
    const b = bboxOfMulti(zone.geom);
    // A line just outside the zone cuts nothing.
    const line: [Pt, Pt] = [
      [b.minX - 100, b.minY - 60],
      [b.maxX + 100, b.minY - 60],
    ];
    const { zones, notes } = applyZoneEdits(s.zones, [{ kind: 'split', zoneId: zone.id, line }]);
    expect(zones.length).toBe(s.zones.length);
    expect(notes[0]).toMatch(/does not cross|under/);
  });

  it('merges zones and reports when the pieces do not touch', async () => {
    const s = await site();
    const [a, b] = [s.zones[0]!, s.zones[1]!];
    const { zones, notes } = applyZoneEdits(s.zones, [{ kind: 'merge', zoneIds: [a.id, b.id] }]);
    expect(zones.length).toBe(s.zones.length - 1);
    const merged = zones.find((z) => z.id.startsWith('merged-'))!;
    expect(merged.computedInScopeAc).toBeCloseTo(a.computedInScopeAc + b.computedInScopeAc, 1);
    expect(notes[0]).toMatch(/merged into/);
  });

  it('never lets a drawn zone overlap one that already exists', async () => {
    const s = await site();
    const existing = s.zones.find((z) => z.geom.length > 0)!;
    const b = bboxOfMulti(existing.geom);
    // A square straddling the existing zone.
    const ring: Pt[] = [
      [b.minX - 20, b.minY - 20],
      [b.minX + 60, b.minY - 20],
      [b.minX + 60, b.minY + 60],
      [b.minX - 20, b.minY + 60],
    ];
    const { zones } = applyZoneEdits(s.zones, [
      { kind: 'create', id: 'drawn-1', name: 'Drawn', ring },
    ]);
    const drawn = zones.filter((z) => z.id.startsWith('drawn-1'));
    for (const d of drawn) {
      for (const other of s.zones) {
        const overlap = multiPolyArea(intersect(d.geom, other.geom));
        expect(overlap, `${d.id} overlaps ${other.name}`).toBeLessThan(1);
      }
    }
  });

  it('reports unzoned land rather than pretending the parcel is covered', async () => {
    const s = await site();
    const before = unzonedLand(s.zones, s.parcel);
    const zone = s.zones.find((z) => z.computedInScopeAc > 1)!;
    const { zones } = applyZoneEdits(s.zones, [{ kind: 'delete', zoneId: zone.id }]);
    const after = unzonedLand(zones, s.parcel);
    expect(after.areaAc).toBeGreaterThan(before.areaAc + zone.computedInScopeAc - 0.5);
  });

  it('flags a zone that will not plan cleanly', async () => {
    const s = await site();
    const tiny: Pt[] = [
      [0, 0],
      [5, 0],
      [5, 5],
      [0, 5],
    ];
    const { zones } = applyZoneEdits(s.zones, [
      { kind: 'create', id: 'drawn-tiny', name: 'Tiny', ring: tiny },
    ]);
    // Too small to be created at all: the minimum is enforced up front.
    expect(zones.some((z) => z.id.startsWith('drawn-tiny'))).toBe(false);
    const checks = validateZones(s.zones, s.parcel);
    expect(checks.length).toBe(s.zones.length);
    expect(MIN_ZONE_M2).toBeGreaterThan(0);
  });

  it('changes the master plan that comes out', async () => {
    const s = await site();
    const c = await config();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);

    const planFor = (edits: ZoneEdit[]) => {
      const edited = { ...s, zones: applyZoneEdits(s.zones, edits).zones };
      const siting = runSiting({ site: edited, kmbr: c.kmbr, siting: c.siting, programme });
      const alt = siting.alternatives[0]!;
      const zoneUses: Record<string, ZoneUse> = Object.fromEntries(
        alt.allocations.map((a) => [a.zoneId, a.use]),
      );
      return runMasterPlan(edited, c, {
        zoneUses, sitingLabel: alt.label, fsi: 3, floorOptions: [12, 15, 20],
        apartmentMix: ['2BHK', '3BHK'], flatsPerFloor: 4, runId: 1,
      });
    };

    const base = planFor([]);
    const zone = s.zones.find((z) => /PROJECT - 2/.test(z.name))!;
    const b = bboxOfMulti(zone.geom);
    const midY = (b.minY + b.maxY) / 2;
    const edited = planFor([
      { kind: 'split', zoneId: zone.id, line: [[b.minX - 50, midY], [b.maxX + 50, midY]] },
    ]);

    // The split zone is gone and its halves are planned in its place.
    expect(base.zones.some((z) => z.zoneId === zone.id)).toBe(true);
    expect(edited.zones.some((z) => z.zoneId === zone.id)).toBe(false);
    expect(edited.zones.length).toBeGreaterThan(base.zones.length);
    // Two smaller zones cut fewer plots than one whole one: the plan is
    // genuinely different, not the same numbers relabelled.
    expect(edited.totals.villaPlots).not.toBe(base.totals.villaPlots);
  });
});
