import { describe, expect, it } from 'vitest';
import { nodeSource } from '../data/nodeSource';
import { loadSite } from '../site/loadSite';
import { LevelSource, confidenceAt } from '../terrain/fill';
import { M2_PER_ACRE } from '../units';

let cached: Awaited<ReturnType<typeof loadSite>> | null = null;
async function filledSite() {
  if (cached) return cached;
  cached = await loadSite(nodeSource(), { withFill: true, fillMarginM: 20 });
  return cached;
}

describe('closing the survey holes', () => {
  it('leaves the measured DEM exactly as delivered', async () => {
    const s = await filledSite();
    expect(s.filled).not.toBeNull();
    const f = s.filled!;
    let checked = 0;
    for (let k = 0; k < s.dem.values.length; k += 1) {
      const raw = s.dem.values[k]!;
      if (!Number.isFinite(raw)) continue;
      checked += 1;
      // Not "close to": identical. A fill that edits a measurement is a lie.
      expect(f.values[k]).toBe(raw);
      expect(f.source[k]).toBe(LevelSource.Survey);
    }
    expect(checked).toBeGreaterThan(60_000);
  });

  it('recovers real levels the DEM was throwing away', async () => {
    const s = await filledSite();
    const f = s.filled!;
    // Spot levels and contour vertices on ground the TIN never carried.
    expect(f.harvestedCells).toBeGreaterThan(300);
    for (let k = 0; k < f.source.length; k += 1) {
      if (f.source[k] !== LevelSource.Harvested) continue;
      expect(Number.isFinite(f.values[k]!)).toBe(true);
      // Harvested ground is measured ground, so it is zero distance from data.
      expect(f.distanceToMeasuredM[k]).toBe(0);
    }
  });

  it('closes the parcel: no hole left inside the surveyed land', async () => {
    const s = await filledSite();
    const f = s.filled!;
    const { nx, ny } = s.dem.meta;
    let holesInParcel = 0;
    // Walk the cells themselves, and judge each on its own centre: sampling a
    // grid of points instead maps several samples onto one cell and reports
    // holes where there are none.
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const k = j * nx + i;
        if (f.source[k] !== LevelSource.None) continue;
        if (pointInParcel(s, s.dem.cellCentre(i, j))) holesInParcel += 1;
      }
    }
    expect(holesInParcel, 'the parcel mesh must be continuous').toBe(0);
    expect(f.interpolatedCells).toBeGreaterThan(10_000);
  });

  it('stays inside the levels the survey actually found', async () => {
    const s = await filledSite();
    const f = s.filled!;
    // A Laplace membrane cannot overshoot its boundary: the maximum principle
    // says every interpolated cell lies between the measurements around it.
    // If this fails the solver has diverged, which over-relaxation can do.
    const min = s.dem.meta.rl_min;
    const max = s.dem.meta.rl_max;
    for (let k = 0; k < f.source.length; k += 1) {
      if (f.source[k] !== LevelSource.Interpolated) continue;
      const v = f.values[k]!;
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(min - 0.01);
      expect(v).toBeLessThanOrEqual(max + 0.01);
    }
  });

  it('joins the measured ground without a step at the seam', async () => {
    const s = await filledSite();
    const f = s.filled!;
    const { nx, ny } = s.dem.meta;
    let seams = 0;
    let worst = 0;
    for (let j = 1; j < ny - 1; j += 1) {
      for (let i = 1; i < nx - 1; i += 1) {
        const k = j * nx + i;
        if (f.source[k] !== LevelSource.Interpolated) continue;
        for (const nk of [k - 1, k + 1, k - nx, k + nx]) {
          if (f.source[nk] !== LevelSource.Survey) continue;
          seams += 1;
          worst = Math.max(worst, Math.abs(f.values[k]! - f.values[nk]!));
        }
      }
    }
    /*
     * Judged against the ground itself, not an absolute figure. This site has
     * 75 m of relief and faces the KMBR rules call unbuildable, so two cells
     * 2 m apart can genuinely differ by metres. What would show a bad fill is
     * a seam steeper than the measured terrain around it.
     */
    let naturalWorst = 0;
    for (let j = 1; j < ny - 1; j += 1) {
      for (let i = 1; i < nx - 1; i += 1) {
        const k = j * nx + i;
        if (f.source[k] !== LevelSource.Survey) continue;
        for (const nk of [k + 1, k + nx]) {
          if (f.source[nk] !== LevelSource.Survey) continue;
          naturalWorst = Math.max(naturalWorst, Math.abs(f.values[k]! - f.values[nk]!));
        }
      }
    }
    expect(seams).toBeGreaterThan(500);
    expect(
      worst,
      `worst seam step ${worst.toFixed(2)} m against ${naturalWorst.toFixed(2)} m in measured ground`,
    ).toBeLessThanOrEqual(naturalWorst);
  });

  it('says how far every filled cell sits from real data', async () => {
    const s = await filledSite();
    const f = s.filled!;
    expect(f.maxFillDistanceM).toBeGreaterThan(10);
    // The largest hole is about 4.6 ac, so its middle is tens of metres out.
    expect(f.maxFillDistanceM).toBeLessThan(200);
    expect(confidenceAt(0)).toBe(1);
    expect(confidenceAt(25)).toBeCloseTo(0.5, 6);
    expect(confidenceAt(f.maxFillDistanceM)).toBeLessThan(confidenceAt(5));
  });

  it('converges rather than running out of iterations', async () => {
    const s = await filledSite();
    const f = s.filled!;
    expect(f.residualM).toBeLessThan(0.01);
    expect(f.iterations).toBeLessThan(4000);
  });

  it('reports what it did in acres, not just cells', async () => {
    const s = await filledSite();
    const f = s.filled!;
    const { nx, ny } = s.dem.meta;
    const cellArea = s.dem.cell * s.dem.cell;

    // In the parcel is the figure that matters to the plan. The total is
    // larger because the fill runs a margin past the boundary so the mesh
    // edge is not ragged, and that margin is not land anyone is planning.
    let inParcel = 0;
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const k = j * nx + i;
        if (f.source[k] !== LevelSource.Interpolated) continue;
        if (pointInParcel(s, s.dem.cellCentre(i, j))) inParcel += 1;
      }
    }
    const inParcelAc = (inParcel * cellArea) / M2_PER_ACRE;
    const totalAc = (f.interpolatedCells * cellArea) / M2_PER_ACRE;

    // The survey left 13.47 ac of the 73.54 ac parcel unmeasured.
    expect(inParcelAc).toBeGreaterThan(12);
    expect(inParcelAc).toBeLessThan(15);
    expect(totalAc).toBeGreaterThan(inParcelAc);
    expect((f.harvestedCells * cellArea) / M2_PER_ACRE).toBeGreaterThan(0);
  });
});

