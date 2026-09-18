import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { normaliseGoal, settingsFor, layoutWeightsFor, goalExplanation, BALANCED_GOAL } from '../optimise/goal';
import type { SuperGoal } from '../optimise/goal';
import { buildWaterModel, waterStatsFor, isWetCell, waterBuffer, pondingGround } from '../terrain/water';
import { runSiting } from '../siting/allocate';
import { runMasterPlan } from '../masterplan/run';
import { loadProgramme } from '../rules/programme';
import { measureZones } from '../siting/metrics';
import { multiPolyArea } from '../geom/planar';
import type { ZoneUse } from '../site/level1';

const SPACE: SuperGoal = { space: 1, terrain: 0, water: 0 };
const TERRAIN: SuperGoal = { space: 0, terrain: 1, water: 0 };
const WATER: SuperGoal = { space: 0, terrain: 0, water: 1 };

async function waterModel() {
  const s = await site();
  const c = await config();
  return { s, c, water: buildWaterModel({ dem: s.dem, minUpslopeCells: 250, features: s.features }) };
}

describe('the super goal', () => {
  it('normalises any scale to the same goal and names what leads', () => {
    const a = normaliseGoal({ space: 2, terrain: 1, water: 1 });
    const b = normaliseGoal({ space: 200, terrain: 100, water: 100 });
    expect(a.space).toBeCloseTo(b.space, 9);
    expect(a.space).toBeCloseTo(0.5, 9);
    expect(a.dominant).toBe('space');
    expect(normaliseGoal(TERRAIN).label).toBe('Terrain-led');
    expect(normaliseGoal(WATER).label).toBe('Water-led');
    expect(normaliseGoal(BALANCED_GOAL).label).toBe('Balanced');
    // All-zero is not a goal; it falls back rather than scoring everything flat.
    expect(normaliseGoal({ space: 0, terrain: 0, water: 0 }).space).toBeCloseTo(1 / 3, 9);
  });

  it('moves every setting the objectives are supposed to move', () => {
    const base = { routeGradePenaltyM: 12, waterBufferM: 15 };
    const space = settingsFor(normaliseGoal(SPACE), base);
    const terrain = settingsFor(normaliseGoal(TERRAIN), base);
    const water = settingsFor(normaliseGoal(WATER), base);

    // Terrain buys road detour; water buys buffer and crossing avoidance.
    expect(terrain.routeGradePenaltyM).toBeGreaterThan(space.routeGradePenaltyM * 3);
    expect(water.waterBufferM).toBeGreaterThan(space.waterBufferM * 3);
    expect(water.routeWaterPenaltyM).toBeGreaterThan(0);
    expect(space.routeWaterPenaltyM).toBe(0);
    expect(terrain.preferContourRoads).toBe(true);
    expect(space.preferContourRoads).toBe(false);
    expect(water.excludePonding).toBe(true);
    expect(space.excludePonding).toBe(false);
  });

  it('redistributes layout weight without losing any of it', () => {
    for (const g of [SPACE, TERRAIN, WATER, BALANCED_GOAL]) {
      const w = layoutWeightsFor(normaliseGoal(g));
      const total = Object.values(w).reduce((s, v) => s + v, 0);
      expect(total).toBeCloseTo(1, 9);
    }
    expect(layoutWeightsFor(normaliseGoal(SPACE)).yield).toBeGreaterThan(
      layoutWeightsFor(normaliseGoal(TERRAIN)).yield,
    );
    expect(layoutWeightsFor(normaliseGoal(TERRAIN)).earthwork).toBeGreaterThan(
      layoutWeightsFor(normaliseGoal(SPACE)).earthwork,
    );
    expect(layoutWeightsFor(normaliseGoal(WATER)).water).toBeGreaterThan(0);
    expect(layoutWeightsFor(normaliseGoal(SPACE)).water).toBe(0);
  });

  it('explains itself in one line per objective', () => {
    const g = normaliseGoal({ space: 1, terrain: 2, water: 1 });
    const lines = goalExplanation(g, settingsFor(g, { routeGradePenaltyM: 12, waterBufferM: 15 }));
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.length).toBeGreaterThan(30);
  });
});

