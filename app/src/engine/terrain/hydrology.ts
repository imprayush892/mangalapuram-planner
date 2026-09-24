import type { Dem } from './dem';
import type { SiteFeature } from '../site/types';
import { buildWaterModel } from './water';
import type { WaterModel } from './water';
import { pick } from '../data/config';

/**
 * The one set of hydrology rules the app uses.
 *
 * The panel's numbers, the 2D raster, the 3D terrain tint, the flow lines and
 * the particles all read one storm simulation from here, so what is drawn is
 * what is reported. tools/preprocess/hydrology_analysis.py runs the same
 * simulation offline for the report, from the same config block
 * (config/assumptions.yaml `hydrology`); hydrology.test.ts holds the two to
 * each other.
 *
 * The storm model is fill-and-spill on the DEM. Runoff is routed downslope;
 * every hollow on the way holds what reaches it, from its lowest cell up, and
 * passes on only what it cannot hold. So a small storm leaves puddles in the
 * bottoms of the hollows that catch the most ground, a large one fills every
 * hollow to its rim and sends the rest on, and past that point more rain
 * means more water moving, not bigger ponds. It is a volume balance over the
 * storm: no evaporation or seepage from the ponds during it.
 *
 * On top of that volume balance sits the storm's peak. Flowing water has
 * depth, and the harder it rains the deeper and wider it runs, so the area
 * under water keeps growing after every hollow is full. Each flow path gets a
 * peak discharge (the IMD short-duration rule over a Kirpich time of
 * concentration, on the runoff that actually reaches it), and a Manning depth
 * across a cross-section cut from the DEM. A full hollow rises over its rim
 * by the depth its outflow needs to get away. Steady normal depth at the peak:
 * no backwater, and no culverts, because the survey shows none.
 */

export interface HydrologyParams {
  annualRainfallMm: number;
  designStormMm: number;
  designReturnPeriodYr: number;
  /** A fixed storm runoff coefficient, or null to use the formula. */
  stormRunoffCoeff: number | null;
  formula: { a: number; b: number; areaReductionFactor: number };
  annualRunoffCoeff: number;
  imperviousShareDeveloped: number;
  imperviousRunoffCoeff: number;
  pondingDepthM: number;
  standingWaterShowM: number;
  channelFlowLps: number;
  peak: {
    shortDurationExponent: number;
    kirpich: { a: number; b: number; c: number };
    tcMinMinutes: number;
    manningN: number;
    minSlope: number;
    sectionHalfWidthM: number;
    maxDepthM: number;
  };
  presets: { label: string; mm: number; note: string }[];
}

const need = (doc: unknown, path: string): number => {
  const v = pick<number | null>(doc, `hydrology.${path}`, null);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`config/assumptions.yaml hydrology.${path} is missing; add it with its source rather than hard-coding it`);
  }
  return v;
};

/** The hydrology assumptions, from config/assumptions.yaml. Throws when one is missing. */
export function hydrologyParams(assumptions: unknown): HydrologyParams {
  const fixed = pick<number | null>(assumptions, 'hydrology.storm_runoff_coeff', null);
  return {
    annualRainfallMm: need(assumptions, 'annual_rainfall_mm'),
    designStormMm: need(assumptions, 'design_storm_mm'),
    designReturnPeriodYr: need(assumptions, 'design_return_period_yr'),
    stormRunoffCoeff: typeof fixed === 'number' && Number.isFinite(fixed) ? fixed : null,
    formula: {
      a: need(assumptions, 'runoff_formula.a'),
      b: need(assumptions, 'runoff_formula.b'),
      areaReductionFactor: need(assumptions, 'runoff_formula.area_reduction_factor'),
    },
    annualRunoffCoeff: need(assumptions, 'annual_runoff_coeff'),
    imperviousShareDeveloped: need(assumptions, 'impervious_share_developed'),
    imperviousRunoffCoeff: need(assumptions, 'impervious_runoff_coeff'),
    pondingDepthM: need(assumptions, 'ponding_depth_m'),
    standingWaterShowM: need(assumptions, 'standing_water_show_m'),
    channelFlowLps: need(assumptions, 'channel_flow_lps'),
    peak: {
      shortDurationExponent: need(assumptions, 'peak_flow.short_duration_exponent'),
      kirpich: {
        a: need(assumptions, 'peak_flow.kirpich.a'),
        b: need(assumptions, 'peak_flow.kirpich.b'),
        c: need(assumptions, 'peak_flow.kirpich.c'),
      },
      tcMinMinutes: need(assumptions, 'peak_flow.tc_min_minutes'),
      manningN: need(assumptions, 'peak_flow.manning_n'),
      minSlope: need(assumptions, 'peak_flow.min_slope'),
      sectionHalfWidthM: need(assumptions, 'peak_flow.section_half_width_m'),
      maxDepthM: need(assumptions, 'peak_flow.max_depth_m'),
    },
    presets: pick<{ label: string; mm: number; note?: string }[]>(assumptions, 'hydrology.storm_presets', []).map(
      (p) => ({ label: p.label, mm: p.mm, note: p.note ?? '' }),
    ),
  };
}

