import type { MultiPoly, Pt, Ring } from '../geom/types';
import { minAreaRect, multiPolyArea, orientedRect, pointInMulti } from '../geom/planar';
import { difference, union } from '../geom/boolean';
import { insetMulti } from '../geom/offset';
import type { Dem } from '../terrain/dem';
import { classifyFall } from '../terrain/analysis';
import type { FallThresholds } from '../terrain/analysis';
import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import {
  accessWidthM,
  coverageFsi,
  daylightDepthM,
  gapBetweenBuildingsM,
  travelDistanceM,
  governingYardM,
  highRise,
  needsDtpApproval,
  parkingForOther,
  unbuildableSlopeDeg,
  yardsFor,
} from '../rules/kmbr';
import type { Occupancy } from '../rules/kmbr';
import { m2ToAcres, m2ToSft, sftToM2 } from '../units';
import type { BlockResult, LayoutMetrics, LayoutOption, OpenSpaceResult, TerrainSummary } from './types';
import { ZoneRaster } from './zoneRaster';
import { fail, info, pass, warn } from '../rules/findings';
import type { Finding } from '../rules/findings';

export interface BlockGeneratorInput {
  zoneId: string;
  zoneName: string;
  zone: MultiPoly;
  dem: Dem;
  kmbr: YamlDoc;
  client: YamlDoc;
  assumptions: YamlDoc;
  occupancy: Occupancy;
  /** Built-up area the programme asks for. */
  builtUpSft: number;
  useLabel: string;
  /** School only: the core campus must sit on ground no steeper than this. */
  maxSlopeDeg?: number;
  noGo?: MultiPoly;
}

/**
 * SPEC 6.3, v1: a massing block for the uses that do not get a full layout —
 * school, club, commercial, hotel, business hub. The block is placed at the
 * Table 6 coverage and FSI inside the Table 4 yards, on the flattest ground the
 * zone offers, with parking and access width computed from the KMBR tables.
 */
