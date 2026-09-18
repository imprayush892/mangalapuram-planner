import { useMemo } from 'react';
import { useSite } from './store';
import { useZoneEdit } from './zoneEditStore';
import { applyZoneEdits } from '../engine/site/zoneEdit';
import type { SiteModel } from '../engine/site/loadSite';

/**
 * The site as it stands now: the client's zoning plan with the user's edits
 * replayed on top. Every panel reads this rather than the loaded site, so a
 * split or a merge reaches the siting engine, the generators, the plan, the 3D
 * view and the exports at once.
 */
export function useEditedSite(): SiteModel | null {
  const site = useSite((s) => s.site);
  const edits = useZoneEdit((s) => s.edits);
  return useMemo(() => {
    if (!site || edits.length === 0) return site;
    return { ...site, zones: applyZoneEdits(site.zones, edits).zones };
  }, [site, edits]);
}