/**
 * Storm runoff coefficient: the fixed value if one is set, else the CWC /
 * RBF-16 coastal formula C = a (R F)^b with R the 24 h rainfall in cm. It
 * rises with the storm — wetter ground sheds more — and is capped at 1.
 */
export function stormRunoffCoeff(p: HydrologyParams, rainMm: number): number {
  if (p.stormRunoffCoeff !== null) return Math.min(1, Math.max(0, p.stormRunoffCoeff));
  const rCm = Math.max(0, rainMm) / 10;
  return Math.min(1, p.formula.a * Math.pow(rCm * p.formula.areaReductionFactor, p.formula.b));
}

/** Area-weighted coefficient once built: impervious share at its own C, the rest as natural ground. */
export function developedRunoffCoeff(p: HydrologyParams, naturalC: number): number {
  const s = Math.min(1, Math.max(0, p.imperviousShareDeveloped));
  return s * p.imperviousRunoffCoeff + (1 - s) * naturalC;
}

/** m³ over 24 h for a mean flow of `lps` litres a second. */
export const lpsToM3PerDay = (lps: number): number => (lps / 1000) * 86400;

/* ------------------------------------------------------------ the model */

const modelCache = new WeakMap<Dem, { features: SiteFeature[]; pondingDepthM: number; model: WaterModel }>();

/**
 * The water model for a site, built once. The raster, the 3D view, the panel
 * and the particles all ask for it, and it takes a moment on 160k cells.
 */
export function waterModelFor(dem: Dem, features: SiteFeature[], pondingDepthM: number): WaterModel {
  const hit = modelCache.get(dem);
  if (hit && hit.features === features && hit.pondingDepthM === pondingDepthM) return hit.model;
  const model = buildWaterModel({
    dem,
    // Distance-to-water scoring uses its own channel threshold; the storm
    // decides what is drawn as flowing.
    minUpslopeCells: 250,
    features,
    pondingDepthM,
  });
  modelCache.set(dem, { features, pondingDepthM, model });
  return model;
}

/* ------------------------------------------------------------ the storm */

export interface CatchmentStorm {
  /** Outlet cell: where this catchment's water leaves the survey. */
  outlet: number;
  areaM2: number;
  runoffM3: number;
  heldM3: number;
  outflowM3: number;
}

export interface StormResult {
  rainMm: number;
  runoffCoeff: number;
  /** Rain on the modelled ground, m³. */
  rainM3: number;
  /** rain × C, m³. */
  runoffM3: number;
  /** Held in hollows at the end of the storm, m³. */
  heldM3: number;
  /** Leaves the survey at its edge, m³. runoff − held. */
  outflowM3: number;
  /** Standing water per cell at the end of the storm, m. */
  waterDepthM: Float32Array;
  /** Volume that passed through each cell during the storm, m³. */
  flowM3: Float32Array;
  /** 1 where standing water is drawn: deep enough, in a hollow deep enough to be a pond. */
  standing: Uint8Array;
  standingAreaM2: number;
  /** Water depth at the storm's peak: the ponds, risen over their rims, and the water running. */
  peakDepthM: Float32Array;
  /** 1 where the peak depth reaches the drawing threshold. */
  peakWet: Uint8Array;
  peakWetAreaM2: number;
  /** Peak discharge per cell, m³/s. */
  peakQ: Float32Array;
  /** Largest peak discharge leaving the site, m³/s, and its time of concentration, minutes. */
  peakOutflowM3s: number;
  peakOutflowTcMin: number;
  /** 1 where a flow path carries at least the channel flow. */
  channel: Uint8Array;
  channelFlowM3: number;
  /** Hollows that are real ponds, and how many of them this storm fills to the rim. */
  pondsFull: number;
  pondsTotal: number;
  catchments: Map<number, CatchmentStorm>;
  /** Where the water goes, and the ponds and channels it stands in, so the volumes can be checked. */
  balance: WaterBalance;
}

