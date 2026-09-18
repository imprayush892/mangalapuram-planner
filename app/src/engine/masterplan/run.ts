import type { SiteModel } from '../site/loadSite';
import type { ConfigBundle } from '../data/config';
import type { ZoneUse } from '../site/level1';
import { USE_LABEL, USE_OCCUPANCY } from '../site/level1';
import { loadProgramme } from '../rules/programme';
import { accessWidthM, unbuildableSlopeDeg } from '../rules/kmbr';
import { roadWidths } from '../rules/client';
import { generateVillaLayouts } from '../generators/villa';
import type { RoadDirection } from '../generators/villa';
import { generateTowerLayouts } from '../generators/tower';
import { generateBlockLayout } from '../generators/block';
import type { BandName, MinSideApplies } from '../rules/client';
import { pick } from '../data/config';
import { multiPolyArea } from '../geom/planar';
import { briefForZone } from './brief';
import { circulationFootprint, generateCirculation } from './circulation';
import { buildJunctions } from './junctions';
import { gradientLimits, measureGradient, summariseGradients } from '../rules/roadGradient';
import { subdivisionRules } from '../rules/kmbr';
import type { MasterPlan, MasterPlanZone, MasterPlanTotals } from './types';

/**
 * Builds the whole master plan: every zone laid out with the generator its use
 * calls for, plus the circulation between them.
 *
 * The use comes from the siting engine, so this is where the two halves meet —
 * change a weight, a rule or an assumption and the plan that comes out is a
 * different plan, which is the point.
 */

export interface MasterPlanOptions {
  /** Use per zone id, from the active siting alternative. */
  zoneUses: Record<string, ZoneUse>;
  sitingLabel: string;
  /** Layout option to draw per zone; the best-scoring one where unset. */
  chosen?: Record<string, number>;
  minSideApplies?: MinSideApplies;
  directions?: RoadDirection[];
  fsi: number;
  floorOptions: number[];
  apartmentMix: BandName[];
  flatsPerFloor: number;
  runId: number;
}

function totalsOf(
  zones: MasterPlanZone[],
  circulationLengthM: number,
  circulationAreaM2: number,
  junctions: number,
  splayAreaM2: number,
): MasterPlanTotals {
  const t: MasterPlanTotals = {
    villaPlots: 0,
    villaUnits: 0,
    towers: 0,
    flats: 0,
    blocks: 0,
    builtFootprintM2: 0,
    builtFloorM2: 0,
    dwellings: 0,
    population: 0,
    internalRoadLengthM: 0,
    circulationRoadLengthM: circulationLengthM,
    roadAreaM2: circulationAreaM2,
    junctions,
    splayAreaM2,
    openSpaceM2: 0,
    plannedAreaAc: 0,
  };
  for (const z of zones) {
    const layout = z.options[z.chosenIndex];
    if (!layout) continue;
    t.plannedAreaAc += z.areaAc;
    t.villaPlots += layout.plots.length;
    t.villaUnits += layout.plots.reduce((s, p) => s + p.unitsOnPlot, 0);
    t.towers += layout.towers.length;
    t.flats += layout.towers.reduce((s, tower) => s + tower.flats, 0);
    t.blocks += layout.blocks.length;
    t.builtFootprintM2 += layout.metrics.footprintM2;
    t.builtFloorM2 += layout.metrics.totalFloorAreaM2;
    t.population += layout.metrics.populationCapacity;
    t.internalRoadLengthM += layout.roads.reduce((s, r) => s + r.lengthM, 0);
    t.roadAreaM2 += layout.metrics.roadAreaM2;
    t.openSpaceM2 += layout.metrics.openSpaceAreaM2;
  }
  t.dwellings = t.villaUnits + t.flats;
  return t;
}

