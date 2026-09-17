import { describe, expect, it } from 'vitest';
import { config, expected } from './fixtures';
import { apartmentSbuaSft, sizeApartments, sizeVillaPlots, villaSbuaSft } from '../rules/client';
import type { BandName } from '../rules/client';
import { acresToM2 } from '../units';

interface VillaGolden {
  balance_villas: {
    land_ac: number;
    units: number;
    unit_plot_m2: number;
    grouping: number;
    plot_m2: number;
    plots: number;
    dims_long18: [number, number];
    footprint_m2: number;
  };
  senior_enclave: {
    land_ac: number;
    units: number;
    unit_plot_m2: number;
    grouping: number;
    plot_m2: number;
    plots: number;
    dims_long18: [number, number];
    aspect: number;
  };
  min_plot_area_m2: number;
}

interface ApartmentGolden {
  total_floor_area_m2: number;
  total_footprint_m2: number;
  footprint_share_of_land: number;
  rows: { mix: BandName[]; per_floor: number; plate_m2: number; towers: number; flats: number }[];
}

describe('M2 client sizing — golden values', () => {
  it('derives the minimum plot area from the 18 m long side', async () => {
    const { client } = await config();
    const g = (await expected()).villa_20_30_50 as VillaGolden;
    const sizing = sizeVillaPlots(client, acresToM2(32), 640);
    expect(sizing.minPlotAreaM2).toBeCloseTo(g.min_plot_area_m2, 1);
  });

  it('reproduces the balance-villas 20/30/50 sizing', async () => {
    const { client } = await config();
    const g = ((await expected()).villa_20_30_50 as VillaGolden).balance_villas;
    const s = sizeVillaPlots(client, acresToM2(g.land_ac), g.units);
    expect(s.unitPlotAreaM2).toBeCloseTo(g.unit_plot_m2, 1);
    expect(s.grouping).toBe(g.grouping);
    expect(s.plotAreaM2).toBeCloseTo(g.plot_m2, 1);
    expect(s.plots).toBe(g.plots);
    expect(s.widthM).toBeCloseTo(g.dims_long18[0], 2);
    expect(s.depthM).toBeCloseTo(g.dims_long18[1], 2);
    expect(s.footprintM2).toBeCloseTo(g.footprint_m2, 1);
    expect(s.rowHousing).toBe(true);
  });

  it('reproduces the senior-enclave sizing, tolerance and all', async () => {
    const { client } = await config();
    const g = ((await expected()).villa_20_30_50 as VillaGolden).senior_enclave;
    const s = sizeVillaPlots(client, acresToM2(g.land_ac), g.units);
    expect(s.unitPlotAreaM2).toBeCloseTo(g.unit_plot_m2, 1);
    expect(s.grouping).toBe(g.grouping);
    expect(s.plotAreaM2).toBeCloseTo(g.plot_m2, 1);
    expect(s.plots).toBe(g.plots);
    expect(s.widthM).toBeCloseTo(g.dims_long18[0], 2);
    expect(s.depthM).toBeCloseTo(g.dims_long18[1], 2);
    expect(s.aspect).toBeCloseTo(g.aspect, 2);
    // 126.5 m2 is under the 129.6 m2 minimum but inside the client's own 3%
    // tolerance — the client's 126 m2 example depends on it.
    expect(s.plotAreaM2).toBeLessThan(s.minPlotAreaM2);
    expect(s.plotAreaM2).toBeGreaterThanOrEqual(s.minPlotAreaWithToleranceM2);
  });

  it('splits land 20/30/50 exactly', async () => {
    const { client } = await config();
    const land = acresToM2(32);
    const s = sizeVillaPlots(client, land, 640);
    expect(s.roadsM2 / land).toBeCloseTo(0.2, 9);
    expect(s.openSpaceM2 / land).toBeCloseTo(0.3, 9);
    expect(s.saleableM2 / land).toBeCloseTo(0.5, 9);
  });

  it('gives a 324 m2 minimum under the both-sides reading of the 18 m rule', async () => {
    const { client } = await config();
    const s = sizeVillaPlots(client, acresToM2(32), 640, { minSideApplies: 'both_sides' });
    expect(s.minPlotAreaM2).toBeCloseTo(324, 6);
    expect(s.grouping).toBeGreaterThan(2);
  });

  it('reproduces the apartment client method on 10.8 ac at FSI 3', async () => {
    const { client } = await config();
    const g = (await expected()).apartments_client_method as ApartmentGolden;
    const landM2 = acresToM2(10.8);
    for (const row of g.rows) {
      const s = sizeApartments(client, {
        landM2,
        fsi: 3,
        floors: 20,
        mix: row.mix,
        flatsPerFloor: row.per_floor,
      });
      expect(Math.round(s.totalFloorAreaM2)).toBe(g.total_floor_area_m2);
      expect(Math.round(s.totalFootprintM2)).toBe(g.total_footprint_m2);
      expect(s.footprintShareOfLand).toBeCloseTo(g.footprint_share_of_land, 2);
      expect(Math.round(s.plateM2), `plate for ${row.mix.join('+')} @${row.per_floor}`).toBe(row.plate_m2);
      expect(s.towers, `towers for ${row.mix.join('+')} @${row.per_floor}`).toBe(row.towers);
      expect(s.flats, `flats for ${row.mix.join('+')} @${row.per_floor}`).toBe(row.flats);
    }
  });

  it('flags the 15% footprint share as below the client 30–50% buildable band', async () => {
    const { client } = await config();
    const s = sizeApartments(client, {
      landM2: acresToM2(10.8),
      fsi: 3,
      floors: 20,
      mix: ['2BHK', '3BHK'],
      flatsPerFloor: 4,
    });
    expect(s.footprintShareOk).toBe(false);
    expect(s.notes.join(' ')).toMatch(/below the client's 30–50% buildable share/);
  });

  it('reproduces the SBUA definitions', async () => {
    const { client } = await config();
    const g = (await expected()).commercial as Record<string, number>;
    expect(apartmentSbuaSft(client, 1500)).toBeCloseTo(g.apartment_sbua_from_plinth_1500!, 1);
    expect(villaSbuaSft(client, 2000)).toBeCloseTo(g.villa_sbua_from_plinth_2000!, 6);
  });
});
