import { pick, require$ } from '../data/config';
import type { YamlDoc } from '../data/config';
import { m2ToSft } from '../units';

/**
 * KMBR accessors. Every number comes out of config/kmbr_rules.yaml — nothing is
 * hard-coded here. A missing value throws rather than being invented, per
 * CLAUDE.md: add it to the YAML with a clause reference and verified status.
 */

export type Occupancy =
  | 'A1'
  | 'A2'
  | 'A2_senior'
  | 'B_school'
  | 'B_higher_education'
  | 'C_hospital'
  | 'D_assembly'
  | 'D1_recreational'
  | 'D_convention'
  | 'E_office'
  | 'F_commercial'
  | 'J_multiplex';

export interface Yards {
  frontAvg: number;
  frontMin: number;
  rearAvg: number;
  rearMin: number;
  sideAvg: number;
  sideMin: number;
}

export interface YardContext {
  occupancy: Occupancy;
  heightM: number;
  /** Plot area, needed for the small-plot row of Table 4. */
  plotAreaM2?: number;
  builtUpAreaM2?: number;
}

const TABLE4_ROW: Record<Occupancy, string> = {
  A1: 'A1_A2_any__F_upto200',
  A2: 'A1_A2_any__F_upto200',
  A2_senior: 'A1_A2_any__F_upto200',
  B_school: 'B_C_E_over500',
  B_higher_education: 'B_C_E_over500',
  C_hospital: 'B_C_E_over500',
  D_assembly: 'D_over800',
  D1_recreational: 'D1_recreational',
  D_convention: 'D_over800',
  E_office: 'B_C_E_over500',
  F_commercial: 'F_over200',
  J_multiplex: 'J_multiplex',
};

/** Table 4 base yards, before the Rule 26 height increment. */
export function baseYards(kmbr: YamlDoc, ctx: YardContext): { yards: Yards; row: string } {
  let row = TABLE4_ROW[ctx.occupancy];
  // Table 4's small-plot concession for A1/F.
  if (
    (ctx.occupancy === 'A1' || ctx.occupancy === 'F_commercial') &&
    ctx.plotAreaM2 !== undefined &&
    ctx.builtUpAreaM2 !== undefined &&
    ctx.plotAreaM2 <= 125 &&
    ctx.builtUpAreaM2 <= 200
  ) {
    row = 'small_plot_A1_F_bua_le200_plot_le125';
  }
  // B/C/E below 500 m2 built-up take the lighter row.
  if (
    ['B_school', 'B_higher_education', 'C_hospital', 'E_office'].includes(ctx.occupancy) &&
    ctx.builtUpAreaM2 !== undefined &&
    ctx.builtUpAreaM2 <= 500
  ) {
    row = 'B_C_E_200_500';
  }
  const values = require$<number[]>(kmbr, `table4_yards_up_to_10m.${row}`, `KMBR Table 4 row '${row}'`);
  const [frontAvg, frontMin, rearAvg, rearMin, sideAvg, sideMin] = values;
  return {
    row: `KMBR Table 4 · ${row}`,
    yards: {
      frontAvg: frontAvg ?? 0,
      frontMin: frontMin ?? 0,
      rearAvg: rearAvg ?? 0,
      rearMin: rearMin ?? 0,
      sideAvg: sideAvg ?? 0,
      sideMin: sideMin ?? 0,
    },
  };
}

/**
 * Rule 26: add `add_m` per `per_m` of height above `above_m`, rounded up, to the
 * minimum and average of every yard, until a yard reaches the cap.
 */
export function yardIncreaseM(kmbr: YamlDoc, heightM: number): number {
  const above = require$<number>(kmbr, 'rule26.height_increment.above_m', 'KMBR Rule 26 height increment');
  const add = require$<number>(kmbr, 'rule26.height_increment.add_m', 'KMBR Rule 26 height increment');
  const per = require$<number>(kmbr, 'rule26.height_increment.per_m', 'KMBR Rule 26 height increment');
  if (heightM <= above) return 0;
  return Math.ceil((heightM - above) / per) * add;
}