/** One pond at the storm's peak (and what its hollows hold when the rain stops). */
export interface PondBalance {
  id: number;
  /** Cell nearest the middle of the pond, for labelling. */
  centre: number;
  areaM2: number;
  meanDepthM: number;
  maxDepthM: number;
  /** Water in it at the peak, m³: area × mean depth. */
  peakVolumeM3: number;
  /** Held in its hollows when the rain stops, m³. */
  endVolumeM3: number;
  /** What its hollows hold full to the rim, m³. */
  capacityM3: number;
  full: boolean;
}

export interface WaterBalance {
  /** The day's water, m³: rain = loss + runoff; runoff = held + outflow (closure is what is left over). */
  rainM3: number;
  lossM3: number;
  runoffM3: number;
  heldM3: number;
  heldInPondsM3: number;
  heldInShallowHollowsM3: number;
  outflowM3: number;
  closureM3: number;
  /** Water on the ground at the peak, counted where it is at least the drawing depth. */
  peak: {
    pondAreaM2: number;
    pondVolumeM3: number;
    pondMeanDepthM: number;
    pondMaxDepthM: number;
    /** Every flow line carrying at least the channel flow, m, along the flow. */
    flowLineLengthM: number;
    /** The channels proper: flow lines running at least the drawing depth at the peak, m. */
    channelLengthM: number;
    /** The water on their banks, cell by cell as drawn (each cell once), m2 and m3. */
    channelAreaM2: number;
    channelVolumeM3: number;
    /** Wetted area over channel length, m; volume over area, m. */
    channelMeanWidthM: number;
    channelMeanDepthM: number;
    channelMaxDepthM: number;
    /**
     * Width of the Manning section cut across each channel cell to find its
     * water level (median and 90th percentile by length), m. On flat valley
     * floors neighbouring flow lines cut sections across the same floodplain,
     * so these are the hydraulic widths, not a second count of the water.
     */
    sectionMedianWidthM: number;
    sectionP90WidthM: number;
    shallowAreaM2: number;
    shallowVolumeM3: number;
    outflowM3s: number;
  };
  ponds: PondBalance[];
  /** Per cell at the peak: 0 dry, 1 pond, 2 channel, 3 shallow hollow. */
  kind: Uint8Array;
}

/**
 * Route one storm across the DEM, fill and spill every hollow on the way.
 *
 * Water is conserved: runoff = held + outflow, per catchment and in total.
 */