describe('the hydrology', () => {
  it('finds catchments, wetness and distance to water over the real site', async () => {
    const { water } = await waterModel();
    expect(water.outlets.length).toBeGreaterThan(0);
    expect(water.channelCells.length).toBeGreaterThan(0);
    expect(water.maxWetness).toBeGreaterThan(0);
    // Every surveyed cell belongs to exactly one catchment.
    let labelled = 0;
    for (let k = 0; k < water.catchment.length; k += 1) if (water.catchment[k]! >= 0) labelled += 1;
    expect(labelled).toBeGreaterThan(50_000);
    // A channel cell is at distance zero from water, by construction.
    for (const k of Array.from(water.channelCells).slice(0, 50)) {
      expect(water.distanceToWaterM[k]).toBe(0);
    }
  });

  it('never calls unsurveyed ground dry', async () => {
    const { water } = await waterModel();
    let unknown = 0;
    for (let k = 0; k < water.wetness.length; k += 1) {
      if (!Number.isFinite(water.wetness[k]!)) {
        unknown += 1;
        // Unknown wetness must not read as a wet cell either way by accident.
        expect(isWetCell(water, k)).toBe(water.ponding[k] === 1);
      }
    }
    expect(unknown).toBeGreaterThan(0);
  });

  it('measures a zone against the water network', async () => {
    const { s, water } = await waterModel();
    const zone = s.zones.find((z) => z.geom.length > 0)!;
    const stats = waterStatsFor(s.dem, water, zone.geom, 15);
    expect(stats.wetnessRank).toBeGreaterThanOrEqual(0);
    expect(stats.wetnessRank).toBeLessThanOrEqual(1);
    expect(stats.catchments).toBeGreaterThan(0);
    expect(stats.pondingShare).toBeGreaterThanOrEqual(0);
  });

  it('widens the no-build strip as the water weight rises', async () => {
    const { s, water } = await waterModel();
    const narrow = multiPolyArea(waterBuffer(s.dem, water, s.parcel, 6));
    const wide = multiPolyArea(waterBuffer(s.dem, water, s.parcel, 36));
    expect(wide).toBeGreaterThan(narrow);
    expect(multiPolyArea(pondingGround(s.dem, water, s.parcel))).toBeGreaterThanOrEqual(0);
  });
});

