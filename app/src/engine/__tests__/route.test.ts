import { describe, expect, it } from 'vitest';
import { Dem } from '../terrain/dem';
import type { DemMeta } from '../terrain/dem';
import type { Pt } from '../geom/types';
import { corridor, gradeLimitedProfile, leastEarthworkProfile, profileOptions, RoadLevels } from '../pipeline/route';
import type { ProfileOptions, RoadProfile } from '../pipeline/route';

/** A 2 m grid whose level is z(x), the same across y: a road along x sees it exactly. */
function demOf(z: (x: number, y: number) => number, nx = 120, ny = 20, cell = 2): Dem {
  const meta: DemMeta = {
    format: 'test', nodata: 'NaN', cell_m: cell, x0: 0, y0: 0, nx, ny,
    cell_centre: '', coords: '', source: 'test', valid_cells: nx * ny, rl_min: 0, rl_max: 0,
  };
  const v = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) v[j * nx + i] = z(cell * (i + 0.5), cell * (j + 0.5));
  return new Dem(meta, v);
}

/** Gentle 1:40 fall with a 4 m bump at x = 70 and a 3.5 m dip at x = 160, both far steeper than 1:8. */
const bumpDip = (x: number): number =>
  100 + x / 40 + 4 * Math.exp(-(((x - 70) / 9) ** 2)) - 3.5 * Math.exp(-(((x - 160) / 8) ** 2));

const GRADE = 1 / 8;
const WIDTH = 6;
const line: Pt[] = [[4, 20], [236, 20]];
const opts = (o: Partial<ProfileOptions> = {}): ProfileOptions => ({
  mode: 'least_earthwork', widthM: WIDTH, cutRs: 350, fillRs: 300, wallRsPerM: 0, wallFreeM: 0.5, ...o,
});

const earth = (dem: Dem, p: RoadProfile): { cut: number; fill: number; rs: number } => {
  const c = corridor(dem, line, WIDTH, p, new Float32Array(dem.values.length));
  return { cut: c.cutM3, fill: c.fillM3, rs: 350 * c.cutM3 + 300 * c.fillM3 };
};

const withinGrade = (p: RoadProfile, grade: number): void => {
  for (let i = 1; i < p.design.length; i += 1) {
    expect(Math.abs(p.design[i]! - p.design[i - 1]!)).toBeLessThanOrEqual(grade * (p.s[i]! - p.s[i - 1]!) + 1e-9);
  }
  expect(p.designMaxGrade).toBeLessThanOrEqual(grade + 1e-9);
};

