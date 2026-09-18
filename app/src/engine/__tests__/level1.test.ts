import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { loadProgramme } from '../rules/programme';
import { inferUse, runLevel1, USE_LABEL } from '../site/level1';
import { generateVillaLayouts } from '../generators/villa';
import { generateBlockLayout } from '../generators/block';
import { generateTowerLayouts } from '../generators/tower';
import { buildScenario, parseScenario, SCENARIO_FORMAT } from '../scenario';
import type { LayoutOption } from '../generators/types';
import { m2ToSft } from '../units';

describe('M5 Level 1 zoning', () => {
  it('assigns a use to every client zone', async () => {
    const s = await site();
    const c = await config();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const result = runLevel1({
      zones: s.zones,
      parcel: s.parcel,
      programme,
      generated: {},
      householdSizes: { family: 3.5, senior: 1.6 },
    });
    // PHASE 4 has no land in scope, so it drops out.
    expect(result.assignments.length).toBe(s.zones.filter((z) => z.geom.length > 0).length);
    for (const a of result.assignments) expect(USE_LABEL[a.use]).toBeDefined();
    expect(inferUse('PROJECT - 2 (VILLAS)')).toBe('villas');
    expect(inferUse('APARTMENTS & FUTURE DEVELOPMENT')).toBe('apartments');
    expect(inferUse('SENIOR LIVING')).toBe('senior');
    expect(inferUse('HOSPITAL')).toBe('hospital_reserved');
    expect(inferUse('PHASE 2')).toBe('villas');
  });

  it('keeps the hospital reserved and places nothing on it', async () => {
    const s = await site();
    const c = await config();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const result = runLevel1({
      zones: s.zones,
      parcel: s.parcel,
      programme,
      generated: {},
      householdSizes: { family: 3.5, senior: 1.6 },
    });
    const hospital = result.balances.find((b) => b.use === 'hospital_reserved')!;
    expect(hospital.deferred).toBe(true);
    const finding = result.findings.find((f) => f.id === 'level1.use.hospital_reserved')!;
    expect(finding.detail).toMatch(/waits for the 26.4 ac balance land/);
  });

  it('reports the land shortfall as a failure, not a rounding note', async () => {
    const s = await site();
    const c = await config();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const result = runLevel1({
      zones: s.zones,
      parcel: s.parcel,
      programme,
      generated: {},
      householdSizes: { family: 3.5, senior: 1.6 },
    });
    const finding = result.findings.find((f) => f.id === 'level1.land')!;
    expect(finding.status).toBe('fail');
    expect(result.shortfallAc).toBeCloseTo(6.26, 2);
    expect(finding.detail).toMatch(/either a line loses land/i);
  });

  it('closes the loop: generated yields feed back into the balance', async () => {
    const s = await site();
    const c = await config();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const zone = s.zones.find((z) => z.name === 'PROJECT - 2 (VILLAS)')!;
    const options = generateVillaLayouts({
      zoneId: zone.id,
      zoneName: zone.name,
      zone: zone.geom,
      dem: s.dem,
      kmbr: c.kmbr,
      client: c.client,
      assumptions: c.assumptions,
      targetUnits: Math.round(zone.computedInScopeAc * 20),
      householdSize: 3.5,
    });
    const generated: Record<string, LayoutOption[]> = { [zone.id]: options };
    const result = runLevel1({
      zones: s.zones,
      parcel: s.parcel,
      programme,
      generated,
      householdSizes: { family: 3.5, senior: 1.6 },
    });
    const villas = result.balances.find((b) => b.use === 'villas')!;
    expect(villas.zonesGenerated).toBe(1);
    expect(villas.zonesTotal).toBeGreaterThan(1);
    expect(villas.generatedUnits).toBe(options[0]!.metrics.unitCount);
    // One zone of several cannot carry the whole villa line, and the loop says so.
    const yieldFinding = result.findings.find((f) => f.id === 'level1.yield.villas')!;
    expect(yieldFinding.status).toBe('fail');
    expect(yieldFinding.detail).toMatch(/units short across 1 of/);
    expect(result.populationCapacity).toBeGreaterThan(0);
  });
});

