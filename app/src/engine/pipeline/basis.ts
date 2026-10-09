import { pick } from '../data/config';
import type { ConfigBundle, YamlDoc } from '../data/config';
import type { SiteModel } from '../site/loadSite';
import { withPath } from './plan';
import type { PlanInput } from './plan';

export type PlanBasis = 'client' | 'draft_model';
export type DraftZoning = 'model' | 'green_pockets' | 'green_chain';

/** Which of the draft-model zonings the plan is drawn on (planning_rules.yaml options.draft_zoning). */
export function draftZoningOf(planning: YamlDoc): DraftZoning {
  const z = pick<string>(planning, 'options.draft_zoning', 'model');
  return z === 'green_pockets' || z === 'green_chain' ? z : 'model';
}

/**
 * The zone set a draft zoning and road layout plan on (SiteModel.draftZoneSets): the gardens are snapped to whole
 * plots of the base plan with the same roads (D1 for D3/D5, D2 for D4/D6). Null: the model's own zoning.
 */
export function draftZoneSetName(zoning: DraftZoning, roads: string): string | null {
  if (zoning === 'model') return null;
  return `${zoning === 'green_pockets' ? 'pockets' : 'chain'}${roads === 'north_south' ? '_ns' : ''}`;
}

/** The draft-model zones a plan of this zoning and road layout is drawn on. */
export function draftZonesFor(site: SiteModel, zoning: DraftZoning, roads: string): SiteModel['draftZones'] {
  const name = draftZoneSetName(zoning, roads);
  return (name && site.draftZoneSets[name]?.length ? site.draftZoneSets[name] : null) ?? site.draftZones;
}

/** Which programme and zoning the plan is drawn on (planning_rules.yaml options.basis). */
export function basisOf(planning: YamlDoc): PlanBasis {
  return pick<string>(planning, 'options.basis', 'client') === 'draft_model' ? 'draft_model' : 'client';
}

/**
 * The zones, programme and rules a plan is drawn on. The client basis: the client's zoning plan and
 * programme.yaml. The draft-model basis (owner 7 Oct 2026): the zones drawn for the owner's draft
 * financial model, its programme, and the rules planning_rules.yaml sets for it under bases.draft_model
 * (dotted paths that replace the client-basis values).
 */
export function planBasis(site: SiteModel, config: ConfigBundle): Pick<PlanInput, 'zones' | 'programme' | 'planning'> {
  if (basisOf(config.planning) === 'client') {
    return {
      planning: config.planning,
      programme: config.programme,
      zones: site.zones.map((z) => ({ name: z.name, geom: z.geom, labelAc: z.labelAreaAc })),
    };
  }
  let planning = config.planning;
  for (const [path, value] of Object.entries(pick<Record<string, unknown>>(config.planning, 'bases.draft_model', {}))) {
    planning = withPath(planning, path, value);
  }
  // Owner 9 Oct: options D3/D4 plan the zoning with green pockets (options.draft_zoning: green_pockets).
  // Owner 9 Oct: D3-D6 plan the zonings with green pockets or a green chain (options.draft_zoning).
  const zones = draftZonesFor(site, draftZoningOf(planning), pick<string>(planning, 'options.road_orientation', 'terrain'));
  return {
    planning,
    programme: config.programmeDraft,
    zones: zones.map((z) => ({ name: z.name, geom: z.geom, labelAc: z.labelAreaAc, use: z.use, phase: z.phase, component: z.component, within: z.within })),
  };
}
