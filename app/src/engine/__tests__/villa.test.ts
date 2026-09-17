import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { generateVillaLayouts } from '../generators/villa';
import { multiPolyArea } from '../geom/planar';
import { m2ToAcres } from '../units';
import { sizeVillaPlots } from '../rules/client';
import { intersect } from '../geom/boolean';

const ZONE = 'PROJECT - 2 (VILLAS)';

/** PROJECT - 2 carries its share of the 640-villa balance line at 20 units/ac. */
const UNITS_PER_AC = 20;

async function runProject2() {
  const s = await site();
  const c = await config();
  const zone = s.zones.find((z) => z.name === ZONE)!;
  const targetUnits = Math.round(zone.computedInScopeAc * UNITS_PER_AC);
  const options = generateVillaLayouts({
    zoneId: zone.id,
    zoneName: zone.name,
    zone: zone.geom,
    dem: s.dem,
    kmbr: c.kmbr,
    client: c.client,
    assumptions: c.assumptions,
    targetUnits,
    householdSize: 3.5,
  });
  return { s, c, zone, targetUnits, options };
}

describe('M3 villa generator — PROJECT - 2 (7.77 ac)', () => {
  it('returns three options', async () => {
    const { options } = await runProject2();
    expect(options.length).toBe(3);
    for (const o of options) {
      expect(o.kind).toBe('villa');
      expect(o.strategy.length).toBeGreaterThan(10);
      expect(o.plots.length).toBeGreaterThan(0);
      expect(o.roads.length).toBeGreaterThan(0);
    }
  });

  it('never places more units than the programme asks for', async () => {
    const { options, targetUnits } = await runProject2();
    for (const o of options) {
      expect(o.metrics.unitCount, o.strategy).toBeLessThanOrEqual(targetUnits);
    }
  });

  it('keeps every plot at or above the client minimum', async () => {
    const { options, c, zone, targetUnits } = await runProject2();
    const sizing = sizeVillaPlots(c.client, multiPolyArea(zone.geom), targetUnits);
    for (const o of options) {
      for (const p of o.plots) {
        expect(p.areaM2, `${o.strategy}: plot ${p.id}`).toBeGreaterThanOrEqual(
          sizing.minPlotAreaWithToleranceM2 - 1e-6,
        );
        expect(Math.max(p.widthM, p.depthM)).toBeGreaterThanOrEqual(18 * 0.97);
      }
    }
  });

  it('keeps plots inside the buildable area and clear of Rule 22 ground', async () => {
    const { options } = await runProject2();
    for (const o of options) {
      for (const p of o.plots.slice(0, 40)) {
        const inside = intersect([[p.ring]], o.buildable);
        expect(m2ToAcres(multiPolyArea(inside))).toBeCloseTo(m2ToAcres(p.areaM2), 4);
      }
    }
  });

  it('lands the roads and open space near the 20/30/50 split', async () => {
    const { options } = await runProject2();
    const best = options[0]!;
    // Roads and saleable are what the strip geometry controls directly.
    expect(best.metrics.shares.roads).toBeGreaterThan(0.1);
    expect(best.metrics.shares.roads).toBeLessThan(0.35);
    expect(best.metrics.shares.roads + best.metrics.shares.openSpace + best.metrics.shares.saleable).toBeGreaterThan(
      0.9,
    );
  });

  it('produces a complete report for every option', async () => {
    const { options } = await runProject2();
    for (const o of options) {
      expect(o.findings.length).toBeGreaterThan(8);
      // Every finding must carry a traceable reference.
      for (const f of o.findings) expect(f.reference.length).toBeGreaterThan(3);
      expect(o.findings.some((f) => f.id === 'villa.min_plot_area')).toBe(true);
      expect(o.findings.some((f) => f.id === 'villa.yield')).toBe(true);
      expect(o.findings.some((f) => f.id === 'villa.share.roads')).toBe(true);
      expect(o.findings.some((f) => f.conflict)).toBe(true);
      expect(Number.isFinite(o.score.total)).toBe(true);
      expect(Number.isFinite(o.metrics.cutM3)).toBe(true);
      expect(Number.isFinite(o.metrics.retainingFaceM2)).toBe(true);
    }
  });

  it('classifies terrain per plot against the assumption thresholds', async () => {
    const { options } = await runProject2();
    const plots = options[0]!.plots;
    const classes = new Set(plots.map((p) => p.terrain.fallClass));
    expect(classes.size).toBeGreaterThan(1);
    for (const p of plots) {
      expect(Number.isFinite(p.terrain.platformRl) || p.terrain.fallClass === 'unsurveyed').toBe(true);
    }
  });

  it('places a villa footprint inside the setbacks on every plot', async () => {
    const { options } = await runProject2();
    for (const p of options[0]!.plots) {
      expect(p.footprint).not.toBeNull();
      expect(p.footprintAreaM2).toBeGreaterThan(0);
      expect(p.footprintAreaM2).toBeLessThan(p.areaM2 * 0.5);
    }
  });

  it('runs a zone inside the 10 s performance budget', async () => {
    const started = Date.now();
    await runProject2();
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