describe('M5 other uses', () => {
  it('places a school block on gentle ground inside the yards', async () => {
    const s = await site();
    const c = await config();
    const zone = s.zones.find((z) => z.name === 'SCHOOL')!;
    const option = generateBlockLayout({
      zoneId: zone.id,
      zoneName: zone.name,
      zone: zone.geom,
      dem: s.dem,
      kmbr: c.kmbr,
      client: c.client,
      assumptions: c.assumptions,
      occupancy: 'B_school',
      builtUpSft: 200_000,
      useLabel: 'School',
      maxSlopeDeg: 8,
    });
    expect(option).not.toBeNull();
    const block = option!.blocks[0]!;
    expect(block.footprintM2).toBeGreaterThan(0);
    // The B (up to higher secondary) row of Table 6: 40% coverage, FSI 2.5.
    expect(option!.metrics.coveragePct).toBeLessThanOrEqual(40);
    expect(option!.metrics.fsiUsed).toBeLessThanOrEqual(2.5 + 1e-6);
    const ids = option!.findings.map((f) => f.id);
    expect(ids).toContain('block.coverage');
    expect(ids).toContain('block.fsi');
    expect(ids).toContain('block.parking');
    expect(ids).toContain('block.access');
    expect(ids).toContain('block.slope');
  });

  it('places the club and commercial blocks at their own Table 6 rows', async () => {
    const s = await site();
    const c = await config();
    const cases = [
      { name: 'CLUBHOUSE', occupancy: 'D1_recreational' as const, sft: 50_000, coverage: 70, fsi: 1.5 },
      { name: 'COMMERCIAL & CONVENTION CENTRE', occupancy: 'F_commercial' as const, sft: 300_000, coverage: 65, fsi: 3 },
    ];
    for (const useCase of cases) {
      const zone = s.zones.find((z) => z.name === useCase.name)!;
      const option = generateBlockLayout({
        zoneId: zone.id,
        zoneName: zone.name,
        zone: zone.geom,
        dem: s.dem,
        kmbr: c.kmbr,
        client: c.client,
        assumptions: c.assumptions,
        occupancy: useCase.occupancy,
        builtUpSft: useCase.sft,
        useLabel: useCase.name,
      });
      expect(option, useCase.name).not.toBeNull();
      expect(option!.metrics.coveragePct).toBeLessThanOrEqual(useCase.coverage);
      expect(option!.metrics.fsiUsed).toBeLessThanOrEqual(useCase.fsi + 1e-6);
      expect(option!.findings.find((f) => f.id === 'block.coverage')!.status).toBe('pass');
    }
  });

  it('reports when a zone cannot hold its programme line', async () => {
    const s = await site();
    const c = await config();
    // The commercial line asks for 300,000 sft on a 3.73 ac zone at 65% coverage.
    const zone = s.zones.find((z) => z.name === 'COMMERCIAL & CONVENTION CENTRE')!;
    const option = generateBlockLayout({
      zoneId: zone.id,
      zoneName: zone.name,
      zone: zone.geom,
      dem: s.dem,
      kmbr: c.kmbr,
      client: c.client,
      assumptions: c.assumptions,
      occupancy: 'F_commercial',
      builtUpSft: 300_000,
      useLabel: 'Commercial',
    })!;
    const yieldFinding = option.findings.find((f) => f.id === 'block.yield')!;
    expect(['pass', 'warn']).toContain(yieldFinding.status);
    expect(m2ToSft(option.blocks[0]!.builtUpM2)).toBeGreaterThan(0);
  });
});

describe('M5 scenarios', () => {
  it('round-trips a scenario with its full input snapshot', async () => {
    const s = await site();
    const c = await config();
    const zone = s.zones.find((z) => z.name === 'APARTMENTS & FUTURE DEVELOPMENT')!;
    const options = generateTowerLayouts({
      zoneId: zone.id,
      zoneName: zone.name,
      zone: zone.geom,
      dem: s.dem,
      kmbr: c.kmbr,
      client: c.client,
      assumptions: c.assumptions,
      fsi: 3,
      floorOptions: [20],
      mix: ['2BHK', '3BHK'],
      flatsPerFloor: 4,
      householdSize: 3.5,
    });
    const versions = {
      kmbr: String(c.kmbr.version),
      client: String(c.client.version),
      programme: String(c.programme.version),
    };
    const scenario = buildScenario({
      name: 'Test scenario',
      configVersions: versions,
      overrides: { kmbr: {}, client: { 'villa_plots.min_side_m': 20 }, programme: {}, assumptions: {}, siting: {} },
      switches: { fsiTierIndex: 0 },
      zoneUses: { [zone.id]: 'apartments' },
      layouts: { [zone.id]: { options, chosen: 0 } },
    });
    expect(scenario.format).toBe(SCENARIO_FORMAT);

    const { scenario: loaded, warnings } = parseScenario(JSON.stringify(scenario), versions);
    expect(warnings).toEqual([]);
    expect(loaded.overrides.client['villa_plots.min_side_m']).toBe(20);
    expect(loaded.layouts[zone.id]!.options.length).toBe(options.length);
    expect(loaded.layouts[zone.id]!.options[0]!.towers.length).toBe(options[0]!.towers.length);
    expect(loaded.zoneUses[zone.id]).toBe('apartments');
  });

  it('warns when the rules have changed since the scenario was saved', async () => {
    const c = await config();
    const versions = {
      kmbr: String(c.kmbr.version),
      client: String(c.client.version),
      programme: String(c.programme.version),
    };
    const scenario = buildScenario({
      name: 'Old',
      configVersions: { ...versions, kmbr: '2019-01-01' },
      overrides: { kmbr: {}, client: {}, programme: {}, assumptions: {}, siting: {} },
      switches: {},
      zoneUses: {},
      layouts: {},
    });
    const { warnings } = parseScenario(JSON.stringify(scenario), versions);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/kmbr_rules.yaml has changed/);
  });

  it('refuses a file that is not a scenario', () => {
    expect(() => parseScenario('{"hello":1}', { kmbr: '', client: '', programme: '' })).toThrow(
      /Not a Mangalapuram planner scenario/,
    );
    expect(() => parseScenario('not json', { kmbr: '', client: '', programme: '' })).toThrow(/could not be parsed/);
  });
});
