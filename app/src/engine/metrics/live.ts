import type { SiteModel } from '../site/loadSite';
import type { ConfigBundle } from '../data/config';
import { pick } from '../data/config';
import type { ZoneUse } from '../site/level1';
import { USE_LABEL } from '../site/level1';
import { loadProgramme } from '../rules/programme';
import { coverageFsi } from '../rules/kmbr';
import { sizeApartments, sizeVillaPlots, villaDelivery } from '../rules/client';
import type { BandName, MinSideApplies } from '../rules/client';
import { briefForZone, kindForUse } from '../masterplan/brief';
import { m2ToSft, M2_PER_ACRE, sftToM2 } from '../units';
import type { MasterPlan } from '../masterplan/types';

/**
 * Metrics the moment a control moves, with no geometry and no worker.
 *
 * Laying out the site takes about twelve seconds; working out what that layout
 * WILL hold takes microseconds, because it is the client's own arithmetic on
 * the rules. Splitting the two is what lets a slider answer while it is still
 * being dragged: the predicted figures move continuously and the drawn plan
 * catches up behind them.
 *
 * Predicted and built are always reported separately. A predicted figure is
 * what the rules allow; a built figure is what the ground actually took. Where
 * they differ, the difference is the finding.
 */

export interface LiveSwitches {
  fsiTierIndex: number;
  minSideApplies: MinSideApplies;
  apartmentMix: BandName[];
  flatsPerFloor: number;
  towerFloorOptions: number[];
}

export interface UseMetric {
  use: ZoneUse;
  label: string;
  landAc: number;
  units: number;
  floorAreaM2: number;
  footprintM2: number;
}

export interface LiveConstraint {
  id: string;
  actual: number;
  limit: number;
  label: string;
  /** Which document the limit comes from. */
  reference: string;
  breached: boolean;
  /** One sentence, shown on the control itself. */
  message: string;
}

export interface LiveMetrics {
  plannedZones: number;
  landAc: number;
  villaPlots: number;
  villaUnits: number;
  towers: number;
  flats: number;
  dwellings: number;
  population: number;
  floorAreaM2: number;
  footprintM2: number;
  fsi: number;
  coveragePct: number;
  parkingCars: number;
  byUse: UseMetric[];
  constraints: LiveConstraint[];
  /** Milliseconds taken, so the claim of "instant" is testable. */
  elapsedMs: number;
}

export interface LiveInput {
  site: SiteModel;
  config: ConfigBundle;
  switches: LiveSwitches;
  zoneUses: Record<string, ZoneUse>;
}