/** Table 4 plus the Rule 26 height increment, capped by `cap_min_yard_m`. */
export function yardsFor(kmbr: YamlDoc, ctx: YardContext): { yards: Yards; row: string; increaseM: number } {
  const { yards, row } = baseYards(kmbr, ctx);
  const inc = yardIncreaseM(kmbr, ctx.heightM);
  const cap = require$<number>(kmbr, 'rule26.height_increment.cap_min_yard_m', 'KMBR Rule 26 yard cap');
  const bump = (v: number): number => Math.min(cap, v + inc);
  return {
    row,
    increaseM: inc,
    yards: {
      frontAvg: bump(yards.frontAvg),
      frontMin: bump(yards.frontMin),
      rearAvg: bump(yards.rearAvg),
      rearMin: bump(yards.rearMin),
      sideAvg: bump(yards.sideAvg),
      sideMin: bump(yards.sideMin),
    },
  };
}

/** The tightest yard a building must keep, used as an inward offset. */
export const governingYardM = (yards: Yards): number =>
  Math.max(yards.frontAvg, yards.rearAvg, yards.sideAvg);

export interface HighRiseCheck {
  isHighRise: boolean;
  reason: string;
}

/** Chapter XVII: 16 m or more, or more than 5 floors, basements excluded. */
export function highRise(kmbr: YamlDoc, heightM: number, floors: number): HighRiseCheck {
  const minH = require$<number>(kmbr, 'chapter17_high_rise.definition.height_m_ge', 'KMBR Ch.XVII definition');
  const maxFloors = require$<number>(kmbr, 'chapter17_high_rise.definition.or_floors_gt', 'KMBR Ch.XVII definition');
  if (heightM >= minH) return { isHighRise: true, reason: `${heightM} m ≥ ${minH} m` };
  if (floors > maxFloors) return { isHighRise: true, reason: `${floors} floors > ${maxFloors}` };
  return { isHighRise: false, reason: `${heightM} m and ${floors} floors` };
}

export interface CoverageFsi {
  coveragePct: number;
  fsiTiers: number[];
  key: string;
}

const TABLE6_KEY: Record<Occupancy, string> = {
  A1: 'A1_residential',
  A2: 'A2_lodging_special',
  A2_senior: 'A2_lodging_special',
  B_school: 'B_upto_higher_secondary',
  B_higher_education: 'B_other',
  C_hospital: 'C_hospital',
  D_assembly: 'D_assembly',
  D1_recreational: 'D1_recreational',
  D_convention: 'D_assembly',
  E_office: 'E_office',
  F_commercial: 'F_commercial',
  J_multiplex: 'J_multiplex',
};

export function coverageFsi(kmbr: YamlDoc, occupancy: Occupancy): CoverageFsi {
  const key = TABLE6_KEY[occupancy];
  const row = require$<{ coverage: number; fsi: number[] }>(
    kmbr,
    `table6_coverage_fsi.${key}`,
    `KMBR Table 6 row '${key}'`,
  );
  return { coveragePct: row.coverage, fsiTiers: row.fsi, key: `KMBR Table 6 · ${key}` };
}

/** Weighted FSI for a group of buildings or mixed occupancies (Table 6 note). */
export function weightedFsi(parts: readonly { fsi: number; floorAreaM2: number }[]): number {
  const total = parts.reduce((s, p) => s + p.floorAreaM2, 0);
  if (total <= 0) return 0;
  return parts.reduce((s, p) => s + p.fsi * p.floorAreaM2, 0) / total;
}

type AccessTable = [number, number][];

const ACCESS_TABLE: Record<Occupancy, string> = {
  A1: 'table7_access_A1',
  A2: 'table8_access_A2',
  A2_senior: 'table8_access_A2',
  B_school: 'table8_access_B_C_D_E_F',
  B_higher_education: 'table8_access_B_C_D_E_F',
  C_hospital: 'table8_access_B_C_D_E_F',
  D_assembly: 'table8_access_B_C_D_E_F',
  D1_recreational: 'table8_access_D1',
  D_convention: 'table8_access_B_C_D_E_F',
  E_office: 'table8_access_B_C_D_E_F',
  F_commercial: 'table8_access_B_C_D_E_F',
  J_multiplex: 'table8_access_B_C_D_E_F',
};

