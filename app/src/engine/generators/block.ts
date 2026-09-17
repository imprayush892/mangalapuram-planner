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

  // A block roughly 1:1.6, laid on the flattest ground the placeable area holds.
  // An irregular zone rarely takes the full-size rectangle, so the block is
  // shrunk until it fits and the area it loses is reported rather than the
  // generator returning nothing.
  const rect = minAreaRect(placeable.flatMap((p) => p[0] ?? []));
  let placed: Ring | null = null;
  let footprintM2 = wantedFootprintM2;
  let length = 0;
  let depth = 0;
  for (const scale of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.12]) {
    footprintM2 = wantedFootprintM2 * scale;
    depth = Math.sqrt(footprintM2 / 1.6);
    length = footprintM2 / depth;
    placed = placeBlock(placeable, dem, length, depth, rect.angle);
    if (placed) break;
  }
  if (!placed) return null;

  // With a smaller footprint, more floors recover some of the area — up to what
  // the FSI tier allows, never past it.
  const floorsByFsi = Math.max(1, Math.floor((fsi * zoneAreaM2) / footprintM2));
  const floors = Math.max(1, Math.min(floorsByFsi, Math.ceil(builtUpM2 / footprintM2)));
  const heightM = floors * floorToFloor;

  const terrain = blockTerrain(dem, placed, fallThresholds);
  const notes: string[] = [];
  if (Number.isFinite(terrain.fall) && terrain.fall > 3) {
    notes.push(`Ground falls ${terrain.fall.toFixed(1)} m across the block: step the platform or use a podium.`);
  }
  if (footprintM2 < wantedFootprintM2 * 0.999) {
    notes.push(
      `A ${Math.round(wantedFootprintM2).toLocaleString('en-IN')} m² footprint does not fit inside the ${yardM.toFixed(1)} m yard on this zone shape; the block is drawn at ${Math.round(footprintM2).toLocaleString('en-IN')} m². Splitting the use into several blocks would recover some of it.`,
    );
  }
  if (footprintM2 * floors < builtUpM2 * 0.999) {
    notes.push(
      `The zone holds ${Math.round(m2ToSft(footprintM2 * floors)).toLocaleString('en-IN')} sft of the ${input.builtUpSft.toLocaleString('en-IN')} sft asked for.`,
    );
  }

  const block: BlockResult = {
    id: 'B1',
    use: input.useLabel,
    ring: placed,
    footprintM2,
    floors,
    heightM,
    builtUpM2: footprintM2 * floors,
    terrain,
    notes,
  };

  const openSpace = buildOpenSpace(buildable, [[placed]], zone);
  const grossPerCar = pick<number>(assumptions, 'parking_gross_m2_per_car', 30);
  const parking = parkingForOther(kmbr, input.occupancy, block.builtUpM2, grossPerCar);
  const access = accessWidthM(kmbr, input.occupancy, block.builtUpM2);

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
    totalFloorAreaM2: block.builtUpM2,
    footprintM2,
    fsiUsed: zoneAreaM2 > 0 ? block.builtUpM2 / zoneAreaM2 : 0,
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
    strategy: `${input.useLabel}: one block of ${Math.round(m2ToSft(block.builtUpM2)).toLocaleString('en-IN')} sft over ${floors} floors, ${length.toFixed(0)} × ${depth.toFixed(0)} m footprint inside the ${yardM.toFixed(1)} m yard`,
    plots: [],
    roads: [],
    openSpace,
    towers: [],
    blocks: [block],
    buildable,
    metrics,
    score: {
      yield: builtUpM2 > 0 ? Math.min(100, (block.builtUpM2 / builtUpM2) * 100) : 100,
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
    meanSlopeDeg: dem.terrainIn([[placed]]).meanSlopeDeg,
  });
  return option;
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
  const block = layout.blocks[0]!;

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
