import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { generateVillaLayouts } from '../generators/villa';
import { loadProgramme } from '../rules/programme';
import { multiPolyArea } from '../geom/planar';
import { sizeVillaPlots } from '../rules/client';

describe('M3 villa generator — SENIOR LIVING (3.06 ac)', () => {
  it('lays out senior plots on the villa rules, at the senior household size', async () => {
    const s = await site();
    const c = await config();
    const zone = s.zones.find((z) => z.name === 'SENIOR LIVING')!;
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    // The senior lines state their own land and units; scale to the zone.
    const lines = programme.lines.filter((l) => l.use === 'senior');
    const totalAc = lines.reduce((sum, l) => sum + l.landAc, 0);
    const totalUnits = lines.reduce((sum, l) => sum + l.units, 0);
    const targetUnits = Math.round((totalUnits / totalAc) * zone.computedInScopeAc);

    const options = generateVillaLayouts({
      zoneId: zone.id,
      zoneName: zone.name,
      zone: zone.geom,
      dem: s.dem,
      kmbr: c.kmbr,
      client: c.client,
      assumptions: c.assumptions,
      targetUnits,
      householdSize: 1.6,
      senior: true,
    });

    expect(options.length).toBe(3);
    const sizing = sizeVillaPlots(c.client, multiPolyArea(zone.geom), targetUnits);
    // 32 units/ac on the senior lines gives a unit plot well under the minimum,
    // so the client's row-housing rule must trigger here too.
    expect(sizing.rowHousing).toBe(true);
    for (const o of options) {
      expect(o.strategy).toMatch(/row senior/);
      expect(o.metrics.unitCount).toBeLessThanOrEqual(targetUnits);
      expect(o.metrics.populationCapacity).toBeCloseTo(o.metrics.unitCount * 1.6, 6);
      for (const p of o.plots) {
        expect(p.areaM2).toBeGreaterThanOrEqual(sizing.minPlotAreaWithToleranceM2 - 1e-6);
      }
      expect(o.findings.some((f) => f.id === 'villa.min_plot_area')).toBe(true);
    }
  });
});