export function simulateStorm(dem: Dem, model: WaterModel, p: HydrologyParams, rainMm: number, runoffCoeff: number): StormResult {
  const { nx, ny } = dem.meta;
  const n = nx * ny;
  const cellArea = dem.cell * dem.cell;
  const own = (Math.max(0, rainMm) / 1000) * Math.max(0, runoffCoeff) * cellArea;
  const { popOrder, receiver, depression, depressions } = model;

  // Which hollows spill into each rim cell.
  const exitsAt = new Map<number, number[]>();
  depressions.forEach((d, id) => {
    const list = exitsAt.get(d.exit);
    if (list) list.push(id);
    else exitsAt.set(d.exit, [id]);
  });

  const flow = new Float64Array(n);
  const inflow = new Float64Array(depressions.length);
  const held = new Float64Array(depressions.length);
  const waterDepthM = new Float32Array(n);
  const visited = new Uint8Array(n);
  let cellsModelled = 0;

  for (let idx = popOrder.length - 1; idx >= 0; idx -= 1) {
    const k = popOrder[idx]!;
    cellsModelled += 1;
    flow[k]! += own;
    const spilling = exitsAt.get(k);
    if (spilling) {
      for (const id of spilling) {
        const stored = fillDepression(dem, depressions[id]!, inflow[id]!, waterDepthM, visited, nx, ny);
        held[id] = stored;
        flow[k]! += inflow[id]! - stored;
      }
    }
    const d = depression[k]!;
    if (d >= 0) {
      // Everything reaching a hollow is its to hold; the spill leaves at the exit.
      inflow[d]! += flow[k]!;
      continue;
    }
    const r = receiver[k]!;
    if (r >= 0) flow[r]! += flow[k]!;
  }

  // Through-flow across a hollow that spills, so a flow path crosses a full
  // pond rather than stopping at its edge.
  depressions.forEach((dep, id) => {
    const spill = inflow[id]! - held[id]!;
    if (spill <= 0) return;
    for (const k of dep.cells) flow[k] = spill;
  });

  const channelFlowM3 = lpsToM3PerDay(p.channelFlowLps);
  const standing = new Uint8Array(n);
  const channel = new Uint8Array(n);
  let standingCells = 0;
  for (let k = 0; k < n; k += 1) {
    const d = depression[k]!;
    if (d >= 0 && waterDepthM[k]! >= p.standingWaterShowM && depressions[d]!.maxDepthM >= p.pondingDepthM) {
      standing[k] = 1;
      standingCells += 1;
    } else if (flow[k]! >= channelFlowM3) {
      channel[k] = 1;
    }
  }

  let pondsTotal = 0;
  let pondsFull = 0;
  let heldTotal = 0;
  depressions.forEach((dep, id) => {
    heldTotal += held[id]!;
    if (dep.maxDepthM < p.pondingDepthM) return;
    pondsTotal += 1;
    if (held[id]! >= dep.capacityM3 * 0.999) pondsFull += 1;
  });

  const catchments = new Map<number, CatchmentStorm>();
  const outlets = model.flowOutlets;
  const counts = new Float64Array(outlets.length);
  for (let k = 0; k < n; k += 1) {
    const c = model.flowCatchment[k]!;
    if (c >= 0) counts[c]! += 1;
  }
  const heldBy = new Float64Array(outlets.length);
  depressions.forEach((dep, id) => {
    const c = model.flowCatchment[dep.lowest]!;
    if (c >= 0) heldBy[c]! += held[id]!;
  });
  let outflowTotal = 0;
  outlets.forEach((outlet, c) => {
    const out = flow[outlet]!;
    outflowTotal += out;
    catchments.set(outlet, {
      outlet,
      areaM2: counts[c]! * cellArea,
      runoffM3: counts[c]! * own,
      heldM3: heldBy[c]!,
      outflowM3: out,
    });
  });

  /* ------------------------------------------------------------ the peak */
  const paths = flowPathsFor(dem, model);
  const peakQ = new Float32Array(n);
  const tcMin = new Float32Array(n);
  const { a: ka, b: kb, c: kc } = p.peak.kirpich;
  for (let k = 0; k < n; k += 1) {
    const f = flow[k]!;
    if (!(f > 0)) continue;
    const length = Math.max(dem.cell, paths.length[k]!);
    const slope = Math.max(p.peak.minSlope, (paths.top[k]! - model.filledLevel[k]!) / length);
    const tc = Math.max(p.peak.tcMinMinutes, ka * Math.pow(length, kb) * Math.pow(slope, -kc));
    tcMin[k] = tc;
    // Rain in the tc hours at the peak, from the 24 h total: P_t = P_24 (t/24)^e.
    // The runoff that reaches this cell is `flow`, so Q = flow × P_t/P_24 / t.
    const hours = Math.min(24, tc / 60);
    peakQ[k] = (f * Math.pow(hours / 24, p.peak.shortDurationExponent)) / (hours * 3600);
  }

  const peakDepthM = Float32Array.from(waterDepthM);
  const stage = new Float64Array(n).fill(Number.NaN);
  const section = crossSections(dem, p);
  for (let k = 0; k < n; k += 1) {
    if (channel[k] !== 1) continue;
    const r = receiver[k]!;
    if (r < 0) continue;
    stage[k] = section.stageAt(k, r, peakQ[k]!, model.filledLevel);
  }
  // Height above nearest drainage: every cell takes the water level of the
  // channel cell it drains into, and is under water where its ground is below
  // it. popOrder has every receiver first, so each cell's drain is known when
  // it is reached. Cells further from their drain than the section looks are
  // left dry: they are not on that channel's banks.
  const drain = new Int32Array(n).fill(-1);
  const reach = p.peak.sectionHalfWidthM;
  for (const k of popOrder) {
    if (channel[k] === 1 && Number.isFinite(stage[k]!)) drain[k] = k;
    else {
      const r = receiver[k]!;
      if (r >= 0) drain[k] = drain[r]!;
    }
    const d = drain[k]!;
    if (d < 0) continue;
    const dx = (k % nx) - (d % nx);
    const dy = Math.floor(k / nx) - Math.floor(d / nx);
    if (dem.cell * Math.hypot(dx, dy) > reach) continue;
    const depth = stage[d]! - dem.values[k]!;
    if (depth > peakDepthM[k]!) peakDepthM[k] = depth;
  }
  // A full hollow passes its outflow over the rim, which takes a head of water:
  // the pond stands at the stage its exit runs at, and spreads to match.
  const beforeSpread = Float32Array.from(peakDepthM);
  depressions.forEach((dep, id) => {
    if (dep.maxDepthM < p.pondingDepthM || held[id]! < dep.capacityM3 * 0.999) return;
    const L = stage[dep.exit]!;
    if (!(L > dep.spillLevel)) return;
    spreadPond(dem, dep.cells, dep.spillLevel, L, model.filledLevel, peakDepthM, nx, ny);
  });
  // Channel sections at the peak: width and water area across each channel cell.
  let flowLineLength = 0;
  let chLen = 0;
  let chDepthMax = 0;
  const widths: { w: number; l: number }[] = [];
  for (let k = 0; k < n; k += 1) {
    if (channel[k] !== 1 || !Number.isFinite(stage[k]!)) continue;
    const r = receiver[k]!;
    if (r < 0) continue;
    const step = dem.cell * Math.hypot((r % nx) - (k % nx), Math.floor(r / nx) - Math.floor(k / nx));
    flowLineLength += step;
    const depth = stage[k]! - dem.values[k]!;
    if (!(depth >= p.standingWaterShowM)) continue;
    const sec = section.sectionAt(k, r, stage[k]!);
    chLen += step;
    chDepthMax = Math.max(chDepthMax, depth);
    widths.push({ w: sec.width, l: step });
  }
  widths.sort((a, b) => a.w - b.w);
  const widthAtShare = (share: number): number => {
    let acc = 0;
    for (const x of widths) {
      acc += x.l;
      if (acc >= share * chLen) return x.w;
    }
    return widths.length > 0 ? widths[widths.length - 1]!.w : 0;
  };

  const peakWet = new Uint8Array(n);
  let peakWetCells = 0;
  for (let k = 0; k < n; k += 1) {
    if (peakDepthM[k]! >= p.standingWaterShowM) {
      peakWet[k] = 1;
      peakWetCells += 1;
    }
  }
  let peakOutflowM3s = 0;
  let peakOutflowTcMin = 0;
  for (const outlet of outlets) {
    if (peakQ[outlet]! > peakOutflowM3s) {
      peakOutflowM3s = peakQ[outlet]!;
      peakOutflowTcMin = tcMin[outlet]!;
    }
  }

  const rainM3 = (Math.max(0, rainMm) / 1000) * cellsModelled * cellArea;

  /* ------------------------------------------------------ water balance */
  // Each wet cell at the peak is a pond (a real hollow, or ground a full pond
  // rises over), a channel (the running water's banks) or a shallow hollow.
  const kind = new Uint8Array(n);
  for (let k = 0; k < n; k += 1) {
    if (!(peakDepthM[k]! > 0)) continue;
    const d = depression[k]!;
    if (peakDepthM[k]! > beforeSpread[k]! + 1e-6) kind[k] = 1;
    else if (d >= 0 && depressions[d]!.maxDepthM >= p.pondingDepthM) kind[k] = 1;
    else if (d >= 0 && waterDepthM[k]! >= peakDepthM[k]! - 1e-6) kind[k] = 3;
    else kind[k] = 2;
  }
  const show = p.standingWaterShowM;
  let pondArea = 0;
  let pondVol = 0;
  let pondMax = 0;
  let chArea = 0;
  let chVol = 0;
  let chMax = 0;
  let shArea = 0;
  let shVol = 0;
  for (let k = 0; k < n; k += 1) {
    const h = peakDepthM[k]!;
    if (!(h >= show)) continue;
    if (kind[k] === 1) {
      pondArea += cellArea;
      pondVol += h * cellArea;
      pondMax = Math.max(pondMax, h);
    } else if (kind[k] === 2) {
      chArea += cellArea;
      chVol += h * cellArea;
      chMax = Math.max(chMax, h);
    } else if (kind[k] === 3) {
      shArea += cellArea;
      shVol += h * cellArea;
    }
  }
  // Ponds one by one: the connected pond cells at the peak.
  const pondId = new Int32Array(n).fill(-1);
  const ponds: PondBalance[] = [];
  for (let k0 = 0; k0 < n; k0 += 1) {
    if (kind[k0] !== 1 || !(peakDepthM[k0]! >= show) || pondId[k0]! >= 0) continue;
    const id = ponds.length;
    const stack = [k0];
    pondId[k0] = id;
    let area = 0;
    let vol = 0;
    let max = 0;
    let sx = 0;
    let sy = 0;
    const members: number[] = [];
    while (stack.length > 0) {
      const k = stack.pop()!;
      members.push(k);
      const h = peakDepthM[k]!;
      area += cellArea;
      vol += h * cellArea;
      max = Math.max(max, h);
      const i = k % nx;
      const j = (k - i) / nx;
      sx += i;
      sy += j;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const q = b * nx + a;
        if (pondId[q]! >= 0 || kind[q] !== 1 || !(peakDepthM[q]! >= show)) continue;
        pondId[q] = id;
        stack.push(q);
      }
    }
    const ci = Math.round(sx / members.length);
    const cj = Math.round(sy / members.length);
    let centre = members[0]!;
    let bestD = Infinity;
    for (const k of members) {
      const d2 = ((k % nx) - ci) ** 2 + (Math.floor(k / nx) - cj) ** 2;
      if (d2 < bestD) {
        bestD = d2;
        centre = k;
      }
    }
    ponds.push({ id, centre, areaM2: area, meanDepthM: vol / area, maxDepthM: max, peakVolumeM3: vol, endVolumeM3: 0, capacityM3: 0, full: false });
  }
  let heldInPonds = 0;
  depressions.forEach((dep, id) => {
    if (dep.maxDepthM < p.pondingDepthM) return;
    heldInPonds += held[id]!;
    const pid = pondId[dep.lowest]!;
    if (pid < 0) return;
    const pond = ponds[pid]!;
    const first = pond.capacityM3 === 0;
    pond.endVolumeM3 += held[id]!;
    pond.capacityM3 += dep.capacityM3;
    const full = held[id]! >= dep.capacityM3 * 0.999;
    pond.full = first ? full : pond.full && full;
  });
  ponds.sort((a, b) => b.areaM2 - a.areaM2);
  const runoffM3 = cellsModelled * own;
  const balance: WaterBalance = {
    rainM3,
    lossM3: rainM3 - runoffM3,
    runoffM3,
    heldM3: heldTotal,
    heldInPondsM3: heldInPonds,
    heldInShallowHollowsM3: heldTotal - heldInPonds,
    outflowM3: outflowTotal,
    closureM3: runoffM3 - heldTotal - outflowTotal,
    peak: {
      pondAreaM2: pondArea,
      pondVolumeM3: pondVol,
      pondMeanDepthM: pondArea > 0 ? pondVol / pondArea : 0,
      pondMaxDepthM: pondMax,
      flowLineLengthM: flowLineLength,
      channelLengthM: chLen,
      channelAreaM2: chArea,
      channelVolumeM3: chVol,
      channelMeanWidthM: chLen > 0 ? chArea / chLen : 0,
      channelMeanDepthM: chArea > 0 ? chVol / chArea : 0,
      channelMaxDepthM: Math.max(chDepthMax, chMax),
      sectionMedianWidthM: widthAtShare(0.5),
      sectionP90WidthM: widthAtShare(0.9),
      shallowAreaM2: shArea,
      shallowVolumeM3: shVol,
      outflowM3s: 0,
    },
    ponds,
    kind,
  };
  return {
    rainMm,
    runoffCoeff,
    rainM3,
    runoffM3: cellsModelled * own,
    heldM3: heldTotal,
    outflowM3: outflowTotal,
    waterDepthM,
    flowM3: Float32Array.from(flow),
    standing,
    standingAreaM2: standingCells * cellArea,
    peakDepthM,
    peakWet,
    peakWetAreaM2: peakWetCells * cellArea,
    peakQ,
    peakOutflowM3s,
    peakOutflowTcMin,
    channel,
    channelFlowM3,
    pondsFull,
    pondsTotal,
    catchments,
    balance: { ...balance, peak: { ...balance.peak, outflowM3s: peakOutflowM3s } },
  };
}

