import type { MultiPoly, Pt, Ring } from '../geom/types';
import { dist, minAreaRect, multiPolyArea, orientedRect, polyArea, rotatePt } from '../geom/planar';
import { difference, intersect, union } from '../geom/boolean';
import { bufferPolyline, offsetMulti } from '../geom/offset';
import type { Dem } from '../terrain/dem';
import { classifyFall, dominantAspectDeg, drainageChannels, flowAccumulation } from '../terrain/analysis';
import type { FallThresholds } from '../terrain/analysis';
import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import { aspectBand, clientSetbacks, cornerPlotsArePremium, landSplit, roadWidths, sizeVillaPlots } from '../rules/client';
import type { MinSideApplies, PlotSizing } from '../rules/client';
import { subdivisionRules, unbuildableSlopeDeg } from '../rules/kmbr';
import { BALANCED_GOAL, layoutWeightsFor, normaliseGoal } from '../optimise/goal';
import type { NormalGoal, SuperGoal } from '../optimise/goal';

/** The goal this run is optimising for; balanced where the caller set none. */
const goalOf = (input: { goal?: SuperGoal }): NormalGoal =>
  normaliseGoal(input.goal ?? BALANCED_GOAL);
import { gradientLimits, measureGradient, summariseGradients } from '../rules/roadGradient';
import { toRad } from '../units';
import type {
  Facing,
  LayoutMetrics,
  LayoutOption,
  OpenSpaceResult,
  PlotResult,
  RoadResult,
  ScoreBreakdown,
  TerrainSummary,
} from './types';
import { ZoneRaster } from './zoneRaster';
import { checkVillaLayout } from '../rules/villaCompliance';
import { builtWaterMetrics, isWetCell } from '../terrain/water';
import type { WaterModel } from '../terrain/water';

export type RoadDirection = 'contour' | 'north_south' | 'east_west';

export interface VillaGeneratorInput {
  zoneId: string;
  zoneName: string;
  /** Zone polygon, already clipped to the in-scope parcel. */
  zone: MultiPoly;
  dem: Dem;
  kmbr: YamlDoc;
  client: YamlDoc;
  assumptions: YamlDoc;
  /** Programme target for this zone. */
  targetUnits: number;
  householdSize: number;
  /** User-drawn no-go areas, subtracted from the buildable area. */
  noGo?: MultiPoly;
  /** Hydrology, so the layout can be scored on its relationship to water. */
  water?: WaterModel;
  /** The three objectives and their weights. */
  goal?: SuperGoal;
  minSideApplies?: MinSideApplies;
  directions?: RoadDirection[];
  keep?: number;
  /** Set for senior-living zones; changes labels only, the rules are the same. */
  senior?: boolean;
  /**
   * Plinth per dwelling the programme asks for, and the client villa type it
   * belongs to. Without these the layout cannot be checked against the size the
   * client confirmed, only against the plot rules.
   */
  wantedPlinthSft?: number;
  villaTypeName?: string;
}

const SHARE_TOLERANCE = 0.02;
const FLOW_CHANNEL_CELLS = 250;
const OPEN_SPACE_SEED_SLOPE_DEG = 20;
const MIN_ROAD_LENGTH_M = 15;
const CUL_DE_SAC_MAX_LEN_M = 250;

/** One point in the search space: a road grid over the zone. */
interface Candidate {
  direction: RoadDirection;
  angle: number;
  /** Spacing of the plot-serving roads. */
  pitch: number;
  /** Fraction of a pitch the grid is shifted by. */
  phase: number;
  /** Spacing of the cross roads that link the strips. */
  crossPitch: number;
  crossPhase: number;
}

interface CellPlot {
  row: number;
  side: 0 | 1;
  col: number;
}

interface Evaluation {
  candidate: Candidate;
  /** Plot keys that are wholly buildable, in placement order. */
  accepted: CellPlot[];
  roadCells: number;
  plotCells: number;
  openCells: number;
  score: ScoreBreakdown;
  metrics: LayoutMetrics;
}

/**
 * SPEC 6.1. For each road-direction candidate, lay double-loaded strips at a
 * pitch of 2 x plot depth + road width, cut plots along them, and iterate the
 * pitch, phase and cross-road spacing until the 20/30/50 shares come within
 * +/-2 points and the plot count is as close to target as possible without
 * exceeding it. The best option per direction is kept.
 */
export function generateVillaLayouts(input: VillaGeneratorInput): LayoutOption[] {
  const { zone, dem, kmbr, client } = input;
  if (zone.length === 0) return [];

  const slopeLimit = unbuildableSlopeDeg(kmbr);
  const raster = new ZoneRaster(dem, zone, slopeLimit, input.noGo ?? []);
  if (raster.zoneCells === 0) return [];

  const zoneAreaM2 = multiPolyArea(zone);
  const sizing = sizeVillaPlots(client, zoneAreaM2, input.targetUnits, {
    minSideApplies: input.minSideApplies,
  });
  if (sizing.plots <= 0 || sizing.depthM <= 0) return [];

  const widths = roadWidths(client);
  const split = landSplit(client);
  const directions = input.directions ?? ['contour', 'north_south', 'east_west'];

  const options: LayoutOption[] = [];
  for (const direction of directions) {
    const baseAngle = roadAngleFor(direction, dem, zone);
    if (!Number.isFinite(baseAngle)) continue;
    const best = search(raster, sizing, widths, split, input, direction, baseAngle);
    if (!best) continue;
    options.push(buildOption(raster, sizing, widths, split, input, best, zoneAreaM2));
  }

  options.sort((a, b) => b.score.total - a.score.total);
  return options.slice(0, input.keep ?? 3);
}

