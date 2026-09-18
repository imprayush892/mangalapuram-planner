import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import { dist } from '../geom/planar';
import type { ZoneUse } from '../site/level1';
import { USE_LABEL } from '../site/level1';
import { useRules } from './constraints';
import type { ScoreFactor, ZoneMetrics } from './types';

/**
 * PRD §5.3: each eligible zone gets a 0-100 score per use from weighted
 * factors — buildable area, earthwork, access and frontage, adjacency, view
 * and elevation, drainage risk and phase order. Weights are editable.
 *
 * Every factor returns 0-100 and carries the sentence that explains it, so the
 * score can be read back rather than taken on trust.
 */

export interface ScoreWeights {
  buildable_area: number;
  earthwork: number;
  access_frontage: number;
  adjacency: number;
  view_elevation: number;
  drainage_risk: number;
  phase_order: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  buildable_area: 25,
  earthwork: 20,
  access_frontage: 15,
  adjacency: 15,
  view_elevation: 10,
  drainage_risk: 10,
  phase_order: 5,
};

export function loadWeights(siting: YamlDoc): ScoreWeights {
  const raw = pick<Partial<ScoreWeights>>(siting, 'scoring_weights', {});
  return { ...DEFAULT_WEIGHTS, ...raw };
}

export interface ScoreContext {
  /** Where each use currently sits, for the adjacency factor. */
  centroidsByUse: Map<ZoneUse, { centroid: [number, number]; areaAc: number }[]>;
  /** Phase the programme wants this use built in, or null. */
  phaseForUse?: (use: ZoneUse) => number | null;
}

export interface ScoredCandidate {
  score: number;
  factors: ScoreFactor[];
}

export function scoreCandidate(
  siting: YamlDoc,
  weights: ScoreWeights,
  use: ZoneUse,
  metrics: ZoneMetrics,
  ctx: ScoreContext,
): ScoredCandidate {
  const rules = useRules(siting, use);
  const prefers = rules.prefers ?? {};
  const factors: ScoreFactor[] = [];

  /* Buildable area: what share of the zone is usable at all. */
  factors.push({
    key: 'buildable_area',
    label: 'Buildable area',
    value: metrics.buildableShare * 100,
    weight: weights.buildable_area,
    detail: `${(metrics.buildableShare * 100).toFixed(0)}% of the zone is clear of Rule 22 ground${
      metrics.unsurveyedShare > 0.05
        ? `; ${(metrics.unsurveyedShare * 100).toFixed(0)}% is unsurveyed and low-confidence`
        : ''
    }`,
  });

  /* Earthwork: median fall across a plot-sized window. 0 m is perfect, 4 m is hopeless. */
  const fall = metrics.medianPlotFallM;
  factors.push({
    key: 'earthwork',
    label: 'Earthwork',
    value: Number.isFinite(fall) ? Math.max(0, 100 - (fall / 4) * 100) : 50,
    weight: weights.earthwork,
    detail: Number.isFinite(fall)
      ? `median fall ${fall.toFixed(2)} m across an 11.4 × 14.2 m window`
      : 'no surveyed ground: earthwork scored at the midpoint',
  });

  /* Access and frontage. */
  const frontageScore = Math.min(100, metrics.frontageShare * 250);
  factors.push({
    key: 'access_frontage',
    label: 'Access and frontage',
    value: frontageScore,
    weight: weights.access_frontage,
    detail:
      metrics.frontageM > 0
        ? `${Math.round(metrics.frontageM)} m of boundary on an existing road (${(metrics.frontageShare * 100).toFixed(0)}% of its perimeter)`
        : `no road frontage; nearest road ${Number.isFinite(metrics.distanceToRoadM) ? `${Math.round(metrics.distanceToRoadM)} m` : '—'} away`,
  });

  /* Adjacency: near what it should be near, away from what it should not. */
  const adjacency = scoreAdjacency(siting, metrics, ctx, prefers);
  factors.push({
    key: 'adjacency',
    label: 'Adjacency',
    value: adjacency.value,
    weight: weights.adjacency,
    detail: adjacency.detail,
  });

  /* View and elevation, plus the edge/central preference, which is the same
     "where in the site" judgement. */
  const position = scorePosition(metrics, prefers);
  factors.push({
    key: 'view_elevation',
    label: 'View and position',
    value: position.value,
    weight: weights.view_elevation,
    detail: position.detail,
  });

  /* Drainage risk: a channel through the zone is a cost for most uses and a
     feature for the club. */
  const wantsDrainage = prefers.on_drainage === true;
  const drainagePenalty = Math.min(100, metrics.drainageShare * 400);
  factors.push({
    key: 'drainage_risk',
    label: 'Drainage',
    value: wantsDrainage ? drainagePenalty : 100 - drainagePenalty,
    weight: weights.drainage_risk,
    detail: `${(metrics.drainageShare * 100).toFixed(1)}% of the zone carries a drainage channel${
      wantsDrainage ? ', which this use wants as a water feature' : ''
    }`,
  });

  /* Phase order: does the zoning plan's phase match the programme's? */
  const phase = scorePhase(use, metrics, ctx);
  factors.push({
    key: 'phase_order',
    label: 'Phase order',
    value: phase.value,
    weight: weights.phase_order,
    detail: phase.detail,
  });

  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const score = totalWeight > 0 ? factors.reduce((s, f) => s + f.value * f.weight, 0) / totalWeight : 0;
  return { score, factors };
}

