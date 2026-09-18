import type { Dem } from '../terrain/dem';
import type { Pt } from '../geom/types';
import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';

/**
 * Road gradients against the client's assumption, which states them the way a
 * civil engineer writes them — "1:12" desirable, "1:8" over a short stretch.
 *
 * The assumption has sat in `assumptions.yaml` since the first build and no
 * engine had ever measured a generated road against it.
 */

export interface GradientLimits {
  /** Desirable maximum, as a rise:run ratio expressed as a fraction. */
  desirable: number;
  /** Absolute maximum, allowed only over a short stretch. */
  maxShort: number;
  desirableLabel: string;
  maxShortLabel: string;
  /** How long a stretch may use the steeper figure. */
  shortRunM: number;
}

/** Parses "1:12" into 1/12. A plain number is taken as the fraction itself. */
function parseRatio(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const m = /^\s*([\d.]+)\s*:\s*([\d.]+)\s*$/.exec(value);
    if (m) {
      const run = Number(m[2]);
      if (run > 0) return Number(m[1]) / run;
    }
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function gradientLimits(assumptions: YamlDoc): GradientLimits {
  const raw = pick<Record<string, unknown>>(assumptions, 'road_gradient', {});
  return {
    desirable: parseRatio(raw.desirable, 1 / 12),
    maxShort: parseRatio(raw.max_short, 1 / 8),
    desirableLabel: typeof raw.desirable === 'string' ? raw.desirable : '1:12',
    maxShortLabel: typeof raw.max_short === 'string' ? raw.max_short : '1:8',
    shortRunM: pick<number>(assumptions, 'road_gradient_short_run_m', 30),
  };
}

export interface RoadGradient {
  roadId: string;
  /** Steepest single stretch, as a fraction (0.08 = 1:12.5). */
  maxGrade: number;
  /** Length of road steeper than the desirable limit. */
  overDesirableM: number;
  /** Length of road steeper than the absolute limit. */
  overMaxM: number;
  lengthM: number;
  /** True where a stretch over the desirable limit runs longer than allowed. */
  longSteepRun: boolean;
  /** Set where the DEM does not cover the road. */
  unsurveyedShare: number;
}

/**
 * Samples a road centreline on the DEM and measures its gradient.
 *
 * Unsurveyed ground carries no gradient: a NaN sample is counted and reported,
 * never treated as flat, because a road over 18% unsurveyed land that reports
 * 0% would be the worst kind of false pass.
 */
export function measureGradient(
  dem: Dem,
  roadId: string,
  centreline: readonly Pt[],
  limits: GradientLimits,
  sampleM = 5,
): RoadGradient {
  let maxGrade = 0;
  let overDesirable = 0;
  let overMax = 0;
  let length = 0;
  let unsurveyed = 0;
  let runOverDesirable = 0;
  let longRun = false;

  for (let i = 1; i < centreline.length; i += 1) {
    const a = centreline[i - 1]!;
    const b = centreline[i]!;
    const segLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (segLength <= 0) continue;
    const steps = Math.max(1, Math.ceil(segLength / sampleM));
    for (let s = 0; s < steps; s += 1) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const p0: Pt = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const p1: Pt = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      const run = segLength / steps;
      length += run;
      const z0 = dem.sampleBilinear(p0);
      const z1 = dem.sampleBilinear(p1);
      if (Number.isNaN(z0) || Number.isNaN(z1)) {
        unsurveyed += run;
        runOverDesirable = 0;
        continue;
      }
      const grade = Math.abs(z1 - z0) / run;
      maxGrade = Math.max(maxGrade, grade);
      if (grade > limits.desirable) {
        overDesirable += run;
        runOverDesirable += run;
        if (runOverDesirable > limits.shortRunM) longRun = true;
      } else {
        runOverDesirable = 0;
      }
      if (grade > limits.maxShort) overMax += run;
    }
  }

  return {
    roadId,
    maxGrade,
    overDesirableM: overDesirable,
    overMaxM: overMax,
    lengthM: length,
    longSteepRun: longRun,
    unsurveyedShare: length > 0 ? unsurveyed / length : 0,
  };
}

export interface GradientSummary {
  roads: RoadGradient[];
  limits: GradientLimits;
  totalLengthM: number;
  overDesirableM: number;
  overMaxM: number;
  steepestGrade: number;
  steepestRoadId: string | null;
  unsurveyedShare: number;
}

export function summariseGradients(roads: RoadGradient[], limits: GradientLimits): GradientSummary {
  const total = roads.reduce((s, r) => s + r.lengthM, 0);
  const steepest = roads.reduce<RoadGradient | null>(
    (best, r) => (!best || r.maxGrade > best.maxGrade ? r : best),
    null,
  );
  return {
    roads,
    limits,
    totalLengthM: total,
    overDesirableM: roads.reduce((s, r) => s + r.overDesirableM, 0),
    overMaxM: roads.reduce((s, r) => s + r.overMaxM, 0),
    steepestGrade: steepest?.maxGrade ?? 0,
    steepestRoadId: steepest?.roadId ?? null,
    unsurveyedShare:
      total > 0 ? roads.reduce((s, r) => s + r.unsurveyedShare * r.lengthM, 0) / total : 0,
  };
}

/** "1:12.4", the way a road gradient is written. */
export const asRatio = (grade: number): string =>
  grade > 0 ? `1:${(1 / grade).toFixed(1)}` : 'level';
