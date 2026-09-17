import { describe, expect, it } from 'vitest';
import { config } from './fixtures';
import { loadProgramme } from '../rules/programme';
import { openItems, ruleConflicts } from '../rules/conflicts';

describe('M2 programme engine', () => {
  it('reads every cashflow line and keeps the hospital deferred', async () => {
    const c = await config();
    const p = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    expect(p.lines.length).toBe(14);
    const hospital = p.lines.find((l) => l.id === 'hospital');
    expect(hospital?.deferred).toBe(true);
    expect(p.deferredDemandAc).toBe(5);
    // Deferred land is excluded from the in-scope demand.
    expect(p.lines.filter((l) => !l.deferred).some((l) => l.id === 'hospital')).toBe(false);
  });

  it('reports the land shortfall honestly rather than hiding it', async () => {
    const c = await config();
    const p = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    // 1.2 + 3 + 1 + 10.3 + 5 + 1 + 7 + 4 + 32 + 10.8 + 3 + 0 + 1.5 = 79.8 ac
    expect(p.demandedAc).toBeCloseTo(79.8, 6);
    expect(p.inScopeAc).toBe(73.54);
    expect(p.shortfallAc).toBeCloseTo(6.26, 6);
    expect(p.notes.join(' ')).toMatch(/shortfall of 6\.3 ac/);
  });

  it('applies the client SBUA definitions per use', async () => {
    const c = await config();
    const p = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const apartments = p.lines.find((l) => l.id === 'balance_apartments')!;
    expect(apartments.sbuaSftPerUnit).toBeCloseTo(1976.4, 1);
    expect(apartments.totalSbuaSft).toBeCloseTo(1976.4 * 900, 0);
    const villas = p.lines.find((l) => l.id === 'balance_villas')!;
    expect(villas.sbuaSftPerUnit).toBeCloseTo(2150, 6);
    const senior = p.lines.find((l) => l.id === 'senior_enclave')!;
    expect(senior.sbuaSftPerUnit).toBeCloseTo(1150, 6);
  });

  it('counts population at the assumed household sizes', async () => {
    const c = await config();
    const p = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    // 1,000 flats + 700 villas at 3.5, 192 senior units at 1.6
    expect(p.population).toBeCloseTo((100 + 900 + 60 + 640) * 3.5 + (32 + 160) * 1.6, 3);
    expect(p.population).toBeGreaterThan(p.populationTargetNow);
    expect(p.populationFinalCapacity).toBe(6300);
  });

  it('carries the hotel and business hub in as flagged assumptions', async () => {
    const c = await config();
    const p = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const hotel = p.lines.find((l) => l.id === 'hotel')!;
    expect(hotel.isAssumption).toBe(true);
    expect(hotel.units).toBe(120);
    expect(hotel.totalPlinthSft).toBe(120_000);
    expect(p.lines.find((l) => l.id === 'business_hub')!.isAssumption).toBe(true);
  });

  it('sizes parking and access per line from the KMBR tables', async () => {
    const c = await config();
    const p = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const apartments = p.lines.find((l) => l.id === 'balance_apartments')!;
    // 1,500 sft = 139.4 m2 per unit -> 1 car/DU, +15% visitors on 900 units.
    expect(apartments.parkingCars).toBe(1035);
    expect(apartments.accessWidthM).toBe(8);
    expect(apartments.dtpApproval).toBe(true);
    const school = p.lines.find((l) => l.id === 'school')!;
    expect(school.coveragePct).toBe(40);
    expect(school.fsiFree).toBe(2.5);
  });
});

describe('M2 rule conflicts', () => {
  it('lists the front-yard conflict and applies KMBR', async () => {
    const c = await config();
    const conflicts = ruleConflicts(c.client, c.kmbr);
    const front = conflicts.find((f) => f.id === 'conflict.front_yard');
    expect(front).toBeDefined();
    expect(front!.conflict).toEqual({
      clientValue: '2.0 m',
      kmbrValue: '3.0 m average / 1.8 m minimum',
      applied: '3.0 m',
      appliedBy: 'KMBR',
    });
  });

  it('lists the 6 m internal road against the Rule 31 7 m street', async () => {
    const c = await config();
    const f = ruleConflicts(c.client, c.kmbr).find((x) => x.id === 'conflict.internal_road_width');
    expect(f?.conflict?.appliedBy).toBe('CLIENT');
    expect(f?.detail).toMatch(/flagged, not blocked/);
  });

  it('keeps the stricter client rule where the client is stricter', async () => {
    const c = await config();
    const conflicts = ruleConflicts(c.client, c.kmbr);
    expect(conflicts.find((f) => f.id === 'conflict.min_plot_area')?.conflict?.appliedBy).toBe('CLIENT');
    expect(conflicts.find((f) => f.id === 'conflict.tower_spacing')?.conflict?.appliedBy).toBe('CLIENT');
  });

  it('surfaces every open item from SPEC section 11 with its default', async () => {
    const c = await config();
    const items = openItems(c.client, c.assumptions);
    expect(items.map((i) => i.key)).toEqual([
      'core_flats_split',
      'min_side_applies_to',
      'front_yard',
      'fsi_tier',
      'sprinklered',
      'aai_height_cap_m',
      'tbm_msl_offset_m',
    ]);
    expect(items.find((i) => i.key === 'core_flats_split')?.value).toBe('20 / 80');
    expect(items.find((i) => i.key === 'aai_height_cap_m')?.value).toBe('unset');
    expect(items.find((i) => i.key === 'tbm_msl_offset_m')?.value).toMatch(/outfall design blocked/);
  });
});
