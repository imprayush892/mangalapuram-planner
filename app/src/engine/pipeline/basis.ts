import { pick } from '../data/config';
import type { ConfigBundle, YamlDoc } from '../data/config';
import type { SiteModel } from '../site/loadSite';
import { withPath } from './plan';
import type { PlanInput } from './plan';

export type PlanBasis = 'client' | 'draft_model';
export type DraftZoning = 'model' | 'green_pockets';

/** Which of the draft-model zonings the plan is drawn on (planning_rules.yaml options.draft_zoning). */
export function draftZoningOf(planning: YamlDoc): DraftZoning {
  return pick<string>(planning, 'options.draft_zoning', 'model') === 'green_pockets' ? 'green_pockets' : 'model';
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
  // The pocket gardens are snapped to whole plots of the base plan with the same roads (D1 for D3, D2 for D4).
  const ns = pick<string>(planning, 'options.road_orientation', 'terrain') === 'north_south';
  const pocketZones = ns ? site.draftZonesPocketsNs : site.draftZonesPockets;
  const pockets = draftZoningOf(planning) === 'green_pockets' && pocketZones.length > 0;
  return {
    planning,
    programme: config.programmeDraft,
    zones: (pockets ? pocketZones : site.draftZones).map((z) => ({ name: z.name, geom: z.geom, labelAc: z.labelAreaAc, use: z.use, phase: z.phase, component: z.component, within: z.within })),
  };
}
