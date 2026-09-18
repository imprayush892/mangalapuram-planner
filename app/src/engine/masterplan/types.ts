import type { LayoutOption } from '../generators/types';
import type { ZoneUse } from '../site/level1';
import type { CirculationResult } from './circulation';
import type { ZoneBrief } from './brief';

/** One zone's place in the master plan. */
export interface MasterPlanZone {
  zoneId: string;
  zoneName: string;
  use: ZoneUse;
  useLabel: string;
  areaAc: number;
  brief: ZoneBrief;
  /** Every option the generator returned; the plan draws `chosenIndex`. */
  options: LayoutOption[];
  chosenIndex: number;
  /** Set when nothing could be generated, with the reason stated. */
  empty: string | null;
  elapsedMs: number;
}

export interface MasterPlanTotals {
  villaPlots: number;
  villaUnits: number;
  towers: number;
  flats: number;
  blocks: number;
  /** Plinth of every building drawn, m². */
  builtFootprintM2: number;
  /** Gross floor area of everything drawn, m². */
  builtFloorM2: number;
  dwellings: number;
  population: number;
  internalRoadLengthM: number;
  circulationRoadLengthM: number;
  roadAreaM2: number;
  openSpaceM2: number;
  plannedAreaAc: number;
}

export interface MasterPlan {
  /** Rises on every run, so the UI can tell one plan from the next. */
  runId: number;
  generatedAt: number;
  /** Which siting alternative this plan was built on. */
  sitingLabel: string;
  zones: MasterPlanZone[];
  circulation: CirculationResult;
  totals: MasterPlanTotals;
  /** Honest findings about the plan as a whole. */
  notes: string[];
  elapsedMs: number;
}
