import type { MultiPoly } from '../geom/types';
import { multiPolyArea } from '../geom/planar';
import { m2ToAcres, m2ToSft } from '../units';
import type { Zone } from './types';
import type { LayoutOption } from '../generators/types';
import type { ProgrammeLine, ProgrammeSummary, UseKind } from '../rules/programme';
import type { Occupancy } from '../rules/kmbr';
import type { Finding } from '../rules/findings';
import { fail, info, pass, warn } from '../rules/findings';

/**
 * Level 1 is the allocation of uses to zones, and the loop that compares what
 * the Level 2 generators actually yield against what the programme asks for.
 * The client zoning plan is the starting point; the user edits it and the loop
 * reports what still does not fit.
 */

export type ZoneUse =
  | 'villas'
  | 'senior'
  | 'apartments'
  | 'school'
  | 'club'
  | 'commercial'
  | 'hotel'
  | 'office'
  | 'hospital_reserved'
  | 'infrastructure'
  | 'unassigned';

export interface ZoneAssignment {
  zoneId: string;
  zoneName: string;
  use: ZoneUse;
  areaAc: number;
  /** Programme lines this zone is expected to carry. */
  lineIds: string[];
}

export const USE_LABEL: Record<ZoneUse, string> = {
  villas: 'Villas',
  senior: 'Senior living',
  apartments: 'Apartments',
  school: 'School',
  club: 'Club and mini golf',
  commercial: 'Commercial and convention',
  hotel: 'Hotel',
  office: 'Business hub',
  hospital_reserved: 'Hospital (reserved, deferred land)',
  infrastructure: 'Infrastructure',
  unassigned: 'Unassigned',
};

/** KMBR occupancy each use is checked under. */
export const USE_OCCUPANCY: Record<ZoneUse, Occupancy> = {
  villas: 'A1',
  senior: 'A2_senior',
  apartments: 'A1',
  school: 'B_school',
  club: 'D1_recreational',
  commercial: 'F_commercial',
  hotel: 'A2',
  office: 'E_office',
  hospital_reserved: 'C_hospital',
  infrastructure: 'F_commercial',
  unassigned: 'A1',
};

/** How a zone's name in the client plan maps onto a use. */
export function inferUse(zoneName: string): ZoneUse {
  const n = zoneName.toUpperCase();
  if (n.includes('APARTMENT')) return 'apartments';
  if (n.includes('SENIOR')) return 'senior';
  if (n.includes('VILLA') || n.startsWith('PHASE')) return 'villas';
  if (n.includes('SCHOOL')) return 'school';
  if (n.includes('CLUB')) return 'club';
  if (n.includes('COMMERCIAL') || n.includes('CONVENTION')) return 'commercial';
  if (n.includes('HOSPITAL')) return 'hospital_reserved';
  if (n.includes('BATCHING')) return 'infrastructure';
  return 'unassigned';
}

/** Programme lines that belong to a use. */
const USE_LINES: Record<ZoneUse, UseKind[]> = {
  villas: ['villas'],
  senior: ['senior'],
  apartments: ['apartments'],
  school: ['school'],
  club: ['club'],
  commercial: ['commercial', 'convention'],
  hotel: ['hotel'],
  office: ['office'],
  hospital_reserved: ['hospital'],
  infrastructure: [],
  unassigned: [],
};

export function assignZones(
  zones: Zone[],
  programme: ProgrammeSummary,
  zoneUses: Record<string, ZoneUse> = {},
): ZoneAssignment[] {
  return zones
    .filter((z) => z.geom.length > 0)
    .map((z) => {
      const use = zoneUses[z.id] ?? inferUse(z.name);
      const uses = USE_LINES[use];
      return {
        zoneId: z.id,
        zoneName: z.name,
        use,
        areaAc: z.computedInScopeAc,
        lineIds: programme.lines.filter((l) => uses.includes(l.use)).map((l) => l.id),
      };
    });
}

export interface UseBalance {
  use: ZoneUse;
  /** Land the programme asks for, in acres. */
  demandAc: number;
  /** Land the zoning plan gives it, in acres. */
  zonedAc: number;
  /** Units or sft the programme asks for. */
  targetUnits: number;
  targetBuiltUpSft: number;
  /** What the Level 2 generators actually placed on the zoned land. */
  generatedUnits: number;
  generatedBuiltUpSft: number;
  /** Zones generated so far, of the zones assigned to this use. */
  zonesGenerated: number;
  zonesTotal: number;
  deferred: boolean;
}

export interface Level1Result {
  assignments: ZoneAssignment[];
  balances: UseBalance[];
  inScopeAc: number;
  zonedAc: number;
  /** Land inside the parcel that no zone covers. */
  unzonedAc: number;
  demandAc: number;
  shortfallAc: number;
  totalGeneratedUnits: number;
  populationCapacity: number;
  populationTarget: number;
  populationFinalCapacity: number;
  findings: Finding[];
}

