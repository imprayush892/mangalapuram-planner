import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { computeLive, builtMetrics } from '../metrics/live';
import type { LiveSwitches } from '../metrics/live';
import { runSiting } from '../siting/allocate';
import { runMasterPlan } from '../masterplan/run';
import { loadProgramme } from '../rules/programme';
import type { ZoneUse } from '../site/level1';

const BASE: LiveSwitches = {
  fsiTierIndex: 0,
  minSideApplies: 'long_side',
  apartmentMix: ['2BHK', '3BHK'],
  flatsPerFloor: 4,
  towerFloorOptions: [12, 15, 20],
};

async function setup() {
  const s = await site();
  const c = await config();
  const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
  const siting = runSiting({ site: s, kmbr: c.kmbr, siting: c.siting, programme });
  const alt = siting.alternatives[0]!;
  const zoneUses: Record<string, ZoneUse> = Object.fromEntries(
    alt.allocations.map((a) => [a.zoneId, a.use]),
  );
  return { s, c, zoneUses, alt };
}

describe('live metrics', () => {
  it('answers fast enough to run while a slider is moving', async () => {
    const { s, c, zoneUses } = await setup();
    // Warm once, then measure: the claim is that this is per-frame cheap.
    computeLive({ site: s, config: c, switches: BASE, zoneUses });
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) {
      computeLive({ site: s, config: c, switches: BASE, zoneUses });
    }
    const perCall = (Date.now() - started) / 20;
    expect(perCall, `${perCall.toFixed(1)} ms per call`).toBeLessThan(16);
  });

  it('moves when a lever moves, in the direction the lever implies', async () => {
    const { s, c, zoneUses } = await setup();
    const low = computeLive({ site: s, config: c, switches: BASE, zoneUses });
    const high = computeLive({
      site: s,
      config: c,
      switches: { ...BASE, fsiTierIndex: 2 },
      zoneUses,
    });
    // A higher FSI tier buys more floor area and more flats, nothing else.
    expect(high.floorAreaM2).toBeGreaterThan(low.floorAreaM2);
    expect(high.flats).toBeGreaterThan(low.flats);
    expect(high.villaPlots).toBe(low.villaPlots);

    const denser = computeLive({
      site: s,
      config: c,
      switches: { ...BASE, flatsPerFloor: 6 },
      zoneUses,
    });
    expect(denser.flats).toBe(low.flats);
    // More flats per floor is a bigger plate, so fewer towers carry the same area.
    expect(denser.towers).toBeLessThanOrEqual(low.towers);
  });

  it('names the rule behind every limit it reports', async () => {
    const { s, c, zoneUses } = await setup();
    const m = computeLive({ site: s, config: c, switches: BASE, zoneUses });
    expect(m.constraints.length).toBeGreaterThan(3);
    for (const con of m.constraints) {
      expect(con.reference.length, `${con.id} has no reference`).toBeGreaterThan(0);
      expect(con.message.length, `${con.id} has no message`).toBeGreaterThan(0);
    }
  });

  it('turns a control red only when it really is outside the rule', async () => {
    const { s, c, zoneUses } = await setup();
    const legal = computeLive({ site: s, config: c, switches: { ...BASE, flatsPerFloor: 5 }, zoneUses });
    expect(legal.constraints.find((x) => x.id === 'flatsPerFloor')!.breached).toBe(false);

    const illegal = computeLive({ site: s, config: c, switches: { ...BASE, flatsPerFloor: 9 }, zoneUses });
    const con = illegal.constraints.find((x) => x.id === 'flatsPerFloor')!;
    expect(con.breached).toBe(true);
    expect(con.message).toMatch(/outside the client's/);
  });

  it('keeps predicted and built apart instead of blending them', async () => {
    const { s, c, zoneUses, alt } = await setup();
    const predicted = computeLive({ site: s, config: c, switches: BASE, zoneUses });
    const plan = runMasterPlan(s, c, {
      zoneUses,
      sitingLabel: alt.label,
      fsi: 3,
      floorOptions: BASE.towerFloorOptions,
      apartmentMix: BASE.apartmentMix,
      flatsPerFloor: BASE.flatsPerFloor,
      runId: 1,
    });
    const built = builtMetrics(plan)!;

    // Both are real numbers, and the ground takes less than the rules allow —
    // which is exactly why the tool must not report one as the other.
    expect(predicted.villaPlots).toBeGreaterThan(0);
    expect(built.villaPlots).toBeGreaterThan(0);
    expect(built.villaPlots!).toBeLessThanOrEqual(predicted.villaPlots);
    expect(builtMetrics(null)).toBeNull();
  });

  it('reports no land for a use no zone carries', async () => {
    const { s, c } = await setup();
    const m = computeLive({ site: s, config: c, switches: BASE, zoneUses: {} });
    expect(m.plannedZones).toBe(0);
    expect(m.dwellings).toBe(0);
    expect(m.byUse).toHaveLength(0);
    expect(m.landAc).toBe(0);
  });
});
