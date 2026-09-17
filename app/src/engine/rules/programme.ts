import { pick, require$ } from '../data/config';
import type { YamlDoc } from '../data/config';
import { M2_PER_ACRE, m2ToSft, sftToM2 } from '../units';
import { apartmentSbuaSft, villaSbuaSft } from './client';
import type { Occupancy } from './kmbr';
import { accessWidthM, coverageFsi, needsDtpApproval, parkingForFlats, parkingForOther } from './kmbr';

export type UseKind =
  | 'apartments'
  | 'villas'
  | 'senior'
  | 'school'
  | 'hospital'
  | 'club'
  | 'commercial'
  | 'hotel'
  | 'convention'
  | 'office';

export interface ProgrammeLineRaw {
  id: string;
  use: UseKind;
  occupancy: string;
  units?: number;
  keys?: number;
  plinth_sft?: number;
  bua_sft?: number;
  land_ac?: number | Record<string, number>;
  status?: string;
  type?: string;
  assumption?: boolean;
  host?: string;
  hall_m2?: number;
  phase1_sft?: number;
  [key: string]: unknown;
}

/** programme.yaml occupancy strings map onto the KMBR occupancy classes. */
const OCCUPANCY_MAP: Record<string, Occupancy> = {
  A1: 'A1',
  A2: 'A2',
  A2_senior_villa_style: 'A2_senior',
  B_upto_higher_secondary: 'B_school',
  C_hospital: 'C_hospital',
  D1: 'D1_recreational',
  D_convention: 'D_convention',
  E: 'E_office',
  F: 'F_commercial',
};

export interface ProgrammeLine {
  id: string;
  use: UseKind;
  occupancy: Occupancy;
  occupancyRaw: string;
  units: number;
  plinthSftPerUnit: number;
  /** Total plinth for unit-based lines, or the stated BUA for area-based lines. */
  totalPlinthSft: number;
  sbuaSftPerUnit: number;
  totalSbuaSft: number;
  landAc: number;
  landDetail: Record<string, number> | null;
  deferred: boolean;
  isAssumption: boolean;
  /** Occupants at the assumed household size; 0 for non-residential lines. */
  population: number;
  parkingCars: number;
  parkingAreaM2: number;
  accessWidthM: number;
  coveragePct: number;
  fsiFree: number;
  dtpApproval: boolean;
  notes: string[];
}

export interface ProgrammeSummary {
  lines: ProgrammeLine[];
  inScopeAc: number;
  deferredAc: number;
  /** Land the programme asks for, excluding deferred lines. */
  demandedAc: number;
  deferredDemandAc: number;
  shortfallAc: number;
  totalUnits: number;
  totalPlinthSft: number;
  totalSbuaSft: number;
  population: number;
  populationTargetNow: number;
  populationFinalCapacity: number;
  totalParkingCars: number;
  notes: string[];
}

const landAcOf = (line: ProgrammeLineRaw): { ac: number; detail: Record<string, number> | null } => {
  const land = line.land_ac;
  if (typeof land === 'number') return { ac: land, detail: null };
  if (land && typeof land === 'object') {
    const detail = land as Record<string, number>;
    // The zone total is the land the scheme has to find for this line.
    const ac = detail.zone_total ?? detail.developable ?? detail.core_campus ?? 0;
    return { ac, detail };
  }
  return { ac: 0, detail: null };
};

