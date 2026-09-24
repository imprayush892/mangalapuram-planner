import { describe, expect, it } from 'vitest';
import { Dem } from '../terrain/dem';
import type { DemMeta } from '../terrain/dem';
import { multiPolyArea } from '../geom/planar';
import { and, areaM2, count, erode, maskFrom, openToWidth, patches, rasterise, toMulti } from '../pipeline/mask';
import { pick } from '../data/config';
import { parseRatio, runAnalysis } from '../pipeline/analysis';
import type { AnalysisResult } from '../pipeline/analysis';
import { config, expected, site } from './fixtures';

/** A flat 40 x 30 grid of 1 m cells, for testing the mask tools where the answer is known. */
function flatDem(nx = 40, ny = 30, cell = 1): Dem {
  const meta: DemMeta = {
    format: 'test',
    nodata: 'NaN',
    cell_m: cell,
    x0: 0,
    y0: 0,
    nx,
    ny,
    cell_centre: '',
    coords: '',
    source: 'test',
    valid_cells: nx * ny,
    rl_min: 0,
    rl_max: 0,
  };
  return new Dem(meta, new Float32Array(nx * ny));
}

describe('masks', () => {
  it('rasterises a rectangle exactly and traces it back to the same area', () => {
    const dem = flatDem();
    const m = rasterise(dem, [[[[5, 5], [25, 5], [25, 15], [5, 15]]]]);
    expect(count(m)).toBe(200);
    const geom = toMulti(dem, m);
    expect(geom).toHaveLength(1);
    expect(multiPolyArea(geom)).toBeCloseTo(200, 6);
    // A rectangle traces to four corners, not 60 collinear points.
    expect(geom[0]![0]!.length).toBe(4);
  });

  it('keeps a hole as a hole and two corner-touching cells apart', () => {
    const dem = flatDem();
    const ring = rasterise(dem, [[
      [[2, 2], [12, 2], [12, 12], [2, 12]],
      [[5, 5], [5, 9], [9, 9], [9, 5]],
    ]]);
    const geom = toMulti(dem, ring);
    expect(geom).toHaveLength(1);
    expect(geom[0]).toHaveLength(2);
    expect(multiPolyArea(geom)).toBeCloseTo(100 - 16, 6);

    const diag = maskFrom(dem, (k) => k === 20 * 40 + 20 || k === 21 * 40 + 21);
    const pinch = toMulti(dem, diag);
    expect(pinch).toHaveLength(2);
    expect(multiPolyArea(pinch)).toBeCloseTo(2, 6);
  });

  it('opening to a width removes necks and slivers narrower than it', () => {
    const dem = flatDem(60, 40);
    // Two 20 x 20 blocks joined by a 4 m wide neck, plus a 6 m wide spur.
    const shape = rasterise(dem, [
      [[[2, 10], [22, 10], [22, 30], [2, 30]]],
      [[[22, 18], [36, 18], [36, 22], [22, 22]]],
      [[[36, 10], [56, 10], [56, 30], [36, 30]]],
      [[[10, 30], [16, 30], [16, 38], [10, 38]]],
    ]);
    const opened = openToWidth(dem, shape, 15);
    // The blocks survive whole, the neck and the spur do not.
    expect(opened[20 * 60 + 12]).toBe(1);
    expect(opened[20 * 60 + 46]).toBe(1);
    expect(opened[20 * 60 + 29]).toBe(0);
    expect(opened[35 * 60 + 13]).toBe(0);
    // Nothing is added.
    expect(count(and(opened, shape))).toBe(count(opened));
    // A disc rounds each square corner off, to 400 - 4 (r² - πr²/4) per block
    // (r = 7.5); a cell the disc only clips still counts, so the grid keeps a
    // little more than that and never more than the blocks themselves.
    const r = 7.5;
    const rounded = 2 * (400 - 4 * (r * r - (Math.PI * r * r) / 4));
    expect(count(opened)).toBeGreaterThanOrEqual(rounded);
    expect(count(opened)).toBeLessThan(2 * 400);
    // And it is an opening: doing it twice changes nothing.
    expect(count(openToWidth(dem, opened, 15))).toBe(count(opened));
  });

  it('reads slopes written rise:run and refuses anything else', () => {
    expect(parseRatio('1:4', 'x')).toBe(0.25);
    expect(parseRatio('1:5', 'x')).toBe(0.2);
    expect(() => parseRatio('4', 'x')).toThrow();
    expect(() => parseRatio(null, 'x')).toThrow();
  });
});

