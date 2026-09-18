import type { MultiPoly, Pt, Ring } from '../geom/types';

export type Facing = 'N' | 'E' | 'S' | 'W';

export type RoadKind = 'spine' | 'public' | 'internal' | 'cul_de_sac' | 'fire_lane' | 'access';

export interface TerrainSummary {
  /** max - min RL inside the shape. NaN when wholly unsurveyed. */
  fall: number;
  platformRl: number;
  minRl: number;
  maxRl: number;
  cutM3: number;
  fillM3: number;
  /** Share of the shape's DEM cells that are unsurveyed. */
  unsurveyedShare: number;
  /** Key from assumptions.plot_fall_thresholds_m, or 'over_split_level'. */
  fallClass: string;
}

export interface PlotResult {
  id: string;
  ring: Ring;
  areaM2: number;
  /** Short side (frontage) and long side (depth, perpendicular to the road). */
  widthM: number;
  depthM: number;
  corner: boolean;
  facing: Facing;
  unitsOnPlot: number;
  terrain: TerrainSummary;
  /** Client-setback building envelope. */
  envelope: MultiPoly;
  /** Placeholder villa footprint: 1:2.5 rectangle at 45% of plot area. */
  footprint: Ring | null;
  footprintAreaM2: number;
  /** KMBR yard check for this plot's footprint. */
  kmbrYardOk: boolean;
  notes: string[];
}

export interface RoadResult {
  id: string;
  kind: RoadKind;
  centreline: Pt[];
  widthM: number;
  geom: MultiPoly;
  lengthM: number;
  /** Set on cul-de-sac stubs. */
  headGeom?: MultiPoly;
}

export interface OpenSpaceResult {
  id: string;
  geom: MultiPoly;
  areaM2: number;
  kind: 'steep' | 'drainage' | 'sliver' | 'recreation' | 'topup';
  minWidthM: number;
  countsAsRecreation: boolean;
}

export interface TowerResult {
  id: string;
  ring: Ring;
  centre: Pt;
  plateM2: number;
  lengthM: number;
  depthM: number;
  angleRad: number;
  floors: number;
  heightM: number;
  flats: number;
  cores: number;
  podiumRl: number;
  terrain: TerrainSummary;
  joinedWith: string[];
  notes: string[];
}

export interface BlockResult {
  id: string;
  use: string;
  ring: Ring;
  footprintM2: number;
  floors: number;
  heightM: number;
  builtUpM2: number;
  terrain: TerrainSummary;
  notes: string[];
}

export interface AreaShares {
  roads: number;
  openSpace: number;
  saleable: number;
}

export interface LayoutMetrics {
  zoneAreaM2: number;
  buildableAreaM2: number;
  unbuildableAreaM2: number;
  unsurveyedAreaM2: number;
  roadAreaM2: number;
  openSpaceAreaM2: number;
  saleableAreaM2: number;
  shares: AreaShares;
  targetShares: AreaShares;
  plotCount: number;
  unitCount: number;
  targetUnits: number;
  towerCount: number;
  totalFloorAreaM2: number;
  footprintM2: number;
  fsiUsed: number;
  coveragePct: number;
  cutM3: number;
  fillM3: number;
  retainingFaceM2: number;
  cornerPlots: number;
  goodOrientationShare: number;
  populationCapacity: number;
  /**
   * Mean fall across a plot, metres. Available while the search is running,
   * unlike cut and fill, which are only known once the plots exist — so this
   * is what the terrain objective actually steers on.
   */
  meanPlotFallM: number;
  /**
   * Mean along-road gradient as a rise:run fraction, over the grid's own
   * roads. What "optimise road alignment for cut and fill" is measured by.
   */
  meanRoadGrade: number;
  /** Share of plot land that sits on ground the hydrology says is wet. */
  wetPlotShare: number;
  /** Share of the zone's channel cells left unbuilt, which is what water-led means here. */
  channelsKeptClear: number;
}

export interface ScoreBreakdown {
  yield: number;
  earthwork: number;
  orientation: number;
  roadShare: number;
  openSpaceQuality: number;
  corners: number;
  /** How flat the grid's own roads run. */
  roadGrade: number;
  /** How well the layout keeps off wet ground and leaves the channels open. */
  water: number;
  total: number;
}

export type LayoutKind = 'villa' | 'tower' | 'block';

export interface LayoutOption {
  id: string;
  zoneId: string;
  zoneName: string;
  kind: LayoutKind;
  /** Short human label: "contour-parallel, 6 m roads" etc. */
  strategy: string;
  plots: PlotResult[];
  roads: RoadResult[];
  openSpace: OpenSpaceResult[];
  towers: TowerResult[];
  blocks: BlockResult[];
  buildable: MultiPoly;
  metrics: LayoutMetrics;
  score: ScoreBreakdown;
  /** Populated by engine/rules/compliance. */
  findings: import('../rules/findings').Finding[];
  warnings: string[];
}
