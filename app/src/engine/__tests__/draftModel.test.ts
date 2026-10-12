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
// (config/programme_draft_model.yaml) on the optimised zoning (owner 12 Oct: tools/zoning/optimise.py, greens.py).

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

  it('draws one zone per component, in one piece; retail and office on the 18 m road (owner 12 Oct)', async () => {
    const [s, c] = await Promise.all([site(), config()]);
    const lines = pick<Line[]>(c.programmeDraft, 'lines', []);
    // Owner 12 Oct: the hospital is out; the sales office has no land of its own.
    const zoned = lines.filter((l) => !l.deferred && l.use !== 'site_office');
    expect(s.draftZones.filter((z) => z.use !== 'park').length).toBe(zoned.length);
    const routes = pick<{ points: [number, number][]; width_m?: number }[]>(planBasis(s, c).planning, 'roads.owner_routes', []);
    const main = routes.find((r) => (r.width_m ?? 0) >= 18)!.points;
    const [a, b] = [main[0]!, main[main.length - 1]!];
    const fromMain = (p: [number, number]): number => {
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)));
      return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1]));
    };
    for (const l of zoned) {
      const z = s.draftZones.find((q) => q.component === l.id);
      expect(z, l.id).toBeDefined();
      expect(z!.use === l.use || (z!.use === 'clubhouse' && l.use === 'club'), `${l.id} use`).toBe(true);
      // No stray piece (owner 12 Oct: no isolated building or zone); a villa phase is a band the fixed roads may
      // cross, each of its pieces at least a block of villas (0.4 ac).
      const pieces = z!.geom.filter((poly) => multiPolyArea([poly]) > 400);
      if (l.use === 'villas') for (const q of pieces) expect(m2ToAcres(multiPolyArea([q])), `${l.id} piece`).toBeGreaterThan(0.4);
      else expect(pieces.length, `${l.id} pieces`).toBe(1);
      if (l.use === 'retail' || l.use === 'office') {
        const near = Math.min(...z!.geom.flatMap((poly) => poly[0]!.map((v) => fromMain(v as [number, number]))));
        expect(near, `${l.id} from the 18 m road`).toBeLessThan(9 + 4);
      }
    }
  });

  it('designates the open space, each piece usable and clear of plots (KMBR Rule 31(v)-(vi)); every acre counted once', async () => {
    const [s, c, p] = await Promise.all([site(), config(), plan()]);
    const rule = pick<{ min_area_m2: number; min_width_m: number }>(c.kmbr, 'rule31_subdivision.recreation', { min_area_m2: 200, min_width_m: 6 });
    const open = s.draftZones.filter((z) => z.use === 'park');
    const roads = p.roads.flatMap((r) => r.geom);
    for (const z of open) {
      const a = multiPolyArea(z.geom);
      expect(a, z.name).toBeGreaterThanOrEqual(rule.min_area_m2);
      // A park (RC size) keeps its land; the villa streets run on through the green in the villas.
      if (a >= pick<number>(c.planning, 'open_space.rc_min_m2', 1000)) expect(multiPolyArea(intersect(z.geom, roads)) / a, `${z.name} under roads`).toBeLessThan(0.25);
    }
    // No plot in the open space (a few square metres at an edge: the zones are read on the 2 m grid).
    for (const q of p.plots) for (const z of open) expect(multiPolyArea(intersect([[q.ring as [number, number][]]], z.geom)), `${q.id} in ${z.name}`).toBeLessThan(5);
    // The land account: the parcel's 73.54 ac, at least a tenth of it open space, the lakes in it (owner 12 Oct).
    const L = p.land;
    expect(m2ToAcres(L.parcelM2)).toBeCloseTo(73.54, 1);
    expect(L.openSpaceM2 / L.parcelM2).toBeGreaterThan(0.1);
    expect(L.green.lakesM2).toBeGreaterThan(0);
    const zones = L.zones.reduce((t, z) => t + z.areaM2, 0);
    const parks = L.zones.filter((z) => z.use === 'park').reduce((t, z) => t + z.areaM2, 0);
    // The zones other than parks, the roads and the open space make up the parcel.
    expect(Math.abs(zones - parks + L.roadsM2 + L.openSpaceM2 - L.parcelM2)).toBeLessThan(50);
  });

  it('green pockets (D3/D4, owner 12 Oct): whole plots turned to gardens in the villa land', async () => {
    const s = await site();
    const ac = (zs: typeof s.draftZones, use: string): number => zs.filter((z) => z.use === use).reduce((a, z) => a + multiPolyArea(z.geom), 0) / 4046.8564224;
    for (const zs of [s.draftZoneSets.pockets!, s.draftZoneSets.pockets_ns!]) {
      const gardens = zs.filter((z) => z.component?.startsWith('OS-P'));
      expect(gardens.length).toBeGreaterThanOrEqual(1);
      for (const g of gardens) {
        expect(g.within).toBe('villas');
        expect(multiPolyArea(g.geom), g.name).toBeGreaterThanOrEqual(200); // KMBR Rule 31(vi)
      }
      // The gardens come out of the villa land: none on another use's land.
      for (const g of gardens)
        for (const z of zs.filter((q) => q.use !== 'villas' && q.use !== 'park'))
          expect(multiPolyArea(intersect(g.geom, z.geom)), `${g.name} on ${z.name}`).toBeLessThan(5);
      expect(ac(zs, 'villas')).toBeGreaterThan(20);
    }
  });

  it('green link (D5/D6, owner 12 Oct): a corridor through the villas, keeping at least 300 villas', async () => {
    const s = await site();
    for (const name of ['chain', 'chain_ns']) {
      const zs = s.draftZoneSets[name]!;
      const link = zs.filter((z) => z.component?.startsWith('OS-L'));
      expect(link.length, name).toBeGreaterThanOrEqual(3);
      for (const g of link) {
        expect(g.within).toBe('villas');
        expect(multiPolyArea(g.geom), g.name).toBeGreaterThanOrEqual(200);
      }
      const area = link.reduce((a, z) => a + multiPolyArea(z.geom), 0) / 4046.8564224;
      expect(area, name).toBeGreaterThan(1);
      expect(area, name).toBeLessThan(3);
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

  it('fills the villa land within 15 an acre, in the model plot mix', async () => {
    const [p, c] = await Promise.all([plan(), config()]);
    const types = pick<{ name: string; share: number; plot_sft: number }[]>(c.programmeDraft, 'villa_types', []);
    expect(p.option.villaSizing).toBe('MIX');
    // Owner 12 Oct: D1 holds the villas its zoning asks for (planning_rules villas.count_by_zoning), never more than
    // 15 an acre of a villa zone.
    const [lo, hi] = pick<[number, number]>(c.planning, 'villas.count_by_zoning.model', [350, 420]);
    expect(p.plots.length).toBeGreaterThanOrEqual(lo);
    expect(p.plots.length).toBeLessThanOrEqual(hi);
    for (const z of p.zones.filter((q) => q.use === 'villas')) {
      const ps = p.plots.filter((q) => q.zone === z.name);
      expect(ps.length).toBeGreaterThan(0);
      expect(ps.length / m2ToAcres(z.areaM2), `${z.name} an acre`).toBeLessThanOrEqual(15);
      for (const t of types) {
        const share = ps.filter((q) => q.kind === t.name).length / ps.length;
        // a small phase with many edge plots strays further from the mix (the model is given the plan's own mix)
        expect(Math.abs(share - t.share), `${z.name} ${t.name}`).toBeLessThan(m2ToAcres(z.areaM2) < 5 ? 0.2 : 0.15);
      }
    }
    for (const t of types) expect(Math.abs(p.plots.filter((q) => q.kind === t.name).length / p.plots.length - t.share), t.name).toBeLessThan(0.1);
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
    // With cross streets through the rows (owner 8 Oct: the roads the plan wants, not the model's), two thirds and
    // more of the villa land is in plots (the optimised zoning's villa land is less regular, owner 12 Oct).
    expect(p.option.plottedShare).toBeGreaterThan(0.65);
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
    // Owner 12 Oct: every flat of the model's 935 in a tower, none short.
    expect(towers.reduce((s, b) => s + b.units, 0)).toBe(935);
    for (const t of towers) expect(t.topRl).toBeLessThanOrEqual(p.airport.capRl + 1e-6);
  });
});
