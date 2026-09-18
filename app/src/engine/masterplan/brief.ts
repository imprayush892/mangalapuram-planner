import type { ProgrammeSummary } from '../rules/programme';
import type { ZoneUse } from '../site/level1';
import { USE_LABEL } from '../site/level1';
import type { Occupancy } from '../rules/kmbr';

/** Which generator a use is built with. */
export type ZoneKind = 'villa' | 'tower' | 'block' | 'none';

/**
 * What to build in one zone. Derived from the use the siting engine chose, not
 * from the zone's name: move a use to another zone and its brief moves with it,
 * which is what makes the master plan follow the siting rather than the client
 * zoning plan's labels.
 */
export interface ZoneBrief {
  zoneId: string;
  zoneName: string;
  use: ZoneUse;
  kind: ZoneKind;
  areaAc: number;
  /** This zone's share of all the land the use holds, 0-1. */
  shareOfUse: number;
  targetUnits: number;
  senior: boolean;
  occupancy: Occupancy;
  builtUpSft: number;
  useLabel: string;
  maxSlopeDeg?: number;
  /** Plinth per dwelling the programme asks for, on a villa or senior zone. */
  wantedPlinthSft?: number;
  /** Client villa type that plinth belongs to. */
  villaTypeName?: string;
  /** Why these numbers, for the report and the tooltip. */
  basis: string;
  /** Set when nothing is generated here, and why. */
  skipReason?: string;
}

interface BlockSpec {
  occupancy: Occupancy;
  lineIds: string[];
  maxSlopeDeg?: number;
}

/** Uses that get a massing block rather than a subdivided internal layout. */
const BLOCK_USES: Partial<Record<ZoneUse, BlockSpec>> = {
  school: { occupancy: 'B_school', lineIds: ['school'], maxSlopeDeg: 8 },
  club: { occupancy: 'D1_recreational', lineIds: ['clubhouse_annex', 'clubhouse_golf'] },
  commercial: { occupancy: 'F_commercial', lineIds: ['commercial', 'convention'] },
  hotel: { occupancy: 'A2', lineIds: ['hotel'] },
  office: { occupancy: 'E_office', lineIds: ['business_hub'] },
};

export function kindForUse(use: ZoneUse): ZoneKind {
  if (use === 'villas' || use === 'senior') return 'villa';
  if (use === 'apartments') return 'tower';
  if (BLOCK_USES[use]) return 'block';
  return 'none';
}

/** The cashflow sizes villa land at 20 units per acre (sheet C17: 640 / 20). */
const VILLA_UNITS_PER_AC = 20;

function sumBy<T>(rows: T[], f: (row: T) => number): number {
  return rows.reduce((s, r) => s + f(r), 0);
}

export interface BriefInput {
  zoneId: string;
  zoneName: string;
  use: ZoneUse;
  areaAc: number;
  /** Total acreage the siting engine gave this use across every zone. */
  useTotalAc: number;
  programme: ProgrammeSummary;
  householdSizeFamily: number;
  householdSizeSenior: number;
}

/**
 * A use spread over several zones splits its programme between them by area, so
 * two villa zones of 9 and 5 acres carry the unit counts their land supports
 * rather than each trying to hold the whole line.
 */
export function briefForZone(input: BriefInput): ZoneBrief {
  const { use, areaAc, useTotalAc, programme } = input;
  const kind = kindForUse(use);
  const share = useTotalAc > 0 ? areaAc / useTotalAc : 1;
  const senior = use === 'senior';

  const base = {
    zoneId: input.zoneId,
    zoneName: input.zoneName,
    use,
    kind,
    areaAc,
    shareOfUse: share,
    senior,
    useLabel: USE_LABEL[use],
  };

  if (kind === 'none') {
    return {
      ...base,
      targetUnits: 0,
      occupancy: 'A1',
      builtUpSft: 0,
      basis: 'no generator for this use',
      skipReason:
        use === 'hospital_reserved'
          ? 'reserved for the hospital on deferred land; nothing is placed here'
          : `no generator is built for ${USE_LABEL[use]} yet`,
    };
  }

  if (kind === 'block') {
    const spec = BLOCK_USES[use];
    if (!spec) throw new Error(`no block spec for ${use}`);
    const lines = programme.lines.filter((l) => spec.lineIds.includes(l.id));
    const builtUpSft = sumBy(lines, (l) => l.totalPlinthSft) * share;
    return {
      ...base,
      targetUnits: 0,
      occupancy: spec.occupancy,
      builtUpSft,
      maxSlopeDeg: spec.maxSlopeDeg,
      basis:
        share < 0.999
          ? `${Math.round(share * 100)}% of ${spec.lineIds.join(' + ')} plinth, this zone's share of the ${useTotalAc.toFixed(1)} ac the use holds`
          : `${spec.lineIds.join(' + ')} plinth from the programme`,
      skipReason: builtUpSft > 0 ? undefined : `no programme line gives ${USE_LABEL[use]} any built-up area`,
    };
  }

  if (senior) {
    // The senior lines state their own unit counts and land; keep their density.
    const lines = programme.lines.filter((l) => l.use === 'senior');
    const totalAc = sumBy(lines, (l) => l.landAc);
    const totalUnits = sumBy(lines, (l) => l.units);
    const perAc = totalAc > 0 ? totalUnits / totalAc : 0;
    return {
      ...base,
      targetUnits: Math.round(perAc * areaAc),
      occupancy: 'A2_senior',
      builtUpSft: 0,
      wantedPlinthSft: weightedPlinthSft(lines),
      basis: `${perAc.toFixed(1)} units/ac from the senior programme lines × ${areaAc.toFixed(2)} ac`,
    };
  }

  if (kind === 'tower') {
    const lines = programme.lines.filter((l) => l.use === 'apartments');
    const totalAc = sumBy(lines, (l) => l.landAc);
    const totalUnits = sumBy(lines, (l) => l.units);
    const perAc = totalAc > 0 ? totalUnits / totalAc : 0;
    return {
      ...base,
      targetUnits: Math.round(perAc * areaAc),
      occupancy: 'A1',
      builtUpSft: 0,
      basis: `${perAc.toFixed(0)} flats/ac from the apartment programme lines × ${areaAc.toFixed(2)} ac`,
    };
  }

  const villaLines = programme.lines.filter((l) => l.use === 'villas');
  return {
    ...base,
    targetUnits: Math.round(areaAc * VILLA_UNITS_PER_AC),
    occupancy: 'A1',
    builtUpSft: 0,
    wantedPlinthSft: weightedPlinthSft(villaLines),
    villaTypeName: 'standard',
    basis: `${VILLA_UNITS_PER_AC} units/ac (cashflow sheet C17) × ${areaAc.toFixed(2)} ac`,
  };
}

/**
 * Plinth per dwelling across a use's programme lines, weighted by unit count —
 * the villa lines state 1,750 and 2,000 sft, and a zone carries a share of both.
 */
function weightedPlinthSft(lines: { units: number; plinthSftPerUnit: number }[]): number {
  const units = sumBy(lines, (l) => l.units);
  if (units <= 0) return 0;
  return sumBy(lines, (l) => l.units * l.plinthSftPerUnit) / units;
}