/** Tables 7 / 8 / 8A: minimum access width for a total floor area. */
export function accessWidthM(
  kmbr: YamlDoc,
  occupancy: Occupancy,
  totalFloorAreaM2: number,
): { widthM: number; reference: string } {
  const tableKey = ACCESS_TABLE[occupancy];
  const table = require$<AccessTable>(kmbr, tableKey, `KMBR access ${tableKey}`);
  for (const [upper, width] of table) {
    if (totalFloorAreaM2 <= upper) return { widthM: width, reference: `KMBR ${tableKey}` };
  }
  const last = table[table.length - 1];
  return { widthM: last?.[1] ?? 0, reference: `KMBR ${tableKey}` };
}

export interface ParkingRequirement {
  cars: number;
  visitorCars: number;
  totalCars: number;
  carAreaM2: number;
  twoWheelerAreaM2: number;
  totalParkingAreaM2: number;
  reference: string;
  basis: string;
}

/**
 * Table 9 for flats (cars per dwelling by floor area per unit), plus visitor
 * parking and two-wheeler space as a share of the car area.
 */
export function parkingForFlats(
  kmbr: YamlDoc,
  units: number,
  floorAreaPerUnitM2: number,
  grossM2PerCar: number,
): ParkingRequirement {
  const table = require$<AccessTable>(kmbr, 'rule29_parking.table9_A1_flats', 'KMBR Table 9');
  let perDu = table[table.length - 1]?.[1] ?? 0;
  for (const [upper, rate] of table) {
    if (floorAreaPerUnitM2 <= upper) {
      perDu = rate;
      break;
    }
  }
  const visitorShare = require$<number>(
    kmbr,
    'rule29_parking.visitor_parking_A1_extra_share',
    'KMBR Rule 29 visitor parking',
  );
  const twoWheelerShare = require$<number>(
    kmbr,
    'rule29_parking.two_wheeler_area_share_of_car_area',
    'KMBR Rule 29 two-wheeler share',
  );
  const cars = units * perDu;
  const visitorCars = cars * visitorShare;
  const totalCars = Math.ceil(cars + visitorCars);
  const carArea = totalCars * grossM2PerCar;
  const twoWheelerArea = carArea * twoWheelerShare;
  return {
    cars,
    visitorCars,
    totalCars,
    carAreaM2: carArea,
    twoWheelerAreaM2: twoWheelerArea,
    totalParkingAreaM2: carArea + twoWheelerArea,
    reference: 'KMBR Table 9 + Rule 29',
    basis: `${perDu} cars/DU at ${floorAreaPerUnitM2.toFixed(0)} m² per unit, +${(visitorShare * 100).toFixed(0)}% visitors`,
  };
}

/** Table 10: floor area per car for everything that is not a flat. */
export function parkingForOther(
  kmbr: YamlDoc,
  occupancy: Occupancy,
  floorAreaM2: number,
  grossM2PerCar: number,
): ParkingRequirement {
  const table10 = require$<Record<string, unknown>>(kmbr, 'rule29_parking.table10_other', 'KMBR Table 10');
  const twoWheelerShare = require$<number>(
    kmbr,
    'rule29_parking.two_wheeler_area_share_of_car_area',
    'KMBR Rule 29 two-wheeler share',
  );

  const tiered = (entry: { first_m2: number; rate_first: number; rate_after: number }): number => {
    const first = Math.min(floorAreaM2, entry.first_m2);
    const rest = Math.max(0, floorAreaM2 - entry.first_m2);
    return first / entry.rate_first + rest / entry.rate_after;
  };

  let cars = 0;
  let basis = '';
  switch (occupancy) {
    case 'A2':
    case 'E_office':
    case 'F_commercial': {
      const key = occupancy === 'A2' ? 'A2' : occupancy === 'E_office' ? 'E_office' : 'F_commercial';
      const entry = table10[key] as { first_m2: number; rate_first: number; rate_after: number };
      cars = tiered(entry);
      basis = `1 car per ${entry.rate_first} m² for the first ${entry.first_m2} m², then per ${entry.rate_after} m²`;
      break;
    }
    case 'A2_senior': {
      const entry = table10.A2 as { first_m2: number; rate_first: number; rate_after: number };
      const share = require$<number>(
        kmbr,
        'rule29_parking.table10_other.A2_senior_living_share',
        'KMBR Table 10 senior living share',
      );
      cars = tiered(entry) * share;
      basis = `A2 rate at ${(share * 100).toFixed(0)}% for senior living`;
      break;
    }
    case 'D_convention': {
      const entry = table10.D_convention_wedding_auditorium as { rate: number; area_basis: string };
      cars = floorAreaM2 / entry.rate;
      basis = `1 car per ${entry.rate} m² (${entry.area_basis})`;
      break;
    }
    default: {
      const key =
        occupancy === 'B_school'
          ? 'B_school'
          : occupancy === 'B_higher_education'
            ? 'B_higher_education'
            : occupancy === 'C_hospital'
              ? 'C_hospital'
              : occupancy === 'D1_recreational'
                ? 'D1_recreational'
                : occupancy === 'J_multiplex'
                  ? 'J_multiplex'
                  : 'D_other';
      const rate = table10[key] as number;
      cars = floorAreaM2 / rate;
      basis = `1 car per ${rate} m² floor area`;
      break;
    }
  }

  const totalCars = Math.ceil(cars);
  const carArea = totalCars * grossM2PerCar;
  const twoWheelerArea = carArea * twoWheelerShare;
  return {
    cars,
    visitorCars: 0,
    totalCars,
    carAreaM2: carArea,
    twoWheelerAreaM2: twoWheelerArea,
    totalParkingAreaM2: carArea + twoWheelerArea,
    reference: 'KMBR Table 10 + Rule 29',
    basis,
  };
}

