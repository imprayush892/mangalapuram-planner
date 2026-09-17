import { describe, expect, it } from 'vitest';
import { config, expected } from './fixtures';
import {
  accessWidthM,
  apartmentRecreation,
  baseYards,
  coverageFsi,
  highRise,
  parkingForFlats,
  parkingForOther,
  weightedFsi,
  yardIncreaseM,
  yardsFor,
} from '../rules/kmbr';

interface KmbrGolden {
  yard_increase_m: Record<string, number>;
  A1_front_avg_at_60m: number;
  access_A1_total_floor_30000m2: number;
  parking_A1_per_du_139m2: number;
  high_rise: Record<string, boolean>;
}

describe('M2 KMBR engine — golden values', () => {
  it('applies the Rule 26 height increment to every listed height', async () => {
    const { kmbr } = await config();
    const g = (await expected()).kmbr as KmbrGolden;
    for (const [key, want] of Object.entries(g.yard_increase_m)) {
      const heightM = Number(key.replace('H', ''));
      expect(yardIncreaseM(kmbr, heightM), `H${heightM}`).toBeCloseTo(want, 6);
    }
  });

  it('gives an A1 front yard of 11.5 m at 60 m tall', async () => {
    const { kmbr } = await config();
    const g = (await expected()).kmbr as KmbrGolden;
    const { yards } = yardsFor(kmbr, { occupancy: 'A1', heightM: 60 });
    expect(yards.frontAvg).toBeCloseTo(g.A1_front_avg_at_60m, 6);
  });

  it('caps yards at the Rule 26 ceiling', async () => {
    const { kmbr } = await config();
    const { yards } = yardsFor(kmbr, { occupancy: 'A1', heightM: 200 });
    expect(yards.frontAvg).toBe(16);
    expect(yards.sideMin).toBe(16);
  });

  it('reads Table 7 access widths by total floor area', async () => {
    const { kmbr } = await config();
    const g = (await expected()).kmbr as KmbrGolden;
    expect(accessWidthM(kmbr, 'A1', 30_000).widthM).toBe(g.access_A1_total_floor_30000m2);
    expect(accessWidthM(kmbr, 'A1', 24_000).widthM).toBe(7);
    expect(accessWidthM(kmbr, 'A1', 500).widthM).toBe(2);
  });

  it('reads Table 9 flat parking at 139 m2 per unit', async () => {
    const { kmbr } = await config();
    const g = (await expected()).kmbr as KmbrGolden;
    const p = parkingForFlats(kmbr, 100, 139, 30);
    expect(p.cars / 100).toBeCloseTo(g.parking_A1_per_du_139m2, 6);
    // 15% visitors on top, then two-wheeler space at 25% of the car area.
    expect(p.totalCars).toBe(115);
    expect(p.twoWheelerAreaM2).toBeCloseTo(p.carAreaM2 * 0.25, 6);
  });

  it('classifies high-rise by height or floor count', async () => {
    const { kmbr } = await config();
    const g = (await expected()).kmbr as KmbrGolden;
    expect(highRise(kmbr, 15, 5).isHighRise).toBe(g.high_rise['15m_5fl']);
    expect(highRise(kmbr, 16, 5).isHighRise).toBe(g.high_rise['16m_5fl']);
    expect(highRise(kmbr, 15, 6).isHighRise).toBe(g.high_rise['15m_6fl']);
  });

  it('reads Table 6 coverage and FSI tiers', async () => {
    const { kmbr } = await config();
    const a1 = coverageFsi(kmbr, 'A1');
    expect(a1.coveragePct).toBe(65);
    expect(a1.fsiTiers).toEqual([3, 4, 6]);
    expect(coverageFsi(kmbr, 'B_school').fsiTiers[0]).toBe(2.5);
  });

  it('weights FSI across a group of buildings by floor area', async () => {
    expect(
      weightedFsi([
        { fsi: 3, floorAreaM2: 1000 },
        { fsi: 1.5, floorAreaM2: 1000 },
      ]),
    ).toBeCloseTo(2.25, 6);
  });

  it('sizes Table 10 parking for other uses', async () => {
    const { kmbr } = await config();
    // School: 1 car per 300 m2.
    expect(parkingForOther(kmbr, 'B_school', 3000, 30).totalCars).toBe(10);
    // Senior living takes the A2 rate at 25%.
    const seniorRate = parkingForOther(kmbr, 'A2_senior', 1170, 30).cars;
    const a2Rate = parkingForOther(kmbr, 'A2', 1170, 30).cars;
    expect(seniorRate).toBeCloseTo(a2Rate * 0.25, 6);
    // Commercial is tiered: 1170/90 then the remainder at 1/60.
    expect(parkingForOther(kmbr, 'F_commercial', 2170, 30).cars).toBeCloseTo(1170 / 90 + 1000 / 60, 6);
  });

  it('sizes Rule 43 apartment recreation', async () => {
    const { kmbr } = await config();
    const r = apartmentRecreation(kmbr, 900, 131_118);
    expect(r.applies).toBe(true);
    expect(r.areaM2).toBeCloseTo(131_118 * 0.06, 3);
    expect(r.groundAreaM2).toBeCloseTo(r.areaM2 * 0.35, 3);
    expect(apartmentRecreation(kmbr, 10, 5000).applies).toBe(false);
  });

  it('picks the Table 4 row that matches the occupancy and plot', async () => {
    const { kmbr } = await config();
    const small = baseYards(kmbr, { occupancy: 'A1', heightM: 8, plotAreaM2: 120, builtUpAreaM2: 180 });
    expect(small.yards.frontAvg).toBe(1.8);
    const normal = baseYards(kmbr, { occupancy: 'A1', heightM: 8, plotAreaM2: 200, builtUpAreaM2: 180 });
    expect(normal.yards.frontAvg).toBe(3.0);
  });

  it('refuses to invent a regulation value that is missing from config', async () => {
    expect(() => yardIncreaseM({}, 30)).toThrow(/missing from config/);
  });
});
