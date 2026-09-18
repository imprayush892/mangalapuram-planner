/**
 * One optimisation goal, three objectives.
 *
 * Space efficiency, terrain response and water response are not three planning
 * modes to pick between. They are three objectives the same engine pursues at
 * once, and the user sets how much each one counts. Every place the engine
 * makes a choice — which use goes in which zone, which road grid to lay, where
 * to route a collector, whether ground is buildable at all — reads its weights
 * from here, so moving one slider moves the whole plan coherently rather than
 * switching it into a different mode.
 *
 * The weights are relative and always normalised, so 2/1/1 and 200/100/100 are
 * the same goal. Setting one to zero does not disable the objective's rules —
 * KMBR and the client rules still apply — it only stops that objective
 * influencing which of several legal answers wins.
 */

export interface SuperGoal {
  /** Fit the programme into the land. */
  space: number;
  /** Work with the ground: least cut and fill. */
  terrain: number;
  /** Organise around water: hydrology leads. */
  water: number;
}

export const BALANCED_GOAL: SuperGoal = { space: 1, terrain: 1, water: 1 };

export interface NormalGoal extends SuperGoal {
  /** True where one objective holds at least half the total weight. */
  dominant: keyof SuperGoal | null;
  label: string;
}

export function normaliseGoal(goal: SuperGoal): NormalGoal {
  const raw = {
    space: Math.max(0, goal.space),
    terrain: Math.max(0, goal.terrain),
    water: Math.max(0, goal.water),
  };
  const total = raw.space + raw.terrain + raw.water;
  // All three at zero is not a goal; fall back to balanced rather than
  // silently scoring everything the same.
  if (total <= 0) return { ...BALANCED_GOAL, space: 1 / 3, terrain: 1 / 3, water: 1 / 3, dominant: null, label: 'Balanced' };

  const n = { space: raw.space / total, terrain: raw.terrain / total, water: raw.water / total };
  const entries = Object.entries(n) as [keyof SuperGoal, number][];
  entries.sort((a, b) => b[1] - a[1]);
  const [topKey, topValue] = entries[0]!;
  const dominant = topValue >= 0.5 ? topKey : null;

  const label =
    dominant === 'space'
      ? 'Space-led'
      : dominant === 'terrain'
        ? 'Terrain-led'
        : dominant === 'water'
          ? 'Water-led'
          : Math.abs(n.space - n.terrain) < 0.08 && Math.abs(n.terrain - n.water) < 0.08
            ? 'Balanced'
            : `${Math.round(n.space * 100)}/${Math.round(n.terrain * 100)}/${Math.round(n.water * 100)}`;

  return { ...n, dominant, label };
}

/* ------------------------------------------------ what each objective buys */

/**
 * Weights for choosing which use goes in which zone.
 *
 * The seven PRD factors are held, and the goal redistributes emphasis between
 * them: space pushes buildable area and phase order, terrain pushes earthwork
 * and gentle ground, water pushes drainage and the use's own relationship to
 * water. Access and adjacency matter under every goal, so they keep a floor.
 */
export interface SitingWeights {
  buildableArea: number;
  earthwork: number;
  accessFrontage: number;
  adjacency: number;
  viewElevation: number;
  drainageRisk: number;
  phaseOrder: number;
  /** New under a water goal: how well the use suits its position on the water network. */
  waterFit: number;
}

export function sitingWeightsFor(goal: NormalGoal, base: SitingWeights): SitingWeights {
  const { space, terrain, water } = goal;
  // A multiplier of 1 leaves the configured weight alone; the objectives push
  // it up or down around that, never below a third of it.
  const lift = (share: number): number => 0.35 + 1.95 * share;
  return {
    buildableArea: base.buildableArea * lift(space),
    earthwork: base.earthwork * lift(terrain),
    accessFrontage: base.accessFrontage * (0.7 + 0.6 * space),
    adjacency: base.adjacency,
    viewElevation: base.viewElevation * (0.6 + 0.8 * Math.max(space, water)),
    drainageRisk: base.drainageRisk * lift(water),
    phaseOrder: base.phaseOrder * (0.5 + space),
    waterFit: base.waterFit * (water * 3),
  };
}

