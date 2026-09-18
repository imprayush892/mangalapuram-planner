import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { loadProgramme } from '../rules/programme';
import { runSiting } from '../siting/allocate';
import { runMasterPlan } from '../masterplan/run';
import { briefForZone, kindForUse } from '../masterplan/brief';
import type { MasterPlan } from '../masterplan/types';
import type { ZoneUse } from '../site/level1';
import { pointInMulti } from '../geom/planar';
import { intersect } from '../geom/boolean';
import { multiPolyArea } from '../geom/planar';

let cached: MasterPlan | null = null;

async function plan(): Promise<MasterPlan> {
  if (cached) return cached;
  const s = await site();
  const c = await config();
  const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
  const siting = runSiting({ site: s, kmbr: c.kmbr, siting: c.siting, programme });
  const alt = siting.alternatives[0]!;
  const zoneUses: Record<string, ZoneUse> = Object.fromEntries(
    alt.allocations.map((a) => [a.zoneId, a.use]),
  );
  cached = runMasterPlan(s, c, {
    zoneUses,
    sitingLabel: alt.label,
    fsi: 3,
    floorOptions: [12, 15, 20],
    apartmentMix: ['2BHK', '3BHK'],
    flatsPerFloor: 4,
    runId: 1,
  });
  return cached;
}

describe('master plan', () => {
  it('lays out every zone the siting engine allocated', async () => {
    const p = await plan();
    expect(p.zones.length).toBeGreaterThanOrEqual(10);
    // Most zones must actually produce something, or the plan is not a plan.
    const built = p.zones.filter((z) => z.options.length > 0);
    expect(built.length).toBeGreaterThanOrEqual(p.zones.length - 2);
  });

  it('produces buildings, not just zones', async () => {
    const p = await plan();
    expect(p.totals.villaPlots).toBeGreaterThan(200);
    expect(p.totals.dwellings).toBeGreaterThan(800);
    expect(p.totals.builtFootprintM2).toBeGreaterThan(20_000);
    expect(p.totals.towers + p.totals.blocks).toBeGreaterThan(5);
  });

  it('keeps every plot, tower and block inside its own zone', async () => {
    const s = await site();
    const p = await plan();
    for (const z of p.zones) {
      const layout = z.options[z.chosenIndex];
      if (!layout) continue;
      const zone = s.zones.find((x) => x.id === z.zoneId)!;
      for (const plot of layout.plots) {
        for (const pt of plot.ring) {
          expect(pointInMulti(pt, zone.geom), `${plot.id} corner outside ${z.zoneName}`).toBe(true);
        }
      }
      for (const tower of layout.towers) {
        for (const pt of tower.ring) {
          expect(pointInMulti(pt, zone.geom), `${tower.id} corner outside ${z.zoneName}`).toBe(true);
        }
      }
      for (const block of layout.blocks) {
        for (const pt of block.ring) {
          expect(pointInMulti(pt, zone.geom), `${block.id} corner outside ${z.zoneName}`).toBe(true);
        }
      }
    }
  });

  it('keeps buildings off the roads that run between the zones', async () => {
    const p = await plan();
    const roads = p.circulation.roads.map((r) => r.geom);
    for (const z of p.zones) {
      const layout = z.options[z.chosenIndex];
      if (!layout) continue;
      for (const plot of layout.plots) {
        for (const road of roads) {
          const overlap = multiPolyArea(intersect([[plot.ring]], road));
          // A rasterised boundary can clip a corner; a real conflict is larger.
          expect(overlap, `${plot.id} sits on a road`).toBeLessThan(plot.areaM2 * 0.05);
        }
      }
    }
  });

  it('builds a road hierarchy, widest first', async () => {
    const p = await plan();
    const spine = p.circulation.roads.filter((r) => r.tier === 'spine');
    const pub = p.circulation.roads.filter((r) => r.tier === 'public');
    expect(spine.length).toBe(1);
    expect(pub.length).toBeGreaterThan(0);
    // The client fixes the spine at 18 m and the public roads at 10 m.
    expect(spine[0]!.widthM).toBe(18);
    expect(spine[0]!.lengthM).toBeGreaterThan(300);
    for (const r of pub) expect(r.widthM).toBe(10);
    // Strictly north-south: the client rule gives no angular tolerance.
    const [a, b] = [spine[0]!.centreline[0]!, spine[0]!.centreline[1]!];
    expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-6);
  });

  it('gives every zone a way in', async () => {
    const p = await plan();
    const reached = new Set(p.circulation.gates.map((g) => g.zoneId));
    for (const z of p.zones) {
      expect(reached.has(z.zoneId) || p.circulation.unreachable.some((u) => u.zoneId === z.zoneId)).toBe(true);
    }
    // An unreachable zone is reported rather than quietly left off the plan.
    for (const u of p.circulation.unreachable) {
      expect(p.notes.some((n) => n.includes('no road connection'))).toBe(true);
      expect(u.reason.length).toBeGreaterThan(0);
    }
  });

  it('splits a use between the zones that hold it instead of doubling it', async () => {
    const c = await config();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const one = briefForZone({
      zoneId: 'a', zoneName: 'A', use: 'villas', areaAc: 10, useTotalAc: 10,
      programme, householdSizeFamily: 3.5, householdSizeSenior: 1.6,
    });
    const half = briefForZone({
      zoneId: 'b', zoneName: 'B', use: 'villas', areaAc: 5, useTotalAc: 10,
      programme, householdSizeFamily: 3.5, householdSizeSenior: 1.6,
    });
    expect(half.targetUnits).toBe(Math.round(one.targetUnits / 2));
    expect(half.shareOfUse).toBeCloseTo(0.5, 6);
  });

  it('follows the use it is given, not the zone name', async () => {
    // A zone named for villas but allocated to a school is built as a school.
    expect(kindForUse('school')).toBe('block');
    expect(kindForUse('villas')).toBe('villa');
    expect(kindForUse('apartments')).toBe('tower');
    expect(kindForUse('hospital_reserved')).toBe('none');
  });

  it('states why a zone got nothing rather than dropping it', async () => {
    const p = await plan();
    for (const z of p.zones) {
      if (z.options.length === 0) expect(z.empty && z.empty.length > 0).toBe(true);
    }
  });
});

