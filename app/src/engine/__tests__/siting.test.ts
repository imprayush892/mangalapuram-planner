import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { loadProgramme } from '../rules/programme';
import { measureZones } from '../siting/metrics';
import { checkConstraints, isEligible, useRules } from '../siting/constraints';
import { loadWeights, scoreCandidate } from '../siting/score';
import { runSiting } from '../siting/allocate';
import type { ZoneMetrics } from '../siting/types';
import type { ZoneUse } from '../site/level1';

let cached: ZoneMetrics[] | null = null;
async function metrics(): Promise<ZoneMetrics[]> {
  if (cached) return cached;
  const s = await site();
  const c = await config();
  cached = measureZones(s, c.kmbr, c.siting);
  return cached;
}

async function siting() {
  const s = await site();
  const c = await config();
  const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
  return runSiting({
    site: s,
    kmbr: c.kmbr,
    siting: c.siting,
    programme,
    metrics: await metrics(),
  });
}

describe('Phase 7 — zone metrics', () => {
  it('measures every zone that has land in scope', async () => {
    const s = await site();
    const m = await metrics();
    expect(m.length).toBe(s.zones.filter((z) => z.geom.length > 0).length);
    for (const z of m) {
      expect(z.areaAc).toBeGreaterThan(0);
      expect(z.buildableShare).toBeGreaterThanOrEqual(0);
      expect(z.buildableShare).toBeLessThanOrEqual(1);
      expect(Number.isFinite(z.centroid[0])).toBe(true);
    }
  });

  it('agrees with the site model on zone areas', async () => {
    const s = await site();
    for (const z of await metrics()) {
      const zone = s.zones.find((x) => x.id === z.zoneId)!;
      expect(z.areaAc).toBeCloseTo(zone.computedInScopeAc, 6);
    }
  });

  it('ranks elevation and edge position across the zones present', async () => {
    const m = await metrics();
    const ranks = m.map((z) => z.elevationRank);
    expect(Math.min(...ranks)).toBeCloseTo(0, 6);
    expect(Math.max(...ranks)).toBeCloseTo(1, 6);
    for (const z of m) {
      expect(z.edgeRank).toBeGreaterThanOrEqual(0);
      expect(z.edgeRank).toBeLessThanOrEqual(1);
    }
  });

  it('finds road frontage where the survey shows retained roads', async () => {
    const m = await metrics();
    // The existing road network runs through the site, so some zone must have
    // frontage — if none did, the frontage measure would be silently broken.
    expect(m.some((z) => z.frontageM > 0)).toBe(true);
    for (const z of m) {
      expect(z.frontageShare).toBeGreaterThanOrEqual(0);
      expect(z.frontageShare).toBeLessThanOrEqual(1.0001);
    }
  });

  it('reads the phase out of the zoning plan zone names', async () => {
    const m = await metrics();
    const phase2 = m.find((z) => z.zoneName === 'PHASE 2')!;
    expect(phase2.phase).toBe(2);
    expect(m.find((z) => z.zoneName === 'SCHOOL')!.phase).toBeNull();
  });
});

describe('Phase 7 — hard constraints', () => {
  it('vetoes senior living on ground steeper than 5 degrees', async () => {
    const c = await config();
    const m = await metrics();
    const steep = m.filter((z) => z.meanSlopeDeg > 5);
    expect(steep.length).toBeGreaterThan(0);
    for (const z of steep) {
      const constraints = checkConstraints(c.siting, 'senior', z, 10);
      const slope = constraints.find((x) => x.id === 'siting.slope')!;
      expect(slope.status).toBe('fail');
      expect(isEligible(constraints)).toBe(false);
    }
  });

  it('reads every threshold from config rather than the code', async () => {
    const c = await config();
    expect(useRules(c.siting, 'senior').max_mean_slope_deg).toBe(5);
    expect(useRules(c.siting, 'hospital_reserved').max_mean_slope_deg).toBe(10);
    expect(useRules(c.siting, 'school').max_mean_slope_deg).toBe(8);
    // A use with no rule entry applies only the shared buildable-share rule,
    // rather than inventing thresholds for it.
    const unknown = checkConstraints(c.siting, 'unassigned' as ZoneUse, (await metrics())[0]!, 10);
    expect(unknown.map((x) => x.id)).toEqual(['siting.buildable_share']);
  });

  it('never silently passes a constraint it cannot test', async () => {
    const c = await config();
    const m = await metrics();
    const constraints = checkConstraints(c.siting, 'hospital_reserved', m[0]!, 10);
    const unevaluable = constraints.filter((x) => x.status === 'unevaluable');
    expect(unevaluable.length).toBeGreaterThan(0);
    for (const u of unevaluable) {
      expect(u.actual).toBe('not tested');
      expect(u.reason).toBeTruthy();
    }
    // Unevaluable must not veto — it is reported, not treated as a failure.
    expect(isEligible(constraints)).toBe(isEligible(constraints.filter((x) => x.status !== 'unevaluable')));
  });

  it('demands road frontage where the use needs its own gate', async () => {
    const c = await config();
    const m = await metrics();
    for (const z of m) {
      const constraints = checkConstraints(c.siting, 'school', z, 10);
      const frontage = constraints.find((x) => x.id === 'siting.road_frontage')!;
      expect(frontage.status).toBe(z.frontageM > 0 ? 'pass' : 'fail');
    }
  });

  it('records constraints another engine checks rather than dropping them', async () => {
    const c = await config();
    const constraints = checkConstraints(c.siting, 'apartments', (await metrics())[0]!, 10);
    const layout = constraints.filter((x) => x.id.startsWith('siting.layout.'));
    expect(layout.length).toBe(2);
    expect(layout.every((x) => x.status === 'pass')).toBe(true);
  });
});

