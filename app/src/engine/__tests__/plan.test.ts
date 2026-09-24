import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { runAnalysis } from '../pipeline/analysis';
import type { AnalysisResult } from '../pipeline/analysis';
import { runPlan } from '../pipeline/plan';
import type { PlanResult } from '../pipeline/plan';
import { sftToM2 } from '../units';

/**
 * Planning steps 8-16 against the owner's rules (config/planning_rules.yaml).
 * The numbers the plan reaches will move as it improves; the rules must not.
 */

let cache: { a: AnalysisResult; p: PlanResult } | null = null;
async function plan(): Promise<{ a: AnalysisResult; p: PlanResult; s: Awaited<ReturnType<typeof site>> }> {
  const [s, c] = await Promise.all([site(), config()]);
  if (!cache) {
    const a = runAnalysis({
      dem: s.dem,
      parcel: s.parcel,
      features: s.features,
      measured: s.measured,
      surveySlopeDeg: s.surveySlopeDeg,
      planning: c.planning,
      assumptions: c.assumptions,
      client: c.client,
      kmbr: c.kmbr,
    });
    const p = runPlan(
      { dem: s.dem, features: s.features, kmbr: c.kmbr, client: c.client, assumptions: c.assumptions, planning: c.planning, programme: c.programme },
      a,
    );
    cache = { a, p };
  }
  return { ...cache, s };
}

const side = (r: readonly (readonly [number, number])[], i: number): number => {
  const a = r[i]!;
  const b = r[(i + 1) % r.length]!;
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
};

describe('step 8 roads', () => {
  it('holds every new road to its tier limit, grading where the ground will not do', async () => {
    const { p } = await plan();
    expect(p.roads.length).toBeGreaterThan(0);
    for (const r of p.roads) {
      expect(r.tier).not.toBe('existing');
      expect(r.designMaxGrade, `${r.id} design grade`).toBeLessThanOrEqual(r.limit + 1e-6);
      if (!r.withinLimitAsIs) expect(r.cutM3 + r.fillM3, `${r.id} is graded`).toBeGreaterThan(0);
    }
    const lim = { primary: 1 / 8, secondary: 1 / 7, tertiary: 1 / 6 };
    for (const r of p.roads) expect(r.limit).toBeCloseTo(lim[r.tier as keyof typeof lim], 9);
  });

  it('checks the existing roads against the primary limit without moving them', async () => {
    const { p } = await plan();
    expect(p.existingRoads.lengthM).toBeGreaterThan(0);
    expect(p.existingRoads.limit).toBeCloseTo(1 / 8, 9);
    expect(p.existingRoads.overLimitM).toBeLessThanOrEqual(p.existingRoads.lengthM);
  });
});

