import { create } from 'zustand';
import type { SuperGoal } from '../engine/optimise/goal';
import { BALANCED_GOAL, normaliseGoal } from '../engine/optimise/goal';

/**
 * The one goal the whole engine optimises against.
 *
 * Kept apart from the design switches because it is a different kind of thing:
 * a switch says what to build, the goal says what to optimise for while
 * building it.
 */
interface GoalState {
  goal: SuperGoal;
  /** The goal the drawn plan was built with, so drift can be shown. */
  planGoal: SuperGoal | null;
  set: (goal: Partial<SuperGoal>) => void;
  preset: (name: 'balanced' | 'space' | 'terrain' | 'water') => void;
  markSolved: (goal: SuperGoal) => void;
}

const PRESETS: Record<string, SuperGoal> = {
  balanced: BALANCED_GOAL,
  space: { space: 3, terrain: 1, water: 1 },
  terrain: { space: 1, terrain: 3, water: 1 },
  water: { space: 1, terrain: 1, water: 3 },
};

export const useGoal = create<GoalState>((set) => ({
  goal: BALANCED_GOAL,
  planGoal: null,
  set: (patch) => set((s) => ({ goal: { ...s.goal, ...patch } })),
  preset: (name) => set({ goal: PRESETS[name] ?? BALANCED_GOAL }),
  markSolved: (goal) => set({ planGoal: goal }),
}));

/** True where the drawn plan was built with a different goal to the one set. */
export function goalDrifted(goal: SuperGoal, planGoal: SuperGoal | null): boolean {
  if (!planGoal) return false;
  const a = normaliseGoal(goal);
  const b = normaliseGoal(planGoal);
  return (
    Math.abs(a.space - b.space) > 0.01 ||
    Math.abs(a.terrain - b.terrain) > 0.01 ||
    Math.abs(a.water - b.water) > 0.01
  );
}