/** Road bearing in radians, measured counter-clockwise from east. */
function roadAngleFor(direction: RoadDirection, dem: Dem, zone: MultiPoly): number {
  if (direction === 'north_south') return Math.PI / 2;
  if (direction === 'east_west') return 0;
  const aspectBearing = dominantAspectDeg(dem, zone);
  if (!Number.isFinite(aspectBearing)) return 0;
  // Roads along the contours run perpendicular to the dominant aspect.
  return toRad(90 - aspectBearing) + Math.PI / 2;
}

/* --------------------------------------------------------------- the search */

function search(
  raster: ZoneRaster,
  sizing: PlotSizing,
  widths: ReturnType<typeof roadWidths>,
  split: ReturnType<typeof landSplit>,
  input: VillaGeneratorInput,
  direction: RoadDirection,
  baseAngle: number,
): Evaluation | null {
  const basePitch = 2 * sizing.depthM + widths.internalM;
  // Cross roads make up the difference between the strip road share and the
  // client's 20% budget, and give every strip a second connection.
  const stripShare = widths.internalM / basePitch;
  const wantedCross = Math.max(0, split.roads - stripShare);
  const idealCrossPitch = wantedCross > 0.001 ? widths.internalM / wantedCross : 400;

  const angleNudges = direction === 'contour' ? [0, toRad(8), toRad(-8), toRad(16), toRad(-16)] : [0, toRad(4), toRad(-4)];
  const pitchScales = [1, 0.97, 1.03];
  const phases = [0, 0.2, 0.4, 0.6, 0.8];
  const crossScales = [1, 0.8, 1.25, 1.6];

  let best: Evaluation | null = null;
  for (const nudge of angleNudges) {
    for (const scale of pitchScales) {
      for (const phase of phases) {
        for (const crossScale of crossScales) {
          const candidate: Candidate = {
            direction,
            angle: baseAngle + nudge,
            pitch: basePitch * scale,
            phase,
            crossPitch: Math.max(40, idealCrossPitch * crossScale),
            crossPhase: 0.5,
          };
          const evaluation = evaluate(raster, sizing, widths, split, input, candidate);
          if (!evaluation) continue;
          if (!best || evaluation.score.total > best.score.total) best = evaluation;
        }
      }
    }
  }
  return best;
}

/**
 * One search pass, entirely in cell space. Each zone cell is mapped into the
 * road grid's frame and labelled road, plot or open; plots are kept only when
 * every one of their cells is buildable.
 */
