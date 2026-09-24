import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config, site } from './fixtures';
import {
  developedRunoffCoeff,
  hydrologyParams,
  simulateStorm,
  stormRunoffCoeff,
  waterModelFor,
} from '../terrain/hydrology';

/**
 * The app's storm model against the offline report, and against physics.
 *
 * The report (tools/preprocess/hydrology_analysis.py) and the app run the same
 * fill-and-spill model from the same config block. They are written in two
 * languages, so this is what stops them drifting apart: at the design storm
 * the app must reproduce the report's figures.
 */

async function setup() {
  const [s, c] = await Promise.all([site(), config()]);
  const p = hydrologyParams(c.assumptions);
  const model = waterModelFor(s.dem, s.features, p.pondingDepthM);
  return { s, p, model };
}

async function report(): Promise<{
  site_totals: { total_sinks_m3: number; ponds: number; hollows: number };
  design_storm: {
    natural: {
      runoff_coeff: number;
      runoff_m3: number;
      held_m3: number;
      outflow_m3: number;
      standing_water_ha: number;
      under_water_at_peak_ha: number;
      peak_outflow_m3s: number;
    };
    developed: { runoff_coeff: number; outflow_m3: number };
  };
  catchments: { outlet_cell: number; design_runoff_m3: number; design_held_m3: number; design_outflow_m3: number }[];
}> {
  const file = path.resolve(__dirname, '../../../../data/processed/hydrology_report.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

const close = (a: number, b: number, rel = 0.01, abs = 1): boolean => Math.abs(a - b) <= Math.max(abs, Math.abs(b) * rel);

describe('hydrology — the app and the report agree', () => {
  it('uses the sourced defaults', async () => {
    const { p } = await setup();
    // KWRA-2024 benchmark; the owner's 300 mm planning storm (planning_rules.yaml).
    expect(p.annualRainfallMm).toBe(2700);
    expect(p.designStormMm).toBe(300);
    // CWC/RBF-16 coastal: 0.332 × 30^0.2 = 0.655
    expect(stormRunoffCoeff(p, 300)).toBeCloseTo(0.655, 3);
    // The sourced estimates stay one click away.
    expect(p.presets.map((x) => x.mm)).toEqual([152.5, 168.1, 200, 239.5, 300, 320]);
  });

  it('finds the same hollows', async () => {
    const { model, p } = await setup();
    const r = await report();
    const capacity = model.depressions.reduce((sum, d) => sum + d.capacityM3, 0);
    expect(close(capacity, r.site_totals.total_sinks_m3, 0.001)).toBe(true);
    expect(model.depressions.length).toBe(r.site_totals.hollows);
    expect(model.depressions.filter((d) => d.maxDepthM >= p.pondingDepthM).length).toBe(r.site_totals.ponds);
  });

  it('reproduces the design storm, in total and per catchment', async () => {
    const { s, p, model } = await setup();
    const r = await report();
    const c = stormRunoffCoeff(p, p.designStormMm);
    const storm = simulateStorm(s.dem, model, p, p.designStormMm, c);
    const want = r.design_storm.natural;
    expect(c).toBeCloseTo(want.runoff_coeff, 3);
    expect(close(storm.runoffM3, want.runoff_m3)).toBe(true);
    expect(close(storm.heldM3, want.held_m3)).toBe(true);
    expect(close(storm.outflowM3, want.outflow_m3)).toBe(true);
    expect(close(storm.standingAreaM2 / 1e4, want.standing_water_ha, 0.02, 0.01)).toBe(true);
    expect(close(storm.peakWetAreaM2 / 1e4, want.under_water_at_peak_ha, 0.02, 0.02)).toBe(true);
    expect(close(storm.peakOutflowM3s, want.peak_outflow_m3s, 0.02, 0.01)).toBe(true);
    for (const row of r.catchments) {
      const live = storm.catchments.get(row.outlet_cell);
      expect(live, `outlet ${row.outlet_cell}`).toBeDefined();
      expect(close(live!.runoffM3, row.design_runoff_m3)).toBe(true);
      expect(close(live!.heldM3, row.design_held_m3, 0.02, 5)).toBe(true);
      expect(close(live!.outflowM3, row.design_outflow_m3, 0.02, 5)).toBe(true);
    }
    const dev = simulateStorm(s.dem, model, p, p.designStormMm, developedRunoffCoeff(p, c));
    expect(close(dev.outflowM3, r.design_storm.developed.outflow_m3)).toBe(true);
  });
});

describe('hydrology — the storm behaves like water', () => {
  it('conserves water: runoff = held + outflow, per catchment and in total', async () => {
    const { s, p, model } = await setup();
    for (const rain of [10, 50, 320, 10_000]) {
      const storm = simulateStorm(s.dem, model, p, rain, stormRunoffCoeff(p, rain));
      expect(close(storm.heldM3 + storm.outflowM3, storm.runoffM3, 1e-6, 1e-3)).toBe(true);
      for (const cat of storm.catchments.values()) {
        expect(close(cat.heldM3 + cat.outflowM3, cat.runoffM3, 1e-6, 1e-3)).toBe(true);
      }
    }
  });

  it('fills ponds with the storm until they are full, then sends the rest on', async () => {
    const { s, p, model } = await setup();
    const at = (rain: number) => simulateStorm(s.dem, model, p, rain, stormRunoffCoeff(p, rain));
    const storms = [5, 10, 25, 50, 100, 320, 1000, 10_000].map(at);
    const capacity = model.depressions.reduce((sum, d) => sum + d.capacityM3, 0);

    for (let i = 1; i < storms.length; i += 1) {
      const a = storms[i - 1]!;
      const b = storms[i]!;
      // More rain never holds less, never shows less water, never sends less on.
      expect(b.heldM3).toBeGreaterThanOrEqual(a.heldM3 - 1e-6);
      expect(b.standingAreaM2).toBeGreaterThanOrEqual(a.standingAreaM2);
      expect(b.outflowM3).toBeGreaterThan(a.outflowM3);
      expect(b.channel.reduce((n, v) => n + v, 0)).toBeGreaterThanOrEqual(a.channel.reduce((n, v) => n + v, 0));
    }
    const small = storms[1]!; // 10 mm
    const huge = storms[storms.length - 1]!; // 10,000 mm
    // A light shower does not fill the hollows; a deluge fills every one to the rim.
    expect(small.heldM3).toBeLessThan(capacity * 0.9);
    expect(small.pondsFull).toBeLessThan(small.pondsTotal);
    expect(huge.pondsFull).toBe(huge.pondsTotal);
    expect(close(huge.heldM3, capacity, 1e-6, 1e-3)).toBe(true);
    // After the storm, a full pond cannot hold more than its rim allows...
    const design = storms[5]!;
    if (design.pondsFull === design.pondsTotal) {
      expect(huge.standingAreaM2).toBe(design.standingAreaM2);
      expect(huge.outflowM3).toBeGreaterThan(design.outflowM3 * 10);
    }
  });

  it('puts more ground under water at the peak the harder it rains, with no ceiling', async () => {
    const { s, p, model } = await setup();
    const at = (rain: number) => simulateStorm(s.dem, model, p, rain, stormRunoffCoeff(p, rain));
    const storms = [10, 50, 168.1, 320, 1000, 10_000].map(at);
    for (let i = 1; i < storms.length; i += 1) {
      const a = storms[i - 1]!;
      const b = storms[i]!;
      // ...but at the peak the water is running, and running water has depth.
      expect(b.peakWetAreaM2).toBeGreaterThan(a.peakWetAreaM2);
      expect(b.peakOutflowM3s).toBeGreaterThan(a.peakOutflowM3s);
      // The peak always includes the ponds standing after it.
      expect(b.peakWetAreaM2).toBeGreaterThanOrEqual(b.standingAreaM2);
    }
    const big = storms[3]!; // 320 mm: every pond full
    const huge = storms[5]!; // 10,000 mm
    expect(huge.standingAreaM2).toBe(big.standingAreaM2);
    expect(huge.peakWetAreaM2).toBeGreaterThan(big.peakWetAreaM2 * 1.5);
  }, 120_000);
});