describe('the objectives change the plan', () => {
  async function planFor(goal: SuperGoal) {
    const s = await site();
    const c = await config();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const siting = runSiting({ site: s, kmbr: c.kmbr, siting: c.siting, programme, goal });
    const alt = siting.alternatives[0]!;
    const zoneUses: Record<string, ZoneUse> = Object.fromEntries(
      alt.allocations.map((a) => [a.zoneId, a.use]),
    );
    const plan = runMasterPlan(s, c, {
      zoneUses, sitingLabel: alt.label, fsi: 3, floorOptions: [12, 15, 20],
      apartmentMix: ['2BHK', '3BHK'], flatsPerFloor: 4, runId: 1, goal,
    });
    return { siting, alt, plan };
  }

  it('scores the same zone differently under each objective', async () => {
    const s = await site();
    const c = await config();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const metrics = measureZones(s, c.kmbr, c.siting);
    const runs = [SPACE, TERRAIN, WATER].map((goal) =>
      runSiting({ site: s, kmbr: c.kmbr, siting: c.siting, programme, goal, metrics }),
    );
    // A zone's score for a use must not be identical under all three goals, or
    // the objectives are decorative.
    const scoresFor = (r: (typeof runs)[number]): string =>
      r.alternatives[0]!.allocations.map((a) => `${a.zoneId}:${a.use}:${a.score.toFixed(1)}`).join('|');
    const [a, b, cc] = runs.map(scoresFor);
    expect(a).not.toBe(b);
    expect(b).not.toBe(cc);
  });

  it('gives a water-led plan less buildable land than a space-led one', async () => {
    const spaceRun = await planFor(SPACE);
    const waterRun = await planFor(WATER);
    // The water buffer is real land taken out before anything is laid out.
    const spaceNote = spaceRun.plan.notes.find((n) => n.includes('watercourse buffer'));
    const waterNote = waterRun.plan.notes.find((n) => n.includes('watercourse buffer'));
    expect(waterNote, 'a water-led plan must state the land its buffer costs').toBeTruthy();
    const acresIn = (n: string | undefined): number => (n ? Number(/([\d.]+) ac/.exec(n)?.[1] ?? 0) : 0);
    expect(acresIn(waterNote)).toBeGreaterThan(acresIn(spaceNote));
    // And it must cost something, or the objective is not doing anything —
    // but it must still leave a plan, not scrape the site bare.
    expect(waterRun.plan.totals.villaPlots).toBeLessThan(spaceRun.plan.totals.villaPlots);
    expect(
      waterRun.plan.totals.villaPlots,
      'a water-led plan must still be a plan: buffering every rill is not water-led, it is unbuildable',
    ).toBeGreaterThan(spaceRun.plan.totals.villaPlots * 0.3);
  });

  it('makes a terrain-led plan take flatter roads on the same allocation', async () => {
    // Holding the land use fixed is the only way to test the road objective:
    // two goals that also allocate differently are two different schemes, and
    // comparing their gradients says nothing about road alignment.
    const s = await site();
    const c = await config();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const fixed = runSiting({ site: s, kmbr: c.kmbr, siting: c.siting, programme });
    const alt = fixed.alternatives[0]!;
    const zoneUses: Record<string, ZoneUse> = Object.fromEntries(
      alt.allocations.map((a) => [a.zoneId, a.use]),
    );
    const planWith = (goal: SuperGoal) =>
      runMasterPlan(s, c, {
        zoneUses, sitingLabel: alt.label, fsi: 3, floorOptions: [12, 15, 20],
        apartmentMix: ['2BHK', '3BHK'], flatsPerFloor: 4, runId: 1, goal,
      });

    const spacePlan = planWith(SPACE);
    const terrainPlan = planWith(TERRAIN);
    const share = (p: typeof spacePlan): number =>
      p.gradients.totalLengthM > 0 ? p.gradients.overDesirableM / p.gradients.totalLengthM : 0;

    expect(share(terrainPlan), 'terrain-led roads must not be steeper').toBeLessThanOrEqual(
      share(spacePlan) + 1e-9,
    );
    /*
     * And the earthwork itself must be lower, which is the objective as the
     * brief states it. Per plot, not in total: a plan that simply cuts fewer
     * plots moves less earth without having responded to anything.
     */
    const earthworkPerPlot = (p: typeof spacePlan): number => {
      let moved = 0;
      let plots = 0;
      for (const z of p.zones) {
        const m = z.options[z.chosenIndex]?.metrics;
        if (!m || m.plotCount === 0) continue;
        moved += m.cutM3 + m.fillM3;
        plots += m.plotCount;
      }
      return plots > 0 ? moved / plots : Number.NaN;
    };
    expect(
      earthworkPerPlot(terrainPlan),
      'terrain-led must move less earth per plot',
    ).toBeLessThanOrEqual(earthworkPerPlot(spacePlan) + 1e-9);
  });

  it('states what each objective did, on every run', async () => {
    const { plan } = await planFor({ space: 1, terrain: 1, water: 1 });
    const heads = plan.notes.slice(0, 3);
    expect(heads[0]).toMatch(/^Space \d+%/);
    expect(heads[1]).toMatch(/^Terrain \d+%/);
    expect(heads[2]).toMatch(/^Water \d+%/);
  });
});