function scoreAdjacency(
  siting: YamlDoc,
  metrics: ZoneMetrics,
  ctx: ScoreContext,
  prefers: NonNullable<ReturnType<typeof useRules>['prefers']>,
): { value: number; detail: string } {
  const walkDetour = pick<number>(siting, 'defaults.walk_detour_factor', 1.35);
  const near = prefers.adjacent_to ?? [];
  const far = prefers.away_from ?? [];
  if (near.length === 0 && far.length === 0) {
    return { value: 50, detail: 'no adjacency preference for this use' };
  }

  const parts: string[] = [];
  let score = 50;

  for (const other of near) {
    const d = nearestUseDistance(ctx, other, metrics.centroid);
    if (d === null) {
      parts.push(`${USE_LABEL[other].toLowerCase()} not yet placed`);
      continue;
    }
    const walk = d * walkDetour;
    // Full marks inside the walk limit, tailing off to nothing at four times it.
    const limit = prefers.within_walk_m ?? 400;
    const closeness = Math.max(0, 1 - Math.max(0, walk - limit) / (limit * 3));
    score += closeness * (50 / near.length);
    parts.push(
      `${Math.round(walk)} m walk to ${USE_LABEL[other].toLowerCase()}${
        prefers.within_walk_m ? ` (wants ${prefers.within_walk_m} m)` : ''
      }`,
    );
  }

  for (const other of far) {
    const d = nearestUseDistance(ctx, other, metrics.centroid);
    if (d === null) continue;
    // Anything under 200 m of a use it should avoid costs marks.
    const tooClose = Math.max(0, 1 - d / 200);
    score -= tooClose * (30 / far.length);
    if (tooClose > 0) parts.push(`${Math.round(d)} m from ${USE_LABEL[other].toLowerCase()}, which it should avoid`);
  }

  return {
    value: Math.min(100, Math.max(0, score)),
    detail: parts.length > 0 ? parts.join('; ') : 'related uses not yet placed',
  };
}

function nearestUseDistance(
  ctx: ScoreContext,
  use: ZoneUse,
  from: readonly [number, number],
): number | null {
  const placed = ctx.centroidsByUse.get(use);
  if (!placed || placed.length === 0) return null;
  return Math.min(...placed.map((p) => dist(from, p.centroid)));
}

function scorePosition(
  metrics: ZoneMetrics,
  prefers: NonNullable<ReturnType<typeof useRules>['prefers']>,
): { value: number; detail: string } {
  const parts: string[] = [];
  const scores: number[] = [];

  if (prefers.elevation === 'high') {
    scores.push(metrics.elevationRank * 100);
    parts.push(`mean RL ${metrics.meanRl.toFixed(1)}, in the upper ${((1 - metrics.elevationRank) * 100).toFixed(0)}% of the site`);
  } else if (prefers.elevation === 'low') {
    scores.push((1 - metrics.elevationRank) * 100);
    parts.push(`mean RL ${metrics.meanRl.toFixed(1)}, low ground`);
  }

  if (prefers.edge) {
    scores.push(metrics.edgeRank * 100);
    parts.push(`${Math.round(metrics.distanceToParcelEdgeM)} m from the parcel boundary`);
  } else if (prefers.central) {
    scores.push((1 - metrics.edgeRank) * 100);
    parts.push(`${Math.round(metrics.distanceToParcelEdgeM)} m inside the parcel`);
  }

  if (prefers.near_main_road) {
    const d = metrics.distanceToRoadM;
    scores.push(Number.isFinite(d) ? Math.max(0, 100 - (d / 300) * 100) : 0);
    parts.push(Number.isFinite(d) ? `${Math.round(d)} m from an existing road` : 'no road nearby');
  }

  if (prefers.quiet) {
    // Quiet is the inverse of road proximity: far from traffic is quiet.
    const d = metrics.distanceToRoadM;
    scores.push(Number.isFinite(d) ? Math.min(100, (d / 200) * 100) : 100);
    parts.push(Number.isFinite(d) ? `${Math.round(d)} m from the nearest road` : 'away from any road');
  }

  if (scores.length === 0) return { value: 50, detail: 'no position preference for this use' };
  return {
    value: scores.reduce((s, v) => s + v, 0) / scores.length,
    detail: parts.join('; '),
  };
}

function scorePhase(use: ZoneUse, metrics: ZoneMetrics, ctx: ScoreContext): { value: number; detail: string } {
  const wanted = ctx.phaseForUse?.(use) ?? null;
  if (metrics.phase === null) {
    return { value: 50, detail: 'the zoning plan gives this zone no phase' };
  }
  if (wanted === null) {
    // Earlier phases are worth more when the programme says nothing: they are
    // the land that gets built first.
    const value = Math.max(0, 100 - (metrics.phase - 1) * 25);
    return { value, detail: `zoning plan phase ${metrics.phase}; the programme does not pin a phase for this use` };
  }
  const gap = Math.abs(metrics.phase - wanted);
  return {
    value: Math.max(0, 100 - gap * 40),
    detail: `zoning plan phase ${metrics.phase} against programme phase ${wanted}`,
  };
}
