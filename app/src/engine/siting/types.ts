import type { Pt } from '../geom/types';
import type { ZoneUse } from '../site/level1';

/** Everything the siting engine measures about one zone, before any use is considered. */
export interface ZoneMetrics {
  zoneId: string;
  zoneName: string;
  areaM2: number;
  areaAc: number;
  centroid: Pt;

  /** Share of the zone that is not Rule 22 ground. */
  buildableShare: number;
  buildableAreaM2: number;
  unsurveyedShare: number;

  /** Plan-area weighted mean slope over the zone's cells. */
  meanSlopeDeg: number;
  /** Median fall across a plot-sized window — the earthwork proxy. */
  medianPlotFallM: number;

  minRl: number;
  maxRl: number;
  meanRl: number;
  /** Where the zone's mean level sits in the site's own range, 0 (low) to 1 (high). */
  elevationRank: number;

  /** Shortest distance from the zone boundary to an existing road edge. */
  distanceToRoadM: number;
  /** Length of zone boundary within the frontage search distance of a road. */
  frontageM: number;
  /** Frontage as a share of the zone's perimeter. */
  frontageShare: number;

  /** Distance from the zone centroid to the parcel boundary: small means edge. */
  distanceToParcelEdgeM: number;
  /** 0 (dead centre of the site) to 1 (on the parcel edge). */
  edgeRank: number;

  /** Share of the zone's cells carrying a drainage channel. */
  drainageShare: number;

  /* --------------------------------------------------------- hydrology */
  /** 0 (sheds water) to 1 (collects it), from the topographic wetness index. */
  wetnessRank: number;
  /** Nearest watercourse from anywhere in the zone, metres. */
  minDistanceToWaterM: number;
  meanDistanceToWaterM: number;
  /** Share of the zone within the water buffer. */
  nearWaterShare: number;
  /** Share of the zone that ponds. */
  pondingShare: number;
  /** Catchments the zone spans: more than one means it cannot drain as one. */
  catchments: number;

  /** Phase read from the zone name, or null. */
  phase: number | null;
}

export type ConstraintStatus = 'pass' | 'fail' | 'unevaluable';

export interface ConstraintResult {
  id: string;
  status: ConstraintStatus;
  /** What the rule asks for. */
  requirement: string;
  /** What this zone actually offers. */
  actual: string;
  /** PRD, KMBR, CLIENT or ASSUMPTION. */
  provenance: string;
  /** Set on `unevaluable`: why it cannot be tested from the data held. */
  reason?: string;
}

export interface ScoreFactor {
  key: string;
  label: string;
  /** 0-100 before weighting. */
  value: number;
  weight: number;
  /** What drove the number, for the rationale card. */
  detail: string;
}

/** One zone considered for one use. */
export interface SitingCandidate {
  zoneId: string;
  zoneName: string;
  use: ZoneUse;
  /** True when no hard constraint failed. */
  eligible: boolean;
  constraints: ConstraintResult[];
  /** 0-100, weighted. NaN when the candidate is vetoed. */
  score: number;
  factors: ScoreFactor[];
  /** Constraints that could not be tested; carried into every report. */
  unevaluable: string[];
}

export interface ZoneAllocation {
  zoneId: string;
  zoneName: string;
  use: ZoneUse;
  areaAc: number;
  score: number;
  /**
   * What actually decided the choice: the siting score tempered by how much
   * land the use still needs and how well the zone fits it. A use can score
   * higher and still lose on priority, which is why both are reported.
   */
  priority: number;
  /** Set when the client fixed this zone rather than the engine choosing it. */
  locked: boolean;
  /** The use that came second, and on what — the "alternatives rejected" line. */
  runnerUp: { use: ZoneUse; score: number; priority: number } | null;
  /**
   * Land this zone carries beyond what the use still needed. Zones are
   * allocated whole, so a use smaller than its zone leaves surplus; splitting
   * the zone is zone-editing work, not siting work.
   */
  surplusAc?: number;
  factors: ScoreFactor[];
  constraints: ConstraintResult[];
  unevaluable: string[];
}

export interface UseAllocation {
  use: ZoneUse;
  demandAc: number;
  allocatedAc: number;
  zoneIds: string[];
  /** Positive means the use did not get the land the programme asks for. */
  shortfallAc: number;
}

export interface SitingAlternative {
  id: string;
  label: string;
  /** How this alternative differs from the best one. */
  strategy: string;
  allocations: ZoneAllocation[];
  byUse: UseAllocation[];
  /** Mean siting score across allocated zones, area-weighted. */
  totalScore: number;
  /** Land the programme asks for that no zone carries. */
  totalShortfallAc: number;
  /** Zones no use could legally take. */
  unallocated: { zoneId: string; zoneName: string; areaAc: number; reason: string }[];
  /** Findings about the allocation itself: uses left unserved, oversized zones. */
  notes: string[];
}

export interface SitingResult {
  metrics: ZoneMetrics[];
  candidates: SitingCandidate[];
  alternatives: SitingAlternative[];
  /** Every constraint the engine could not test, deduplicated, for the report. */
  unevaluable: { use: ZoneUse; note: string }[];
}
