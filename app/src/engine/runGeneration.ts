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

/**
 * One generation run, with no DOM and no worker API in sight. The worker calls
 * this, and so does the main thread when a host will not start a worker, so the
 * two paths cannot drift apart.
 */

export interface GenerateRequest {
  id: number;
  baseUrl: string;
  overrides: OverrideSet;
  zoneId: string;
  kind: 'villa' | 'tower' | 'block';
  targetUnits: number;
  householdSize: number;
  senior?: boolean;
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
}

export type GenerateResponse =
  | { id: number; status: 'progress'; message: string }
  | { id: number; status: 'done'; options: LayoutOption[]; elapsedMs: number }
  | { id: number; status: 'error'; error: string };

/** Site data is loaded once per context and kept for the session. */
let sitePromise: Promise<SiteModel> | null = null;
let configPromise: Promise<ConfigBundle> | null = null;

export async function runGeneration(
  req: GenerateRequest,
  onProgress: (message: string) => void = () => {},
): Promise<LayoutOption[]> {
  const src = fetchSource(req.baseUrl);
  onProgress('loading site data');
  sitePromise ??= loadSite(src);
  configPromise ??= loadConfig(src);
  const [site, baseConfig] = await Promise.all([sitePromise, configPromise]);

  const config: ConfigBundle = {
    kmbr: applyOverrides(baseConfig.kmbr, req.overrides.kmbr),
    client: applyOverrides(baseConfig.client, req.overrides.client),
    programme: applyOverrides(baseConfig.programme, req.overrides.programme),
    assumptions: applyOverrides(baseConfig.assumptions, req.overrides.assumptions),
  };

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
  });
}
