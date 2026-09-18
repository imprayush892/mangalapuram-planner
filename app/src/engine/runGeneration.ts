import { loadSite } from './site/loadSite';
import type { SiteModel } from './site/loadSite';
import { fetchSource } from './data/source';
import { applyOverrides } from './data/overrides';
import type { OverrideSet } from './data/overrides';
import { loadConfig } from './data/config';
import type { ConfigBundle } from './data/config';
import { generateVillaLayouts } from './generators/villa';
import type { RoadDirection } from './generators/villa';
import { generateTowerLayouts } from './generators/tower';
import { generateBlockLayout } from './generators/block';
import type { LayoutOption } from './generators/types';
import type { BandName, MinSideApplies } from './rules/client';
import type { Occupancy } from './rules/kmbr';
import { runMasterPlan } from './masterplan/run';
import type { MasterPlanOptions } from './masterplan/run';
import type { MasterPlan } from './masterplan/types';
import { applyZoneEdits } from './site/zoneEdit';
import type { ZoneEdit } from './site/zoneEdit';

/**
 * One generation run, with no DOM and no worker API in sight. The worker calls
 * this, and so does the main thread when a host will not start a worker, so the
 * two paths cannot drift apart.
 */

export interface GenerateRequest {
  job?: 'zone';
  id: number;
  baseUrl: string;
  overrides: OverrideSet;
  zoneId: string;
  kind: 'villa' | 'tower' | 'block';
  targetUnits: number;
  householdSize: number;
  senior?: boolean;
  wantedPlinthSft?: number;
  villaTypeName?: string;
  minSideApplies?: MinSideApplies;
  directions?: RoadDirection[];
  /** Tower options. */
  fsi?: number;
  floorOptions?: number[];
  mix?: BandName[];
  flatsPerFloor?: number;
  /** Block options. */
  occupancy?: Occupancy;
  builtUpSft?: number;
  useLabel?: string;
  maxSlopeDeg?: number;
  zoneEdits?: ZoneEdit[];
}

/** One run of the whole master plan: every zone, plus the roads between them. */
export interface MasterPlanRequest {
  job: 'masterplan';
  id: number;
  baseUrl: string;
  overrides: OverrideSet;
  options: MasterPlanOptions;
  zoneEdits?: ZoneEdit[];
}

export type WorkerRequest = GenerateRequest | MasterPlanRequest;

export type GenerateResponse =
  | { id: number; status: 'progress'; message: string; done?: number; total?: number }
  | { id: number; status: 'done'; options: LayoutOption[]; elapsedMs: number }
  | { id: number; status: 'plan'; plan: MasterPlan; elapsedMs: number }
  | { id: number; status: 'error'; error: string };

/** Site data is loaded once per context and kept for the session. */
let sitePromise: Promise<SiteModel> | null = null;
let configPromise: Promise<ConfigBundle> | null = null;

async function loadContext(
  baseUrl: string,
  overrides: OverrideSet,
  onProgress: (message: string) => void,
  zoneEdits: readonly ZoneEdit[] = [],
): Promise<{ site: SiteModel; config: ConfigBundle }> {
  const src = fetchSource(baseUrl);
  onProgress('loading site data');
  sitePromise ??= loadSite(src);
  configPromise ??= loadConfig(src);
  const [loaded, baseConfig] = await Promise.all([sitePromise, configPromise]);
  // Zone edits are replayed on every run rather than stored as geometry, so the
  // worker and the main thread always agree on what the zoning plan is now.
  const site: SiteModel =
    zoneEdits.length > 0 ? { ...loaded, zones: applyZoneEdits(loaded.zones, zoneEdits).zones } : loaded;
  return {
    site,
    config: {
      kmbr: applyOverrides(baseConfig.kmbr, overrides.kmbr),
      client: applyOverrides(baseConfig.client, overrides.client),
      programme: applyOverrides(baseConfig.programme, overrides.programme),
      assumptions: applyOverrides(baseConfig.assumptions, overrides.assumptions),
      siting: applyOverrides(baseConfig.siting, overrides.siting),
    },
  };
}

/** Runs the whole master plan, zone by zone, then the circulation. */
export async function runMasterPlanJob(
  req: MasterPlanRequest,
  onProgress: (message: string, done: number, total: number) => void = () => {},
): Promise<MasterPlan> {
  const { site, config } = await loadContext(
    req.baseUrl,
    req.overrides,
    (m) => onProgress(m, 0, 0),
    req.zoneEdits ?? [],
  );
  return runMasterPlan(site, config, req.options, onProgress);
}

export async function runGeneration(
  req: GenerateRequest,
  onProgress: (message: string) => void = () => {},
): Promise<LayoutOption[]> {
  const { site, config } = await loadContext(req.baseUrl, req.overrides, onProgress, req.zoneEdits ?? []);

  const zone = site.zones.find((z) => z.id === req.zoneId);
  if (!zone) throw new Error(`zone '${req.zoneId}' not found`);
  if (zone.geom.length === 0) throw new Error(`zone '${zone.name}' has no land in scope`);

  onProgress(`generating ${req.kind} options for ${zone.name}`);

  const common = {
    zoneId: zone.id,
    zoneName: zone.name,
    zone: zone.geom,
    dem: site.dem,
    kmbr: config.kmbr,
    client: config.client,
    assumptions: config.assumptions,
  };

  if (req.kind === 'block') {
    const option = generateBlockLayout({
      ...common,
      occupancy: req.occupancy ?? 'F_commercial',
      builtUpSft: req.builtUpSft ?? 0,
      useLabel: req.useLabel ?? 'Block',
      maxSlopeDeg: req.maxSlopeDeg,
    });
    return option ? [option] : [];
  }

  if (req.kind === 'tower') {
    return generateTowerLayouts({
      ...common,
      fsi: req.fsi ?? 3,
      floorOptions: req.floorOptions ?? [12, 15, 20],
      mix: req.mix ?? ['2BHK', '3BHK'],
      flatsPerFloor: req.flatsPerFloor ?? 4,
      householdSize: req.householdSize,
    });
  }

  return generateVillaLayouts({
    ...common,
    targetUnits: req.targetUnits,
    householdSize: req.householdSize,
    minSideApplies: req.minSideApplies,
    directions: req.directions,
    senior: req.senior,
    wantedPlinthSft: req.wantedPlinthSft,
    villaTypeName: req.villaTypeName,
  });
}