describe('road vertical profile', () => {
  const dem = demOf(bumpDip);

  it('grade_limited (the default) is the profile it always was', () => {
    const a = gradeLimitedProfile(dem, line, GRADE);
    const b = gradeLimitedProfile(dem, line, GRADE, 2, profileOptions({ roads: { profile_mode: 'grade_limited' } }, {}, WIDTH));
    const c = gradeLimitedProfile(dem, line, GRADE, 2, profileOptions({}, {}, WIDTH));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(profileOptions({ roads: { profile_mode: 'least_earthwork' } }, {}, WIDTH).mode).toBe('least_earthwork');
  });

  it('least_earthwork moves less earth than grade_limited over a bump and a dip, within the grade', () => {
    const old = gradeLimitedProfile(dem, line, GRADE);
    const neu = gradeLimitedProfile(dem, line, GRADE, 2, opts());
    expect(neu.design.length).toBe(old.design.length);
    expect(neu.terrain).toEqual(old.terrain);
    withinGrade(old, GRADE);
    withinGrade(neu, GRADE);
    const e0 = earth(dem, old);
    const e1 = earth(dem, neu);
    expect(e1.cut + e1.fill).toBeLessThan(0.8 * (e0.cut + e0.fill));
    expect(e1.rs).toBeLessThan(e0.rs);
    // Where the ground is within grade (the 1:40 run in between) the road lies on it.
    const mid = neu.s.findIndex((s) => s > 114);
    expect(Math.abs(neu.design[mid]! - neu.terrain[mid]!)).toBeLessThan(1e-6);
  });

  it('is the optimum: no worse than a fine-level dynamic programme', () => {
    const p = leastEarthworkProfile(dem, line, GRADE, 2, opts());
    const t = p.terrain;
    const cost = (z: number, i: number): number => {
      const ds = ((i + 1 < t.length ? p.s[i + 1]! : p.s[i]!) - (i > 0 ? p.s[i - 1]! : p.s[i]!)) / 2;
      return ds * WIDTH * (z < t[i]! ? 350 * (t[i]! - z) : 300 * (z - t[i]!));
    };
    const total = p.design.reduce((acc, z, i) => acc + cost(z, i), 0);
    // Brute force over 1 cm levels (grade window rounded down: a slightly tighter problem, so its optimum is no lower).
    const h = 0.01;
    const zmin = Math.min(...t) - 6;
    const levels = Math.ceil((Math.max(...t) + 6 - zmin) / h);
    let f = new Float64Array(levels).map((_, k) => cost(zmin + k * h, 0));
    for (let i = 1; i < t.length; i += 1) {
      const r = Math.floor((GRADE * (p.s[i]! - p.s[i - 1]!)) / h + 1e-9);
      const g = new Float64Array(levels);
      for (let k = 0; k < levels; k += 1) {
        let m = Infinity;
        for (let q = Math.max(0, k - r); q <= Math.min(levels - 1, k + r); q += 1) m = Math.min(m, f[q]!);
        g[k] = m + cost(zmin + k * h, i);
      }
      f = g;
    }
    const brute = Math.min(...f);
    expect(total).toBeLessThanOrEqual(brute + 1e-6 * brute);
    expect(total).toBeGreaterThan(0.95 * brute);
  });

  it('holds fixed junction levels at its ends', () => {
    const p = leastEarthworkProfile(dem, line, GRADE, 2, opts({ fixedStart: 101, fixedEnd: 104 }));
    expect(p.design[0]).toBeCloseTo(101, 6);
    expect(p.design[p.design.length - 1]).toBeCloseTo(104, 6);
    withinGrade(p, GRADE);
  });

  it('meets the level of a road already laid at its end, and records its own levels', () => {
    const levels = new RoadLevels(dem);
    // A road already laid across the end of this one, 2 m above the ground there.
    const { nx, ny } = dem.meta;
    for (let j = 0; j < ny; j += 1) for (let i = 115; i < 120; i += 1) levels.record(j * nx + i, dem.values[j * nx + i]! + 2);
    const free = gradeLimitedProfile(dem, line, GRADE, 2, opts({ wallRsPerM: 14_000 }));
    const p = gradeLimitedProfile(dem, line, GRADE, 2, { ...opts({ wallRsPerM: 14_000 }), levels });
    const last = p.design.length - 1;
    const join = levels.at(line[1]!)!;
    // Priced as a wall the width of the road, the step at the junction is traded against the ramp's earth and verges.
    expect(Math.abs(p.design[last]! - join)).toBeLessThan(Math.abs(free.design[last]! - join) - 0.5);
    withinGrade(p, GRADE);
    corridor(dem, line, WIDTH, p, new Float32Array(dem.values.length));
    expect(levels.at([100, 20])).toBeCloseTo(p.design[48]!, 1);
  });

  it('keeps the verges off walls when walls are priced', () => {
    // The ground is level across the road here, so the verge steps by |design - ground|.
    const wallExcess = (p: RoadProfile): number =>
      p.design.reduce((acc, z, i) => acc + (i > 0 ? p.s[i]! - p.s[i - 1]! : 0) * Math.max(0, Math.abs(z - p.terrain[i]!) - 0.5), 0);
    const free = leastEarthworkProfile(dem, line, GRADE, 2, opts());
    const walled = leastEarthworkProfile(dem, line, GRADE, 2, opts({ wallRsPerM: 14_000 }));
    withinGrade(walled, GRADE);
    expect(wallExcess(walled)).toBeLessThan(wallExcess(free));
  });

  it('is quick: a 2 km road in well under 50 ms', () => {
    const long = demOf((x) => 100 + 3 * Math.sin(x / 15) + x / 30, 1100, 20);
    const ln: Pt[] = [[2, 20], [2196, 20]];
    const t0 = performance.now();
    const p = gradeLimitedProfile(long, ln, GRADE, 2, profileOptions({ roads: { profile_mode: 'least_earthwork' } }, {}, 10));
    expect(performance.now() - t0).toBeLessThan(50);
    withinGrade(p, GRADE);
  });
});
