import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import type { ZoneUse } from '../site/level1';
import type { ConstraintResult, ZoneMetrics } from './types';

/**
 * PRD §5.2: hard constraints veto a zone for a use before it is scored.
 *
 * Two rules govern this module:
 *  - a constraint with no value in siting_rules.yaml is simply not applied; it
 *    never becomes a silent pass with an invented threshold;
 *  - a constraint the data cannot test comes back `unevaluable` and is carried
 *    into every report, so nobody reads a green row as "checked and fine".
 */

export interface UseSitingRules {
  max_mean_slope_deg?: number;
  min_access_width_m?: number;
  needs_public_road_frontage?: boolean;
  max_coverage_pct?: number;
  min_buildable_share?: number;
  prefers?: {
    elevation?: 'high' | 'low';
    edge?: boolean;
    central?: boolean;
    near_main_road?: boolean;
    quiet?: boolean;
    on_drainage?: boolean;
    adjacent_to?: ZoneUse[];
    away_from?: ZoneUse[];
    within_walk_m?: number;
  };
  unevaluable?: string[];
  layout_checked?: string[];
  provenance?: string;
}

export const useRules = (siting: YamlDoc, use: ZoneUse): UseSitingRules =>
  pick<UseSitingRules>(siting, `uses.${use}`, {});

/**
 * Evaluates every hard constraint for one zone and one use. Returns the full
 * list, passes included: a rationale card has to show what was checked, not
 * only what failed.
 */
export function checkConstraints(
  siting: YamlDoc,
  use: ZoneUse,
  metrics: ZoneMetrics,
  /** Widest road the zone can reach, from the site's existing road network. */
  availableAccessWidthM: number,
): ConstraintResult[] {
  const rules = useRules(siting, use);
  const provenance = rules.provenance ?? 'PRD';
  const out: ConstraintResult[] = [];

  /* Rule 22 buildable share — applies to every use. */
  const minBuildable = rules.min_buildable_share ?? pick<number>(siting, 'defaults.min_buildable_share', 0.5);
  out.push({
    id: 'siting.buildable_share',
    status: metrics.buildableShare >= minBuildable ? 'pass' : 'fail',
    requirement: `at least ${(minBuildable * 100).toFixed(0)}% of the zone buildable`,
    actual: `${(metrics.buildableShare * 100).toFixed(0)}% buildable (KMBR Rule 22 removes the rest)`,
    provenance: 'ASSUMPTION',
  });

  /* Slope. */
  if (rules.max_mean_slope_deg !== undefined) {
    const ok = Number.isFinite(metrics.meanSlopeDeg) && metrics.meanSlopeDeg <= rules.max_mean_slope_deg;
    out.push({
      id: 'siting.slope',
      status: Number.isFinite(metrics.meanSlopeDeg) ? (ok ? 'pass' : 'fail') : 'unevaluable',
      requirement: `mean slope at or under ${rules.max_mean_slope_deg}°`,
      actual: Number.isFinite(metrics.meanSlopeDeg) ? `${metrics.meanSlopeDeg.toFixed(1)}°` : 'no surveyed ground',
      provenance,
      ...(Number.isFinite(metrics.meanSlopeDeg)
        ? {}
        : { reason: 'The zone has no surveyed cells, so its slope is unknown.' }),
    });
  }

  /* Access width, read off the existing road network. */
  if (rules.min_access_width_m !== undefined) {
    const ok = availableAccessWidthM >= rules.min_access_width_m;
    out.push({
      id: 'siting.access_width',
      status: ok ? 'pass' : 'fail',
      requirement: `${rules.min_access_width_m} m access`,
      actual: `existing roads are retained at ${availableAccessWidthM} m`,
      provenance,
    });
  }

  /* Its own gate on a public road. */
  if (rules.needs_public_road_frontage) {
    const ok = metrics.frontageM > 0;
    out.push({
      id: 'siting.road_frontage',
      status: ok ? 'pass' : 'fail',
      requirement: 'own gate on a public road',
      actual: ok
        ? `${Math.round(metrics.frontageM)} m of boundary within reach of an existing road`
        : `nearest road is ${Number.isFinite(metrics.distanceToRoadM) ? `${Math.round(metrics.distanceToRoadM)} m` : 'not reachable'} away`,
      provenance,
    });
  }

  /* Constraints the data cannot settle. */
  for (const note of rules.unevaluable ?? []) {
    const [requirement, reason] = splitNote(note);
    out.push({
      id: `siting.unevaluable.${slug(requirement)}`,
      status: 'unevaluable',
      requirement,
      actual: 'not tested',
      provenance,
      reason,
    });
  }

  /* Constraints another engine already checks, recorded so they are not lost. */
  for (const note of rules.layout_checked ?? []) {
    const [requirement, reason] = splitNote(note);
    out.push({
      id: `siting.layout.${slug(requirement)}`,
      status: 'pass',
      requirement,
      actual: reason ?? 'checked when the zone is laid out',
      provenance,
    });
  }

  return out;
}

/** A candidate is eligible when nothing failed. Unevaluable does not veto. */
export const isEligible = (constraints: readonly ConstraintResult[]): boolean =>
  !constraints.some((c) => c.status === 'fail');

export const unevaluableNotes = (constraints: readonly ConstraintResult[]): string[] =>
  constraints
    .filter((c) => c.status === 'unevaluable')
    .map((c) => (c.reason ? `${c.requirement} — ${c.reason}` : c.requirement));

function splitNote(note: string): [string, string | undefined] {
  const idx = note.indexOf(':');
  if (idx < 0) return [note, undefined];
  return [note.slice(0, idx).trim(), note.slice(idx + 1).trim()];
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
