import type { Dem } from '../terrain/dem';
import type { MultiPoly } from '../geom/types';
import type { SiteFeature } from '../site/types';
import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import { roadFromEdge } from '../geom/offset';
import { hydrologyParams, stormFor, stormRunoffCoeff, waterModelFor } from '../terrain/hydrology';
import type { StormResult } from '../terrain/hydrology';
import { unbuildableSlopeDeg } from '../rules/kmbr';
import type { Mask } from './mask';
import { and, areaM2, dilate, dropSmall, maskFrom, minus, openToWidth, or, patches, rasterise, toMulti } from './mask';

/**
 * Planning steps 1-7: from the terrain to the land that can take plots.
 *
 *   1 terrain          the DEM from the terrain mesh, inside the parcel
 *   2 hydrology        the planning storm, routed and flooded at its peak
 *   3 waterlogging     ground under water at the peak -> the rest is safe to build
 *   4 public space     waterlogging + non-buildable slope + land too narrow to plot
 *   5 slope            every cell classed against 1:5 and 1:4
 *   6 non-buildable    steeper than 1:4
 *   7 plotable         safe, not steep, off the existing roads, and wide enough for a plot
 *
 * Every layer is a mask on the DEM grid plus its outline, and carries the
 * reasons it is what it is: the rule, the number, the file it came from. Each
 * is derived from the ones before it; nothing is drawn by hand.
 */

export type LayerId =
  | 'terrain'
  | 'flowPaths'
  | 'waterlogging'
  | 'safe'
  | 'moderateSlope'
  | 'nonBuildable'
  | 'drains'
  | 'existingRoads'
  | 'residual'
  | 'publicSpace'
  | 'plotable';

export interface PlanningLayer {
  id: LayerId;
  step: number;
  title: string;
  mask: Mask;
  geom: MultiPoly;
  areaM2: number;
  /** Share of the in-scope parcel. */
  share: number;
  /** Separate pieces. */
  pieces: number;
  why: string[];
}

export interface AnalysisInput {
  dem: Dem;
  parcel: MultiPoly;
  features: SiteFeature[];
  /** 1 where a survey point stands behind the level; null for a survey-only DEM. */
  measured: Uint8Array | null;
  /** Slope in degrees of the raw survey TIN per cell; null when not supplied. */
  surveySlopeDeg: Float32Array | null;
  planning: YamlDoc;
  assumptions: YamlDoc;
  client: YamlDoc;
  kmbr: YamlDoc;
}

/** One KMBR Rule 22 condition and how the plan answers it. */
export interface Rule22Check {
  clause: string;
  condition: string;
  status: 'applied' | 'no data';
  how: string;
}

export interface AnalysisResult {
  layers: Record<LayerId, PlanningLayer>;
  /** Display order, earliest step first. */
  order: LayerId[];
  parcelAreaM2: number;
  storm: StormResult;
  stormMm: number;
  /** Slope per cell as rise/run (0.25 = 1:4); NaN off the DEM. */
  gradient: Float32Array;
  /** Slopes as rise/run: non-buildable over this, plots at most plotMax. */
  limits: { nonBuildable: number; nonBuildableLabel: string; plotMax: number };
  rule22: Rule22Check[];
  /** The waterlogging the plan counts, and what it ignores, with the water in each (at the peak). */
  water: {
    counted: { areaM2: number; volumeM3: number; meanDepthM: number };
    ignoredChannels: { areaM2: number; volumeM3: number; widthM: number };
    ignoredPatches: { areaM2: number; volumeM3: number; underM2: number };
  };
  ms: number;
}

/** "1:4" -> 0.25. Throws on anything else, so a typo is not read as flat. */
export function parseRatio(v: unknown, what: string): number {
  if (typeof v === 'number' && v > 0) return v;
  const m = typeof v === 'string' ? /^\s*1\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(v) : null;
  if (!m) throw new Error(`${what}: expected a slope like "1:4", got ${JSON.stringify(v)}`);
  return 1 / Number(m[1]);
}

