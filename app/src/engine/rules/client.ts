import { pick, require$ } from '../data/config';
import type { YamlDoc } from '../data/config';
import { M2_PER_ACRE, sftToM2 } from '../units';

/**
 * Client (ONÈO / developer) sizing rules. These GOVERN the first cut; KMBR is
 * checked on top and the stricter value decides compliance status.
 */

export interface LandSplit {
  roads: number;
  openSpace: number;
  saleable: number;
}

export function landSplit(client: YamlDoc): LandSplit {
  return {
    roads: require$<number>(client, 'villa_and_senior_land_split.roads', 'client 20/30/50 split'),
    openSpace: require$<number>(client, 'villa_and_senior_land_split.open_space', 'client 20/30/50 split'),
    saleable: require$<number>(client, 'villa_and_senior_land_split.saleable', 'client 20/30/50 split'),
  };
}

export type MinSideApplies = 'long_side' | 'both_sides';

export interface PlotSizingOptions {
  /** Open item (SPEC §11): default long_side. */
  minSideApplies?: MinSideApplies;
  /** Cap on row-housing grouping; k starts at 1 and steps up. */
  maxGrouping?: number;
}

export interface PlotSizing {
  landM2: number;
  saleableM2: number;
  roadsM2: number;
  openSpaceM2: number;
  units: number;
  unitPlotAreaM2: number;
  /** Units grouped onto one plot; 1 means detached. */
  grouping: number;
  plotAreaM2: number;
  plots: number;
  /** Short side (frontage) and long side (depth). */
  widthM: number;
  depthM: number;
  aspect: number;
  minPlotAreaM2: number;
  /** min plot area after the client's aspect tolerance. */
  minPlotAreaWithToleranceM2: number;
  rowHousing: boolean;
  footprintM2: number;
  footprintWidthM: number;
  footprintDepthM: number;
  notes: string[];
}

/**
 * The client's 20/30/50 method, in the order the client stated it:
 * split the land, divide the saleable share by the unit count, group units onto
 * one plot when the unit plot falls below the minimum, then derive w x d.
 */
export function sizeVillaPlots(
  client: YamlDoc,
  landM2: number,
  units: number,
  opts: PlotSizingOptions = {},
): PlotSizing {
  const split = landSplit(client);
  const minSide = require$<number>(client, 'villa_plots.min_side_m', 'client minimum plot side');
  const aspectMax = require$<number>(client, 'villa_plots.aspect_ratio.max', 'client plot aspect ratio');
  const tolerance = require$<number>(client, 'villa_plots.aspect_tolerance', 'client aspect tolerance');
  const footprintShare = require$<number>(
    client,
    'villa_plots.footprint_placeholder.share_of_plot_area',
    'client villa footprint placeholder',
  );
  const footprintAspect = require$<number>(
    client,
    'villa_plots.footprint_placeholder.aspect_ratio',
    'client villa footprint placeholder',
  );
  const minSideApplies = opts.minSideApplies ?? (pick<MinSideApplies>(client, 'villa_plots.min_side_applies_to', 'long_side'));
  const maxGrouping = opts.maxGrouping ?? 8;

  // Long-side reading: the minimum plot is the 18 m side at the maximum aspect.
  // Both-sides reading: 18 x 18 = 324 m2.
  const minPlotArea =
    minSideApplies === 'both_sides' ? minSide * minSide : minSide * (minSide / aspectMax);
  // The client's own 126 m2 example sits just under 129.6 at 1:2.56, so the
  // stated aspect tolerance is applied to the minimum area too.
  const minPlotAreaTol = minPlotArea * (1 - tolerance);

  const saleableM2 = landM2 * split.saleable;
  const unitPlotArea = units > 0 ? saleableM2 / units : 0;

  let grouping = 1;
  while (grouping < maxGrouping && unitPlotArea * grouping < minPlotAreaTol) grouping++;
  const plotArea = unitPlotArea * grouping;
  const plots = grouping > 0 ? Math.floor(units / grouping) : 0;

  const dims = plotDims(plotArea, minSide, minSideApplies);
  const notes: string[] = [];
  if (grouping > 1) {
    notes.push(
      `Unit plot ${unitPlotArea.toFixed(1)} m² is below the ${minPlotArea.toFixed(1)} m² minimum, so ${grouping} units are grouped per plot (row housing).`,
    );
  }
  if (dims.aspect > aspectMax) {
    const over = dims.aspect / aspectMax - 1;
    notes.push(
      over <= tolerance
        ? `Aspect 1:${dims.aspect.toFixed(2)} is over the 1:${aspectMax} rule but inside the ${(tolerance * 100).toFixed(0)}% tolerance the client's own 126 m² example implies.`
        : `Aspect 1:${dims.aspect.toFixed(2)} exceeds the 1:${aspectMax} rule beyond tolerance.`,
    );
  }

  const footprintArea = plotArea * footprintShare;
  const footprintWidth = Math.sqrt(footprintArea / footprintAspect);

  return {
    landM2,
    saleableM2,
    roadsM2: landM2 * split.roads,
    openSpaceM2: landM2 * split.openSpace,
    units,
    unitPlotAreaM2: unitPlotArea,
    grouping,
    plotAreaM2: plotArea,
    plots,
    widthM: dims.width,
    depthM: dims.depth,
    aspect: dims.aspect,
    minPlotAreaM2: minPlotArea,
    minPlotAreaWithToleranceM2: minPlotAreaTol,
    rowHousing: grouping > 1,
    footprintM2: footprintArea,
    footprintWidthM: footprintWidth,
    footprintDepthM: footprintWidth * footprintAspect,
    notes,
  };
}