export function generateBlockLayout(input: BlockGeneratorInput): LayoutOption | null {
  const { zone, dem, kmbr, assumptions } = input;
  if (zone.length === 0) return null;

  const slopeLimit = unbuildableSlopeDeg(kmbr);
  const raster = new ZoneRaster(dem, zone, slopeLimit, input.noGo ?? []);
  if (raster.zoneCells === 0) return null;

  const zoneAreaM2 = multiPolyArea(zone);
  const buildable = buildableGeometry(raster, zone);
  const cover = coverageFsi(kmbr, input.occupancy);
  const fsi = cover.fsiTiers[0] ?? 1;
  const builtUpM2 = sftToM2(input.builtUpSft);

  // Floors follow from the coverage the zone allows and the area wanted.
  const maxFootprintM2 = zoneAreaM2 * (cover.coveragePct / 100);
  const floorToFloor = pick<number>(assumptions, 'floor_to_floor_m.apartments', 3.0);
  const wantedFloors = Math.max(1, Math.ceil(builtUpM2 / Math.max(1, maxFootprintM2)));
  const wantedFootprintM2 = Math.min(maxFootprintM2, builtUpM2 / wantedFloors);

  const { yards } = yardsFor(kmbr, {
    occupancy: input.occupancy,
    heightM: wantedFloors * floorToFloor,
    builtUpAreaM2: builtUpM2,
  });
  const yardM = governingYardM(yards);
  const placeable = insetMulti(buildable, yardM);
  if (placeable.length === 0) return null;

  const fallThresholds = pick<FallThresholds>(assumptions, 'plot_fall_thresholds_m', {
    build_as_drawn: 0.5,
    absorb_in_plinth: 1.0,
    stepped_plinth: 2.0,
    split_level: 3.0,
  });

  /*
   * A campus, not one slab. The use's plinth is laid as a set of bars whose
   * depth comes from KMBR Rule 41 — habitable space within 7.5 m of an opening,
   * so a double-loaded bar is twice that plus the corridor, exactly as the
   * tower plate is derived — separated by the KMBR Rule 26 gap between
   * buildings. Bars are placed one at a time on the flattest ground left, so a
   * school reads as a school rather than as a single rectangle covering its
   * whole site.
   */
  const corridorM = pick<number>(assumptions, 'corridor_width_m', 2);
  const barDepth = daylightDepthM(kmbr) * 2 + corridorM;
  const gap = gapBetweenBuildingsM(kmbr, wantedFloors * floorToFloor, false);
  // A bar with a stair at each end can be no longer than twice the Rule 36
  // travel distance, which is what stops a 11,000 m² plinth becoming one 650 m
  // building. Sprinklers are not assumed.
  const maxBarLength = travelDistanceM(kmbr, false) * 2;
  const rect = minAreaRect(placeable.flatMap((p) => p[0] ?? []));

  const campus = placeCampus({
    placeable,
    dem,
    angle: rect.angle,
    barDepth,
    gap,
    maxBarLength,
    wantedFootprintM2,
  });

  if (campus.rings.length === 0) return null;
  const placed = campus.rings[0]!;
  const footprintM2 = campus.footprintM2;
  const length = campus.meanLengthM;
  const depth = campus.depthM;

  // With a smaller footprint, more floors recover some of the area — up to what
  // the FSI tier allows, never past it.
  const floorsByFsi = Math.max(1, Math.floor((fsi * zoneAreaM2) / Math.max(1, footprintM2)));
  const floors = Math.max(1, Math.min(floorsByFsi, Math.ceil(builtUpM2 / Math.max(1, footprintM2))));
  const heightM = floors * floorToFloor;

  const terrain = blockTerrain(dem, placed, fallThresholds);
  const notes: string[] = [];
  if (campus.rings.length > 1) {
    notes.push(
      `The plinth is laid as ${campus.rings.length} blocks ${campus.depthM.toFixed(0)} m deep and ${gap.toFixed(0)} m apart, not one slab: Rule 41 puts habitable space within ${daylightDepthM(kmbr)} m of an opening, and Rule 26 sets the gap.`,
    );
  }
  if (footprintM2 < wantedFootprintM2 * 0.999) {
    notes.push(
      `A ${Math.round(wantedFootprintM2).toLocaleString('en-IN')} m² footprint does not fit inside the ${yardM.toFixed(1)} m yard on this zone shape; ${campus.rings.length} block${campus.rings.length === 1 ? '' : 's'} totalling ${Math.round(footprintM2).toLocaleString('en-IN')} m² is what the ground takes.`,
    );
  }
  if (footprintM2 * floors < builtUpM2 * 0.999) {
    notes.push(
      `The zone holds ${Math.round(m2ToSft(footprintM2 * floors)).toLocaleString('en-IN')} sft of the ${input.builtUpSft.toLocaleString('en-IN')} sft asked for.`,
    );
  }

  const blocks: BlockResult[] = campus.rings.map((ring, i) => {
    const area = campus.areas[i] ?? 0;
    const t = blockTerrain(dem, ring, fallThresholds);
    const barNotes: string[] = [];
    if (Number.isFinite(t.fall) && t.fall > 3) {
      barNotes.push(`Ground falls ${t.fall.toFixed(1)} m across this block: step the platform or use a podium.`);
    }
    return {
      id: `B${i + 1}`,
      use: input.useLabel,
      ring,
      footprintM2: area,
      floors,
      heightM,
      builtUpM2: area * floors,
      terrain: t,
      notes: barNotes,
    };
  });
  const builtTotalM2 = blocks.reduce((sum, b) => sum + b.builtUpM2, 0);

  const openSpace = buildOpenSpace(buildable, blocks.map((b) => [b.ring]), zone);
  const grossPerCar = pick<number>(assumptions, 'parking_gross_m2_per_car', 30);
  const parking = parkingForOther(kmbr, input.occupancy, builtTotalM2, grossPerCar);
  const access = accessWidthM(kmbr, input.occupancy, builtTotalM2);

  const metrics: LayoutMetrics = {
    zoneAreaM2,
    buildableAreaM2: raster.buildableAreaM2,
    unbuildableAreaM2: raster.steepAreaM2,
    unsurveyedAreaM2: raster.unsurveyedAreaM2,
    roadAreaM2: 0,
    openSpaceAreaM2: openSpace.reduce((s, o) => s + o.areaM2, 0),
    saleableAreaM2: footprintM2,
    shares: {
      roads: 0,
      openSpace: zoneAreaM2 > 0 ? openSpace.reduce((s, o) => s + o.areaM2, 0) / zoneAreaM2 : 0,
      saleable: zoneAreaM2 > 0 ? footprintM2 / zoneAreaM2 : 0,
    },
    targetShares: { roads: 0, openSpace: 0, saleable: 0 },
    plotCount: 0,
    unitCount: 0,
    targetUnits: 0,
    towerCount: 0,
    totalFloorAreaM2: builtTotalM2,
    footprintM2,
    fsiUsed: zoneAreaM2 > 0 ? builtTotalM2 / zoneAreaM2 : 0,
    coveragePct: zoneAreaM2 > 0 ? (footprintM2 / zoneAreaM2) * 100 : 0,
    cutM3: Number.isFinite(terrain.cutM3) ? terrain.cutM3 : 0,
    fillM3: Number.isFinite(terrain.fillM3) ? terrain.fillM3 : 0,
    retainingFaceM2: Number.isFinite(terrain.fall) ? (terrain.fall / 2) * (length + depth) * 2 : 0,
    cornerPlots: 0,
    goodOrientationShare: 1,
    populationCapacity: 0,
  };

  const option: LayoutOption = {
    id: `${input.zoneId}-block`,
    zoneId: input.zoneId,
    zoneName: input.zoneName,
    kind: 'block',
    strategy: `${input.useLabel}: ${blocks.length} block${blocks.length === 1 ? '' : 's'} of ${Math.round(m2ToSft(builtTotalM2)).toLocaleString('en-IN')} sft over ${floors} floors, ${depth.toFixed(0)} m deep and up to ${length.toFixed(0)} m long (KMBR Rules 41 and 36), ${gap.toFixed(0)} m apart, inside the ${yardM.toFixed(1)} m yard`,
    plots: [],
    roads: [],
    openSpace,
    towers: [],
    blocks,
    buildable,
    metrics,
    score: {
      yield: builtUpM2 > 0 ? Math.min(100, (builtTotalM2 / builtUpM2) * 100) : 100,
      earthwork: Math.max(0, 100 - (Number.isFinite(terrain.fall) ? terrain.fall * 10 : 0)),
      orientation: 100,
      roadShare: 100,
      openSpaceQuality: Math.min(100, metrics.shares.openSpace * 150),
      corners: 100,
      total: 0,
    },
    findings: [],
    warnings: notes,
  };
  option.score.total =
    option.score.yield * 0.5 + option.score.earthwork * 0.3 + option.score.openSpaceQuality * 0.2;

  option.findings = checkBlock(option, input, {
    cover,
    fsi,
    yards: yardM,
    parkingCars: parking.totalCars,
    parkingAreaM2: parking.totalParkingAreaM2,
    parkingBasis: parking.basis,
    accessWidthM: access.widthM,
    wantedBuiltUpM2: builtUpM2,
    heightM,
    floors,
    maxSlopeDeg: input.maxSlopeDeg,
    meanSlopeDeg: dem.terrainIn(blocks.map((b) => [b.ring])).meanSlopeDeg,
  });
  return option;
}