function evaluate(
  raster: ZoneRaster,
  sizing: PlotSizing,
  widths: ReturnType<typeof roadWidths>,
  split: ReturnType<typeof landSplit>,
  input: VillaGeneratorInput,
  candidate: Candidate,
): Evaluation | null {
  const frame = gridFrame(raster, candidate);
  const depth = sizing.depthM;
  const width = sizing.widthM;
  const road = widths.internalM;
  const { pitch, crossPitch } = candidate;
  if (pitch < road + 2 * depth - 1e-9) return null;

  const good = new Map<number, number>();
  const bad = new Map<number, number>();
  // Wet and channel cells are tallied in the same pass, so the SEARCH can
  // optimise for water rather than only the winner being measured against it.
  const wetByKey = new Map<number, number>();
  const channelByKey = new Map<number, number>();
  const water = input.water;
  // Terrain, measured while the search runs. Cut and fill are only known once
  // the plots exist, so a search scored on them scores every candidate the
  // same; plot fall and road gradient are both available here and are what
  // actually drive the earthwork.
  const loKey = new Map<number, number>();
  const hiKey = new Map<number, number>();
  const slopeGrid = raster.dem.slopeGrid();
  const aspectGrid = raster.dem.aspectGrid();
  let roadGradeSum = 0;
  let roadGradeCells = 0;
  let roadCells = 0;
  let zoneChannelCells = 0;

  for (let j = 0; j < raster.ny; j++) {
    for (let i = 0; i < raster.nx; i++) {
      const code = raster.at(i, j);
      const inZone = code !== 0;
      const buildable = raster.isUsable(i, j);
      const [u, v] = frame.toLocal(raster.centre(i, j));

      const vv = mod(v, pitch);
      const uu = mod(u, crossPitch);
      const onStrip = vv < road;
      const onCross = uu < road;
      if (onStrip || onCross) {
        if (inZone) {
          roadCells++;
          // The gradient a road actually climbs is the ground's steepest
          // gradient resolved along the road's own direction.
          const gk = (raster.j0 + j) * raster.dem.meta.nx + (raster.i0 + i);
          const slopeDeg = slopeGrid[gk]!;
          const aspectDeg = aspectGrid[gk]!;
          if (Number.isFinite(slopeDeg) && Number.isFinite(aspectDeg)) {
            const roadAngle = onStrip ? candidate.angle : candidate.angle + Math.PI / 2;
            const along = Math.abs(Math.cos((aspectDeg * Math.PI) / 180 - roadAngle));
            roadGradeSum += Math.tan((slopeDeg * Math.PI) / 180) * along;
            roadGradeCells += 1;
          }
        }
        continue;
      }

      // Plot bands sit either side of the strip road.
      const offset = vv - road;
      const side: 0 | 1 = offset < depth ? 0 : 1;
      const within = side === 0 ? offset : offset - depth;
      if (within > depth) continue;

      const row = Math.floor(v / pitch);
      const col = Math.floor(u / width);
      const key = plotKey(row, side, col);
      if (buildable) good.set(key, (good.get(key) ?? 0) + 1);
      else bad.set(key, (bad.get(key) ?? 0) + 1);

      const rl = raster.rl[j * raster.nx + i]!;
      if (Number.isFinite(rl)) {
        const lo = loKey.get(key);
        const hi = hiKey.get(key);
        if (lo === undefined || rl < lo) loKey.set(key, rl);
        if (hi === undefined || rl > hi) hiKey.set(key, rl);
      }

      if (water && inZone) {
        const wk = (raster.j0 + j) * water.nx + (raster.i0 + i);
        if (isWetCell(water, wk)) wetByKey.set(key, (wetByKey.get(key) ?? 0) + 1);
        if (water.distanceToWaterM[wk]! <= raster.cell) {
          zoneChannelCells += 1;
          channelByKey.set(key, (channelByKey.get(key) ?? 0) + 1);
        }
      }
    }
  }

  // A plot must be whole: no cell outside the buildable area, and essentially
  // all of the cells its rectangle should contain.
  const expectedCells = (width * depth) / raster.cellAreaM2;
  const whole: { key: number; cells: number; fall: number; wet: number }[] = [];
  for (const [key, cells] of good) {
    if ((bad.get(key) ?? 0) > 0) continue;
    if (cells < expectedCells * 0.9) continue;
    const lo = loKey.get(key);
    const hi = hiKey.get(key);
    whole.push({
      key,
      cells,
      fall: lo !== undefined && hi !== undefined ? hi - lo : Number.NaN,
      wet: (wetByKey.get(key) ?? 0) / Math.max(1, cells),
    });
  }
  if (whole.length === 0) return null;

  /*
   * Which plots to keep when the grid offers more than the programme wants.
   *
   * This used to be completeness alone, which meant the goal could choose a
   * different grid but never a different plot within one: a terrain-led run
   * kept the same steep plots a space-led run did. The order now follows the
   * goal — space keeps the most complete plots, terrain keeps the flattest,
   * water keeps the driest — so dropping a plot is a decision, not an accident
   * of iteration order.
   */
  const goal = goalOf(input);
  whole.sort((a, b) => {
    const rank = (p: typeof a): number =>
      goal.space * (p.cells / Math.max(1, expectedCells)) +
      goal.terrain * (Number.isFinite(p.fall) ? Math.max(0, 1 - p.fall / 3) : 0.5) +
      goal.water * (1 - p.wet);
    return rank(b) - rank(a) || a.key - b.key;
  });
  const accepted = whole.slice(0, sizing.plots).map(({ key }) => unKey(key));
  const plotCells = whole.slice(0, sizing.plots).reduce((s, w) => s + w.cells, 0);
  const openCells = Math.max(0, raster.zoneCells - roadCells - plotCells);

  const acceptedKeys = whole.slice(0, sizing.plots).map(({ key }) => key);
  let wetOnPlots = 0;
  let channelOnPlots = 0;
  let fallSum = 0;
  let fallCount = 0;
  for (const key of acceptedKeys) {
    wetOnPlots += wetByKey.get(key) ?? 0;
    channelOnPlots += channelByKey.get(key) ?? 0;
    const lo = loKey.get(key);
    const hi = hiKey.get(key);
    if (lo !== undefined && hi !== undefined) {
      fallSum += hi - lo;
      fallCount += 1;
    }
  }
  const hydro = {
    wetPlotShare: plotCells > 0 ? wetOnPlots / plotCells : 0,
    channelsKeptClear: zoneChannelCells > 0 ? 1 - channelOnPlots / zoneChannelCells : 1,
    meanPlotFallM: fallCount > 0 ? fallSum / fallCount : Number.NaN,
    meanRoadGrade: roadGradeCells > 0 ? roadGradeSum / roadGradeCells : 0,
  };

  const metrics = rasterMetrics(raster, sizing, split, input, accepted, roadCells, plotCells, openCells, candidate, hydro);
  return {
    candidate,
    accepted,
    roadCells,
    plotCells,
    openCells,
    metrics,
    score: scoreLayout(metrics, split, goalOf(input)),
  };
}

const plotKey = (row: number, side: 0 | 1, col: number): number =>
  ((row + 2048) << 13) | (side << 12) | (col + 2048);

const unKey = (key: number): CellPlot => ({
  row: (key >> 13) - 2048,
  side: ((key >> 12) & 1) as 0 | 1,
  col: (key & 0xfff) - 2048,
});

const mod = (v: number, m: number): number => ((v % m) + m) % m;

interface GridFrame {
  origin: Pt;
  angle: number;
  toLocal: (p: Pt) => Pt;
  toWorld: (p: Pt) => Pt;
}

function gridFrame(raster: ZoneRaster, candidate: Candidate): GridFrame {
  const origin = raster.centre(0, 0);
  const a = candidate.angle;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const shiftV = candidate.phase * candidate.pitch;
  const shiftU = candidate.crossPhase * candidate.crossPitch;
  return {
    origin,
    angle: a,
    toLocal: (p) => {
      const dx = p[0] - origin[0];
      const dy = p[1] - origin[1];
      return [dx * cos + dy * sin + shiftU, -dx * sin + dy * cos + shiftV];
    },
    toWorld: (p) => {
      const u = p[0] - shiftU;
      const v = p[1] - shiftV;
      return [origin[0] + u * cos - v * sin, origin[1] + u * sin + v * cos];
    },
  };
}

/* ------------------------------------------------------- building an option */

