import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { runAnalysis } from '../pipeline/analysis';
import { runPlanSized } from '../pipeline/plan';
import type { PlanResult } from '../pipeline/plan';
import { basisOf, planBasis } from '../pipeline/basis';
import { pick } from '../data/config';
import { m2ToAcres } from '../units';
import { intersect } from '../geom/boolean';
import { multiPolyArea } from '../geom/planar';
import { PRESENT_PLAN_OPTIONS } from '../present/prebuilt';

// Owner 7 Oct 2026: the plan on the owner's draft financial model ("Draft model.xlsx"): its programme
// (config/programme_draft_model.yaml) on the zoning drawn for it (tools/zoning/draft_model.py).

interface Line {
  id: string;
  use: string;
  units?: number;
  bua_sft?: number;
  land_ac?: number;
  deferred?: string;
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
    // Owner 8 Oct: the hospital is built on the 26 ac deferred land; its lobe here is villas.
    const zoned = lines.filter((l) => (l.land_ac ?? 0) > 0 && !l.deferred);
    expect(s.draftZones.filter((z) => z.use !== 'park').length).toBe(zoned.length);
    for (const l of zoned) {
      const z = s.draftZones.find((q) => q.component === l.id);
      expect(z, l.id).toBeDefined();
      expect(z!.use === l.use || (z!.use === 'clubhouse' && l.use === 'club'), `${l.id} use`).toBe(true);
      // Owner 7 Oct: the villas keep the land added south of Phase 4 and Phase 2, less the green pockets.
      if (l.use === 'villas') expect(z!.computedInScopeAc, `${l.id} ${z!.computedInScopeAc.toFixed(2)} ac`).toBeGreaterThan(l.land_ac! - 0.35);
      else expect(Math.abs(z!.computedInScopeAc - l.land_ac!), `${l.id} ${z!.computedInScopeAc.toFixed(2)} ac`).toBeLessThan(0.06);
    }
    const villaModel = zoned.filter((l) => l.use === 'villas').reduce((a, l) => a + l.land_ac!, 0);
    const villaDrawn = s.draftZones.filter((z) => z.use === 'villas').reduce((a, z) => a + z.computedInScopeAc, 0);
    expect(villaDrawn, `villa land ${villaDrawn.toFixed(2)} ac`).toBeGreaterThanOrEqual(villaModel - 0.06);
  });

  it('designates the model open space, each piece usable and reached (KMBR Rule 31(v)-(vi))', async () => {
    const [s, c, p] = await Promise.all([site(), config(), plan()]);
    const model = pick<number>(c.programmeDraft, 'scope.open_space_ac', 8.3);
    const rule = pick<{ min_area_m2: number; min_width_m: number }>(c.kmbr, 'rule31_subdivision.recreation', { min_area_m2: 200, min_width_m: 6 });
    const open = s.draftZones.filter((z) => z.use === 'park');
    const roads = p.roads.flatMap((r) => r.geom);
    let net = 0;
    for (const z of open) {
      const a = multiPolyArea(z.geom);
      expect(a, z.name).toBeGreaterThanOrEqual(rule.min_area_m2);
      // The villa streets run on through a green pocket (a fifth of it at most); other open space keeps its land.
      const under = multiPolyArea(intersect(z.geom, roads));
      expect(under / a, `${z.name} under roads`).toBeLessThan(z.within ? 0.25 : 0.1);
      net += (a - under) / 4046.8564224;
    }
    // The model's open space, net of the roads that cross it (within a fifth of an acre).
    expect(Math.abs(net - model), `open space net of roads ${net.toFixed(2)} ac`).toBeLessThan(0.2);
    // No plot in the open space (a few square metres at an edge: the zones are read on the 2 m grid).
    for (const q of p.plots) for (const z of open) expect(multiPolyArea(intersect([[q.ring as [number, number][]]], z.geom)), `${q.id} in ${z.name}`).toBeLessThan(5);
  });

  it('green pockets (D3/D4, owner 9 Oct): two parks give land to villas, pocket gardens give it back', async () => {
    const s = await site();
    const ac = (zs: typeof s.draftZones, use: string): number => zs.filter((z) => z.use === use).reduce((a, z) => a + multiPolyArea(z.geom), 0) / 4046.8564224;
    // Open space, with the villa streets' share (tools/zoning, 30%) taken out of the pockets the street grid runs
    // through; the pocket gardens are whole plots between the streets (OS-P*), counted in full.
    const openNet = (zs: typeof s.draftZones): number =>
      zs.filter((z) => z.use === 'park').reduce((a, z) => a + multiPolyArea(z.geom) * (z.within && !z.component?.startsWith('OS-P') ? 0.7 : 1), 0) / 4046.8564224;
    for (const zs of [s.draftZoneSets.pockets!, s.draftZoneSets.pockets_ns!]) {
      expect(zs.length).toBeGreaterThan(s.draftZones.length);
      // The parks give a fixed piece (so the villa land's outline, and the street grid, stay put); the gardens
      // take back the whole plots nearest the sketch's points: within a tenth of an acre.
      expect(Math.abs(openNet(zs) - openNet(s.draftZones)), 'open space unchanged').toBeLessThan(0.1);
      const gardens = zs.filter((z) => z.component?.startsWith('OS-P'));
      expect(gardens.length).toBe(9);
      for (const g of gardens) {
        expect(g.within).toBe('villas');
        expect(multiPolyArea(g.geom), g.name).toBeGreaterThanOrEqual(200);
      }
      // The villa land: what the parks gave, the gardens took back.
      expect(Math.abs(ac(zs, 'villas') - ac(s.draftZones, 'villas'))).toBeLessThan(0.1);
    }
  });

  it('green chain (D5/D6, owner 9 Oct): the gardens run on block to block, open space on top of the model', async () => {
    const s = await site();
    const open = (zs: typeof s.draftZones): number => zs.filter((z) => z.use === 'park').reduce((a, z) => a + multiPolyArea(z.geom), 0) / 4046.8564224;
    for (const name of ['chain', 'chain_ns']) {
      const zs = s.draftZoneSets[name]!;
      const chain = zs.filter((z) => z.component?.startsWith('OS-C'));
      expect(chain.length, name).toBeGreaterThanOrEqual(10);
      for (const g of chain) {
        expect(g.within).toBe('villas');
        expect(multiPolyArea(g.geom), g.name).toBeGreaterThanOrEqual(200); // KMBR Rule 31(vi)
      }
      // More open space than the model's, by the chain less what the parks gave the villas.
      expect(open(zs), name).toBeGreaterThan(open(s.draftZones) + 1.5);
    }
  });

  it('carries the draft financial model run on every option (owner 9 Oct, config/financials_draft_model.yaml)', async () => {
    const c = await config();
    const cases = pick<Record<string, { values: Record<string, number | null>; villas?: number }>>(c.financials, 'cases', {});
    expect(cases.model, 'the model as given').toBeDefined();
    for (const o of PRESENT_PLAN_OPTIONS) {
      const v = cases[o.id]?.values;
      expect(v, o.id).toBeDefined();
      for (const k of ['units', 'revenue_cr', 'cost_cr', 'pat_cr', 'project_irr', 'promoter_irr']) expect(v![k], `${o.id} ${k}`).toBeTypeOf('number');
      // The model's residential units: the plan's villas, the model's 935 flats and 192 senior homes.
      expect(v!.units).toBe((cases[o.id]!.villas ?? 0) + 935 + 192);
    }
  });

  it('places the school stages, the clubhouses, retail, office, senior living and apartments in full; the hospital goes to the deferred land', async () => {
    const p = await plan();
    for (const r of p.programme) {
      if (/villas/i.test(r.use)) continue;
      expect(r.met, `${r.use}: asked ${r.asked}, placed ${r.placed}`).toBe(true);
    }
    for (const u of ['retail', 'office'] as const) expect(p.buildings.some((b) => b.typology === u), u).toBe(true);
    expect(p.buildings.some((b) => b.typology === 'hospital')).toBe(false);
    expect(p.programme.find((r) => /hospital/i.test(r.use))?.placed).toMatch(/not in these 73 ac/);
  });

  it('keeps each villa zone to its component count and the model plot mix', async () => {
    const [p, c] = await Promise.all([plan(), config()]);
    const types = pick<{ name: string; share: number; plot_sft: number }[]>(c.programmeDraft, 'villa_types', []);
    expect(p.option.villaSizing).toBe('MIX');
    expect(p.option.villaTarget).toBe(320);
    // Owner 8 Oct: the villa land is filled; the township holds at least the model's 320.
    expect(p.plots.length).toBeGreaterThanOrEqual(320);
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
        // A rectangle at its type's size, widened or deepened; or a row-end plot that came out square (0.84 up).
        rects += 1;
        expect(sftArea / t.plot_sft, `${q.id} ${q.kind}`).toBeGreaterThan(0.84);
        expect(sftArea / t.plot_sft, `${q.id} ${q.kind}`).toBeLessThan(grow + 0.01);
      } else {
        expect(sftArea, `${q.id} ${q.kind}`).toBeGreaterThan(0.84 * sftMin);
        expect(sftArea, `${q.id} ${q.kind}`).toBeLessThan(grow * sftMax + 1);
      }
    }
    expect(rects / p.plots.length).toBeGreaterThan(0.7);
    // No two plots overlap (separating axes; both are convex).
    const apart = (a: [number, number][], b: [number, number][]): boolean =>
      [a, b].some((r) =>
        r.some((v, i) => {
          const w = r[(i + 1) % r.length]!;
          const ax = [-(w[1] - v[1]), w[0] - v[0]];
          const L = Math.hypot(ax[0]!, ax[1]!);
          if (L < 1e-9) return false;
          const pr = (q: [number, number][]) => q.map((u) => (u[0] * ax[0]! + u[1] * ax[1]!) / L);
          const [pa, pb] = [pr(a), pr(b)];
          return Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)) <= 0.2;
        }),
      );
    let overlaps = 0;
    for (let i = 0; i < p.plots.length; i += 1)
      for (let j = i + 1; j < p.plots.length; j += 1) if (!apart(p.plots[i]!.ring as [number, number][], p.plots[j]!.ring as [number, number][])) overlaps += 1;
    expect(overlaps).toBe(0);
    // With cross streets through the rows (owner 8 Oct: the roads the plan wants, not the model's), about three
    // quarters of the villa land is in plots.
    expect(p.option.plottedShare).toBeGreaterThan(0.7);
  });

  it('keeps every building clear of the other buildings, the roads and the plots, and the roads off the plots', async () => {
    const p = await plan();
    const roads = p.roads.flatMap((r) => r.geom);
    const clash = (a: [number, number][], b: [number, number][]): number => multiPolyArea(intersect([[a]], [[b]]));
    for (const [i, b] of p.buildings.entries()) {
      const ring = b.ring as [number, number][];
      for (const o of p.buildings.slice(i + 1)) expect(clash(ring, o.ring as [number, number][]), `${b.id} on ${o.id}`).toBeLessThan(1);
      expect(multiPolyArea(intersect([[ring]], roads)), `${b.id} on a road`).toBeLessThan(1);
      for (const q of p.plots) expect(clash(ring, q.ring as [number, number][]), `${b.id} on ${q.id}`).toBeLessThan(1);
    }
    // and no road runs over a plot (a square metre of drawing either way).
    const onRoads = p.plots.reduce((t, q) => t + multiPolyArea(intersect([[q.ring as [number, number][]]], roads)), 0);
    expect(onRoads).toBeLessThan(5);
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