export interface Level1Input {
  zones: Zone[];
  parcel: MultiPoly;
  programme: ProgrammeSummary;
  /** Best option per zone, from the Level 2 generators. */
  generated: Record<string, LayoutOption[]>;
  householdSizes: { family: number; senior: number };
  /**
   * Use per zone from the siting engine. Without it the use is inferred from
   * the zone's name in the client zoning plan, which is a starting point only.
   */
  zoneUses?: Record<string, ZoneUse>;
}

/**
 * Runs the Level 1 loop: compare the yields the generators actually produced
 * with the programme, and say what has to give. Nothing here rounds a problem
 * away — the shortfall is the finding the client needs.
 */
export function runLevel1(input: Level1Input): Level1Result {
  const { zones, parcel, programme, generated } = input;
  const assignments = assignZones(zones, programme, input.zoneUses);

  const zonedAreaM2 = zones.filter((z) => z.geom.length > 0).reduce((s, z) => s + multiPolyArea(z.geom), 0);
  const parcelAreaM2 = multiPolyArea(parcel);

  const uses = [...new Set(assignments.map((a) => a.use))].filter((u) => u !== 'unassigned');
  const balances: UseBalance[] = uses.map((use) => {
    const zonesForUse = assignments.filter((a) => a.use === use);
    const lines = programme.lines.filter((l) => USE_LINES[use].includes(l.use));
    const deferred = lines.length > 0 && lines.every((l) => l.deferred);
    const best = zonesForUse.map((a) => (generated[a.zoneId] ?? [])[0]).filter(Boolean) as LayoutOption[];
    return {
      use,
      demandAc: lines.reduce((s, l) => s + l.landAc, 0),
      zonedAc: zonesForUse.reduce((s, a) => s + a.areaAc, 0),
      targetUnits: lines.reduce((s, l) => s + l.units, 0),
      targetBuiltUpSft: lines.reduce((s, l) => s + l.totalPlinthSft, 0),
      generatedUnits: best.reduce((s, o) => s + o.metrics.unitCount, 0),
      generatedBuiltUpSft: best.reduce((s, o) => s + m2ToSft(o.metrics.totalFloorAreaM2), 0),
      zonesGenerated: best.length,
      zonesTotal: zonesForUse.length,
      deferred,
    };
  });

  const populationCapacity = balances.reduce((s, b) => {
    if (b.use === 'senior') return s + b.generatedUnits * input.householdSizes.senior;
    if (b.use === 'villas' || b.use === 'apartments') return s + b.generatedUnits * input.householdSizes.family;
    return s;
  }, 0);

  const findings = buildFindings(balances, programme, {
    parcelAc: m2ToAcres(parcelAreaM2),
    zonedAc: m2ToAcres(zonedAreaM2),
    populationCapacity,
  });

  return {
    assignments,
    balances,
    inScopeAc: programme.inScopeAc,
    zonedAc: m2ToAcres(zonedAreaM2),
    unzonedAc: Math.max(0, m2ToAcres(parcelAreaM2 - zonedAreaM2)),
    demandAc: programme.demandedAc,
    shortfallAc: programme.shortfallAc,
    totalGeneratedUnits: balances.reduce((s, b) => s + b.generatedUnits, 0),
    populationCapacity,
    populationTarget: programme.populationTargetNow,
    populationFinalCapacity: programme.populationFinalCapacity,
    findings,
  };
}

