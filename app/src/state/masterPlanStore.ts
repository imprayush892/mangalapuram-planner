import { create } from 'zustand';
import type { MasterPlan } from '../engine/masterplan/types';

export interface MasterPlanStatus {
  running: boolean;
  message: string;
  done: number;
  total: number;
  elapsedMs: number;
  error: string | null;
}

interface MasterPlanState {
  plan: MasterPlan | null;
  /** The run before this one, so a change can be shown as a difference. */
  previous: MasterPlan | null;
  status: MasterPlanStatus;
  /** Layout option drawn per zone; the engine's best where unset. */
  chosen: Record<string, number>;
  setPlan: (plan: MasterPlan) => void;
  setStatus: (status: Partial<MasterPlanStatus>) => void;
  chooseOption: (zoneId: string, index: number) => void;
  clear: () => void;
}

const IDLE: MasterPlanStatus = { running: false, message: '', done: 0, total: 0, elapsedMs: 0, error: null };

export const useMasterPlan = create<MasterPlanState>((set) => ({
  plan: null,
  previous: null,
  status: IDLE,
  chosen: {},

  setPlan: (plan) =>
    set((s) => ({
      plan,
      previous: s.plan,
      status: { ...IDLE, elapsedMs: plan.elapsedMs, message: `${plan.zones.length} zones in ${(plan.elapsedMs / 1000).toFixed(1)} s` },
    })),

  setStatus: (status) => set((s) => ({ status: { ...s.status, ...status } })),
  chooseOption: (zoneId, index) => set((s) => ({ chosen: { ...s.chosen, [zoneId]: index } })),
  clear: () => set({ plan: null, previous: null, status: IDLE, chosen: {} }),
}));

/** What changed between two runs, for the line under the button. */
export function planDelta(plan: MasterPlan, previous: MasterPlan | null): string[] {
  if (!previous) return [];
  const out: string[] = [];
  const pairs: [string, number, number][] = [
    ['plots', previous.totals.villaPlots, plan.totals.villaPlots],
    ['dwellings', previous.totals.dwellings, plan.totals.dwellings],
    ['towers', previous.totals.towers, plan.totals.towers],
    ['blocks', previous.totals.blocks, plan.totals.blocks],
  ];
  for (const [label, was, now] of pairs) {
    if (was !== now) out.push(`${label} ${was} → ${now} (${now > was ? '+' : ''}${now - was})`);
  }
  const wasFloor = Math.round(previous.totals.builtFloorM2);
  const nowFloor = Math.round(plan.totals.builtFloorM2);
  if (wasFloor !== nowFloor) {
    const pct = wasFloor > 0 ? ((nowFloor - wasFloor) / wasFloor) * 100 : 0;
    out.push(`floor area ${(wasFloor / 1000).toFixed(1)}k → ${(nowFloor / 1000).toFixed(1)}k m² (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`);
  }
  return out;
}
