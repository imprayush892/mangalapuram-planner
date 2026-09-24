import { useMemo } from 'react';
import { create } from 'zustand';
import { useSite } from './store';
import { useRules } from './useRules';
import { runAnalysis } from '../engine/pipeline/analysis';
import type { AnalysisResult, LayerId } from '../engine/pipeline/analysis';
import { DEFAULT_VISIBLE } from '../ui/planningStyle';

interface PlanningState {
  visible: LayerId[];
  toggle: (id: LayerId) => void;
  /** The client's hand-drawn zoning is hidden once, the first time the layers are opened. */
  zoningHidden: boolean;
  markZoningHidden: () => void;
}

export const usePlanning = create<PlanningState>((set) => ({
  visible: DEFAULT_VISIBLE,
  toggle: (id) =>
    set((s) => ({ visible: s.visible.includes(id) ? s.visible.filter((v) => v !== id) : [...s.visible, id] })),
  zoningHidden: false,
  markZoningHidden: () => set({ zoningHidden: true }),
}));

/**
 * Planning steps 1-7 on the site as the rules stand now. Recomputed when the
 * site or any rule changes; about half a second on the full grid.
 */
export function usePlanningAnalysis(): AnalysisResult | { error: string } | null {
  const site = useSite((s) => s.site);
  const rules = useRules();
  return useMemo(() => {
    if (!site || !rules) return null;
    try {
      return runAnalysis({
        dem: site.dem,
        parcel: site.parcel,
        features: site.features,
        measured: site.measured,
        surveySlopeDeg: site.surveySlopeDeg,
        planning: rules.planning,
        assumptions: rules.assumptions,
        client: rules.client,
        kmbr: rules.kmbr,
      });
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [site, rules]);
}

/** The analysis when it ran, null otherwise: for views that draw it but do not report errors. */
export function useAnalysisForViews(): AnalysisResult | null {
  const a = usePlanningAnalysis();
  return a && 'layers' in a ? a : null;
}
