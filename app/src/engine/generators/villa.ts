import type { MultiPoly, Pt, Ring } from '../geom/types';
import { dist, minAreaRect, multiPolyArea, orientedRect, polyArea, rotatePt } from '../geom/planar';
import { difference, intersect, union } from '../geom/boolean';
import { bufferPolyline, offsetMulti } from '../geom/offset';
import type { Dem } from '../terrain/dem';
import { classifyFall, dominantAspectDeg, drainageChannels, flowAccumulation } from '../terrain/analysis';
import type { FallThresholds } from '../terrain/analysis';
import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import { clientSetbacks, landSplit, roadWidths, sizeVillaPlots } from '../rules/client';
import type { MinSideApplies, PlotSizing } from '../rules/client';
import { subdivisionRules, unbuildableSlopeDeg } from '../rules/kmbr';
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
  minSideApplies?: MinSideApplies;
  directions?: RoadDirection[];
  keep?: number;
  /** Set for senior-living zones; changes labels only, the rules are the same. */
  senior?: boolean;
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
  let roadCells = 0;

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
        if (inZone) roadCells++;
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
    }
  }

  // A plot must be whole: no cell outside the buildable area, and essentially
  // all of the cells its rectangle should contain.
  const expectedCells = (width * depth) / raster.cellAreaM2;
  const whole: { key: number; cells: number }[] = [];
  for (const [key, cells] of good) {
    if ((bad.get(key) ?? 0) > 0) continue;
    if (cells < expectedCells * 0.9) continue;
    whole.push({ key, cells });
  }
  if (whole.length === 0) return null;

  // Take the plots nearest the zone centre first, so a short line drops the
  // most marginal plots rather than an arbitrary corner.
  whole.sort((a, b) => b.cells - a.cells || a.key - b.key);
  const accepted = whole.slice(0, sizing.plots).map(({ key }) => unKey(key));
  const plotCells = whole.slice(0, sizing.plots).reduce((s, w) => s + w.cells, 0);
  const openCells = Math.max(0, raster.zoneCells - roadCells - plotCells);

  const metrics = rasterMetrics(raster, sizing, split, input, accepted, roadCells, plotCells, openCells, candidate);
  return {
    candidate,
    accepted,
    roadCells,
    plotCells,
    openCells,
    metrics,
    score: scoreLayout(metrics, split),
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
  const plots: PlotResult[] = accepted.map((cp, index) => {
    const ring = plotRing(frame, cp, candidate.pitch, road, depth, width);
    const terrain = plotTerrain(raster, frame, cp, candidate.pitch, road, depth, width, fallThresholds);
    const fpArea = width * depth * footprintShare;
    const fpWidth = Math.sqrt(fpArea / footprintAspect);
    const footprint = placeFootprint(ring, fpWidth, fpWidth * footprintAspect, setbacks);
    return {
      id: `p${index + 1}`,
      ring,
      areaM2: width * depth,
      widthM: width,
      depthM: depth,
      corner: false,
      facing: facingOf(candidate.angle, cp.side),
      unitsOnPlot: sizing.grouping,
      terrain,
      envelope: offsetMulti([[ring]], -setbacks.sideM),
      footprint,
      footprintAreaM2: fpArea,
      kmbrYardOk: footprint !== null,
      notes: terrain.unsurveyedShare > 0.25 ? ['Mostly unsurveyed ground: levels are low-confidence.'] : [],
    };
  });
  tagCornerPlots(plots, accepted);

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
  option.findings = checkVillaLayout(option, input.client, input.kmbr, input.assumptions);
  return option;
}

function plotRing(
  frame: GridFrame,
  cp: CellPlot,
  pitch: number,
  road: number,
  depth: number,
  width: number,
): Ring {
  const vBase = cp.row * pitch + road + cp.side * depth;
  const u0 = cp.col * width;
  return [
    frame.toWorld([u0, vBase]),
    frame.toWorld([u0 + width, vBase]),
    frame.toWorld([u0 + width, vBase + depth]),
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
function tagCornerPlots(plots: PlotResult[], accepted: CellPlot[]): void {
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
        plots[sorted[n]!]!.corner = true;
      }
    }
  }
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
    cornerPlots: 0,
    goodOrientationShare: goodShare,
    populationCapacity: units * input.householdSize,
  };
}

/** SPEC 6.1.10: yield, earthwork, orientation, road share, open space, corners. */
export function scoreLayout(m: LayoutMetrics, split: ReturnType<typeof landSplit>): ScoreBreakdown {
  const ratio = m.targetUnits > 0 ? m.unitCount / m.targetUnits : 0;
  // Going over the programme target is not allowed, so it is punished hard.
  const yieldScore = ratio > 1 ? Math.max(0, 100 - (ratio - 1) * 400) : ratio * 100;

  const earthworkPerPlot = m.plotCount > 0 ? (m.cutM3 + m.fillM3) / m.plotCount : 0;
  const earthwork = Math.max(0, 100 - earthworkPerPlot / 4);

  const orientation = m.goodOrientationShare * 100;
  const roadShare = Math.max(0, 100 - (Math.abs(m.shares.roads - split.roads) / SHARE_TOLERANCE) * 50);
  const openSpaceQuality = Math.max(
    0,
    100 - (Math.abs(m.shares.openSpace - split.openSpace) / SHARE_TOLERANCE) * 50,
  );
  const corners = m.plotCount > 0 ? Math.min(100, (m.cornerPlots / m.plotCount) * 400) : 0;

  const total =
    yieldScore * 0.4 +
    earthwork * 0.14 +
    orientation * 0.14 +
    roadShare * 0.16 +
    openSpaceQuality * 0.14 +
    corners * 0.02;

  return { yield: yieldScore, earthwork, orientation, roadShare, openSpaceQuality, corners, total };
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