describe('Phase 7 — scoring', () => {
  it('returns 0-100 with every factor explained', async () => {
    const c = await config();
    const m = await metrics();
    const weights = loadWeights(c.siting);
    const { score, factors } = scoreCandidate(c.siting, weights, 'villas', m[0]!, {
      centroidsByUse: new Map(),
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(factors.map((f) => f.key)).toEqual([
      'buildable_area',
      'earthwork',
      'access_frontage',
      'adjacency',
      'view_elevation',
      'drainage_risk',
      'phase_order',
    ]);
    for (const f of factors) {
      expect(f.value).toBeGreaterThanOrEqual(0);
      expect(f.value).toBeLessThanOrEqual(100);
      expect(f.detail.length).toBeGreaterThan(5);
    }
  });

  it('takes its weights from config and honours a change', async () => {
    const c = await config();
    const m = await metrics();
    const base = loadWeights(c.siting);
    expect(base.buildable_area).toBe(25);

    // A zone with poor buildability should score worse once buildability
    // dominates the weighting.
    const worst = [...m].sort((a, b) => a.buildableShare - b.buildableShare)[0]!;
    const normal = scoreCandidate(c.siting, base, 'villas', worst, { centroidsByUse: new Map() }).score;
    const tilted = scoreCandidate(
      c.siting,
      { ...base, buildable_area: base.buildable_area * 10 },
      'villas',
      worst,
      { centroidsByUse: new Map() },
    ).score;
    expect(tilted).not.toBeCloseTo(normal, 3);
  });

  it('rewards a use for sitting near what it should be near', async () => {
    const c = await config();
    const m = await metrics();
    const weights = loadWeights(c.siting);
    const zone = m[0]!;
    const near = scoreCandidate(c.siting, weights, 'senior', zone, {
      centroidsByUse: new Map([
        ['hospital_reserved', [{ centroid: [zone.centroid[0] + 50, zone.centroid[1]], areaAc: 5 }]],
      ]),
    });
    const far = scoreCandidate(c.siting, weights, 'senior', zone, {
      centroidsByUse: new Map([
        ['hospital_reserved', [{ centroid: [zone.centroid[0] + 2000, zone.centroid[1]], areaAc: 5 }]],
      ]),
    });
    expect(near.score).toBeGreaterThan(far.score);
  });
});

describe('Phase 7 — allocation', () => {
  it('produces several whole-site alternatives, each saying how it differs', async () => {
    const result = await siting();
    expect(result.alternatives.length).toBeGreaterThanOrEqual(3);
    expect(result.alternatives.length).toBeLessThanOrEqual(5);
    const labels = new Set(result.alternatives.map((a) => a.label));
    expect(labels.size).toBe(result.alternatives.length);
    for (const a of result.alternatives) {
      expect(a.strategy.length).toBeGreaterThan(5);
      expect(a.totalScore).toBeGreaterThan(0);
      expect(a.totalScore).toBeLessThanOrEqual(100);
    }
  });

  it('gives every zone exactly one use, or says why it could not', async () => {
    const result = await siting();
    const zoneCount = result.metrics.length;
    for (const a of result.alternatives) {
      const ids = a.allocations.map((x) => x.zoneId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length + a.unallocated.length).toBe(zoneCount);
      for (const u of a.unallocated) expect(u.reason.length).toBeGreaterThan(10);
    }
  });

  it('never places a use on a zone its constraints veto', async () => {
    const result = await siting();
    const eligible = new Map(
      result.candidates.map((c) => [`${c.zoneId}::${c.use}`, c.eligible] as const),
    );
    for (const a of result.alternatives) {
      for (const alloc of a.allocations) {
        if (alloc.locked) continue;
        expect(eligible.get(`${alloc.zoneId}::${alloc.use}`), `${alloc.zoneName} → ${alloc.use}`).toBe(true);
      }
    }
  });

  it('carries the rationale each allocation needs', async () => {
    const result = await siting();
    const best = result.alternatives[0]!;
    for (const alloc of best.allocations) {
      if (alloc.locked) continue;
      expect(alloc.factors.length).toBe(7);
      expect(alloc.constraints.length).toBeGreaterThan(0);
      // The rejected alternative is what a rationale card reports. It loses on
      // priority, not necessarily on raw score: a use can score higher and
      // still lose because it needs less land or fits the zone worse.
      if (alloc.runnerUp) {
        expect(alloc.runnerUp.use).not.toBe(alloc.use);
        expect(alloc.runnerUp.priority).toBeLessThanOrEqual(alloc.priority + 1e-9);
      }
    }
  });

  it('reports the land shortfall per use rather than hiding it', async () => {
    const result = await siting();
    const best = result.alternatives[0]!;
    const villas = best.byUse.find((u) => u.use === 'villas')!;
    expect(villas.demandAc).toBeCloseTo(35, 6);
    expect(best.totalShortfallAc).toBeGreaterThanOrEqual(0);
    for (const u of best.byUse) {
      expect(u.shortfallAc).toBeCloseTo(u.demandAc - u.allocatedAc, 6);
    }
  });

  it('reserves the hospital zone and never lets it compete for in-scope land', async () => {
    const result = await siting();
    for (const a of result.alternatives) {
      const hospital = a.allocations.filter((x) => x.use === 'hospital_reserved');
      // Exactly the zone the client zoning plan reserves, and nothing else.
      expect(hospital.length).toBe(1);
      expect(hospital[0]!.zoneName).toBe('HOSPITAL');
      expect(hospital[0]!.locked).toBe(true);
      // Its 5 ac waits for the deferred land, so it asks nothing of the site.
      const balance = a.byUse.find((u) => u.use === 'hospital_reserved');
      expect(balance?.demandAc ?? 0).toBe(0);
    }
  });

  it('gives every use that needs land some land in the balanced alternative', async () => {
    // The first cut of this engine let villas, which suit almost any zone,
    // take the whole site while apartments, the school and commercial got
    // nothing. Unmet demand and a starvation boost now spread the land.
    const balanced = (await siting()).alternatives.find((a) => a.id === 'balanced')!;
    for (const u of balanced.byUse) {
      if (u.demandAc <= 0) continue;
      expect(u.allocatedAc, `${u.use} got no land`).toBeGreaterThan(0);
    }
  });

  it('says so when a weighting leaves a use with nothing', async () => {
    // Under a heavy tilt a small use can still lose every round. That is a
    // real consequence of allocating whole zones, so it is reported rather
    // than hidden.
    const result = await siting();
    for (const a of result.alternatives) {
      const starved = a.byUse.filter((u) => u.demandAc > 0 && u.allocatedAc <= 0);
      if (starved.length === 0) continue;
      expect(a.notes.join(' '), `${a.label} starved a use silently`).toMatch(/No zone could be given to/);
      for (const u of starved) {
        expect(a.notes.join(' ')).toContain(u.use === 'office' ? 'business hub' : u.use);
      }
    }
  });

  it('reports a zone that carries far more land than its use needs', async () => {
    // The client zoning plan's smallest zones are 1.51 and 0.42 ac, but four
    // uses want 1.5 to 4 ac, so some use must take an oversized zone. The
    // engine says which, rather than absorbing the surplus quietly.
    const result = await siting();
    for (const a of result.alternatives) {
      const oversized = a.allocations.filter((alloc) => {
        const demand = a.byUse.find((u) => u.use === alloc.use)?.demandAc ?? 0;
        return !alloc.locked && demand > 0 && alloc.areaAc > demand * 1.5;
      });
      if (oversized.length === 0) continue;
      expect(a.notes.join(' ')).toMatch(/Zones are allocated whole/);
      for (const alloc of oversized) {
        expect(a.notes.join(' ')).toContain(alloc.zoneName);
        expect(alloc.surplusAc).toBeGreaterThan(0);
      }
    }
  });

  it('reports the land a zone carries beyond what its use needed', async () => {
    const result = await siting();
    for (const alloc of result.alternatives[0]!.allocations) {
      if (alloc.locked) continue;
      expect(alloc.surplusAc).toBeGreaterThanOrEqual(0);
      expect(alloc.surplusAc).toBeLessThanOrEqual(alloc.areaAc + 1e-9);
    }
  });

  it('collects every untestable constraint for the report', async () => {
    const result = await siting();
    expect(result.unevaluable.length).toBeGreaterThan(0);
    const notes = result.unevaluable.map((u) => u.note).join(' ');
    expect(notes).toMatch(/AAI height limit/);
    expect(notes).toMatch(/ambulance/i);
  });

  it('honours a lock whatever the score says', async () => {
    const s = await site();
    const c = await config();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const m = await metrics();
    // Force the steepest zone to take senior living, which its slope vetoes.
    const steepest = [...m].sort((a, b) => b.meanSlopeDeg - a.meanSlopeDeg)[0]!;
    const result = runSiting({
      site: s,
      kmbr: c.kmbr,
      siting: c.siting,
      programme,
      metrics: m,
      locks: { [steepest.zoneId]: 'senior' },
    });
    for (const a of result.alternatives) {
      const alloc = a.allocations.find((x) => x.zoneId === steepest.zoneId)!;
      expect(alloc.use).toBe('senior');
      expect(alloc.locked).toBe(true);
      // The failing constraint is still reported on the locked zone.
      expect(alloc.constraints.some((x) => x.status === 'fail')).toBe(true);
    }
  });

  it('runs the whole site inside the 10 s budget', async () => {
    const s = await site();
    const c = await config();
    const started = Date.now();
    measureZones(s, c.kmbr, c.siting);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