/**
 * Plot dimensions for a given area. Under the long-side reading the long side is
 * held at the 18 m minimum until the plot is big enough that the short side
 * would exceed it, after which the rectangle simply grows.
 */
export function plotDims(
  areaM2: number,
  minSideM: number,
  applies: MinSideApplies,
): { width: number; depth: number; aspect: number } {
  if (areaM2 <= 0) return { width: 0, depth: 0, aspect: 1 };
  if (applies === 'both_sides') {
    const width = Math.max(minSideM, Math.sqrt(areaM2));
    const depth = areaM2 / width;
    return depth >= width
      ? { width, depth, aspect: depth / width }
      : { width: depth, depth: width, aspect: width / depth };
  }
  const depth = Math.max(minSideM, areaM2 / minSideM);
  const width = areaM2 / depth;
  return { width, depth, aspect: depth / width };
}

export interface ClientSetbacks {
  frontM: number;
  rearM: number;
  sideM: number;
}

export const clientSetbacks = (client: YamlDoc): ClientSetbacks => ({
  frontM: require$<number>(client, 'setbacks_client.front_m', 'client setbacks'),
  rearM: require$<number>(client, 'setbacks_client.rear_m', 'client setbacks'),
  sideM: require$<number>(client, 'setbacks_client.side_m_each', 'client setbacks'),
});

export interface RoadWidths {
  spineM: number;
  publicM: number;
  internalM: number;
  culDeSacAreaM2: number;
  culDeSacSideM: number;
  innerTurningRadiusM: number;
}

export const roadWidths = (client: YamlDoc): RoadWidths => ({
  spineM: require$<number>(client, 'roads.main_spine.width_m', 'client road widths'),
  publicM: require$<number>(client, 'roads.public.width_m', 'client road widths'),
  internalM: require$<number>(client, 'roads.internal.width_m', 'client road widths'),
  culDeSacAreaM2: require$<number>(client, 'roads.cul_de_sac.turning_area_m2_min', 'client cul-de-sac'),
  culDeSacSideM: require$<number>(client, 'roads.cul_de_sac.turning_side_m_min', 'client cul-de-sac'),
  innerTurningRadiusM: require$<number>(client, 'roads.inner_turning_radius_m_min', 'client turning radius'),
});

/* ---------------------------------------------------------------- apartments */

export type BandName = '2BHK' | '3BHK' | '4BHK' | '5BHK';

export interface ApartmentInputs {
  landM2: number;
  fsi: number;
  floors: number;
  mix: BandName[];
  flatsPerFloor: number;
  /** Open item (SPEC §11): default 0.80. */
  flatsShareOfFootprint?: number;
  /**
   * Floors the footprint is sized against. The client's rule divides by the
   * literal 20 of their floor cap, which is the default; a scheme actually
   * built at fewer floors needs `floors` here, or it leaves FSI unused.
   */
  floorsForSizing?: number;
}

export interface ApartmentSizing {
  landM2: number;
  fsi: number;
  floors: number;
  totalFloorAreaM2: number;
  totalFootprintM2: number;
  footprintShareOfLand: number;
  buildableShare: { min: number; max: number };
  footprintShareOk: boolean;
  mix: BandName[];
  avgUnitPlinthSft: number;
  avgUnitPlinthM2: number;
  flatsPerFloor: number;
  plateM2: number;
  towers: number;
  flats: number;
  coreShare: number;
  flatsShare: number;
  notes: string[];
}

export function bandMidpointSft(client: YamlDoc, band: BandName): number {
  const range = require$<number[]>(client, `apartments.unit_bands_plinth_sft.${band}`, `client band ${band}`);
  return ((range[0] ?? 0) + (range[1] ?? 0)) / 2;
}

/**
 * The client's apartment method, §4.2, in the client's own order:
 * floor area = land x FSI; footprint = floor area / 20; plate = flats per floor
 * x average flat / flats share; towers = ceil(footprint / plate).
 *
 * Note the divisor is the literal 20 of the client's rule, not the floor count:
 * the client sizes the footprint against the 20-floor cap.
 */