function buildOption(
  raster: ZoneRaster,
  sizing: PlotSizing,
  widths: ReturnType<typeof roadWidths>,
  split: ReturnType<typeof landSplit>,
  input: VillaGeneratorInput,
  evaluation: Evaluation,
  zoneAreaM2: number,
): LayoutOption {
  const { candidate, accepted } = evaluation;
  const frame = gridFrame(raster, candidate);
  const depth = sizing.depthM;
  const width = sizing.widthM;
  const road = widths.internalM;

  const fallThresholds = pick<FallThresholds>(input.assumptions, 'plot_fall_thresholds_m', {
    build_as_drawn: 0.5,
    absorb_in_plinth: 1.0,
    stepped_plinth: 2.0,
    split_level: 3.0,
  });
  const setbacks = clientSetbacks(input.client);
  const footprintAspect = pick<number>(input.client, 'villa_plots.footprint_placeholder.aspect_ratio', 2.5);
  const footprintShare = pick<number>(input.client, 'villa_plots.footprint_placeholder.share_of_plot_area', 0.45);

  /* plots ------------------------------------------------------------------ */
  // The client asks for corner plots to be premium — "larger/optimised, never
  // at the cost of road widths or setbacks". A corner plot is at the end of a
  // run, so the frontage beyond it carries no other plot: it can grow into that
  // land without taking anything from a neighbour, a road or a setback. The
  // ceiling is the client's own aspect band, since a plot at 1:1 is as square
  // as their rule allows.
  const premiumCorners = cornerPlotsArePremium(input.client);
  const band = aspectBand(input.client);
  const maxCornerWidth = premiumCorners ? Math.min(depth / band.min, depth) : width;
  const cornerFlags = cornerFlagsFor(accepted);
  // Which columns each run already holds, so a corner never grows into a
  // neighbour. A corner at the START of a run has its free side below it, not
  // above, and testing the ground alone would not notice the difference.
  // A column a corner grows into is claimed, so two corners either side of a
  // gap in a run cannot both take it.
  const claimed = new Set(accepted.map((cp) => `${cp.row}:${cp.side}:${cp.col}`));
  const cornerGrowth = cornerFlags.map((flag, i) => {
    if (!flag || !premiumCorners || maxCornerWidth <= width) return { width, uShift: 0 };
    const cp = accepted[i]!;
    const grown = growCorner(
      raster,
      frame,
      cp,
      candidate.pitch,
      candidate.crossPitch,
      road,
      depth,
      width,
      maxCornerWidth,
      claimed,
    );
    for (const col of grown.columns) claimed.add(`${cp.row}:${cp.side}:${col}`);
    return grown;
  });

  const plots: PlotResult[] = accepted.map((cp, index) => {
    const grown = cornerGrowth[index] ?? { width, uShift: 0 };
    const w = grown.width;
    const ring = plotRing(frame, cp, candidate.pitch, road, depth, width, w, grown.uShift);
    const terrain = plotTerrain(raster, frame, cp, candidate.pitch, road, depth, w, fallThresholds);
    const fpArea = w * depth * footprintShare;
    const fpWidth = Math.sqrt(fpArea / footprintAspect);
    const footprint = placeFootprint(ring, fpWidth, fpWidth * footprintAspect, setbacks);
    return {
      id: `p${index + 1}`,
      ring,
      areaM2: w * depth,
      widthM: w,
      depthM: depth,
      corner: cornerFlags[index] ?? false,
      facing: facingOf(candidate.angle, cp.side),
      unitsOnPlot: sizing.grouping,
      terrain,
      envelope: offsetMulti([[ring]], -setbacks.sideM),
      footprint,
      footprintAreaM2: fpArea,
      kmbrYardOk: footprint !== null,
      notes: [
        ...(terrain.unsurveyedShare > 0.25 ? ['Mostly unsurveyed ground: levels are low-confidence.'] : []),
        ...(w > width + 1e-6
          ? [`Corner plot widened from ${width.toFixed(2)} m to ${w.toFixed(2)} m (client premium corners, inside the 1:${band.min}–1:${band.max} aspect band).`]
          : []),
      ],
    };
  });

  /* roads ------------------------------------------------------------------ */
  const roads = buildRoads(frame, candidate, input, widths, accepted, width, road);

  /* geometry for drawing and for open space -------------------------------- */
  const buildableGeom = buildableGeometry(raster, input.zone);
  const roadGeom = union(...roads.map((r) => r.geom));
  const plotGeom: MultiPoly = plots.map((p) => [p.ring]);
  const openSpace = buildOpenSpace(raster, input, buildableGeom, roadGeom, plotGeom, split, zoneAreaM2);

  // Earthwork, corners and footprints are only known once the plots exist; the
  // search pass works without them.
  const cutM3 = plots.reduce((s, p) => s + (Number.isFinite(p.terrain.cutM3) ? p.terrain.cutM3 : 0), 0);
  const fillM3 = plots.reduce((s, p) => s + (Number.isFinite(p.terrain.fillM3) ? p.terrain.fillM3 : 0), 0);
  const footprintM2 = plots.reduce((s, p) => s + p.footprintAreaM2, 0);
  // A terrace step of roughly half the plot fall, retained across the plot's width.
  const retainingFaceM2 = plots.reduce(
    (s, p) => s + (Number.isFinite(p.terrain.fall) ? (p.terrain.fall / 2) * p.widthM : 0),
    0,
  );
  const cornerPlots = plots.filter((p) => p.corner).length;
  // How the layout sits on the hydrology. Without a water model the two figures
  // are reported as unknown-but-neutral rather than silently as perfect.
  const hydro = input.water
    ? builtWaterMetrics(input.dem, input.water, input.zone, plots.map((p) => [[p.ring]] as MultiPoly))
    : { wetShare: 0, channelsClear: 1 };
  const goodOrientationShare =
    plots.length > 0 ? plots.filter((p) => p.facing !== 'S').length / plots.length : 0;

  const metrics: LayoutMetrics = {
    ...evaluation.metrics,
    zoneAreaM2,
    cutM3,
    fillM3,
    footprintM2,
    retainingFaceM2,
    cornerPlots,
    goodOrientationShare,
    wetPlotShare: hydro.wetShare,
    channelsKeptClear: hydro.channelsClear,
    coveragePct: evaluation.metrics.saleableAreaM2 > 0 ? (footprintM2 / evaluation.metrics.saleableAreaM2) * 100 : 0,
  };

  const option: LayoutOption = {
    id: `${input.zoneId}-${candidate.direction}-${Math.round(candidate.pitch)}-${candidate.phase}`,
    zoneId: input.zoneId,
    zoneName: input.zoneName,
    kind: 'villa',
    strategy: strategyLabel(candidate, widths.internalM, sizing, input.senior === true),
    plots,
    roads,
    openSpace,
    towers: [],
    blocks: [],
    buildable: buildableGeom,
    metrics,
    score: scoreLayout(metrics, split),
    findings: [],
    warnings: [],
  };
    const gradLimits = gradientLimits(input.assumptions);
  option.findings = checkVillaLayout(option, input.client, input.kmbr, input.assumptions, {
    wantedPlinthSft: input.wantedPlinthSft ?? null,
    villaTypeName: input.villaTypeName ?? null,
    gradients: summariseGradients(
      roads
        .filter((r) => r.centreline.length >= 2)
        .map((r) => measureGradient(input.dem, r.id, r.centreline, gradLimits)),
      gradLimits,
    ),
  });
  return option;
}