const need = (doc: YamlDoc, path: string, what: string): number => {
  const v = pick<unknown>(doc, path, undefined);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`config/${what} ${path} is missing; add it rather than letting the engine guess`);
  }
  return v;
};

const ratioText = (r: number): string => `1:${(1 / r).toFixed(r >= 1 ? 2 : 0)}`;
const ha = (m2: number): string => `${(m2 / 1e4).toFixed(2)} ha`;
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function runAnalysis(input: AnalysisInput): AnalysisResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { dem, planning } = input;

  /* ------------------------------------------------------------ 1 terrain */
  const parcel = and(rasterise(dem, input.parcel), maskFrom(dem, (k) => Number.isFinite(dem.values[k]!)));
  const parcelArea = areaM2(dem, parcel);
  const measuredInParcel = input.measured ? and(parcel, input.measured) : parcel;

  /* ---------------------------------------------------------- 2 hydrology */
  const stormMm = need(planning, 'hydrology.planning_storm_mm', 'planning_rules.yaml');
  const minDepth = need(planning, 'hydrology.waterlogging_min_depth_m', 'planning_rules.yaml');
  const offset = need(planning, 'hydrology.building_offset_from_waterlogging_m', 'planning_rules.yaml');
  const minWaterPatch = need(planning, 'hydrology.min_waterlogging_patch_m2', 'planning_rules.yaml');
  const narrowChannel = need(planning, 'hydrology.ignore_channels_narrower_than_m', 'planning_rules.yaml');
  const hp = hydrologyParams(input.assumptions);
  const model = waterModelFor(dem, input.features, hp.pondingDepthM);
  const c = stormRunoffCoeff(hp, stormMm);
  const storm = stormFor(dem, model, hp, stormMm, c);

  const flowPaths = and(parcel, storm.channel);
  /* ------------------------------------------------------- 3 waterlogging */
  // Owner, 25 Sep: water running in channels narrower than `narrowChannel` goes
  // to the storm drains, and fragments under `minWaterPatch` are ignored, so the
  // land either side joins up into one usable piece. The ponds stay.
  const wetRaw = and(parcel, maskFrom(dem, (k) => storm.peakDepthM[k]! >= minDepth));
  const wetOpen = narrowChannel > 0 ? openToWidth(dem, wetRaw, narrowChannel) : wetRaw;
  const wet = dropSmall(dem, wetOpen, minWaterPatch);
  const vol = (m: Mask): number => {
    let v = 0;
    for (let k = 0; k < m.length; k += 1) if (m[k]) v += storm.peakDepthM[k]! * dem.cell * dem.cell;
    return v;
  };
  const keepClear = offset > 0 ? and(parcel, dilate(dem, wet, offset)) : wet;
  const safe = minus(parcel, keepClear);

  /* --------------------------------------------------------- 5 / 6 slope */
  // Rule 22 by default; the owner's 1:4 limit can be switched back on in the rules file.
  const nbRule = pick<unknown>(planning, 'slope.non_buildable', 'kmbr_rule22');
  const rule22Deg = unbuildableSlopeDeg(input.kmbr);
  const fromRule22 = nbRule === 'kmbr_rule22';
  const nonBuildableRatio = fromRule22 ? Math.tan((rule22Deg * Math.PI) / 180) : parseRatio(nbRule, 'slope.non_buildable');
  const nonBuildableLabel = fromRule22
    ? `over ${rule22Deg}° (KMBR Rule 22(3))`
    : `steeper than ${ratioText(nonBuildableRatio)} (planning_rules.yaml slope.non_buildable)`;
  const plotMaxRatio = parseRatio(pick(planning, 'slope.plot_max', null), 'slope.plot_max');
  const minSteepPatch = need(planning, 'slope.min_non_buildable_patch_m2', 'planning_rules.yaml');
  const slopeDeg = dem.slopeGrid();
  const gradient = new Float32Array(slopeDeg.length);
  for (let k = 0; k < gradient.length; k += 1) {
    const s = slopeDeg[k]!;
    gradient[k] = Number.isFinite(s) ? Math.tan((s * Math.PI) / 180) : Number.NaN;
  }
  // Too steep on the terrain mesh OR on the raw survey: the mesh is smoothed
  // and flattens faces the survey measured as over the limit, and a statutory
  // limit is not relaxed by smoothing.
  const nbDeg = (Math.atan(nonBuildableRatio) * 180) / Math.PI;
  const survey = input.surveySlopeDeg;
  const steepMesh = and(parcel, maskFrom(dem, (k) => gradient[k]! > nonBuildableRatio));
  const steepSurvey = survey ? and(parcel, maskFrom(dem, (k) => survey[k]! > nbDeg)) : maskFrom(dem, () => false);
  const steepRaw = or(steepMesh, steepSurvey);
  const steep = dropSmall(dem, steepRaw, minSteepPatch);
  const moderate = minus(
    and(parcel, maskFrom(dem, (k) => gradient[k]! > plotMaxRatio && gradient[k]! <= nonBuildableRatio)),
    steep,
  );

  /* ------------------------------------------------------ existing roads */
  const roadWidth = pick<number>(input.client, 'roads.public.width_m', Number.NaN);
  if (!Number.isFinite(roadWidth)) throw new Error('config/client_rules.yaml roads.public.width_m is missing');
  let roads: Mask = maskFrom(dem, () => false);
  let roadLines = 0;
  for (const f of input.features) {
    if (f.kind !== 'existing_road_edge') continue;
    for (const line of f.lines) {
      if (line.length < 2) continue;
      roads = or(roads, rasterise(dem, roadFromEdge(line, roadWidth)));
      roadLines += 1;
    }
  }
  roads = and(roads, parcel);

  /* ------------------------------------------- natural drains, Rule 22(4) */
  // The survey's drains and pond edges, cell by cell along the line: kept
  // clear of building. Their flooded width is already in the waterlogging.
  let drains: Mask = maskFrom(dem, () => false);
  let drainLength = 0;
  for (const f of input.features) {
    if (f.kind !== 'drain' && f.kind !== 'pond_edge') continue;
    for (const line of f.lines) {
      for (let a = 1; a < line.length; a += 1) {
        const p = line[a - 1]!;
        const q = line[a]!;
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        drainLength += len;
        const steps = Math.max(1, Math.ceil(len / (dem.cell / 2)));
        for (let s = 0; s <= steps; s += 1) {
          const c = dem.cellAt([p[0] + ((q[0] - p[0]) * s) / steps, p[1] + ((q[1] - p[1]) * s) / steps]);
          if (c) drains[c.j * dem.meta.nx + c.i] = 1;
        }
      }
    }
  }
  drains = and(drains, parcel);

  /* ----------------------------------------------------------- 7 plotable */
  const minWidth = need(planning, 'plotable.min_width_m', 'planning_rules.yaml');
  const minArea = need(planning, 'plotable.min_area_m2', 'planning_rules.yaml');
  const candidate = minus(parcel, keepClear, steep, drains, roads);
  const plotable = dropSmall(dem, openToWidth(dem, candidate, minWidth), minArea);
  const residual = minus(candidate, plotable);

  /* ------------------------------------------------------ 4 public space */
  const publicSpace = or(wet, steep, drains, residual);

  /* -------------------------------------------------------------- layers */
  const cellArea = dem.cell * dem.cell;
  const make = (id: LayerId, step: number, title: string, mask: Mask, why: string[]): PlanningLayer => {
    const a = areaM2(dem, mask);
    return {
      id,
      step,
      title,
      mask,
      // Areas are drawn without the 2 m staircase; one-cell lines stay as traced.
      geom: toMulti(dem, mask, id !== 'flowPaths' && id !== 'drains'),
      areaM2: a,
      share: parcelArea > 0 ? a / parcelArea : 0,
      pieces: patches(dem, mask).length,
      why,
    };
  };

  const measuredShare = parcelArea > 0 ? areaM2(dem, measuredInParcel) / parcelArea : 0;
  const plotablePieces = patches(dem, plotable);
  const largest = plotablePieces.reduce((m, p) => Math.max(m, p.length), 0) * cellArea;
  const lostNarrow = areaM2(dem, residual);
  const wetOnSteep = areaM2(dem, and(wet, steep));

  const layers: Record<LayerId, PlanningLayer> = {
    terrain: make('terrain', 1, 'Terrain in the parcel', parcel, [
      `the 2 m grid from the terrain mesh (${dem.meta.source})`,
      `${pct(measuredShare)} of it has a survey point within 5 m; the rest is the modeller's surface, flagged in 3D`,
    ]),
    flowPaths: make('flowPaths', 2, 'Flow paths in the planning storm', flowPaths, [
      `${stormMm} mm in 24 h (planning_rules.yaml hydrology.planning_storm_mm), runoff coefficient ${c.toFixed(2)} (CWC/RBF-16 formula)`,
      `a path is drawn where the storm's mean flow reaches ${hp.channelFlowLps} L/s (assumptions.yaml hydrology.channel_flow_lps)`,
      `peak flow leaving the site ${storm.peakOutflowM3s.toFixed(1)} m³/s`,
    ]),
    waterlogging: make('waterlogging', 3, 'Waterlogging', wet, [
      `under at least ${minDepth} m of water at the peak of the ${stormMm} mm storm: ponds risen over their rims and water running in the swales`,
      `${storm.pondsFull} of ${storm.pondsTotal} ponds fill to the rim`,
      `${ha(areaM2(dem, minus(wetRaw, wet)))} of it ignored: channels narrower than ${narrowChannel} m (carried in the storm drains) and patches under ${minWaterPatch} m² (planning_rules.yaml hydrology, owner 25 Sep)`,
      offset > 0
        ? `building kept ${offset} m clear of it (planning_rules.yaml hydrology.building_offset_from_waterlogging_m)`
        : 'no extra building offset set (planning_rules.yaml hydrology.building_offset_from_waterlogging_m = 0)',
    ]),
    safe: make('safe', 3, 'Safe from water', safe, [
      'the parcel less the waterlogged ground' + (offset > 0 ? ` and a ${offset} m margin round it` : ''),
    ]),
    moderateSlope: make('moderateSlope', 5, `Slope over ${ratioText(plotMaxRatio)}, buildable`, moderate, [
      `steeper than the ${ratioText(plotMaxRatio)} a plot may have (planning_rules.yaml slope.plot_max), but not ${nonBuildableLabel}`,
      'plots here need cut and fill to reach a platform; step 11 sizes it',
    ]),
    nonBuildable: make(
      'nonBuildable',
      6,
      `Non-buildable slope: ${fromRule22 ? `over ${rule22Deg}°` : `steeper than ${ratioText(nonBuildableRatio)}`}`,
      steep,
      [
        `slope ${nonBuildableLabel}, a ${(nonBuildableRatio * 100).toFixed(0)}% gradient`,
        `${ha(areaM2(dem, steepSurvey))} from the raw survey TIN (15-Sept, facet slope), ${ha(areaM2(dem, steepMesh))} from the terrain mesh; the mesh is smoothed and flattens the steepest faces, so both count`,
        minSteepPatch > 0
          ? `specks under ${minSteepPatch} m² ignored and left to plot-level cut and fill (${ha(areaM2(dem, minus(steepRaw, steep)))} of them; owner 25 Sep)`
          : 'every cell over the limit counts: it is a statutory limit',
        'goes to the public-space network as landscape',
      ],
    ),
    drains: make('drains', 6, 'Natural drains (Rule 22(4))', drains, [
      `${drainLength.toFixed(0)} m of surveyed drain and pond edge (site_features.geojson DR, POND)`,
      'KMBR Rule 22(4): no construction may obstruct natural drains and streams; kept in the public space',
    ]),
    existingRoads: make('existingRoads', 7, 'Existing roads (fixed)', roads, [
      `${roadLines} built road edges held at ${roadWidth} m (client_rules.yaml roads.public); fixed, never moved`,
    ]),
    residual: make('residual', 7, 'Too narrow or small to plot', residual, [
      `safe, buildable ground a ${minWidth} m plot cannot reach (planning_rules.yaml plotable.min_width_m), or a patch under ${minArea} m²`,
      'joins the public-space network as green links and buffers',
    ]),
    publicSpace: make('publicSpace', 4, 'Public-space network', publicSpace, [
      `waterlogging ${ha(areaM2(dem, wet))} (may overlap: landscape, recreation, ecological infrastructure)`,
      `non-buildable slope ${ha(areaM2(dem, steep))}` + (wetOnSteep > 0 ? `, of which ${ha(wetOnSteep)} is also waterlogged` : ''),
      `natural drains ${ha(areaM2(dem, drains))} (Rule 22(4))`,
      `land too narrow or small to plot ${ha(lostNarrow)}`,
    ]),
    plotable: make('plotable', 7, 'Plotable zones', plotable, [
      `safe from water, not ${nonBuildableLabel}, clear of the natural drains, off the existing roads`,
      `every part reachable by a ${minWidth} m wide plot; pieces under ${minArea} m² dropped`,
      `${plotablePieces.length} zones, the largest ${ha(largest)}`,
    ]),
  };

  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return {
    layers,
    order: [
      'terrain',
      'flowPaths',
      'waterlogging',
      'safe',
      'publicSpace',
      'moderateSlope',
      'nonBuildable',
      'drains',
      'existingRoads',
      'residual',
      'plotable',
    ],
    parcelAreaM2: parcelArea,
    storm,
    stormMm,
    gradient,
    limits: { nonBuildable: nonBuildableRatio, nonBuildableLabel, plotMax: plotMaxRatio },
    water: {
      counted: { areaM2: areaM2(dem, wet), volumeM3: vol(wet), meanDepthM: areaM2(dem, wet) > 0 ? vol(wet) / areaM2(dem, wet) : 0 },
      ignoredChannels: { areaM2: areaM2(dem, minus(wetRaw, wetOpen)), volumeM3: vol(minus(wetRaw, wetOpen)), widthM: narrowChannel },
      ignoredPatches: { areaM2: areaM2(dem, minus(wetOpen, wet)), volumeM3: vol(minus(wetOpen, wet)), underM2: minWaterPatch },
    },
    rule22: [
      {
        clause: '22(3)',
        condition: 'land liable to be flooded',
        status: 'applied',
        how: `ground under water at the peak of the ${stormMm} mm storm is waterlogging: public space, never plotted`,
      },
      {
        clause: '22(3)',
        condition: `slope over ${rule22Deg}°`,
        status: 'applied',
        how: fromRule22
          ? `${ha(areaM2(dem, steep))} over ${rule22Deg}° on the raw survey or the mesh is non-buildable`
          : `the plan uses the stricter ${ratioText(nonBuildableRatio)}, which covers it`,
      },
      {
        clause: '22(4)',
        condition: 'natural drains and streams unobstructed',
        status: 'applied',
        how: `${drainLength.toFixed(0)} m of surveyed drain kept clear; the flooded width of the flow paths is in the waterlogging`,
      },
      {
        clause: '22(3)',
        condition: 'soil unsuitable for percolation',
        status: 'no data',
        how: 'not considered: no soil survey',
      },
      {
        clause: '22(3)',
        condition: 'floodable area in a Master Plan, DTP scheme or IDO',
        status: 'no data',
        how: 'not considered: no master plan flood map loaded',
      },
      {
        clause: '22(3)',
        condition: 'plot declared unsuitable by the Disaster Management Authority',
        status: 'no data',
        how: 'not considered: no DMA declaration loaded',
      },
      {
        clause: '22(1), (2)',
        condition: 'refuse deposits, pits, quarries',
        status: 'no data',
        how: 'not considered: none recorded in the survey',
      },
    ],
    ms,
  };
}