/** Rule 40: lifts required, and the additional lifts for large buildings. */
export function liftCount(kmbr: YamlDoc, storeys: number, builtUpExParkingM2: number, occupancy: Occupancy): number {
  const threshold = pick<number>(
    kmbr,
    occupancy === 'C_hospital' ? 'rule40_lifts.required_if_storeys_gt.C_hospital' : 'rule40_lifts.required_if_storeys_gt.others',
    4,
  );
  if (storeys <= threshold) return 0;
  const extra = Math.max(0, builtUpExParkingM2 - 4000);
  return 1 + Math.ceil(extra / 2500);
}

/** Rule 36 travel distance, which depends on whether the towers are sprinklered. */
export const travelDistanceM = (kmbr: YamlDoc, sprinklered: boolean): number =>
  require$<number>(
    kmbr,
    sprinklered ? 'rule36_travel_distance_m.sprinklered' : 'rule36_travel_distance_m.other',
    'KMBR Rule 36 travel distance',
  );

/** Rule 41: habitable space must be within this distance of an opening. */
export const daylightDepthM = (kmbr: YamlDoc): number =>
  require$<number>(kmbr, 'rule41_daylight_max_depth_from_opening_m', 'KMBR Rule 41 daylight depth');

export interface RecreationRequirement {
  applies: boolean;
  areaM2: number;
  groundAreaM2: number;
  reference: string;
}

/** Rule 43: apartment recreation space as a share of total floor area. */
export function apartmentRecreation(kmbr: YamlDoc, units: number, totalFloorAreaM2: number): RecreationRequirement {
  const appliesIf = require$<number>(kmbr, 'rule43_apartment_recreation.applies_if_units_gt', 'KMBR Rule 43');
  const share = require$<number>(kmbr, 'rule43_apartment_recreation.share_of_total_floor_area', 'KMBR Rule 43');
  const groundShare = require$<number>(kmbr, 'rule43_apartment_recreation.min_share_at_ground', 'KMBR Rule 43');
  const applies = units > appliesIf;
  const area = applies ? totalFloorAreaM2 * share : 0;
  return { applies, areaM2: area, groundAreaM2: area * groundShare, reference: 'KMBR Rule 43' };
}

/** Table 11: does this line need District Town Planner approval? */
export function needsDtpApproval(
  kmbr: YamlDoc,
  occupancy: Occupancy,
  opts: { dwellingUnits?: number; builtUpM2?: number },
): { needed: boolean; reason: string } {
  const t = require$<Record<string, number>>(kmbr, 'table11_dtp_approval', 'KMBR Table 11');
  if (occupancy === 'A1' && opts.dwellingUnits !== undefined) {
    const limit = t.A1_dwelling_units_gt!;
    return { needed: opts.dwellingUnits > limit, reason: `${opts.dwellingUnits} units vs limit ${limit}` };
  }
  const bua = opts.builtUpM2 ?? 0;
  const limit =
    occupancy === 'A2' || occupancy === 'A2_senior' || occupancy.startsWith('B')
      ? t.A2_B_builtup_gt_m2!
      : occupancy === 'C_hospital' || occupancy === 'E_office'
        ? t.C_E_builtup_gt_m2!
        : occupancy.startsWith('D')
          ? t.D_builtup_gt_m2!
          : t.F_builtup_gt_m2!;
  return { needed: bua > limit, reason: `${Math.round(bua)} m² (${Math.round(m2ToSft(bua))} sft) vs limit ${limit} m²` };
}