function plotRing(
  frame: GridFrame,
  cp: CellPlot,
  pitch: number,
  road: number,
  depth: number,
  moduleWidth: number,
  plotWidth = moduleWidth,
  uShift = 0,
): Ring {
  const vBase = cp.row * pitch + road + cp.side * depth;
  const u0 = cp.col * moduleWidth + uShift;
  return [
    frame.toWorld([u0, vBase]),
    frame.toWorld([u0 + plotWidth, vBase]),
    frame.toWorld([u0 + plotWidth, vBase + depth]),
    frame.toWorld([u0, vBase + depth]),
  ];
}

/** Terrain under one plot, read straight from the raster cells it covers. */
function plotTerrain(
  raster: ZoneRaster,
  frame: GridFrame,
  cp: CellPlot,
  pitch: number,
  road: number,
  depth: number,
  width: number,
  thresholds: FallThresholds,
): TerrainSummary {
  const vBase = cp.row * pitch + road + cp.side * depth;
  const u0 = cp.col * width;
  const values: number[] = [];
  let unsurveyed = 0;
  let total = 0;
  const step = raster.cell / 2;
  for (let v = vBase + step / 2; v < vBase + depth; v += step) {
    for (let u = u0 + step / 2; u < u0 + width; u += step) {
      const world = frame.toWorld([u, v]);
      total++;
      const rl = raster.dem.sample(world);
      if (Number.isFinite(rl)) values.push(rl);
      else unsurveyed++;
    }
  }
  if (values.length === 0) {
    return {
      fall: Number.NaN,
      platformRl: Number.NaN,
      minRl: Number.NaN,
      maxRl: Number.NaN,
      cutM3: 0,
      fillM3: 0,
      unsurveyedShare: 1,
      fallClass: 'unsurveyed',
    };
  }
  values.sort((a, b) => a - b);
  const min = values[0]!;
  const max = values[values.length - 1]!;
  const platform = values[Math.floor(values.length / 2)]!;
  const sampleArea = (width * depth) / Math.max(1, total);
  let cut = 0;
  let fill = 0;
  for (const v of values) {
    const d = v - platform;
    if (d > 0) cut += d * sampleArea;
    else fill += -d * sampleArea;
  }
  return {
    fall: max - min,
    platformRl: platform,
    minRl: min,
    maxRl: max,
    cutM3: cut,
    fillM3: fill,
    unsurveyedShare: total > 0 ? unsurveyed / total : 0,
    fallClass: classifyFall(max - min, thresholds),
  };
}

/**
 * Road geometry: one strip road per row of plots, spanning the plots it serves,
 * plus the cross roads that link the strips. A strip short enough to be a dead
 * end gets a cul-de-sac head at its far end.
 */
function buildRoads(
  frame: GridFrame,
  candidate: Candidate,
  input: VillaGeneratorInput,
  widths: ReturnType<typeof roadWidths>,
  accepted: CellPlot[],
  plotWidth: number,
  road: number,
): RoadResult[] {
  const sub = subdivisionRules(input.kmbr);
  const out: RoadResult[] = [];

  // Extent of each strip, taken from the plots it actually serves.
  const rowExtent = new Map<number, { minCol: number; maxCol: number }>();
  for (const cp of accepted) {
    const e = rowExtent.get(cp.row);
    if (!e) rowExtent.set(cp.row, { minCol: cp.col, maxCol: cp.col });
    else {
      e.minCol = Math.min(e.minCol, cp.col);
      e.maxCol = Math.max(e.maxCol, cp.col);
    }
  }
  if (rowExtent.size === 0) return out;

  let index = 0;
  for (const [row, extent] of [...rowExtent.entries()].sort((a, b) => a[0] - b[0])) {
    const u0 = extent.minCol * plotWidth - road / 2;
    const u1 = (extent.maxCol + 1) * plotWidth + road / 2;
    if (u1 - u0 < MIN_ROAD_LENGTH_M) continue;
    const v = row * candidate.pitch + road / 2;
    const a = frame.toWorld([u0, v]);
    const b = frame.toWorld([u1, v]);
    const geom = intersect(bufferPolyline([a, b], road), input.zone);
    if (geom.length === 0) continue;
    const lengthM = dist(a, b);
    const result: RoadResult = {
      id: `r${index++}`,
      kind: lengthM <= CUL_DE_SAC_MAX_LEN_M ? 'cul_de_sac' : 'internal',
      centreline: [a, b],
      widthM: road,
      geom,
      lengthM,
    };
    if (result.kind === 'cul_de_sac') {
      const head = culDeSacHead(b, candidate.angle, widths.culDeSacSideM, sub.turningSideM);
      const headGeom = intersect(head, input.zone);
      if (headGeom.length > 0) result.headGeom = headGeom;
    }
    out.push(result);
  }

  // Cross roads over the span the strips cover, so no strip is a lone dead end.
  const rows = [...rowExtent.keys()];
  const cols = [...rowExtent.values()];
  const v0 = Math.min(...rows) * candidate.pitch;
  const v1 = (Math.max(...rows) + 1) * candidate.pitch;
  const uMin = Math.min(...cols.map((e) => e.minCol)) * plotWidth;
  const uMax = (Math.max(...cols.map((e) => e.maxCol)) + 1) * plotWidth;
  for (let u = Math.ceil(uMin / candidate.crossPitch) * candidate.crossPitch; u <= uMax; u += candidate.crossPitch) {
    const a = frame.toWorld([u, v0]);
    const b = frame.toWorld([u, v1]);
    const geom = intersect(bufferPolyline([a, b], road), input.zone);
    if (geom.length === 0) continue;
    out.push({
      id: `x${index++}`,
      kind: 'internal',
      centreline: [a, b],
      widthM: road,
      geom,
      lengthM: dist(a, b),
    });
  }

  return out;
}