interface CampusInput {
  placeable: MultiPoly;
  dem: Dem;
  angle: number;
  barDepth: number;
  gap: number;
  /** KMBR Rule 36: a bar with a stair at each end reaches twice this. */
  maxBarLength: number;
  wantedFootprintM2: number;
}

interface CampusResult {
  rings: Ring[];
  areas: number[];
  footprintM2: number;
  depthM: number;
  meanLengthM: number;
}

/**
 * Lays the use's plinth as a set of bars rather than one slab.
 *
 * Each bar is `barDepth` deep — the Rule 41 daylight depth on both sides plus
 * the corridor — and as long as the ground left will take. After a bar is
 * placed, the bar plus the Rule 26 gap is cut out of the placeable area, so the
 * next one cannot crowd it. Bars stop when the wanted footprint is met or
 * nothing more fits, and the shortfall is reported by the caller.
 *
 * A zone too small or too broken for a full-depth bar falls back to the largest
 * single block that fits, so the generator never returns nothing where the
 * programme asks for something.
 */
function placeCampus(input: CampusInput): CampusResult {
  const { dem, angle, gap } = input;
  const rings: Ring[] = [];
  const areas: number[] = [];
  let remaining = input.placeable;
  let placedArea = 0;
  let lengthSum = 0;

  // A bar shorter than this is a shed, not a building; stop rather than
  // scatter fragments over the site.
  const minBarLength = input.barDepth * 1.5;

  for (let n = 0; n < 24 && placedArea < input.wantedFootprintM2 * 0.999; n += 1) {
    const wanted = input.wantedFootprintM2 - placedArea;
    const depth = input.barDepth;
    let placedRing: Ring | null = null;
    let barLength = 0;

    // Longest bar first: a campus of a few long buildings reads better, and
    // costs less envelope, than many short ones.
    const maxLength = Math.max(minBarLength, Math.min(input.maxBarLength, wanted / depth));
    for (const scale of [1, 0.85, 0.7, 0.55, 0.45, 0.35, 0.28, 0.2, 0.15, 0.1]) {
      const length = Math.max(minBarLength, maxLength * scale);
      if (length < minBarLength) break;
      const ring = placeBlock(remaining, dem, length, depth, angle);
      if (ring) {
        placedRing = ring;
        barLength = length;
        break;
      }
    }

    if (!placedRing) break;

    rings.push(placedRing);
    const area = barLength * depth;
    areas.push(area);
    placedArea += area;
    lengthSum += barLength;
    remaining = difference(remaining, insetMulti([[placedRing]], -gap));
    if (remaining.length === 0) break;
  }

  if (rings.length === 0) {
    // Nothing takes a full-depth bar: fall back to the biggest block that fits.
    for (const scale of [1, 0.8, 0.6, 0.45, 0.3, 0.2, 0.12]) {
      const area = input.wantedFootprintM2 * scale;
      const depth = Math.sqrt(area / 1.6);
      const length = area / depth;
      const ring = placeBlock(input.placeable, dem, length, depth, angle);
      if (ring) {
        return { rings: [ring], areas: [area], footprintM2: area, depthM: depth, meanLengthM: length };
      }
    }
    return { rings: [], areas: [], footprintM2: 0, depthM: input.barDepth, meanLengthM: 0 };
  }

  return {
    rings,
    areas,
    footprintM2: placedArea,
    depthM: input.barDepth,
    meanLengthM: lengthSum / rings.length,
  };
}