export function loadProgramme(
  programme: YamlDoc,
  client: YamlDoc,
  kmbr: YamlDoc,
  assumptions: YamlDoc,
): ProgrammeSummary {
  const rawLines = require$<ProgrammeLineRaw[]>(programme, 'lines', 'programme lines');
  const inScopeAc = require$<number>(programme, 'scope.in_scope_land_ac', 'programme scope');
  const deferredAc = require$<number>(programme, 'scope.deferred_land_ac', 'programme scope');
  const familySize = pick<number>(assumptions, 'household_size_family', 3.5);
  const seniorSize = pick<number>(assumptions, 'household_size_senior', 1.6);
  const grossM2PerCar = pick<number>(assumptions, 'parking_gross_m2_per_car', 30);
  const hotelSftPerKey = pick<number>(assumptions, 'hotel_gross_sft_per_key', 1000);

  const lines = rawLines.map<ProgrammeLine>((raw) => {
    const occupancy = OCCUPANCY_MAP[raw.occupancy] ?? 'A1';
    const { ac, detail } = landAcOf(raw);
    const deferred = typeof raw.status === 'string' && raw.status.startsWith('DEFERRED');
    const units = raw.units ?? raw.keys ?? 0;
    const plinthPerUnit = raw.plinth_sft ?? (raw.keys ? hotelSftPerKey : 0);
    const totalPlinth = raw.bua_sft ?? units * plinthPerUnit;

    const sbuaPerUnit =
      raw.use === 'apartments'
        ? apartmentSbuaSft(client, plinthPerUnit)
        : raw.use === 'villas' || raw.use === 'senior'
          ? villaSbuaSft(client, plinthPerUnit)
          : 0;
    const totalSbua = sbuaPerUnit > 0 ? sbuaPerUnit * units : totalPlinth;

    const population =
      raw.use === 'senior' ? units * seniorSize : raw.use === 'apartments' || raw.use === 'villas' ? units * familySize : 0;

    const floorAreaM2 = sftToM2(totalPlinth);
    const parking =
      raw.use === 'apartments'
        ? parkingForFlats(kmbr, units, sftToM2(plinthPerUnit), grossM2PerCar)
        : raw.use === 'villas'
          ? parkingForFlats(kmbr, units, sftToM2(plinthPerUnit), grossM2PerCar)
          : parkingForOther(kmbr, occupancy, floorAreaM2, grossM2PerCar);

    const cover = coverageFsi(kmbr, occupancy);
    const access = accessWidthM(kmbr, occupancy, floorAreaM2);
    const dtp = needsDtpApproval(kmbr, occupancy, { dwellingUnits: units || undefined, builtUpM2: floorAreaM2 });

    const notes: string[] = [];
    if (raw.assumption) notes.push('Added on an educated assumption (client decision, 17 Sep 2026) — editable.');
    if (deferred) notes.push('Deferred until the 26.4 ac balance land is acquired; nothing is placed in scope.');
    if (raw.host) notes.push(`Sits inside the ${String(raw.host).replace(/_/g, ' ')} land, not its own parcel.`);
    if (detail) {
      notes.push(
        `Land reads as ${Object.entries(detail)
          .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v} ac`)
          .join(', ')}.`,
      );
    }

    return {
      id: raw.id,
      use: raw.use,
      occupancy,
      occupancyRaw: raw.occupancy,
      units,
      plinthSftPerUnit: plinthPerUnit,
      totalPlinthSft: totalPlinth,
      sbuaSftPerUnit: sbuaPerUnit,
      totalSbuaSft: totalSbua,
      landAc: ac,
      landDetail: detail,
      deferred,
      isAssumption: Boolean(raw.assumption),
      population,
      parkingCars: parking.totalCars,
      parkingAreaM2: parking.totalParkingAreaM2,
      accessWidthM: access.widthM,
      coveragePct: cover.coveragePct,
      fsiFree: cover.fsiTiers[0] ?? 0,
      dtpApproval: dtp.needed,
      notes,
    };
  });

  const inScopeLines = lines.filter((l) => !l.deferred);
  const demandedAc = inScopeLines.reduce((s, l) => s + l.landAc, 0);
  const deferredDemandAc = lines.filter((l) => l.deferred).reduce((s, l) => s + l.landAc, 0);
  const shortfallAc = demandedAc - inScopeAc;

  const notes: string[] = [];
  if (shortfallAc > 0) {
    notes.push(
      `The programme asks for ${demandedAc.toFixed(1)} ac on ${inScopeAc.toFixed(2)} ac in scope: a shortfall of ${shortfallAc.toFixed(1)} ac (${((shortfallAc / inScopeAc) * 100).toFixed(0)}%). Something must give — fewer units, denser layouts, or phasing into the deferred land.`,
    );
  }
  notes.push(
    `The school line reads as a 10.3 ac zone around a 6.0 ac developable area and a 3.0 ac core campus; the zone total is counted here.`,
  );

  return {
    lines,
    inScopeAc,
    deferredAc,
    demandedAc,
    deferredDemandAc,
    shortfallAc,
    totalUnits: inScopeLines.reduce((s, l) => s + l.units, 0),
    totalPlinthSft: inScopeLines.reduce((s, l) => s + l.totalPlinthSft, 0),
    totalSbuaSft: inScopeLines.reduce((s, l) => s + l.totalSbuaSft, 0),
    population: inScopeLines.reduce((s, l) => s + l.population, 0),
    populationTargetNow: require$<number>(programme, 'population.target_now', 'programme population'),
    populationFinalCapacity: require$<number>(programme, 'population.final_capacity', 'programme population'),
    totalParkingCars: inScopeLines.reduce((s, l) => s + l.parkingCars, 0),
    notes,
  };
}

/** Land a use needs, in m2, from its programme line. */
export const lineLandM2 = (line: ProgrammeLine): number => line.landAc * M2_PER_ACRE;

/** Total built area a line implies, for reporting in both units. */
export const lineAreas = (line: ProgrammeLine): { plinthM2: number; plinthSft: number; sbuaSft: number } => ({
  plinthM2: sftToM2(line.totalPlinthSft),
  plinthSft: line.totalPlinthSft,
  sbuaSft: line.totalSbuaSft,
});

export const sftOf = (m2: number): number => m2ToSft(m2);