function buildFindings(
  balances: UseBalance[],
  programme: ProgrammeSummary,
  totals: { parcelAc: number; zonedAc: number; populationCapacity: number },
): Finding[] {
  const out: Finding[] = [];

  out.push(
    (programme.shortfallAc <= 0 ? pass : fail)({
      id: 'level1.land',
      source: 'PROGRAMME',
      reference: 'programme.yaml scope + line land_ac',
      title:
        programme.shortfallAc > 0
          ? `The programme needs ${programme.shortfallAc.toFixed(1)} ac more than the site has`
          : 'The programme fits the land in scope',
      detail:
        programme.shortfallAc > 0
          ? `${programme.demandedAc.toFixed(1)} ac asked for against ${programme.inScopeAc.toFixed(2)} ac in scope. This is a finding, not a rounding error: either a line loses land, the layouts get denser, or part of the scheme waits for the ${programme.deferredAc} ac of deferred land. The hospital's ${programme.deferredDemandAc.toFixed(1)} ac is already excluded.`
          : `${programme.demandedAc.toFixed(1)} ac asked for against ${programme.inScopeAc.toFixed(2)} ac in scope.`,
    }),
  );

  const unzoned = totals.parcelAc - totals.zonedAc;
  if (Math.abs(unzoned) > 0.5) {
    out.push(
      info({
        id: 'level1.unzoned',
        source: 'DATA',
        reference: 'zones_client_registered.geojson against parcel.geojson',
        title: `${unzoned.toFixed(2)} ac of the parcel carries no zone`,
        detail:
          'The client Zoning Plan is a starting point registered onto the survey; PHASE 5 was never recovered from the CAD and some boundaries are approximate. Land with no zone is available for the shortfall.',
      }),
    );
  }

  for (const b of balances) {
    if (b.deferred) {
      out.push(
        info({
          id: `level1.use.${b.use}`,
          source: 'PROGRAMME',
          reference: 'docs/DECISIONS.md, 17 Sep 2026',
          title: `${USE_LABEL[b.use]} is deferred`,
          detail: `${b.demandAc.toFixed(1)} ac waits for the 26.4 ac balance land. The zone is reserved and nothing else is placed on it.`,
        }),
      );
      continue;
    }
    const landGap = b.demandAc - b.zonedAc;
    if (Math.abs(landGap) > 0.5) {
      out.push(
        (landGap > 0 ? warn : info)({
          id: `level1.land.${b.use}`,
          source: 'PROGRAMME',
          reference: 'programme.yaml land_ac against the zoning plan',
          title:
            landGap > 0
              ? `${USE_LABEL[b.use]}: zoned ${b.zonedAc.toFixed(2)} ac for a ${b.demandAc.toFixed(1)} ac line`
              : `${USE_LABEL[b.use]}: zoned ${b.zonedAc.toFixed(2)} ac for a ${b.demandAc.toFixed(1)} ac line, ${Math.abs(landGap).toFixed(2)} ac spare`,
          detail:
            landGap > 0
              ? `${landGap.toFixed(2)} ac short. Resize the zone, move the line into unzoned land, or accept a lower yield.`
              : 'The zoning plan gives this use more land than the programme line asks for.',
        }),
      );
    }

    if (b.zonesGenerated === 0) continue;
    if (b.targetUnits > 0) {
      const gap = b.targetUnits - b.generatedUnits;
      out.push(
        (gap <= 0 ? pass : gap <= b.targetUnits * 0.1 ? warn : fail)({
          id: `level1.yield.${b.use}`,
          source: 'PROGRAMME',
          reference: 'Level 2 generator output against programme.yaml units',
          title: `${USE_LABEL[b.use]}: ${b.generatedUnits} units placed of ${b.targetUnits}`,
          detail:
            gap > 0
              ? `${gap} units short across ${b.zonesGenerated} of ${b.zonesTotal} zones generated. Options: more towers or floors, denser plots, more land, or phasing the balance into the deferred land.`
              : `Across ${b.zonesGenerated} of ${b.zonesTotal} zones generated.`,
        }),
      );
    } else if (b.targetBuiltUpSft > 0) {
      const gap = b.targetBuiltUpSft - b.generatedBuiltUpSft;
      out.push(
        (gap <= b.targetBuiltUpSft * 0.01 ? pass : warn)({
          id: `level1.yield.${b.use}`,
          source: 'PROGRAMME',
          reference: 'Level 2 generator output against programme.yaml bua_sft',
          title: `${USE_LABEL[b.use]}: ${Math.round(b.generatedBuiltUpSft).toLocaleString('en-IN')} sft placed of ${Math.round(b.targetBuiltUpSft).toLocaleString('en-IN')} sft`,
          detail:
            gap > 0
              ? `${Math.round(gap).toLocaleString('en-IN')} sft short. The Table 6 coverage on this zone caps the footprint; more floors or more land is needed.`
              : 'The zone holds the line.',
        }),
      );
    }
  }

  const generatedAny = balances.some((b) => b.zonesGenerated > 0);
  if (generatedAny) {
    out.push(
      (totals.populationCapacity >= programme.populationTargetNow ? pass : warn)({
        id: 'level1.population',
        source: 'PROGRAMME',
        reference: 'programme.yaml population + assumptions.household_size_*',
        title: `Population capacity ${Math.round(totals.populationCapacity).toLocaleString('en-IN')} against a target of ${programme.populationTargetNow.toLocaleString('en-IN')}`,
        detail: `The layouts must also allow ${programme.populationFinalCapacity.toLocaleString('en-IN')} at full build-out. Household sizes are assumptions: ${programme.lines.length} programme lines, counted at 3.5 per family home and 1.6 per senior unit unless changed in the Rules tab.`,
      }),
    );
  }

  return out;
}

/** Programme lines that belong to one zone's use, for the zone panel. */
export function linesForZone(zoneName: string, programme: ProgrammeSummary): ProgrammeLine[] {
  const use = inferUse(zoneName);
  return programme.lines.filter((l) => USE_LINES[use].includes(l.use));
}