function culDeSacHead(at: Pt, angle: number, sideM: number, kmbrSideM: number): MultiPoly {
  const side = Math.max(sideM, kmbrSideM);
  return [[orientedRect(at, side, side, angle)]];
}

/** Zone minus the Rule 22 ground, as polygons for drawing and open space. */
function buildableGeometry(raster: ZoneRaster, zone: MultiPoly): MultiPoly {
  if (raster.steepCells === 0) return zone;
  const squares: MultiPoly = [];
  for (let j = 0; j < raster.ny; j++) {
    for (let i = 0; i < raster.nx; i++) {
      if (raster.at(i, j) !== 2) continue;
      const c = raster.centre(i, j);
      const h = raster.cell / 2;
      squares.push([
        [
          [c[0] - h, c[1] - h],
          [c[0] + h, c[1] - h],
          [c[0] + h, c[1] + h],
          [c[0] - h, c[1] + h],
        ],
      ]);
    }
  }
  const steep = union(...squares.map((p) => [p]));
  return difference(zone, steep);
}

function buildOpenSpace(
  raster: ZoneRaster,
  input: VillaGeneratorInput,
  buildable: MultiPoly,
  roadGeom: MultiPoly,
  plotGeom: MultiPoly,
  split: ReturnType<typeof landSplit>,
  zoneAreaM2: number,
): OpenSpaceResult[] {
  const sub = subdivisionRules(input.kmbr);
  const leftovers = difference(buildable, roadGeom, plotGeom);
  const accumulation = flowAccumulation(input.dem);
  const channels = drainageChannels(input.dem, input.zone, accumulation, FLOW_CHANNEL_CELLS);
  const steepish = steepishGround(raster, OPEN_SPACE_SEED_SLOPE_DEG);
  const seeds = union(channels, steepish);

  const out: OpenSpaceResult[] = [];
  const push = (geom: MultiPoly, kind: OpenSpaceResult['kind']): void => {
    for (const poly of geom) {
      const area = polyArea(poly);
      if (area < 4) continue;
      const minWidth = estimateMinWidth([poly]);
      out.push({
        id: `os${out.length + 1}`,
        geom: [poly],
        areaM2: area,
        kind,
        minWidthM: minWidth,
        countsAsRecreation: area >= sub.recreationMinAreaM2 && minWidth >= sub.recreationMinWidthM,
      });
    }
  };

  // Open space is filled first from the ground that should not carry plots:
  // drainage lines and steeper ground. What is left over is topped up.
  const seeded = intersect(seeds, leftovers);
  push(seeded, 'drainage');
  push(difference(leftovers, seeded), 'topup');
  push(difference(input.zone, buildable), 'steep');

  void split;
  void zoneAreaM2;
  return out;
}

function steepishGround(raster: ZoneRaster, slopeDeg: number): MultiPoly {
  const slope = raster.dem.slopeGrid();
  const squares: MultiPoly = [];
  for (let j = 0; j < raster.ny; j++) {
    for (let i = 0; i < raster.nx; i++) {
      if (raster.at(i, j) === 0) continue;
      const s = slope[(raster.j0 + j) * raster.dem.meta.nx + (raster.i0 + i)]!;
      if (!Number.isFinite(s) || s <= slopeDeg) continue;
      const c = raster.centre(i, j);
      const h = raster.cell / 2;
      squares.push([
        [
          [c[0] - h, c[1] - h],
          [c[0] + h, c[1] - h],
          [c[0] + h, c[1] + h],
          [c[0] - h, c[1] + h],
        ],
      ]);
    }
  }
  if (squares.length === 0) return [];
  return union(...squares.map((p) => [p]));
}

/** Roughly the short side of a shape: 4A/P is exact for a long thin rectangle. */
function estimateMinWidth(poly: MultiPoly): number {
  const area = multiPolyArea(poly);
  if (area <= 0) return 0;
  const outer = poly[0]?.[0] ?? [];
  let perimeter = 0;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) perimeter += dist(outer[j]!, outer[i]!);
  return perimeter > 0 ? (4 * area) / perimeter : 0;
}