describe('campus blocks', () => {
  it('lays a use as several buildings, not one slab', async () => {
    const p = await plan();
    const campuses = p.zones.filter((z) => (z.options[z.chosenIndex]?.blocks.length ?? 0) > 0);
    expect(campuses.length).toBeGreaterThan(2);
    // At least one use must break into a real campus rather than a single mass.
    expect(campuses.some((z) => (z.options[z.chosenIndex]?.blocks.length ?? 0) >= 3)).toBe(true);
  });

  it('holds every block to the KMBR depth and length rules', async () => {
    const c = await config();
    const p = await plan();
    const daylight = c.kmbr.rule41_daylight_max_depth_from_opening_m as number;
    const travel = (c.kmbr.rule36_travel_distance_m as Record<string, number>).other!;
    const corridor = c.assumptions.corridor_width_m as number;
    const maxDepth = daylight * 2 + corridor;
    for (const z of p.zones) {
      for (const b of z.options[z.chosenIndex]?.blocks ?? []) {
        // Ring is a rectangle: measure its two side lengths.
        const [a, bb, cc] = [b.ring[0]!, b.ring[1]!, b.ring[2]!];
        const s1 = Math.hypot(bb[0] - a[0], bb[1] - a[1]);
        const s2 = Math.hypot(cc[0] - bb[0], cc[1] - bb[1]);
        const depth = Math.min(s1, s2);
        const length = Math.max(s1, s2);
        expect(depth, `${z.zoneName} ${b.id} depth`).toBeLessThanOrEqual(maxDepth + 0.01);
        expect(length, `${z.zoneName} ${b.id} length`).toBeLessThanOrEqual(travel * 2 + 0.01);
      }
    }
  });

  it('keeps the campus inside the coverage its occupancy allows', async () => {
    const p = await plan();
    for (const z of p.zones) {
      const layout = z.options[z.chosenIndex];
      if (!layout || layout.blocks.length === 0) continue;
      const failures = layout.findings.filter((f) => f.id === 'block.coverage' && f.status === 'fail');
      expect(failures, `${z.zoneName} coverage`).toHaveLength(0);
    }
  });
});