export function computeLive(input: LiveInput): LiveMetrics {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { site, config, switches, zoneUses } = input;
  const programme = loadProgramme(config.programme, config.client, config.kmbr, config.assumptions);
  const householdFamily = pick<number>(config.assumptions, 'household_size_family', 3.5);
  const householdSenior = pick<number>(config.assumptions, 'household_size_senior', 1.6);
  const villaFloors = pick<number>(config.assumptions, 'villa_floors', 2);
  const a1 = coverageFsi(config.kmbr, 'A1');
  const fsi = a1.fsiTiers[switches.fsiTierIndex] ?? a1.fsiTiers[0] ?? 3;
  const towerFloors = Math.max(...switches.towerFloorOptions, 1);

  const useAc = new Map<ZoneUse, number>();
  for (const zone of site.zones) {
    const use = zoneUses[zone.id];
    if (!use || zone.geom.length === 0) continue;
    useAc.set(use, (useAc.get(use) ?? 0) + zone.computedInScopeAc);
  }

  const byUse = new Map<ZoneUse, UseMetric>();
  const add = (use: ZoneUse, patch: Partial<UseMetric>): void => {
    const row = byUse.get(use) ?? {
      use,
      label: USE_LABEL[use],
      landAc: 0,
      units: 0,
      floorAreaM2: 0,
      footprintM2: 0,
    };
    byUse.set(use, {
      ...row,
      landAc: row.landAc + (patch.landAc ?? 0),
      units: row.units + (patch.units ?? 0),
      floorAreaM2: row.floorAreaM2 + (patch.floorAreaM2 ?? 0),
      footprintM2: row.footprintM2 + (patch.footprintM2 ?? 0),
    });
  };

  let villaPlots = 0;
  let villaUnits = 0;
  let towers = 0;
  let flats = 0;
  let population = 0;
  let plannedZones = 0;
  let landAc = 0;

  for (const zone of site.zones) {
    const use = zoneUses[zone.id];
    if (!use || zone.geom.length === 0) continue;
    const kind = kindForUse(use);
    if (kind === 'none') continue;
    plannedZones += 1;
    landAc += zone.computedInScopeAc;
    const landM2 = zone.computedInScopeAc * M2_PER_ACRE;

    const brief = briefForZone({
      zoneId: zone.id,
      zoneName: zone.name,
      use,
      areaAc: zone.computedInScopeAc,
      useTotalAc: useAc.get(use) ?? zone.computedInScopeAc,
      programme,
      householdSizeFamily: householdFamily,
      householdSizeSenior: householdSenior,
    });

    if (kind === 'villa' && brief.targetUnits > 0) {
      const sizing = sizeVillaPlots(config.client, landM2, brief.targetUnits, {
        minSideApplies: switches.minSideApplies,
      });
      const plotFootprint = sizing.footprintM2 * sizing.plots;
      villaPlots += sizing.plots;
      villaUnits += sizing.plots * sizing.grouping;
      population += sizing.plots * sizing.grouping * (brief.senior ? householdSenior : householdFamily);
      add(use, {
        landAc: zone.computedInScopeAc,
        units: sizing.plots * sizing.grouping,
        footprintM2: plotFootprint,
        floorAreaM2: plotFootprint * villaFloors,
      });
      continue;
    }

    if (kind === 'tower' && brief.targetUnits > 0) {
      const sizing = sizeApartments(config.client, {
        landM2,
        fsi,
        floors: towerFloors,
        floorsForSizing: towerFloors,
        mix: switches.apartmentMix,
        flatsPerFloor: switches.flatsPerFloor,
      });
      towers += sizing.towers;
      flats += sizing.flats;
      population += sizing.flats * householdFamily;
      add(use, {
        landAc: zone.computedInScopeAc,
        units: sizing.flats,
        footprintM2: sizing.totalFootprintM2,
        floorAreaM2: sizing.totalFloorAreaM2,
      });
      continue;
    }

    if (kind === 'block' && brief.builtUpSft > 0) {
      const cover = coverageFsi(config.kmbr, brief.occupancy);
      const builtM2 = sftToM2(brief.builtUpSft);
      const maxFootprint = landM2 * (cover.coveragePct / 100);
      const floors = Math.max(1, Math.ceil(builtM2 / Math.max(1, maxFootprint)));
      add(use, {
        landAc: zone.computedInScopeAc,
        floorAreaM2: builtM2,
        footprintM2: builtM2 / floors,
      });
    }
  }

  const rows = [...byUse.values()].sort((x, y) => y.landAc - x.landAc);
  const floorAreaM2 = rows.reduce((s, r) => s + r.floorAreaM2, 0);
  const footprintM2 = rows.reduce((s, r) => s + r.footprintM2, 0);
  const landM2 = landAc * M2_PER_ACRE;

  const constraints: LiveConstraint[] = [];
  const coveragePct = landM2 > 0 ? (footprintM2 / landM2) * 100 : 0;
  const fsiUsed = landM2 > 0 ? floorAreaM2 / landM2 : 0;

  constraints.push({
    id: 'fsi',
    actual: fsiUsed,
    limit: fsi,
    label: 'FSI used',
    reference: `KMBR Table 6 · A1 tier ${fsi}`,
    breached: fsiUsed > fsi * 1.001,
    message:
      fsiUsed > fsi * 1.001
        ? `FSI ${fsiUsed.toFixed(2)} is over the ${fsi} tier. Raise the tier (fees apply) or build less.`
        : `FSI ${fsiUsed.toFixed(2)} of the ${fsi} allowed.`,
  });

  constraints.push({
    id: 'coverage',
    actual: coveragePct,
    limit: a1.coveragePct,
    label: 'Coverage',
    reference: `KMBR Table 6 · A1 ${a1.coveragePct}%`,
    breached: coveragePct > a1.coveragePct,
    message:
      coveragePct > a1.coveragePct
        ? `Coverage ${coveragePct.toFixed(1)}% is over the ${a1.coveragePct}% limit.`
        : `Coverage ${coveragePct.toFixed(1)}% of the ${a1.coveragePct}% allowed.`,
  });

  const perFloor = pick<{ min: number; max: number }>(config.client, 'apartments.flats_per_floor', {
    min: 4,
    max: 6,
  });
  const perFloorBad = switches.flatsPerFloor < perFloor.min || switches.flatsPerFloor > perFloor.max;
  constraints.push({
    id: 'flatsPerFloor',
    actual: switches.flatsPerFloor,
    limit: perFloor.max,
    label: 'Flats per floor',
    reference: `client ${perFloor.min}–${perFloor.max}`,
    breached: perFloorBad,
    message: perFloorBad
      ? `${switches.flatsPerFloor} is outside the client's ${perFloor.min}–${perFloor.max} range.`
      : `Inside the client's ${perFloor.min}–${perFloor.max} range.`,
  });

  const maxFloors = pick<number>(config.client, 'apartments.max_floors', 20);
  constraints.push({
    id: 'towerFloors',
    actual: towerFloors,
    limit: maxFloors,
    label: 'Tower floors',
    reference: `client cap ${maxFloors}`,
    breached: towerFloors > maxFloors,
    message:
      towerFloors > maxFloors
        ? `${towerFloors} floors is over the client's ${maxFloors}-floor cap.`
        : `${towerFloors} floors, within the ${maxFloors}-floor cap.`,
  });

  const villaZone = site.zones.find((z) => zoneUses[z.id] === 'villas' && z.geom.length > 0);
  if (villaZone) {
    const brief = briefForZone({
      zoneId: villaZone.id,
      zoneName: villaZone.name,
      use: 'villas',
      areaAc: villaZone.computedInScopeAc,
      useTotalAc: useAc.get('villas') ?? villaZone.computedInScopeAc,
      programme,
      householdSizeFamily: householdFamily,
      householdSizeSenior: householdSenior,
    });
    const sizing = sizeVillaPlots(
      config.client,
      villaZone.computedInScopeAc * M2_PER_ACRE,
      brief.targetUnits,
      { minSideApplies: switches.minSideApplies },
    );
    const delivery = villaDelivery(sizing, villaFloors, brief.wantedPlinthSft ?? null, 'standard');
    if (delivery.wantedPlinthSft) {
      constraints.push({
        id: 'villaPlinth',
        actual: delivery.deliveredPlinthSft,
        limit: delivery.wantedPlinthSft,
        label: 'Villa plinth',
        reference: 'client villa type + programme',
        breached: !delivery.meetsType,
        message: delivery.meetsType
          ? `${Math.round(delivery.deliveredPlinthSft)} sft delivered, meeting the ${Math.round(delivery.wantedPlinthSft)} sft asked for.`
          : `${Math.round(delivery.deliveredPlinthSft)} sft delivered against ${Math.round(delivery.wantedPlinthSft)} sft asked for: ${delivery.floorsNeeded?.toFixed(1)} floors would be needed, not ${villaFloors}.`,
      });
    }
  }

  const parkingCars = programme.lines.reduce((s, l) => s + l.parkingCars, 0);
  const finished = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return {
    plannedZones,
    landAc,
    villaPlots,
    villaUnits,
    towers,
    flats,
    dwellings: villaUnits + flats,
    population: Math.round(population),
    floorAreaM2,
    footprintM2,
    fsi: fsiUsed,
    coveragePct,
    parkingCars,
    byUse: rows,
    constraints,
    elapsedMs: finished - started,
  };
}

/** The same headline figures read off a plan that has actually been generated. */
export function builtMetrics(plan: MasterPlan | null): Partial<LiveMetrics> | null {
  if (!plan) return null;
  const landM2 = plan.totals.plannedAreaAc * M2_PER_ACRE;
  return {
    villaPlots: plan.totals.villaPlots,
    villaUnits: plan.totals.villaUnits,
    towers: plan.totals.towers,
    flats: plan.totals.flats,
    dwellings: plan.totals.dwellings,
    population: plan.totals.population,
    floorAreaM2: plan.totals.builtFloorM2,
    footprintM2: plan.totals.builtFootprintM2,
    fsi: landM2 > 0 ? plan.totals.builtFloorM2 / landM2 : 0,
    coveragePct: landM2 > 0 ? (plan.totals.builtFootprintM2 / landM2) * 100 : 0,
    landAc: plan.totals.plannedAreaAc,
  };
}

export const sft = (m2: number): number => m2ToSft(m2);