export function sizeApartments(client: YamlDoc, input: ApartmentInputs): ApartmentSizing {
  const maxFloors = require$<number>(client, 'apartments.max_floors', 'client apartment cap');
  const coreShare = require$<number>(client, 'apartments.core_share_of_footprint', 'client core share');
  const flatsShare = input.flatsShareOfFootprint ?? require$<number>(client, 'apartments.flats_share_of_footprint', 'client flats share');
  const buildableShare = require$<{ min: number; max: number }>(
    client,
    'apartments.buildable_share_of_land',
    'client buildable share',
  );
  const perFloorRange = require$<{ min: number; max: number }>(
    client,
    'apartments.flats_per_floor',
    'client flats per floor',
  );

  const totalFloorArea = input.landM2 * input.fsi;
  const sizingFloors = input.floorsForSizing ?? maxFloors;
  const totalFootprint = totalFloorArea / sizingFloors;
  const avgSft = input.mix.reduce((s, b) => s + bandMidpointSft(client, b), 0) / Math.max(1, input.mix.length);
  const avgM2 = sftToM2(avgSft);
  const plate = (input.flatsPerFloor * avgM2) / flatsShare;
  const towers = plate > 0 ? Math.ceil(totalFootprint / plate) : 0;
  // Flats follow from the saleable share of the footprint over every floor,
  // independent of how they are split between towers.
  const flats = Math.round(((flatsShare * totalFootprint) / avgM2) * sizingFloors);

  const footprintShareOfLand = input.landM2 > 0 ? totalFootprint / input.landM2 : 0;
  const notes: string[] = [];
  if (input.floors > maxFloors) notes.push(`${input.floors} floors exceeds the client cap of ${maxFloors}.`);
  if (input.flatsPerFloor < perFloorRange.min || input.flatsPerFloor > perFloorRange.max) {
    notes.push(`${input.flatsPerFloor} flats per floor is outside the client's ${perFloorRange.min}–${perFloorRange.max} range.`);
  }
  if (footprintShareOfLand < buildableShare.min) {
    notes.push(
      `Footprint is ${(footprintShareOfLand * 100).toFixed(0)}% of the land, below the client's ${(buildableShare.min * 100).toFixed(0)}–${(buildableShare.max * 100).toFixed(0)}% buildable share: the land is under-used at this FSI, or more land should go to other uses.`,
    );
  }
  if (footprintShareOfLand > buildableShare.max) {
    notes.push(`Footprint is ${(footprintShareOfLand * 100).toFixed(0)}% of the land, above the client's ${(buildableShare.max * 100).toFixed(0)}% ceiling.`);
  }

  return {
    landM2: input.landM2,
    fsi: input.fsi,
    floors: input.floors,
    totalFloorAreaM2: totalFloorArea,
    totalFootprintM2: totalFootprint,
    footprintShareOfLand,
    buildableShare,
    footprintShareOk: footprintShareOfLand >= buildableShare.min && footprintShareOfLand <= buildableShare.max,
    mix: input.mix,
    avgUnitPlinthSft: avgSft,
    avgUnitPlinthM2: avgM2,
    flatsPerFloor: input.flatsPerFloor,
    plateM2: plate,
    towers,
    flats,
    coreShare,
    flatsShare,
    notes,
  };
}

export const allowedMixes = (client: YamlDoc): BandName[][] =>
  require$<BandName[][]>(client, 'apartments.allowed_mixes', 'client allowed mixes');

export interface TowerSpacing {
  minClearM: number;
  joinGapM: number;
  joinedInsideOffsetM: number;
}

export function towerSpacing(client: YamlDoc): TowerSpacing {
  return {
    minClearM: require$<number>(client, 'apartments.spacing.min_clear_m', 'client tower spacing'),
    joinGapM: require$<number>(client, 'apartments.spacing.joining.gap_m', 'client tower joining'),
    joinedInsideOffsetM: 6,
  };
}

/* --------------------------------------------------------------- commercial */

/** Client point 9: villa and senior SBUA = plinth + 150 sft. */
export function villaSbuaSft(client: YamlDoc, plinthSft: number): number {
  const formula = require$<string>(client, 'commercial_definitions.villa_sbua', 'client SBUA definition');
  const match = /plinth_sft\s*\+\s*([\d.]+)/.exec(formula);
  if (!match) throw new Error(`client_rules.commercial_definitions.villa_sbua: cannot read '${formula}'`);
  return plinthSft + Number(match[1]);
}

/** Client point 9: apartment SBUA = plinth x 1.22 x 1.08. */
export function apartmentSbuaSft(client: YamlDoc, plinthSft: number): number {
  const formula = require$<string>(client, 'commercial_definitions.apartment_sbua', 'client SBUA definition');
  const factors = [...formula.matchAll(/\*\s*([\d.]+)/g)].map((m) => Number(m[1]));
  if (factors.length === 0) throw new Error(`client_rules.commercial_definitions.apartment_sbua: cannot read '${formula}'`);
  return factors.reduce((v, f) => v * f, plinthSft);
}

export const acresToLandM2 = (ac: number): number => ac * M2_PER_ACRE;
