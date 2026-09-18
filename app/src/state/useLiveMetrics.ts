import { useMemo } from 'react';
import { useEditedSite } from './useEditedSite';
import { useRules } from './useRules';
import { useSettings } from './settingsStore';
import { useSiting, activeZoneUses } from './sitingStore';
import { computeLive } from '../engine/metrics/live';
import type { LiveMetrics } from '../engine/metrics/live';
import { inferUse } from '../engine/site/level1';
import type { ZoneUse } from '../engine/site/level1';

/** The use each zone carries right now: the siting engine's, a pin, or the name. */
export function useZoneUses(): Record<string, ZoneUse> {
  const site = useEditedSite();
  const result = useSiting((s) => s.result);
  const activeIndex = useSiting((s) => s.activeIndex);
  const locks = useSiting((s) => s.locks);
  return useMemo(() => {
    const fromSiting = activeZoneUses({ result, activeIndex });
    const out: Record<string, ZoneUse> = {};
    for (const zone of site?.zones ?? []) {
      if (zone.geom.length === 0) continue;
      out[zone.id] = locks[zone.id] ?? fromSiting[zone.id] ?? inferUse(zone.name);
    }
    return out;
  }, [site, result, activeIndex, locks]);
}

/**
 * Headline metrics for the current settings, recomputed on every change.
 *
 * This is the arithmetic only — no geometry, no worker — which is why it can
 * run inside a render while a slider is still moving.
 */
export function useLiveMetrics(): LiveMetrics | null {
  const site = useEditedSite();
  const rules = useRules();
  const switches = useSettings((s) => s.switches);
  const zoneUses = useZoneUses();

  return useMemo(() => {
    if (!site || !rules) return null;
    try {
      return computeLive({
        site,
        config: rules,
        switches: {
          fsiTierIndex: switches.fsiTierIndex,
          minSideApplies: switches.minSideApplies,
          apartmentMix: switches.apartmentMix,
          flatsPerFloor: switches.flatsPerFloor,
          towerFloorOptions: switches.towerFloorOptions,
        },
        zoneUses,
      });
    } catch {
      // A rule override can be mid-edit and momentarily unreadable; the HUD
      // holds its last good figures rather than blanking.
      return null;
    }
  }, [site, rules, switches, zoneUses]);
}
