/// <reference lib="webworker" />
import { loadSite } from '../engine/site/loadSite';
import type { SiteModel } from '../engine/site/loadSite';
import { fetchSource } from '../engine/data/source';
import { applyOverrides } from '../engine/data/overrides';
import type { OverrideSet } from '../engine/data/overrides';
import { loadConfig } from '../engine/data/config';
import type { ConfigBundle } from '../engine/data/config';
import { generateVillaLayouts } from '../engine/generators/villa';
import type { RoadDirection } from '../engine/generators/villa';
import { generateTowerLayouts } from '../engine/generators/tower';
import { generateBlockLayout } from '../engine/generators/block';
import type { LayoutOption } from '../engine/generators/types';
import type { BandName, MinSideApplies } from '../engine/rules/client';
import type { Occupancy } from '../engine/rules/kmbr';

/**
 * The generators run here so a regeneration never blocks the plan view. The
 * worker loads its own copy of the site data once and keeps it for the session.
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

let sitePromise: Promise<SiteModel> | null = null;
let configPromise: Promise<ConfigBundle> | null = null;

const post = (message: GenerateResponse): void => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
};

self.onmessage = async (event: MessageEvent<GenerateRequest>) => {
  const req = event.data;
  const started = Date.now();
  try {
    const src = fetchSource(req.baseUrl);
    post({ id: req.id, status: 'progress', message: 'loading site data' });
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

    post({ id: req.id, status: 'progress', message: `generating ${req.kind} options for ${zone.name}` });

    const blockOption =
      req.kind === 'block'
        ? generateBlockLayout({
            zoneId: zone.id,
            zoneName: zone.name,
            zone: zone.geom,
            dem: site.dem,
            kmbr: config.kmbr,
            client: config.client,
            assumptions: config.assumptions,
            occupancy: req.occupancy ?? 'F_commercial',
            builtUpSft: req.builtUpSft ?? 0,
            useLabel: req.useLabel ?? 'Block',
            maxSlopeDeg: req.maxSlopeDeg,
          })
        : null;

    const options: LayoutOption[] =
      req.kind === 'block'
        ? blockOption
          ? [blockOption]
          : []
        : req.kind === 'tower'
        ? generateTowerLayouts({
            zoneId: zone.id,
            zoneName: zone.name,
            zone: zone.geom,
            dem: site.dem,
            kmbr: config.kmbr,
            client: config.client,
            assumptions: config.assumptions,
            fsi: req.fsi ?? 3,
            floorOptions: req.floorOptions ?? [12, 15, 20],
            mix: req.mix ?? ['2BHK', '3BHK'],
            flatsPerFloor: req.flatsPerFloor ?? 4,
            householdSize: req.householdSize,
          })
        : generateVillaLayouts({
            zoneId: zone.id,
            zoneName: zone.name,
            zone: zone.geom,
            dem: site.dem,
            kmbr: config.kmbr,
            client: config.client,
            assumptions: config.assumptions,
            targetUnits: req.targetUnits,
            householdSize: req.householdSize,
            minSideApplies: req.minSideApplies,
            directions: req.directions,
            senior: req.senior,
          });

    post({ id: req.id, status: 'done', options, elapsedMs: Date.now() - started });
  } catch (err) {
    post({ id: req.id, status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