function pointInParcel(s: Awaited<ReturnType<typeof loadSite>>, p: readonly [number, number]): boolean {
  for (const poly of s.parcel) {
    let inside = false;
    for (let r = 0; r < poly.length; r += 1) {
      const ring = poly[r]!;
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const a = ring[i]!;
        const b = ring[j]!;
        if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
      }
      if (r === 0) inside = hit;
      else if (hit) inside = false;
    }
    if (inside) return true;
  }
  return false;
}

describe('the filled ground behaves like terrain', () => {
  it('carries the hillside across a hole instead of flattening it', async () => {
    const s = await filledSite();
    const f = s.filled!;
    const { Dem } = await import('../terrain/dem');
    const slope = new Dem(s.dem.meta, f.values).slopeGrid();
    const { nx, ny } = s.dem.meta;

    const band = (test: (k: number) => boolean): number => {
      let total = 0;
      let count = 0;
      for (let j = 1; j < ny - 1; j += 1) {
        for (let i = 1; i < nx - 1; i += 1) {
          const k = j * nx + i;
          const v = slope[k]!;
          if (!Number.isFinite(v) || !test(k)) continue;
          total += v;
          count += 1;
        }
      }
      return count > 0 ? total / count : Number.NaN;
    };

    const measured = band((k) => f.source[k] === LevelSource.Survey);
    const deepFill = band(
      (k) => f.source[k] === LevelSource.Interpolated && f.distanceToMeasuredM[k]! >= 15,
    );

    /*
     * The first version of this filled the deep interiors as dead level
     * ground: 0.00° against 12° in the measured terrain, a plateau nobody
     * surveyed. Interpolated ground should be gentler than measured — that is
     * what interpolating means — but it must still be a hillside.
     */
    expect(deepFill, 'deep fill must not be a plateau').toBeGreaterThan(measured * 0.5);
    expect(deepFill, 'deep fill must not invent terrain steeper than the site').toBeLessThan(measured * 1.2);
  });

  it('is seamless where it meets measured ground', async () => {
    const s = await filledSite();
    const f = s.filled!;
    const { Dem } = await import('../terrain/dem');
    const slope = new Dem(s.dem.meta, f.values).slopeGrid();
    const { nx, ny } = s.dem.meta;
    let seamTotal = 0;
    let seamCount = 0;
    let measuredTotal = 0;
    let measuredCount = 0;
    for (let j = 1; j < ny - 1; j += 1) {
      for (let i = 1; i < nx - 1; i += 1) {
        const k = j * nx + i;
        const v = slope[k]!;
        if (!Number.isFinite(v)) continue;
        if (f.source[k] === LevelSource.Survey) {
          measuredTotal += v;
          measuredCount += 1;
        } else if (f.source[k] === LevelSource.Interpolated && f.distanceToMeasuredM[k]! < 6) {
          seamTotal += v;
          seamCount += 1;
        }
      }
    }
    const seam = seamTotal / Math.max(1, seamCount);
    const measured = measuredTotal / Math.max(1, measuredCount);
    // A ridge thrown up along the join would show here as a steeper seam band.
    expect(seam, `seam ${seam.toFixed(1)}° against ${measured.toFixed(1)}° measured`).toBeLessThan(
      measured * 1.5,
    );
  });
});