/**
 * Fill one hollow with `volume` m³, from its lowest cell up, and write the
 * standing depth into `depth`. Returns what it holds.
 *
 * The water surface rises cell by cell in ground-level order over the cells it
 * can reach, so a nested pit fills before the water tops the saddle into the
 * next one. Full or over, it holds its capacity and the rest spills.
 */
function fillDepression(
  dem: Dem,
  dep: { cells: Int32Array; spillLevel: number; lowest: number; capacityM3: number },
  volume: number,
  depth: Float32Array,
  visited: Uint8Array,
  nx: number,
  ny: number,
): number {
  if (volume <= 0) return 0;
  const z = dem.values;
  if (volume >= dep.capacityM3) {
    for (const k of dep.cells) depth[k] = Math.max(0, dep.spillLevel - z[k]!);
    return dep.capacityM3;
  }
  const area = dem.cell * dem.cell;
  const member = new Set<number>(dep.cells);
  const heapK: number[] = [];
  const heapZ: number[] = [];
  const push = (k: number): void => {
    heapK.push(k);
    heapZ.push(z[k]!);
    let i = heapK.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (heapZ[up]! <= heapZ[i]!) break;
      [heapK[up], heapK[i]] = [heapK[i]!, heapK[up]!];
      [heapZ[up], heapZ[i]] = [heapZ[i]!, heapZ[up]!];
      i = up;
    }
  };
  const pop = (): number => {
    const top = heapK[0]!;
    const lastK = heapK.pop()!;
    const lastZ = heapZ.pop()!;
    if (heapK.length > 0) {
      heapK[0] = lastK;
      heapZ[0] = lastZ;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heapK.length && heapZ[l]! < heapZ[s]!) s = l;
        if (r < heapK.length && heapZ[r]! < heapZ[s]!) s = r;
        if (s === i) break;
        [heapK[s], heapK[i]] = [heapK[i]!, heapK[s]!];
        [heapZ[s], heapZ[i]] = [heapZ[i]!, heapZ[s]!];
        i = s;
      }
    }
    return top;
  };

  const flooded: number[] = [];
  const touched: number[] = [dep.lowest];
  visited[dep.lowest] = 1;
  push(dep.lowest);
  let level = z[dep.lowest]!;
  let used = 0;
  while (heapK.length > 0) {
    const k = pop();
    const zk = z[k]!;
    if (zk > level) {
      // Raise the surface over every flooded cell to this cell's ground.
      const needed = flooded.length * (zk - level) * area;
      if (used + needed >= volume) {
        level += (volume - used) / (flooded.length * area);
        used = volume;
        break;
      }
      used += needed;
      level = zk;
    } else {
      // Over a saddle into lower ground: it fills to the current level first.
      const needed = (level - zk) * area;
      if (used + needed > volume) break;
      used += needed;
    }
    flooded.push(k);
    const i = k % nx;
    const j = (k - i) / nx;
    for (let dj = -1; dj <= 1; dj += 1) {
      for (let di = -1; di <= 1; di += 1) {
        if (di === 0 && dj === 0) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nk = nj * nx + ni;
        if (visited[nk] === 1 || !member.has(nk)) continue;
        visited[nk] = 1;
        touched.push(nk);
        push(nk);
      }
    }
  }
  for (const k of flooded) depth[k] = Math.max(0, level - z[k]!);
  for (const k of touched) visited[k] = 0;
  // Below capacity nothing spills: the whole volume stays in the hollow, even
  // where the last saddle it was topping could not be drawn exactly.
  return volume;
}