/**
 * Weights for choosing one zone's internal layout.
 *
 * Yield is what space efficiency means inside a zone; earthwork is what terrain
 * response means; the water term keeps plots off wet ground and lets open space
 * follow the channels.
 */
export interface LayoutWeights {
  yield: number;
  earthwork: number;
  orientation: number;
  roadShare: number;
  openSpaceQuality: number;
  corners: number;
  /** How flat the zone's own roads run: the other half of terrain response. */
  roadGrade: number;
  water: number;
}

export function layoutWeightsFor(goal: NormalGoal): LayoutWeights {
  const { space, terrain, water } = goal;
  const w: LayoutWeights = {
    yield: 0.20 + 0.45 * space,
    // Terrain response is two things in equal measure: how flat the plots sit,
    // and how flat the roads run. Weighting only the first optimises platforms
    // while letting the streets climb.
    earthwork: 0.10 + 0.30 * terrain,
    roadGrade: 0.04 + 0.26 * terrain,
    orientation: 0.10,
    roadShare: 0.08,
    openSpaceQuality: 0.08 + 0.12 * water,
    corners: 0.04,
    water: 0.45 * water,
  };
  const total = Object.values(w).reduce((s, v) => s + v, 0);
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / total])) as unknown as LayoutWeights;
}

/* -------------------------------------------------- what the goal changes */

export interface GoalSettings {
  /**
   * Metres of detour a road will take to avoid a metre of climb. Terrain
   * response is mostly this number.
   */
  routeGradePenaltyM: number;
  /** Metres of detour to avoid crossing a watercourse. */
  routeWaterPenaltyM: number;
  /** No-build strip either side of a watercourse. */
  waterBufferM: number;
  /** Ground that ponds is kept out of the buildable area above this weight. */
  excludePonding: boolean;
  /**
   * Road directions worth searching. A terrain-led plan searches contour
   * alignments hardest, because that is where the cut and fill is won.
   */
  preferContourRoads: boolean;
  /** Extra candidate grids to search per direction, as a multiplier. */
  searchEffort: number;
}

export function settingsFor(
  goal: NormalGoal,
  base: { routeGradePenaltyM: number; waterBufferM: number },
): GoalSettings {
  return {
    // At a pure space goal a road still avoids a cliff, but it will not detour
    // far for a gentler grade; at a pure terrain goal it will detour a long way.
    routeGradePenaltyM: base.routeGradePenaltyM * (0.25 + 2.25 * goal.terrain),
    routeWaterPenaltyM: 120 * goal.water,
    waterBufferM: base.waterBufferM * (0.2 + 2.4 * goal.water),
    excludePonding: goal.water >= 0.4,
    preferContourRoads: goal.terrain >= 0.4,
    searchEffort: 1 + 1.5 * Math.max(goal.terrain, goal.water),
  };
}

/** One line per objective, for the panel that has to explain what changed. */
export function goalExplanation(goal: NormalGoal, settings: GoalSettings): string[] {
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  return [
    `Space ${pct(goal.space)} — buildable area and phase order carry more of the siting score; zones are filled harder.`,
    `Terrain ${pct(goal.terrain)} — earthwork carries more of every score, and a road will detour ${settings.routeGradePenaltyM.toFixed(0)} m to avoid a metre of climb${settings.preferContourRoads ? '; contour-parallel grids are searched hardest' : ''}.`,
    `Water ${pct(goal.water)} — a ${settings.waterBufferM.toFixed(0)} m strip either side of every watercourse is kept clear${settings.excludePonding ? ', ground that ponds is taken out of the buildable area' : ''}, and each use is scored on how well it suits its position on the water network.`,
  ];
}