describe('client rules the code had not been reading', () => {
  it('widens corner plots and keeps them inside the client aspect band', async () => {
    const c = await config();
    const p = await plan();
    const band = (c.client.villa_plots as Record<string, { min: number; max: number }>).aspect_ratio!;
    let widened = 0;
    for (const z of p.zones) {
      const layout = z.options[z.chosenIndex];
      if (!layout || layout.plots.length === 0) continue;
      const module = Math.min(...layout.plots.map((pl) => pl.widthM));
      for (const plot of layout.plots) {
        if (plot.widthM > module + 1e-6) {
          expect(plot.corner, `${plot.id} widened but is not a corner`).toBe(true);
          widened += 1;
        }
        const aspect = plot.depthM / plot.widthM;
        expect(aspect, `${plot.id} aspect`).toBeGreaterThanOrEqual(band.min - 1e-6);
      }
    }
    expect(widened, 'no corner plot was widened').toBeGreaterThan(0);
  });

  it('never lets a widened corner overlap its neighbour', async () => {
    const p = await plan();
    for (const z of p.zones) {
      const layout = z.options[z.chosenIndex];
      if (!layout || layout.plots.length < 2) continue;
      // Only the widened plots can overlap, so test each against every other.
      const module = Math.min(...layout.plots.map((pl) => pl.widthM));
      const grown = layout.plots.filter((pl) => pl.widthM > module + 1e-6);
      for (const a of grown) {
        for (const b of layout.plots) {
          if (a.id === b.id) continue;
          const overlap = multiPolyArea(intersect([[a.ring]], [[b.ring]]));
          expect(overlap, `${a.id} overlaps ${b.id}`).toBeLessThan(0.5);
        }
      }
    }
  });

  it('checks the villa against the size the client confirmed', async () => {
    const p = await plan();
    const villaZones = p.zones.filter((z) => z.use === 'villas' && z.options.length > 0);
    expect(villaZones.length).toBeGreaterThan(0);
    for (const z of villaZones) {
      const finding = z.options[z.chosenIndex]!.findings.find((f) => f.id === 'villa.type_plinth');
      expect(finding, `${z.zoneName} has no villa size finding`).toBeDefined();
      // On this programme the three client rules cannot all hold, and the tool
      // must say so rather than draw a placeholder and report success.
      expect(finding!.status).toBe('fail');
      expect(finding!.detail).toMatch(/floors, not|% of the plot covered/);
    }
  });

  it('scores orientation against the client preferred facings, not a hard-coded rule', async () => {
    const c = await config();
    const p = await plan();
    const preferred = (c.client.plot_orientation as Record<string, string[]>).preferred_facing!;
    const z = p.zones.find((x) => x.use === 'villas' && (x.options[x.chosenIndex]?.plots.length ?? 0) > 0)!;
    const finding = z.options[z.chosenIndex]!.findings.find((f) => f.id === 'villa.orientation');
    expect(finding).toBeDefined();
    for (const face of preferred) expect(finding!.title).toContain(face);
  });

  it('applies the stricter of the client and KMBR recreation width', async () => {
    const c = await config();
    const p = await plan();
    const clientWidth = (c.client.recreational_area as Record<string, number>).min_width_m;
    const z = p.zones.find((x) => x.use === 'villas' && x.options.length > 0)!;
    const finding = z.options[z.chosenIndex]!.findings.find((f) => f.id === 'villa.recreation');
    expect(finding).toBeDefined();
    expect(finding!.reference).toContain(String(clientWidth));
    expect(finding!.detail).toMatch(/stricter of/);
  });
});