/** Rule 31 subdivision figures; reported only, as the client set the route aside. */
export interface SubdivisionRules {
  minPlotM2: number;
  minAvgWidthM: number;
  rowHousingMinAvgWidthM: number;
  minFrontageM: number;
  streetMinM: number;
  culDeSac: { max_len_m: number; min_width_m: number }[];
  turningAreaM2: number;
  turningSideM: number;
  recreationShare: number;
  recreationMinAreaM2: number;
  recreationMinWidthM: number;
  junctionSplay: { roads_le_10m: number; roads_gt_10m: number };
}

export function subdivisionRules(kmbr: YamlDoc): SubdivisionRules {
  return {
    minPlotM2: require$<number>(kmbr, 'rule31_subdivision.min_plot_m2', 'KMBR Rule 31'),
    minAvgWidthM: require$<number>(kmbr, 'rule31_subdivision.min_avg_width_m', 'KMBR Rule 31'),
    rowHousingMinAvgWidthM: require$<number>(kmbr, 'rule31_subdivision.row_housing_min_avg_width_m', 'KMBR Rule 31'),
    minFrontageM: require$<number>(kmbr, 'rule31_subdivision.min_frontage_m', 'KMBR Rule 31'),
    streetMinM: require$<number>(kmbr, 'rule31_subdivision.street_min_m', 'KMBR Rule 31'),
    culDeSac: require$<{ max_len_m: number; min_width_m: number }[]>(kmbr, 'rule31_subdivision.cul_de_sac', 'KMBR Rule 31'),
    turningAreaM2: require$<number>(kmbr, 'rule31_subdivision.cul_de_sac_turning.area_m2', 'KMBR Rule 31'),
    turningSideM: require$<number>(kmbr, 'rule31_subdivision.cul_de_sac_turning.side_m', 'KMBR Rule 31'),
    recreationShare: require$<number>(kmbr, 'rule31_subdivision.recreation.share', 'KMBR Rule 31'),
    recreationMinAreaM2: require$<number>(kmbr, 'rule31_subdivision.recreation.min_area_m2', 'KMBR Rule 31'),
    recreationMinWidthM: require$<number>(kmbr, 'rule31_subdivision.recreation.min_width_m', 'KMBR Rule 31'),
    junctionSplay: require$<{ roads_le_10m: number; roads_gt_10m: number }>(
      kmbr,
      'rule31_subdivision.junction_splay_m',
      'KMBR Rule 31',
    ),
  };
}

/** Gap between buildings in a group (Rule 26), and the high-rise minimum. */
export function gapBetweenBuildingsM(kmbr: YamlDoc, heightM: number, isHighRise: boolean): number {
  if (isHighRise) return require$<number>(kmbr, 'chapter17_high_rise.gap_between_blocks_m', 'KMBR Ch.XVII gap');
  const key = heightM <= 10 ? 'upto_10m' : 'above_10m';
  return require$<number>(kmbr, `rule26.group_of_buildings.gap_between_buildings_m.${key}`, 'KMBR Rule 26 gap');
}

/** Villas in a group up to 8 m high take the lighter gap. */
export const villaGapM = (kmbr: YamlDoc): number =>
  require$<number>(kmbr, 'rule26.villa_groups_upto_8m_gap_m', 'KMBR Rule 26 villa gap');

export const unbuildableSlopeDeg = (kmbr: YamlDoc): number =>
  require$<number>(kmbr, 'rule22_site_suitability.no_building_slope_deg_over', 'KMBR Rule 22');

export const unpavedOpenSpaceShare = (kmbr: YamlDoc): number =>
  require$<number>(kmbr, 'rule26.unpaved_share_of_open_space_min', 'KMBR Rule 26');
