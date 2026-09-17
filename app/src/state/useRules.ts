import { useMemo } from 'react';
import { useSite } from './store';
import { useSettings } from './settingsStore';
import { applyOverrides } from '../engine/data/overrides';
import type { ConfigBundle } from '../engine/data/config';

/** Config with the UI's overrides applied — what every engine call should use. */
export function useRules(): ConfigBundle | null {
  const config = useSite((s) => s.config);
  const overrides = useSettings((s) => s.overrides);
  return useMemo(() => {
    if (!config) return null;
    return {
      kmbr: applyOverrides(config.kmbr, overrides.kmbr),
      client: applyOverrides(config.client, overrides.client),
      programme: applyOverrides(config.programme, overrides.programme),
      assumptions: applyOverrides(config.assumptions, overrides.assumptions),
    };
  }, [config, overrides]);
}