/* ------------------------------------------------------- flow paths */

const pathCache = new WeakMap<WaterModel, { length: Float32Array; top: Float32Array }>();

/**
 * Per cell, the length of the longest flow path that reaches it and the level
 * that path starts at: what the Kirpich time of concentration needs.
 */
export function flowPathsFor(dem: Dem, model: WaterModel): { length: Float32Array; top: Float32Array } {
  const hit = pathCache.get(model);
  if (hit) return hit;
  const { nx } = dem.meta;
  const n = model.receiver.length;
  const length = new Float32Array(n).fill(-1);
  const top = new Float32Array(n).fill(Number.NaN);
  const order = model.popOrder;
  for (let idx = order.length - 1; idx >= 0; idx -= 1) {
    const k = order[idx]!;
    if (length[k]! < 0) {
      length[k] = 0;
      top[k] = model.filledLevel[k]!;
    }
    const r = model.receiver[k]!;
    if (r < 0) continue;
    const di = (r % nx) - (k % nx);
    const dj = Math.floor(r / nx) - Math.floor(k / nx);
    const reach = length[k]! + dem.cell * Math.hypot(di, dj);
    if (reach > length[r]!) {
      length[r] = reach;
      top[r] = top[k]!;
    }
  }
  const out = { length, top };
  pathCache.set(model, out);
  return out;
}

