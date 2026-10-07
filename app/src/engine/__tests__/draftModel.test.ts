import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { runAnalysis } from '../pipeline/analysis';
import { runPlanSized } from '../pipeline/plan';
import type { PlanResult } from '../pipeline/plan';
import { basisOf, planBasis } from '../pipeline/basis';
import { pick } from '../data/config';
import { m2ToAcres } from '../units';

// Owner 7 Oct 2026: the plan on the owner's draft financial model ("Draft model.xlsx"): its programme
// (config/programme_draft_model.yaml) on the zoning drawn for it (tools/zoning/draft_model.py).

interface Line {
  id: string;
  use: string;
  units?: number;
  bua_sft?: number;
  land_ac?: number;
}

let planned: Promise<PlanResult> | null = null;
const plan = (): Promise<PlanResult> =>
  (planned ??= (async () => {
    const [s, c] = await Promise.all([site(), config()]);
    const a = runAnalysis({ dem: s.dem, parcel: s.parcel, features: s.features, measured: s.measured, surveySlopeDeg: s.surveySlopeDeg, planning: c.planning, assumptions: c.assumptions, client: c.client, kmbr: c.kmbr });
    return runPlanSized({ dem: s.dem, features: s.features, kmbr: c.kmbr, client: c.client, assumptions: c.assumptions, ...planBasis(s, c) }, a);
  })());

describe('the draft model basis (owner, 7 Oct)', () => {
  it('is the basis the rules set', async () => {
    const c = await config();
    expect(basisOf(c.planning)).toBe('draft_model');
  });

  it('draws one zone per component, each at the land the model gives it', async () => {
    const [s, c] = await Promise.all([site(), config()]);
    const lines = pick<Line[]>(c.programmeDraft, 'lines', []);
    const zoned = lines.filter((l) => (l.land_ac ?? 0) > 0);
    expect(s.draftZones.length).toBe(zoned.length);
    for (const l of zoned) {
      const z = s.draftZones.find((q) => q.component === l.id);
      expect(z, l.id).toBeDefined();
      expect(z!.use === l.use || (z!.use === 'clubhouse' && l.use === 'club'), `${l.id} use`).toBe(true);
      expect(Math.abs(z!.computedInScopeAc - l.land_ac!), `${l.id} ${z!.computedInScopeAc.toFixed(2)} ac`).toBeLessThan(0.06);
    }
  });

  it('places the hospital, the school stages, the clubhouses, retail, office, senior living and apartments in full', async () => {
    const p = await plan();
    for (const r of p.programme) {
      if (/villas/i.test(r.use)) continue;
      expect(r.met, `${r.use}: asked ${r.asked}, placed ${r.placed}`).toBe(true);
    }
    for (const u of ['hospital', 'retail', 'office'] as const) expect(p.buildings.some((b) => b.typology === u), u).toBe(true);
  });

  it('keeps each villa zone to its component count and the model plot mix', async () => {
    const [p, c] = await Promise.all([plan(), config()]);
    const types = pick<{ name: string; share: number; plot_sft: number }[]>(c.programmeDraft, 'villa_types', []);
    expect(p.option.villaSizing).toBe('MIX');
    expect(p.option.villaTarget).toBe(320);
    for (const z of p.zones.filter((q) => q.use === 'villas')) {
      const ps = p.plots.filter((q) => q.zone === z.name);
      expect(ps.length).toBeGreaterThan(0);
      for (const t of types) {
        const share = ps.filter((q) => q.kind === t.name).length / ps.length;
        expect(Math.abs(share - t.share), `${z.name} ${t.name}`).toBeLessThan(0.1);
      }
    }
    // Owner 7 Oct: plots are rectangles at their type's size (or widened or deepened, within the growth limit);
    // at the ends and edges of rows, and where a row meets the fixed edge of the land, a plot may be a convex
    // four- or five-sided plot. A row-end plot may take a smaller villa of the mix (the largest its house holds).
    const grow = pick<number>(c.planning, 'villas.categories.MIX.max_plot_growth', 1);
    const sftMin = Math.min(...types.map((t) => t.plot_sft));
    const sftMax = Math.max(...types.map((t) => t.plot_sft));
    let rects = 0;
    for (const q of p.plots) {
      const t = types.find((x) => x.name === q.kind)!;
      const n = q.ring.length;
      expect(n === 4 || n === 5, `${q.id}: ${n} sides`).toBe(true);
      // Every side at least 1 m, every corner turning the same way.
      const turns = q.ring.map((v, i) => {
        const b = q.ring[(i + 1) % n]!;
        const cc = q.ring[(i + 2) % n]!;
        expect(Math.hypot(b[0] - v[0], b[1] - v[1]), q.id).toBeGreaterThan(0.99);
        return Math.sign((b[0] - v[0]) * (cc[1] - b[1]) - (b[1] - v[1]) * (cc[0] - b[0]));
      });
      expect(new Set(turns.filter((s) => s !== 0)).size, q.id).toBe(1);
      const square =
        n === 4 &&
        q.ring.every((v, i) => {
          const a = q.ring[(i + 3) % 4]!;
          const b = q.ring[(i + 1) % 4]!;
          const d = (a[0] - v[0]) * (b[0] - v[0]) + (a[1] - v[1]) * (b[1] - v[1]);
          return Math.abs(d) / (Math.hypot(a[0] - v[0], a[1] - v[1]) * Math.hypot(b[0] - v[0], b[1] - v[1])) < 0.01;
        });
      const sftArea = q.areaM2 * 10.7639;
      if (square) {
        rects += 1;
        expect(sftArea / t.plot_sft, `${q.id} ${q.kind}`).toBeGreaterThan(0.98);
        expect(sftArea / t.plot_sft, `${q.id} ${q.kind}`).toBeLessThan(grow + 0.01);
      } else {
        expect(sftArea, `${q.id} ${q.kind}`).toBeGreaterThan(0.84 * sftMin);
        expect(sftArea, `${q.id} ${q.kind}`).toBeLessThan(grow * sftMax + 1);
      }
    }
    expect(rects / p.plots.length).toBeGreaterThan(0.7);
    // Owner 7 Oct ("80-81% is workable"): about four fifths of the villa land in plots.
    expect(p.option.plottedShare).toBeGreaterThan(0.79);
  });

  it('reports the model apartments, massed in towers under the airport limit', async () => {
    const p = await plan();
    expect(p.option.basis).toBe('draft_model');
    expect(p.option.apartmentUnits).toBe(935);
    const towers = p.buildings.filter((b) => b.typology === 'apartments');
    expect(towers.reduce((s, b) => s + b.units, 0)).toBeGreaterThan(0.95 * 935);
    for (const t of towers) expect(t.topRl).toBeLessThanOrEqual(p.airport.capRl + 1e-6);
    expect(m2ToAcres(p.zones.filter((z) => z.use === 'apartments').reduce((s, z) => s + z.areaM2, 0))).toBeCloseTo(12, 0);
  });
});
