import { describe, expect, it } from 'vitest';
import { expected, site, tolerance } from './fixtures';
import type { Golden } from './fixtures';
import { m2ToAcres } from '../units';
import { localToUtm } from '../site/loadSite';

interface TerrainGolden {
  vertices: number;
  faces: number;
  meshed_plan_area_ac: Golden;
  rl_min: number;
  rl_max: number;
  summit_utm: [number, number];
  facet_slope_bands_ac: { tol_pct: number; values: Record<string, number> };
  plot_window_fall_ac: { note: string; values: Record<string, number> };
}

const SLOPE_EDGES = [0, 5, 10, 15, 20, 30, 45, 90];
const FALL_EDGES = [0, 0.5, 1, 2, 3, Infinity];

/**
 * The survey evaluation measured fall over an 11.4 x 14.2 m plot-sized window.
 * On the 2 m DEM that is 6 x 7 cells; windows are kept where at least 75% of
 * the cells are surveyed, so the survey edge is not thrown away wholesale.
 */
const FALL_WINDOW = { x: 11.4, y: 14.2, minValidFraction: 0.75 };

describe('M1 terrain — golden values', () => {
  it('reads the parcel-clipped TIN as issued', async () => {
    const s = await site();
    const g = (await expected()).terrain_parcel_clipped_tin as TerrainGolden;
    expect(s.tin).not.toBeNull();
    expect(s.tin!.vertexCount).toBe(g.vertices);
    expect(s.tin!.faceCount).toBe(g.faces);
  });

  it('reproduces the meshed plan area and relief', async () => {
    const s = await site();
    const g = (await expected()).terrain_parcel_clipped_tin as TerrainGolden;
    const stats = s.tin!.stats();
    const ac = m2ToAcres(stats.planAreaM2);
    expect(Math.abs(ac - g.meshed_plan_area_ac.value)).toBeLessThanOrEqual(tolerance(g.meshed_plan_area_ac));

    const { min, max, summit } = s.tin!.rlRange();
    expect(min).toBeCloseTo(g.rl_min, 3);
    expect(max).toBeCloseTo(g.rl_max, 3);

    const [e, n] = localToUtm(s.origin, summit[0], summit[1]);
    expect(Math.abs(e - g.summit_utm[0])).toBeLessThan(0.5);
    expect(Math.abs(n - g.summit_utm[1])).toBeLessThan(0.5);
  });

  it('reproduces the facet slope bands', async () => {
    const s = await site();
    const g = (await expected()).terrain_parcel_clipped_tin as TerrainGolden;
    const bands = s.tin!.slopeBandsAc(SLOPE_EDGES);
    const keys = Object.keys(g.facet_slope_bands_ac.values);
    keys.forEach((key, i) => {
      const want = g.facet_slope_bands_ac.values[key]!;
      const tol = (want * g.facet_slope_bands_ac.tol_pct) / 100;
      expect(Math.abs(bands[i]! - want), `band ${key}: ${bands[i]!.toFixed(2)} vs ${want}`).toBeLessThanOrEqual(tol);
    });
  });

  it('reproduces the plot-window fall bands from the DEM (method-sensitive, 10%)', async () => {
    const s = await site();
    const g = (await expected()).terrain_parcel_clipped_tin as TerrainGolden;
    const { bands } = s.dem.fallBandsAc(
      FALL_EDGES,
      FALL_WINDOW.x,
      FALL_WINDOW.y,
      FALL_WINDOW.minValidFraction,
    );
    const keys = Object.keys(g.plot_window_fall_ac.values);
    keys.forEach((key, i) => {
      const want = g.plot_window_fall_ac.values[key]!;
      expect(Math.abs(bands[i]! - want), `fall ${key}: ${bands[i]!.toFixed(2)} vs ${want}`).toBeLessThanOrEqual(
        want * 0.1,
      );
    });
  });

  it('agrees with dem_2m.json on valid cells and relief', async () => {
    const s = await site();
    const stats = s.dem.stats();
    expect(stats.validCells).toBe(s.dem.meta.valid_cells);
    expect(stats.rlMin).toBeCloseTo(s.dem.meta.rl_min, 3);
    expect(stats.rlMax).toBeCloseTo(s.dem.meta.rl_max, 3);
    // The DEM resamples the TIN, so it covers the same ground to within a whisker.
    expect(Math.abs(m2ToAcres(stats.areaM2) - 60.68)).toBeLessThan(0.5);
  });

  it('flags slopes over 45 degrees as unbuildable ground (Rule 22)', async () => {
    const s = await site();
    const bands = s.tin!.slopeBandsAc(SLOPE_EDGES);
    const over45 = bands[6]!;
    expect(over45).toBeGreaterThan(0);
    expect(over45).toBeLessThan(2);
  });
});