/* ---------------------------------------------------- cross-sections */

/**
 * Manning stage across the flow. The section is cut square to the flow
 * direction, sampled every metre off the DEM, and the water surface raised
 * until A R^(2/3) S^(1/2) / n carries the peak.
 */
function crossSections(dem: Dem, p: HydrologyParams) {
  const { nx } = dem.meta;
  const half = Math.max(1, Math.round(p.peak.sectionHalfWidthM));
  const count = 2 * half + 1;
  const zs = new Float64Array(count);
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);

  const carries = (level: number, lo: number, hi: number): { a: number; perim: number } => {
    let a = 0;
    let perim = 0;
    for (let s = half; s >= lo; s -= 1) {
      const z = zs[s]!;
      if (!(z < level)) break;
      a += level - z;
      if (s < half) perim += Math.hypot(1, z - zs[s + 1]!);
    }
    for (let s = half + 1; s <= hi; s += 1) {
      const z = zs[s]!;
      if (!(z < level)) break;
      a += level - z;
      perim += Math.hypot(1, z - zs[s - 1]!);
    }
    return { a, perim: Math.max(perim, 1) };
  };

  return {
    /** Wetted width (m) and water area (m2) across the flow at cell k with the water at `level`. */
    sectionAt(k: number, r: number, level: number): { width: number; area: number } {
      if (r < 0) return { width: 0, area: 0 };
      const i = k % nx;
      const j = (k - i) / nx;
      const ri = r % nx;
      const rj = (r - ri) / nx;
      const len = Math.hypot(ri - i, rj - j);
      if (len === 0) return { width: 0, area: 0 };
      const px = -(rj - j) / len;
      const py = (ri - i) / len;
      const cx = dem.meta.x0 + dem.cell * (i + 0.5);
      const cy = dem.meta.y0 + dem.cell * (j + 0.5);
      let w = 0;
      let a = 0;
      for (const dir of [1, -1]) {
        for (let s = dir > 0 ? 0 : 1; s <= half; s += 1) {
          const z = dem.sampleBilinear([cx + px * s * dir, cy + py * s * dir]);
          if (!(z < level)) break;
          w += 1;
          a += level - z;
        }
      }
      return { width: w, area: a };
    },
    stageAt(k: number, r: number, q: number, level: Float32Array): number {
      const i = k % nx;
      const j = (k - i) / nx;
      const ri = r % nx;
      const rj = (r - ri) / nx;
      const dist = dem.cell * Math.hypot(ri - i, rj - j);
      const slope = Math.max(p.peak.minSlope, (level[k]! - level[r]!) / dist);
      // Square to the flow: (-dy, dx), normalised.
      const len = Math.hypot(ri - i, rj - j);
      const px = -(rj - j) / len;
      const py = (ri - i) / len;
      const cx = dem.meta.x0 + dem.cell * (i + 0.5);
      const cy = dem.meta.y0 + dem.cell * (j + 0.5);
      let lo = half;
      let hi = half;
      for (let s = 0; s < count; s += 1) {
        const off = s - half;
        xs[s] = cx + px * off;
        ys[s] = cy + py * off;
        zs[s] = dem.sampleBilinear([xs[s]!, ys[s]!]);
      }
      while (lo > 0 && Number.isFinite(zs[lo - 1]!)) lo -= 1;
      while (hi < count - 1 && Number.isFinite(zs[hi + 1]!)) hi += 1;
      const bed = zs[half]!;
      if (!Number.isFinite(bed) || !(q > 0)) return Number.NaN;
      const sqrtS = Math.sqrt(slope);
      const discharge = (h: number): number => {
        const { a, perim } = carries(bed + h, lo, hi);
        return (a * Math.pow(a / perim, 2 / 3) * sqrtS) / p.peak.manningN;
      };
      let low = 0;
      let high = p.peak.maxDepthM;
      if (discharge(high) < q) low = high;
      else {
        for (let it = 0; it < 30; it += 1) {
          const mid = (low + high) / 2;
          if (discharge(mid) < q) low = mid;
          else high = mid;
        }
      }
      return bed + (low + high) / 2;
    },
  };
}