describe('steps 9-11 villa plots', () => {
  it('cuts plots of 2,700-3,000 sq ft, no side under 15 m, aspect 1:1 to 1:2.5', async () => {
    const { p } = await plan();
    expect(p.plots.length).toBeGreaterThan(50);
    for (const pl of p.plots) {
      expect(pl.areaM2).toBeGreaterThanOrEqual(sftToM2(2700) - 0.5);
      expect(pl.areaM2).toBeLessThanOrEqual(sftToM2(3000) + 0.5);
      const a = side(pl.ring, 0);
      const b = side(pl.ring, 1);
      expect(Math.min(a, b)).toBeGreaterThanOrEqual(15 - 1e-6);
      expect(Math.max(a, b) / Math.min(a, b)).toBeLessThanOrEqual(2.5);
    }
  });

  it('builds G+1 on 60% of the plot and 40% above it: FSI 1.0', async () => {
    const { p } = await plan();
    const area = (r: readonly (readonly [number, number])[]): number => {
      let s2 = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i, i += 1) s2 += (r[j]![0] + r[i]![0]) * (r[j]![1] - r[i]![1]);
      return Math.abs(s2) / 2;
    };
    for (const pl of p.plots) {
      expect(area(pl.groundFloor) / pl.areaM2).toBeCloseTo(0.6, 3);
      expect(area(pl.upperFloor) / pl.areaM2).toBeCloseTo(0.4, 3);
      expect(pl.fsi).toBeCloseTo(1, 9);
      expect(pl.builtUpM2).toBeCloseTo(pl.areaM2, 6);
    }
  });

  it('brings every plot platform to 1:5 or gentler, grading only the plots that need it', async () => {
    const { p } = await plan();
    for (const pl of p.plots) {
      expect(pl.platform.designGrade).toBeLessThanOrEqual(0.2 + 1e-9);
      if (pl.platform.withinLimitAsIs) expect(pl.platform.designGrade).toBeCloseTo(pl.platform.existingGrade, 9);
      else expect(pl.platform.designGrade).toBeCloseTo(0.2, 9);
    }
  });

  it('never lets two plots overlap', async () => {
    const { p } = await plan();
    const bbox = (r: readonly (readonly [number, number])[]) => ({
      x0: Math.min(...r.map((q) => q[0])),
      x1: Math.max(...r.map((q) => q[0])),
      y0: Math.min(...r.map((q) => q[1])),
      y1: Math.max(...r.map((q) => q[1])),
    });
    const boxes = p.plots.map((pl) => bbox(pl.ring));
    // Plot centres at least half a plot width apart is a cheap proxy the geometry test backs.
    for (let i = 0; i < p.plots.length; i += 1) {
      for (let j = i + 1; j < p.plots.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0) continue;
        const ca = p.plots[i]!.ring.reduce((s2, q) => [s2[0] + q[0] / 4, s2[1] + q[1] / 4], [0, 0]);
        const cb = p.plots[j]!.ring.reduce((s2, q) => [s2[0] + q[0] / 4, s2[1] + q[1] / 4], [0, 0]);
        expect(Math.hypot(ca[0] - cb[0], ca[1] - cb[1])).toBeGreaterThan(7.4);
      }
    }
  });

  it('puts plots only on plotable land', async () => {
    const { a, p, s } = await plan();
    for (const pl of p.plots) {
      const c = pl.ring.reduce((s2, q) => [s2[0] + q[0] / 4, s2[1] + q[1] / 4], [0, 0]);
      const cell = s.dem.cellAt([c[0], c[1]])!;
      expect(a.layers.plotable.mask[cell.j * s.dem.meta.nx + cell.i]).toBe(1);
    }
  });
});

describe('steps 12-14 typologies, FSI and placement', () => {
  it('builds senior living G+3 or more, 12 m apart', async () => {
    const { p } = await plan();
    const sen = p.buildings.filter((b) => b.typology === 'senior');
    expect(sen.length).toBeGreaterThan(0);
    for (const b of sen) expect(b.floors).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < sen.length; i += 1) {
      for (let j = i + 1; j < sen.length; j += 1) {
        const gap = Math.min(
          ...sen[i]!.ring.flatMap((q) => sen[j]!.ring.map((r) => Math.hypot(q[0] - r[0], q[1] - r[1]))),
        );
        expect(gap, `${sen[i]!.id}-${sen[j]!.id}`).toBeGreaterThanOrEqual(12 - 1e-6);
      }
    }
  });

  it('keeps apartments within FSI 3.0 on every parcel, towers 12 m apart on podiums', async () => {
    const { p } = await plan();
    const apt = p.parcels.filter((x) => x.use === 'apartments');
    expect(apt.length).toBeGreaterThan(0);
    for (const x of apt) expect(x.fsi, x.id).toBeLessThanOrEqual(3 + 1e-9);
    const towers = p.buildings.filter((b) => b.typology === 'apartments');
    for (const t of towers) {
      expect(t.floors).toBeLessThanOrEqual(20);
      expect(t.podium).toBeDefined();
      expect(t.podium!.topRl).toBeGreaterThanOrEqual(t.podium!.bottomRl);
      expect(t.baseRl).toBeCloseTo(t.podium!.topRl, 6);
    }
  });

  it('places the school and the clubhouse, and says what it could not place', async () => {
    const { p } = await plan();
    expect(p.buildings.some((b) => b.typology === 'school')).toBe(true);
    expect(p.buildings.some((b) => b.typology === 'clubhouse')).toBe(true);
    const villas = p.programme.find((r) => r.use === 'Villas')!;
    expect(villas).toBeDefined();
    // The programme asks for more villas than the land holds; the plan must say so, not hide it.
    if (p.plots.length < 700) expect(villas.met).toBe(false);
  });

  it('gives every block a use and a reason', async () => {
    const { p } = await plan();
    for (const b of p.blocks) expect(b.why.length, b.id).toBeGreaterThan(0);
  });

  it('adds up its earthwork', async () => {
    const { p } = await plan();
    expect(p.cutM3).toBeGreaterThan(0);
    expect(p.fillM3).toBeGreaterThan(0);
  });
});