export function runMasterPlan(
  site: SiteModel,
  config: ConfigBundle,
  opts: MasterPlanOptions,
  onProgress: (message: string, done: number, total: number) => void = () => {},
): MasterPlan {
  const started = Date.now();
  const programme = loadProgramme(config.programme, config.client, config.kmbr, config.assumptions);
  const householdFamily = pick<number>(config.assumptions, 'household_size_family', 3.5);
  const householdSenior = pick<number>(config.assumptions, 'household_size_senior', 1.6);
  const widths = roadWidths(config.client);

  // Land each use holds across the whole site, so a use split over two zones
  // splits its programme between them rather than doubling it.
  const useAc = new Map<ZoneUse, number>();
  for (const zone of site.zones) {
    const use = opts.zoneUses[zone.id];
    if (!use) continue;
    useAc.set(use, (useAc.get(use) ?? 0) + zone.computedInScopeAc);
  }

  const planned = site.zones.filter((z) => z.geom.length > 0 && opts.zoneUses[z.id]);

  // The roads between the zones are laid first and then kept out of every zone
  // layout: a spine drawn after the plots would run straight through them.
  onProgress('tracing the roads between the zones', 0, planned.length);
  const circulation = generateCirculation({
    dem: site.dem,
    parcel: site.parcel,
    features: site.features,
    zones: planned.map((z) => {
      const use = opts.zoneUses[z.id] as ZoneUse;
      return {
        id: z.id,
        name: z.name,
        geom: z.geom,
        accessWidthM: accessWidthM(config.kmbr, USE_OCCUPANCY[use], multiPolyArea(z.geom)).widthM,
      };
    }),
    publicWidthM: widths.publicM,
    spineWidthM: widths.spineM,
    unbuildableSlopeDeg: unbuildableSlopeDeg(config.kmbr),
    gradePenaltyM: pick<number>(config.assumptions, 'route_grade_penalty_m', 12),
  });
  const roadNoGo = circulationFootprint(circulation.roads);

  const zones: MasterPlanZone[] = [];
  let done = 0;

  for (const zone of planned) {
    const use = opts.zoneUses[zone.id] as ZoneUse;
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

    onProgress(`${USE_LABEL[use]} in ${zone.name}`, done, planned.length);
    const zoneStarted = Date.now();

    const common = {
      zoneId: zone.id,
      zoneName: zone.name,
      zone: zone.geom,
      dem: site.dem,
      kmbr: config.kmbr,
      client: config.client,
      assumptions: config.assumptions,
      noGo: roadNoGo,
    };

    let options: ReturnType<typeof generateVillaLayouts> = [];
    let empty: string | null = brief.skipReason ?? null;

    try {
      if (brief.kind === 'villa' && brief.targetUnits > 0) {
        options = generateVillaLayouts({
          ...common,
          targetUnits: brief.targetUnits,
          householdSize: brief.senior ? householdSenior : householdFamily,
          minSideApplies: opts.minSideApplies,
          directions: opts.directions,
          senior: brief.senior,
          wantedPlinthSft: brief.wantedPlinthSft,
          villaTypeName: brief.villaTypeName,
        });
      } else if (brief.kind === 'tower' && brief.targetUnits > 0) {
        options = generateTowerLayouts({
          ...common,
          fsi: opts.fsi,
          floorOptions: opts.floorOptions,
          mix: opts.apartmentMix,
          flatsPerFloor: opts.flatsPerFloor,
          householdSize: householdFamily,
        });
      } else if (brief.kind === 'block' && brief.builtUpSft > 0) {
        const option = generateBlockLayout({
          ...common,
          occupancy: brief.occupancy,
          builtUpSft: brief.builtUpSft,
          useLabel: brief.useLabel,
          maxSlopeDeg: brief.maxSlopeDeg,
        });
        options = option ? [option] : [];
        if (!option) empty = `no block fits ${zone.name} at the Table 6 coverage inside the Table 4 yards`;
      } else if (!empty) {
        empty = brief.kind === 'none' ? 'no generator for this use' : 'the programme gives this zone nothing to build';
      }
    } catch (err) {
      empty = err instanceof Error ? err.message : String(err);
    }

    if (options.length === 0 && !empty) empty = 'the generator returned no option that fits';

    const chosenRaw = opts.chosen?.[zone.id] ?? 0;
    const chosenIndex = options.length > 0 ? Math.min(Math.max(0, chosenRaw), options.length - 1) : 0;

    zones.push({
      zoneId: zone.id,
      zoneName: zone.name,
      use,
      useLabel: USE_LABEL[use],
      areaAc: zone.computedInScopeAc,
      brief,
      options,
      chosenIndex,
      empty,
      elapsedMs: Date.now() - zoneStarted,
    });
    done += 1;
  }

  /* ------------------------------------------------ junctions and gradients */
  onProgress('splaying the junctions and checking road gradients', done, planned.length);
  const sub = subdivisionRules(config.kmbr);
  const junctions = buildJunctions({
    zoneRoads: zones.map((z) => ({
      zoneId: z.zoneId,
      roads: z.options[z.chosenIndex]?.roads ?? [],
    })),
    circulation: circulation.roads,
    splayRule: { roadsLe10M: sub.junctionSplay.roads_le_10m, roadsGt10M: sub.junctionSplay.roads_gt_10m },
    stubReachM: pick<number>(config.assumptions, 'road_stub_reach_m', 60),
    parcel: site.parcel,
    obstacles: zones.flatMap((z) => {
      const layout = z.options[z.chosenIndex];
      if (!layout) return [];
      return [
        ...layout.plots.map((pl) => [pl.ring]),
        ...layout.towers.map((t) => [t.ring]),
        ...layout.blocks.map((b) => [b.ring]),
      ];
    }),
  });
  circulation.roads.push(...junctions.stubs);
  circulation.notes.push(...junctions.notes);

  const limits = gradientLimits(config.assumptions);
  const gradients = summariseGradients(
    [
      ...circulation.roads.map((r) => measureGradient(site.dem, r.id, r.centreline, limits)),
      ...zones.flatMap((z) =>
        (z.options[z.chosenIndex]?.roads ?? [])
          .filter((r) => r.centreline.length >= 2)
          .map((r) => measureGradient(site.dem, `${z.zoneName}:${r.id}`, r.centreline, limits)),
      ),
    ],
    limits,
  );

  const circLength = circulation.roads.reduce((s, r) => s + r.lengthM, 0);
  const circArea = circulation.roads.reduce((s, r) => s + multiPolyArea(r.geom), 0);
  const splayAreaM2 = multiPolyArea(junctions.splays);
  const totals = totalsOf(zones, circLength, circArea, junctions.junctions.length, splayAreaM2);

  const notes: string[] = [...circulation.notes];
  const skipped = zones.filter((z) => z.empty);
  for (const z of skipped) notes.push(`${z.zoneName}: ${z.empty}`);
  for (const u of circulation.unreachable) {
    const z = zones.find((x) => x.zoneId === u.zoneId);
    notes.push(`${z?.zoneName ?? u.zoneId} has no road connection: ${u.reason}`);
  }

  if (gradients.overMaxM > 0) {
    notes.push(
      `${Math.round(gradients.overMaxM)} m of road is steeper than the ${limits.maxShortLabel} absolute limit; the steepest stretch is ${gradients.steepestRoadId ?? '—'}.`,
    );
  }

  return {
    runId: opts.runId,
    generatedAt: Date.now(),
    sitingLabel: opts.sitingLabel,
    zones,
    circulation,
    junctions,
    gradients,
    totals,
    notes,
    elapsedMs: Date.now() - started,
  };
}