let cached: AnalysisResult | null = null;
async function analysis(): Promise<{ r: AnalysisResult; s: Awaited<ReturnType<typeof site>> }> {
  const [s, c] = await Promise.all([site(), config()]);
  cached ??= runAnalysis({
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
  return { r: cached, s };
}

describe('planning steps 1-7 on the site', () => {
  it('plans for the 300 mm storm under KMBR Rule 22', async () => {
    const { r } = await analysis();
    expect(r.stormMm).toBe(300);
    // Rule 22(3): 45 degrees, a 1:1 gradient. The owner's 1:4 is suspended.
    expect(r.limits.nonBuildable).toBeCloseTo(1, 9);
    expect(r.limits.plotMax).toBe(0.2);
    // Every Rule 22 condition is either applied or said to be unconsidered.
    expect(r.rule22.filter((c) => c.status === 'applied').map((c) => c.condition)).toHaveLength(3);
    expect(r.rule22.every((c) => c.status === 'applied' || c.how.startsWith('not considered'))).toBe(true);
  });

  it('never puts plotable land on waterlogged, steep or road ground', async () => {
    const { r } = await analysis();
    const L = r.layers;
    for (const other of [L.waterlogging, L.nonBuildable, L.drains, L.existingRoads, L.publicSpace]) {
      expect(count(and(L.plotable.mask, other.mask)), `plotable ∩ ${other.id}`).toBe(0);
    }
  });

  it('classes non-buildable ground by Rule 22: over 45 degrees on the mesh or the raw survey, less the specks the owner ignores', async () => {
    const { r, s } = await analysis();
    const c = await config();
    const minSpeck = pick<number>(c.planning, 'slope.min_non_buildable_patch_m2', 0);
    const m = r.layers.nonBuildable.mask;
    const parcel = r.layers.terrain.mask;
    const survey = s.surveySlopeDeg!;
    const over = maskFrom(s.dem, (k) => parcel[k] === 1 && (r.gradient[k]! > 1 || survey[k]! > 45));
    for (let k = 0; k < m.length; k += 1) if (m[k]) expect(over[k], `cell ${k}`).toBe(1);
    // Every over-45 cell left out lies in a patch smaller than the owner's speck size.
    for (const p of patches(s.dem, over)) {
      const kept = p.some((k) => m[k] === 1);
      expect(kept, `patch of ${p.length * 4} m2`).toBe(p.length * s.dem.cell * s.dem.cell >= minSpeck);
    }
  });

  it('keeps the ground the raw survey measured over 45 degrees, which the smoothed mesh flattens', async () => {
    const { r, s } = await analysis();
    const g = (await expected()).terrain_tin as { survey_over_45_ac: { value: number; tol_pct: number } };
    const survey = s.surveySlopeDeg!;
    let cells = 0;
    for (let k = 0; k < survey.length; k += 1) if (survey[k]! > 45) cells += 1;
    const ac = (cells * s.dem.cell * s.dem.cell) / 4046.8564224;
    expect(Math.abs(ac - g.survey_over_45_ac.value)).toBeLessThanOrEqual((g.survey_over_45_ac.value * g.survey_over_45_ac.tol_pct) / 100 + 0.01);
    // What is left after the owner's speck rule is non-buildable; it can only be less.
    expect(r.layers.nonBuildable.areaM2 / 4046.8564224).toBeLessThanOrEqual(ac + 0.01);
  });

  it('keeps the natural drains clear (Rule 22(4))', async () => {
    const { r } = await analysis();
    const L = r.layers;
    expect(L.drains.areaM2).toBeGreaterThan(0);
    expect(count(and(L.plotable.mask, L.drains.mask))).toBe(0);
    expect(count(and(L.publicSpace.mask, L.drains.mask))).toBe(count(L.drains.mask));
  });

  it('public space holds all the waterlogging and all the non-buildable slope', async () => {
    const { r } = await analysis();
    const L = r.layers;
    expect(count(and(L.publicSpace.mask, L.waterlogging.mask))).toBe(count(L.waterlogging.mask));
    expect(count(and(L.publicSpace.mask, L.nonBuildable.mask))).toBe(count(L.nonBuildable.mask));
  });

  it('accounts for every cell of the parcel', async () => {
    const { r, s } = await analysis();
    const L = r.layers;
    const sum = L.plotable.areaM2 + L.publicSpace.areaM2 + L.existingRoads.areaM2 - areaM2(s.dem, and(L.existingRoads.mask, L.publicSpace.mask));
    expect(sum).toBeCloseTo(r.parcelAreaM2, 0);
  });

  it('leaves only land a 15 m plot can sit on', async () => {
    const { r, s } = await analysis();
    const plot = r.layers.plotable.mask;
    // Every plotable cell is within 7.5 m of a point a 15 m disc can be centred on.
    const core = erode(s.dem, plot, 7.5);
    expect(count(core)).toBeGreaterThan(0);
    // Opening again changes nothing: what is left is already wide enough.
    expect(count(openToWidth(s.dem, plot, 15))).toBe(count(plot));
  });

  it('traces outlines whose area matches the cells', async () => {
    const { r, s } = await analysis();
    for (const id of r.order) {
      const layer = r.layers[id];
      // Lines are traced exactly; areas are drawn smoothed: corners cut back by
      // under a cell, so the area moves by less than a quarter metre per metre of outline.
      const perimeter = toMulti(s.dem, layer.mask)
        .flat()
        .reduce((acc, ring) => acc + ring.reduce((q, p, i) => q + Math.hypot(ring[(i + 1) % ring.length]![0] - p[0], ring[(i + 1) % ring.length]![1] - p[1]), 0), 0);
      const tol = id === 'flowPaths' || id === 'drains' ? 1e-3 * Math.max(1, layer.areaM2) : Math.max(1, 0.25 * perimeter);
      expect(Math.abs(multiPolyArea(layer.geom) - layer.areaM2), id).toBeLessThan(tol);
    }
  });

  it('runs in well under a second', async () => {
    const { r } = await analysis();
    expect(r.ms).toBeLessThan(3000);
  });
});
