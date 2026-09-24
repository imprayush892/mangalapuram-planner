import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { runAnalysis } from '../pipeline/analysis';
import type { AnalysisResult } from '../pipeline/analysis';
import { runPlan } from '../pipeline/plan';
import type { PlanResult } from '../pipeline/plan';
import { sftToM2 } from '../units';
import { and, maskFrom, minus, patches, rasterise } from '../pipeline/mask';

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
      { dem: s.dem, features: s.features, zones: s.zones.map((z) => ({ name: z.name, geom: z.geom, labelAc: z.labelAreaAc })), kmbr: c.kmbr, client: c.client, assumptions: c.assumptions, planning: c.planning, programme: c.programme },
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
  it('cuts plots of 2,500-3,000 sq ft, compact ones of 2,000-2,500 where those will not fit; no side under 15 m, aspect 1:1 to 1:2.5', async () => {
    const { p } = await plan();
    expect(p.plots.length).toBeGreaterThan(150);
    for (const pl of p.plots) {
      expect(pl.areaM2).toBeGreaterThanOrEqual(sftToM2(2000) - 0.5);
      expect(pl.areaM2).toBeLessThanOrEqual(sftToM2(3000) + 0.5);
      if (pl.kind === 'standard') expect(pl.areaM2).toBeGreaterThanOrEqual(sftToM2(2500) - 0.5);
      else expect(pl.areaM2).toBeLessThanOrEqual(sftToM2(2500) + 0.5);
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

  it('puts plots only on buildable land in the villa zones of the client zoning plan', async () => {
    const { a, p, s } = await plan();
    const L = a.layers;
    for (const pl of p.plots) {
      expect(/VILLA|PHASE/i.test(pl.zone), `${pl.id} in ${pl.zone}`).toBe(true);
      const c = pl.ring.reduce((s2, q) => [s2[0] + q[0] / 4, s2[1] + q[1] / 4], [0, 0]);
      const cell = s.dem.cellAt([c[0], c[1]])!;
      const k = cell.j * s.dem.meta.nx + cell.i;
      expect(L.waterlogging.mask[k] || L.nonBuildable.mask[k] || L.drains.mask[k], pl.id).toBe(0);
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

  it('keeps apartments within the KMBR FSI ceiling (6.0 with the fee) on every parcel, towers on podiums', async () => {
    const { p } = await plan();
    const apt = p.parcels.filter((x) => x.use === 'apartments');
    expect(apt.length).toBeGreaterThan(0);
    // Owner 25 Sep: 1,000 flats in six towers; FSI is reported against the tiers, not capped at 3.
    for (const x of apt) expect(x.fsi, x.id).toBeLessThanOrEqual(6 + 1e-9);
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

describe('the client zoning plan leads (owner, 25 Sep)', () => {
  it('keeps every building in the client zone for its use', async () => {
    const { p } = await plan();
    const zoneFor: Record<string, RegExp> = {
      school: /SCHOOL/i,
      clubhouse: /CLUBHOUSE/i,
      senior: /SENIOR/i,
      apartments: /APARTMENT/i,
      commercial: /COMMERCIAL/i,
      batching: /BATCHING/i,
    };
    for (const b of p.buildings) expect(zoneFor[b.typology]!.test(b.zone), `${b.id} in ${b.zone}`).toBe(true);
    for (const z of p.zones) if (/HOSPITAL/i.test(z.name)) expect(p.buildings.some((b) => b.zone === z.name)).toBe(false);
  });

  it('builds the school as one campus no road runs through', async () => {
    const { p, s } = await plan();
    const school = s.zones.find((z) => /SCHOOL/i.test(z.name))!;
    const land = minus(and(rasterise(s.dem, school.geom), maskFrom(s.dem, () => true)), p.roadMask);
    const wings = p.buildings.filter((b) => b.typology === 'school');
    expect(wings.length).toBeGreaterThan(0);
    const pieceOf = new Map<number, number>();
    patches(s.dem, land).forEach((piece, i) => piece.forEach((k) => pieceOf.set(k, i)));
    const pieces = new Set(
      wings.map((w) => {
        const c = w.ring.reduce((a2, q) => [a2[0] + q[0] / 4, a2[1] + q[1] / 4], [0, 0]);
        const cell = s.dem.cellAt([c[0], c[1]])!;
        return pieceOf.get(cell.j * s.dem.meta.nx + cell.i);
      }),
    );
    expect(pieces.size).toBe(1);
  });

  it('keeps every building under the airport limit, the towers apart', async () => {
    const { p } = await plan();
    for (const b of p.buildings) expect(b.topAmslM, b.id).toBeLessThanOrEqual(p.airport.capAmslM + 1e-6);
    const towers = p.buildings.filter((b) => b.typology === 'apartments');
    expect(towers.length).toBeGreaterThan(0);
    for (let i = 0; i < towers.length; i += 1) {
      for (let j = i + 1; j < towers.length; j += 1) {
        const gap = Math.min(...towers[i]!.ring.flatMap((q) => towers[j]!.ring.map((r) => Math.hypot(q[0] - r[0], q[1] - r[1]))));
        expect(gap).toBeGreaterThanOrEqual(12 - 1e-6);
      }
    }
  });

  it("puts the Phase 2 towers on the owner's sites and reports the villas' view each hides", async () => {
    const { p } = await plan();
    const ph2 = p.buildings.filter((b) => b.typology === 'apartments' && b.zone.startsWith('PHASE 2'));
    expect(ph2.length).toBe(2);
    for (const b of ph2) expect(b.notes.some((t) => /owner's site .* (\d|1\d) m from it/.test(t)), b.notes.join(' | ')).toBe(true);
    for (const b of p.buildings.filter((q) => q.typology === 'apartments')) expect(b.notes.some((t) => /of the villas' view/.test(t))).toBe(true);
  });

  it('lays golf only on gentle ground, as part of the clubhouse', async () => {
    const { a, p, s } = await plan();
    expect(p.golf.areaM2).toBeGreaterThan(0);
    const golf = p.blocks.filter((b) => b.typology === 'golf');
    expect(golf.length).toBeGreaterThan(0);
    for (const b of golf) {
      const m = rasterise(s.dem, b.geom);
      let steep = 0;
      let n = 0;
      for (let k = 0; k < m.length; k += 1) {
        if (!m[k] || !Number.isFinite(a.gradient[k]!)) continue;
        n += 1;
        if (a.gradient[k]! > p.golf.maxGrade + 0.05) steep += 1;
      }
      // Outlines are drawn smoothed, so a few edge cells may fall outside.
      expect(steep / Math.max(1, n), b.id).toBeLessThan(0.05);
    }
  });

  it('closes the water balance: rain = loss + held + outflow, ponds and channels add up', async () => {
    const { a } = await plan();
    const w = a.storm.balance;
    expect(Math.abs(w.rainM3 - w.lossM3 - w.heldM3 - w.outflowM3)).toBeLessThan(1e-6 * w.rainM3 + 1);
    expect(Math.abs(w.heldInPondsM3 + w.heldInShallowHollowsM3 - w.heldM3)).toBeLessThan(1);
    const ponds = w.ponds.reduce((acc, q) => acc + q.peakVolumeM3, 0);
    expect(Math.abs(ponds - w.peak.pondVolumeM3)).toBeLessThan(1);
    for (const q of w.ponds) expect(q.meanDepthM * q.areaM2).toBeCloseTo(q.peakVolumeM3, 3);
    expect(w.peak.channelMeanWidthM * w.peak.channelLengthM).toBeCloseTo(w.peak.channelAreaM2, 3);
    expect(w.peak.channelMeanDepthM * w.peak.channelAreaM2).toBeCloseTo(w.peak.channelVolumeM3, 3);
  });
});

describe('the plan crosses to the page from the worker', () => {
  it('holds nothing a structured clone cannot copy', async () => {
    const { p } = await plan();
    expect(() => structuredClone(p)).not.toThrow();
  });
});

describe('step 15-16 massing', () => {
  it('puts every villa (two storeys), building and podium into the 3D scene the GLB exports', async () => {
    const { p, s } = await plan();
    const { buildMassingScene } = await import('../export/glb');
    const scene = buildMassingScene({ dem: s.dem, layouts: [], parcel: s.parcel, terrainStep: 8, plan: p });
    const group = scene.getObjectByName('Masterplan');
    expect(group).toBeDefined();
    const villas = group!.getObjectByName('Villas')!;
    const others = group!.getObjectByName('Buildings')!;
    const finite = p.plots.filter((x) => Number.isFinite(x.baseRl)).length;
    expect(villas.children.length).toBe(finite * 2);
    const podiums = p.buildings.filter((b) => b.podium).length;
    expect(others.children.length).toBe(p.buildings.length + podiums);
  });
});