function placeFootprint(
  plotRing: Ring,
  w: number,
  d: number,
  setbacks: ReturnType<typeof clientSetbacks>,
): Ring | null {
  const rect = minAreaRect(plotRing);
  const availableW = rect.width - 2 * setbacks.sideM;
  const availableD = rect.height - setbacks.frontM - setbacks.rearM;
  if (availableW <= 0.5 || availableD <= 0.5) return null;
  const short = Math.min(w, d);
  const long = Math.max(w, d);
  // Shrink the placeholder rather than break a setback.
  const scale = Math.min(1, availableW / short, availableD / long);
  const centre = rotatePt([0, (setbacks.rearM - setbacks.frontM) / 2], rect.angle);
  return orientedRect(
    [rect.centre[0] + centre[0], rect.centre[1] + centre[1]],
    short * scale,
    long * scale,
    rect.angle,
  );
}

/** Which way a plot faces: away from the road it fronts. */
function facingOf(angle: number, side: 0 | 1): Facing {
  const normal = angle + (side === 0 ? -Math.PI / 2 : Math.PI / 2);
  const nx = Math.cos(normal);
  const ny = Math.sin(normal);
  return Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? 'E' : 'W') : ny > 0 ? 'N' : 'S';
}

/** The ends of each run of plots are corner plots, which the client prices up. */
/**
 * Which accepted plots sit at the end of a run. A run is one side of one strip
 * road; any break in the column sequence is also an end.
 */
function cornerFlagsFor(accepted: CellPlot[]): boolean[] {
  const flags = new Array<boolean>(accepted.length).fill(false);
  const byRun = new Map<string, number[]>();
  accepted.forEach((cp, i) => {
    const runKey = `${cp.row}:${cp.side}`;
    const list = byRun.get(runKey) ?? [];
    list.push(i);
    byRun.set(runKey, list);
  });
  for (const indices of byRun.values()) {
    const sorted = indices.sort((a, b) => accepted[a]!.col - accepted[b]!.col);
    // Any break in the column sequence is also an end.
    for (let n = 0; n < sorted.length; n++) {
      const prev = n > 0 ? accepted[sorted[n - 1]!]!.col : null;
      const next = n < sorted.length - 1 ? accepted[sorted[n + 1]!]!.col : null;
      const col = accepted[sorted[n]!]!.col;
      if (prev === null || prev !== col - 1 || next === null || next !== col + 1) {
        flags[sorted[n]!] = true;
      }
    }
  }
  return flags;
}

/**
 * Widens one corner plot into the frontage beyond the end of its run.
 *
 * The plot keeps its depth and its road frontage line; only the far side moves
 * outward, into land no other plot occupies. Three things stop it:
 *
 *  - a cell that is not usable, so a widened plot still cannot overhang the
 *    zone boundary or Rule 22 ground;
 *  - a cross road, which the plot may not sit on;
 *  - a column another plot holds, or that another corner has already claimed —
 *    checked for every column the growth crosses, not just the first, because a
 *    narrow module against an 18 m depth can grow past more than one.
 *
 * The ceiling is `maxWidth`, the widest the client's own aspect band allows.
 */
function growCorner(
  raster: ZoneRaster,
  frame: GridFrame,
  cp: CellPlot,
  pitch: number,
  crossPitch: number,
  road: number,
  depth: number,
  width: number,
  maxWidth: number,
  claimed: Set<string>,
): { width: number; uShift: number; columns: number[] } {
  const vBase = cp.row * pitch + road + cp.side * depth;
  const u0 = cp.col * width;
  const step = Math.min(raster.cell / 2, width / 4);

  /** Usable ground, clear of any cross road, across the plot's whole depth. */
  const clearAt = (u: number): boolean => {
    if (mod(u, crossPitch) < road) return false;
    for (let v = vBase + step / 2; v < vBase + depth; v += step) {
      if (!raster.isUsableAt(frame.toWorld([u, v]))) return false;
    }
    return true;
  };

  const columnOf = (u: number): number => Math.floor(u / width);
  const free = (col: number): boolean => !claimed.has(`${cp.row}:${cp.side}:${col}`);

  let best = { width, uShift: 0, columns: [] as number[] };
  for (const direction of [1, -1] as const) {
    if (!free(cp.col + direction)) continue;
    let extra = 0;
    const entered = new Set<number>();
    for (;;) {
      const next = extra + step;
      if (width + next > maxWidth + 1e-9) break;
      const edge = direction === 1 ? u0 + width + next : u0 - next;
      const col = columnOf(direction === 1 ? edge - 1e-9 : edge + 1e-9);
      if (col !== cp.col && !free(col)) break;
      if (!clearAt(direction === 1 ? edge - step / 2 : edge + step / 2)) break;
      if (col !== cp.col) entered.add(col);
      extra = next;
    }
    if (extra > 0 && width + extra > best.width) {
      best = {
        width: width + extra,
        uShift: direction === 1 ? 0 : -extra,
        columns: [...entered],
      };
    }
  }
  return best;
}

/* -------------------------------------------------------------- the metrics */

