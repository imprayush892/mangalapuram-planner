import { describe, expect, it } from 'vitest';
import { config, expected, site, tolerance } from './fixtures';
import type { Golden } from './fixtures';
import { m2ToAcres } from '../units';
import { multiPolyArea } from '../geom/planar';

describe('M1 site model — golden values', () => {
  it('reproduces the in-scope parcel area', async () => {
    const s = await site();
    const g = (await expected()).site as Record<string, Golden>;
    const total = g.parcel_total_ac!;
    expect(Math.abs(s.parcelAreaAc - total.value)).toBeLessThanOrEqual(tolerance(total));
  });

  it('reproduces the P1 deed parcel area', async () => {
    const s = await site();
    const g = (await expected()).site as Record<string, Golden>;
    const p1 = s.parcelParts.find((p) => p.id === 'P1');
    expect(p1).toBeDefined();
    const area = m2ToAcres(multiPolyArea(p1!.geom));
    const golden = g.parcel_P1_ac!;
    expect(Math.abs(area - golden.value)).toBeLessThanOrEqual(tolerance(golden));
  });

  it('places the TBM where the survey put it, at RL 100', async () => {
    const s = await site();
    const g = (await expected()).site as {
      tbm_local_xy: { value: [number, number]; tol_m: number };
      tbm_rl: number;
    };
    expect(Math.abs(s.origin.tbm.local[0] - g.tbm_local_xy.value[0])).toBeLessThanOrEqual(g.tbm_local_xy.tol_m);
    expect(Math.abs(s.origin.tbm.local[1] - g.tbm_local_xy.value[1])).toBeLessThanOrEqual(g.tbm_local_xy.tol_m);
    expect(s.origin.tbm.rl).toBe(g.tbm_rl);
  });

  it('carries the zoning registration fit the preprocessing recorded', async () => {
    const s = await site();
    const g = (await expected()).zoning_registration as Record<string, Golden & { max?: number }>;
    expect(s.registration.fit_error_m.median).toBeLessThanOrEqual(g.median_fit_m!.max!);
    expect(Math.abs(s.registration.sc - g.scale!.value)).toBeLessThanOrEqual(tolerance(g.scale!));
    const rotationDeg = (s.registration.th * 180) / Math.PI;
    expect(Math.abs(rotationDeg - g.rotation_deg!.value)).toBeLessThanOrEqual(tolerance(g.rotation_deg!));
  });

  it('computes in-scope zone areas by clipping the client zoning plan to the parcel', async () => {
    const s = await site();
    const golden = (await expected()).zones_in_scope_ac as Record<string, number>;
    for (const [name, ac] of Object.entries(golden)) {
      const zone = s.zones.find((z) => z.name === name);
      expect(zone, `zone ${name} missing`).toBeDefined();
      // "approximate" zones carry a wider tolerance, per expected_values.yaml.
      const tol = zone!.confidence === 'approximate' ? 1.0 : 0.3;
      expect(
        Math.abs(zone!.computedInScopeAc - ac),
        `${name}: computed ${zone!.computedInScopeAc.toFixed(2)} vs golden ${ac}`,
      ).toBeLessThanOrEqual(tol);
    }
  });

  it('loads every config file with its verified regulation tables', async () => {
    const c = await config();
    expect(c.kmbr.version).toBeDefined();
    expect(c.client.version).toBeDefined();
    expect(Array.isArray(c.kmbr.table7_access_A1)).toBe(true);
    expect(Array.isArray((c.programme as { lines: unknown[] }).lines)).toBe(true);
  });
});