/** Slides a block over the placeable area and keeps the flattest valid spot. */
function placeBlock(placeable: MultiPoly, dem: Dem, length: number, depth: number, angle: number): Ring | null {
  const pts = placeable.flatMap((p) => p[0] ?? []);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  let best: { ring: Ring; fall: number } | null = null;
  const step = 5;
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      for (const a of [angle, angle + Math.PI / 2]) {
        const ring = orientedRect([x, y], length, depth, a);
        if (!ring.every((p) => pointInMulti(p, placeable))) continue;
        const probes: Pt[] = [...ring, [x, y]];
        const samples = probes.map((p) => dem.sample(p)).filter((v) => Number.isFinite(v));
        const fall = samples.length > 0 ? Math.max(...samples) - Math.min(...samples) : 0;
        if (!best || fall < best.fall) best = { ring, fall };
      }
    }
  }
  return best?.ring ?? null;
}

function blockTerrain(dem: Dem, ring: Ring, thresholds: FallThresholds): TerrainSummary {
  const t = dem.terrainIn([[ring]]);
  if (t.count === 0) {
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
  const cellArea = dem.cell * dem.cell;
  return {
    fall: t.fall,
    platformRl: t.median,
    minRl: t.min,
    maxRl: t.max,
    cutM3: ((t.max - t.median) / 2) * t.count * cellArea,
    fillM3: ((t.median - t.min) / 2) * t.count * cellArea,
    unsurveyedShare: t.count + t.nanCount > 0 ? t.nanCount / (t.count + t.nanCount) : 0,
    fallClass: classifyFall(t.fall, thresholds),
  };
}

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
  return difference(zone, union(...squares.map((p) => [p])));
}

