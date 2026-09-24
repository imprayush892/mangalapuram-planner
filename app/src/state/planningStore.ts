import { useMemo } from 'react';
import { create } from 'zustand';
import { useSite } from './store';
import { useRules } from './useRules';
import { runAnalysis } from '../engine/pipeline/analysis';
import type { AnalysisResult, LayerId } from '../engine/pipeline/analysis';
import type { PlanResult } from '../engine/pipeline/plan';
import { DEFAULT_VISIBLE } from '../ui/planningStyle';

/** What of steps 8-16 is drawn. */
export type PlanLayer = 'roads' | 'blocks' | 'plots' | 'buildings' | 'earthwork';

export interface PlanStatus {
  running: boolean;
  message: string;
  error: string | null;
}

interface PlanningState {
  visible: LayerId[];
  toggle: (id: LayerId) => void;
  plan: PlanResult | null;
  planMs: number;
  planStatus: PlanStatus;
  planVisible: PlanLayer[];
  togglePlan: (id: PlanLayer) => void;
  /** The villas as masses in 3D, when the buildings are drawn. */
  villaMasses: boolean;
  setPlanStatus: (s: PlanStatus) => void;
  setPlanResult: (plan: PlanResult, ms: number) => void;
  /** The client's hand-drawn zoning is hidden once, the first time the layers are opened. */
  zoningHidden: boolean;
  markZoningHidden: () => void;
}

export const usePlanning = create<PlanningState>((set) => ({
  visible: DEFAULT_VISIBLE,
  toggle: (id) =>
    set((s) => ({ visible: s.visible.includes(id) ? s.visible.filter((v) => v !== id) : [...s.visible, id] })),
  plan: null,
  planMs: 0,
  planStatus: { running: false, message: '', error: null },
  planVisible: ['roads', 'blocks', 'plots', 'buildings'],
  villaMasses: true,
  togglePlan: (id) =>
    set((s) => ({ planVisible: s.planVisible.includes(id) ? s.planVisible.filter((v) => v !== id) : [...s.planVisible, id] })),
  setPlanStatus: (planStatus) => set({ planStatus }),
  setPlanResult: (plan, planMs) => set({ plan, planMs, planStatus: { running: false, message: '', error: null } }),
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