/**
 * Raise a full pond to `level`: the ground around it below that level goes
 * under. Only ground whose own flood level is at or above the spill counts —
 * ground past the outlet is lower than the pond and is not part of it.
 */
function spreadPond(
  dem: Dem,
  cells: Int32Array,
  spill: number,
  level: number,
  filled: Float32Array,
  paint: Float32Array,
  nx: number,
  ny: number,
): void {
  const seen = new Set<number>();
  const stack: number[] = [];
  for (const k of cells) {
    seen.add(k);
    stack.push(k);
  }
  const z = dem.values;
  while (stack.length > 0 && seen.size < 200_000) {
    const k = stack.pop()!;
    const d = level - z[k]!;
    if (d > paint[k]!) paint[k] = d;
    const i = k % nx;
    const j = (k - i) / nx;
    for (let dj = -1; dj <= 1; dj += 1) {
      for (let di = -1; di <= 1; di += 1) {
        if (di === 0 && dj === 0) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nk = nj * nx + ni;
        if (seen.has(nk)) continue;
        if (!(z[nk]! < level) || !(filled[nk]! >= spill)) continue;
        seen.add(nk);
        stack.push(nk);
      }
    }
  }
}

const stormCache = new WeakMap<WaterModel, Map<string, StormResult>>();

/** simulateStorm, remembered for the last few storms asked of each model. */
export function stormFor(dem: Dem, model: WaterModel, p: HydrologyParams, rainMm: number, runoffCoeff: number): StormResult {
  const key = JSON.stringify([rainMm, runoffCoeff, p.pondingDepthM, p.standingWaterShowM, p.channelFlowLps, p.peak]);
  let byKey = stormCache.get(model);
  if (!byKey) {
    byKey = new Map();
    stormCache.set(model, byKey);
  }
  const hit = byKey.get(key);
  if (hit) return hit;
  const result = simulateStorm(dem, model, p, rainMm, runoffCoeff);
  byKey.set(key, result);
  if (byKey.size > 6) byKey.delete(byKey.keys().next().value!);
  return result;
}