function buildOpenSpace(buildable: MultiPoly, blockGeom: MultiPoly, zone: MultiPoly): OpenSpaceResult[] {
  const out: OpenSpaceResult[] = [];
  for (const poly of difference(buildable, blockGeom)) {
    const area = multiPolyArea([poly]);
    if (area < 4) continue;
    out.push({
      id: `os${out.length + 1}`,
      geom: [poly],
      areaM2: area,
      kind: 'topup',
      minWidthM: 0,
      countsAsRecreation: area >= 200,
    });
  }
  for (const poly of difference(zone, buildable)) {
    const area = multiPolyArea([poly]);
    if (area < 4) continue;
    out.push({
      id: `os${out.length + 1}`,
      geom: [poly],
      areaM2: area,
      kind: 'steep',
      minWidthM: 0,
      countsAsRecreation: false,
    });
  }
  return out;
}

interface BlockCheckContext {
  cover: ReturnType<typeof coverageFsi>;
  fsi: number;
  yards: number;
  parkingCars: number;
  parkingAreaM2: number;
  parkingBasis: string;
  accessWidthM: number;
  wantedBuiltUpM2: number;
  heightM: number;
  floors: number;
  maxSlopeDeg?: number;
  meanSlopeDeg: number;
}

function checkBlock(layout: LayoutOption, input: BlockGeneratorInput, ctx: BlockCheckContext): Finding[] {
  const out: Finding[] = [];
  const m = layout.metrics;
  // The campus is checked as a whole: coverage, FSI and yield are the sum of
  // its blocks, and the floors and depth are common to all of them.
  const worstFall = layout.blocks.reduce(
    (worst, b) => (Number.isFinite(b.terrain.fall) && b.terrain.fall > worst.fall ? b.terrain : worst),
    layout.blocks[0]!.terrain,
  );
  const block = {
    footprintM2: layout.blocks.reduce((sum, b) => sum + b.footprintM2, 0),
    builtUpM2: layout.blocks.reduce((sum, b) => sum + b.builtUpM2, 0),
    floors: layout.blocks[0]?.floors ?? 1,
    /** The worst bar decides: a campus is only as buildable as its hardest block. */
    terrain: worstFall,
  };

  out.push(
    (m.coveragePct <= ctx.cover.coveragePct ? pass : fail)({
      id: 'block.coverage',
      source: 'KMBR',
      reference: ctx.cover.key,
      title: `Coverage ${m.coveragePct.toFixed(1)}% against the ${ctx.cover.coveragePct}% limit`,
      detail: `${Math.round(block.footprintM2).toLocaleString('en-IN')} m² footprint on ${m2ToAcres(m.zoneAreaM2).toFixed(2)} ac.`,
    }),
  );

  out.push(
    (m.fsiUsed <= ctx.fsi + 1e-6 ? pass : fail)({
      id: 'block.fsi',
      source: 'KMBR',
      reference: ctx.cover.key,
      title: `FSI ${m.fsiUsed.toFixed(2)} against the free tier of ${ctx.fsi}`,
      detail: `${ctx.cover.fsiTiers.length > 1 ? `Up to ${Math.max(...ctx.cover.fsiTiers)} with fees. ` : ''}${Math.round(m2ToSft(block.builtUpM2)).toLocaleString('en-IN')} sft over ${block.floors} floors.`,
    }),
  );

  out.push(
    (block.builtUpM2 >= ctx.wantedBuiltUpM2 * 0.999 ? pass : warn)({
      id: 'block.yield',
      source: 'PROGRAMME',
      reference: 'programme.yaml bua_sft',
      title: `${Math.round(m2ToSft(block.builtUpM2)).toLocaleString('en-IN')} sft of the ${input.builtUpSft.toLocaleString('en-IN')} sft asked for`,
      detail:
        block.builtUpM2 >= ctx.wantedBuiltUpM2 * 0.999
          ? 'The zone holds the programme line.'
          : `${layout.warnings.join(' ')} More floors are capped by the FSI tier of ${ctx.fsi}; beyond that the line needs more land, several blocks, or to be cut.`,
    }),
  );

  out.push(
    info({
      id: 'block.yards',
      source: 'KMBR',
      reference: 'KMBR Table 4 with the Rule 26 height increment',
      title: `Block placed inside a ${ctx.yards.toFixed(1)} m yard`,
      detail: `${block.floors} floors, ${ctx.heightM.toFixed(0)} m. ${highRise(input.kmbr, ctx.heightM, ctx.floors).isHighRise ? 'High rise: Chapter XVII fire access applies.' : 'Below the high-rise threshold.'}`,
    }),
  );

  out.push(
    info({
      id: 'block.parking',
      source: 'KMBR',
      reference: 'KMBR Table 10 + Rule 29',
      title: `${ctx.parkingCars.toLocaleString('en-IN')} cars, ${Math.round(ctx.parkingAreaM2).toLocaleString('en-IN')} m²`,
      detail: `${ctx.parkingBasis}. Two-wheeler space at 25% of the car area is included.`,
    }),
  );

  out.push(
    info({
      id: 'block.access',
      source: 'KMBR',
      reference: 'KMBR Tables 7 / 8',
      title: `Access road ${ctx.accessWidthM} m`,
      detail: `Required for ${Math.round(block.builtUpM2).toLocaleString('en-IN')} m² of total floor area at occupancy ${input.occupancy}.`,
    }),
  );

  const dtp = needsDtpApproval(input.kmbr, input.occupancy, { builtUpM2: block.builtUpM2 });
  out.push(
    info({
      id: 'block.dtp',
      source: 'KMBR',
      reference: 'KMBR Table 11',
      title: dtp.needed ? 'District Town Planner approval is required' : 'No DTP approval trigger',
      detail: dtp.reason,
    }),
  );

  if (ctx.maxSlopeDeg !== undefined) {
    out.push(
      (Number.isFinite(ctx.meanSlopeDeg) && ctx.meanSlopeDeg <= ctx.maxSlopeDeg ? pass : warn)({
        id: 'block.slope',
        source: 'CLIENT',
        reference: 'docs/SPEC.md §6.3 school siting',
        title: `Ground under the block averages ${Number.isFinite(ctx.meanSlopeDeg) ? `${ctx.meanSlopeDeg.toFixed(1)}°` : '—'} against the ${ctx.maxSlopeDeg}° the use needs`,
        detail: 'A school core campus needs gentle ground and its own gate on a public road.',
      }),
    );
  }

  out.push(
    (Number.isFinite(block.terrain.fall) && block.terrain.fall <= 3 ? pass : warn)({
      id: 'block.terrain',
      source: 'ASSUMPTION',
      reference: 'assumptions.plot_fall_thresholds_m',
      title: `Fall across the block ${Number.isFinite(block.terrain.fall) ? `${block.terrain.fall.toFixed(1)} m` : 'unsurveyed'}`,
      detail: `Platform RL ${Number.isFinite(block.terrain.platformRl) ? block.terrain.platformRl.toFixed(2) : '—'}. Cut ${Math.round(m.cutM3).toLocaleString('en-IN')} m³, fill ${Math.round(m.fillM3).toLocaleString('en-IN')} m³.`,
    }),
  );

  return out;
}