function rasterMetrics(
  raster: ZoneRaster,
  sizing: PlotSizing,
  split: ReturnType<typeof landSplit>,
  input: VillaGeneratorInput,
  accepted: CellPlot[],
  roadCells: number,
  plotCells: number,
  openCells: number,
  candidate: Candidate,
  hydro: { wetPlotShare: number; channelsKeptClear: number; meanPlotFallM: number; meanRoadGrade: number },
): LayoutMetrics {
  const cellArea = raster.cellAreaM2;
  const zoneAreaM2 = raster.zoneAreaM2;
  const roadAreaM2 = roadCells * cellArea;
  const saleableAreaM2 = accepted.length * sizing.widthM * sizing.depthM;
  const openSpaceAreaM2 = Math.max(0, zoneAreaM2 - roadAreaM2 - saleableAreaM2);
  const units = accepted.length * sizing.grouping;
  const goodFacing = facingOf(candidate.angle, 0) !== 'S' ? 1 : 0;
  const goodFacing2 = facingOf(candidate.angle, 1) !== 'S' ? 1 : 0;
  const goodShare =
    accepted.length > 0
      ? (accepted.filter((cp) => (cp.side === 0 ? goodFacing : goodFacing2) === 1).length) / accepted.length
      : 0;

  void openCells;
  void plotCells;

  return {
    zoneAreaM2,
    buildableAreaM2: raster.buildableAreaM2,
    unbuildableAreaM2: raster.steepAreaM2,
    unsurveyedAreaM2: raster.unsurveyedAreaM2,
    roadAreaM2,
    openSpaceAreaM2,
    saleableAreaM2,
    shares: {
      roads: zoneAreaM2 > 0 ? roadAreaM2 / zoneAreaM2 : 0,
      openSpace: zoneAreaM2 > 0 ? openSpaceAreaM2 / zoneAreaM2 : 0,
      saleable: zoneAreaM2 > 0 ? saleableAreaM2 / zoneAreaM2 : 0,
    },
    targetShares: { roads: split.roads, openSpace: split.openSpace, saleable: split.saleable },
    plotCount: accepted.length,
    unitCount: units,
    targetUnits: input.targetUnits,
    towerCount: 0,
    totalFloorAreaM2: 0,
    footprintM2: 0,
    fsiUsed: 0,
    coveragePct: 0,
    cutM3: 0,
    fillM3: 0,
    retainingFaceM2: 0,
    meanPlotFallM: hydro.meanPlotFallM,
    meanRoadGrade: hydro.meanRoadGrade,
    wetPlotShare: hydro.wetPlotShare,
    channelsKeptClear: hydro.channelsKeptClear,
    cornerPlots: 0,
    goodOrientationShare: goodShare,
    populationCapacity: units * input.householdSize,
  };
}

/** SPEC 6.1.10: yield, earthwork, orientation, road share, open space, corners. */
/**
 * Scores one candidate layout against the super goal.
 *
 * The six original factors are unchanged; what the goal decides is how much
 * each one counts, plus a seventh that only matters under a water objective.
 * A space-led goal makes yield dominate, a terrain-led goal makes earthwork
 * dominate, a water-led goal makes keeping off wet ground and leaving the
 * channels open dominate. Same engine, same rules, different emphasis.
 */
export function scoreLayout(
  m: LayoutMetrics,
  split: ReturnType<typeof landSplit>,
  goal: NormalGoal = normaliseGoal(BALANCED_GOAL),
): ScoreBreakdown {
  const ratio = m.targetUnits > 0 ? m.unitCount / m.targetUnits : 0;
  // Going over the programme target is not allowed, so it is punished hard.
  const yieldScore = ratio > 1 ? Math.max(0, 100 - (ratio - 1) * 400) : ratio * 100;

  /*
   * Earthwork is scored on the fall across a plot, not on cut and fill.
   * Cut and fill are only known once the plots have been placed, so a search
   * scored on them scores every candidate identically and the terrain
   * objective does nothing. Plot fall is available at every stage, and it is
   * what the cut and fill follow from.
   */
  /*
   * A linear score clipped at zero is no score at all once the site is past
   * the clip: on this terrain the mean plot fall is over 3 m almost
   * everywhere, so `100 - fall/3 × 100` gave every candidate zero and the
   * objective could not tell them apart. These curves fall away but never
   * saturate, so a flatter option always outranks a steeper one.
   */
  const fall = m.meanPlotFallM;
  const earthwork = Number.isFinite(fall) ? 100 / (1 + fall / 1.5) : 50;
  // 1:16 scores about 62, 1:12 about 55, 1:8 about 44.
  const roadGrade = 100 / (1 + m.meanRoadGrade / 0.08);

  const orientation = m.goodOrientationShare * 100;
  const roadShare = Math.max(0, 100 - (Math.abs(m.shares.roads - split.roads) / SHARE_TOLERANCE) * 50);
  const openSpaceQuality = Math.max(
    0,
    100 - (Math.abs(m.shares.openSpace - split.openSpace) / SHARE_TOLERANCE) * 50,
  );
  const corners = m.plotCount > 0 ? Math.min(100, (m.cornerPlots / m.plotCount) * 400) : 0;

  // Dry plots and open channels, the two things a water-led layout is judged on.
  const water = (1 - m.wetPlotShare) * 60 + m.channelsKeptClear * 40;

  const w = layoutWeightsFor(goal);
  const total =
    yieldScore * w.yield +
    earthwork * w.earthwork +
    orientation * w.orientation +
    roadShare * w.roadShare +
    openSpaceQuality * w.openSpaceQuality +
    corners * w.corners +
    roadGrade * w.roadGrade +
    water * w.water;

  return { yield: yieldScore, earthwork, orientation, roadShare, openSpaceQuality, corners, roadGrade, water, total };
}

function strategyLabel(
  candidate: Candidate,
  roadWidth: number,
  sizing: PlotSizing,
  senior: boolean,
): string {
  const deg = ((candidate.angle * 180) / Math.PI + 360) % 180;
  const dir =
    candidate.direction === 'contour'
      ? `contour-parallel roads (${deg.toFixed(0)}°)`
      : candidate.direction === 'north_south'
        ? 'north–south roads, plots facing E and W'
        : 'east–west roads, plots facing N';
  const housing = sizing.rowHousing
    ? `${sizing.grouping}-unit row ${senior ? 'senior' : 'housing'}`
    : 'detached plots';
  return `${dir}, ${roadWidth} m internal roads, ${housing} at ${sizing.widthM.toFixed(1)} × ${sizing.depthM.toFixed(1)} m`;
}
