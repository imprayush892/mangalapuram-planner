import { create } from 'zustand';
import type { SitingResult } from '../engine/siting/types';
import type { ZoneUse } from '../engine/site/level1';

interface SitingState {
  result: SitingResult | null;
  /** Which alternative the rest of the app follows. */
  activeIndex: number;
  running: boolean;
  error: string | null;
  elapsedMs: number;
  /** Zones the user has pinned to a use. */
  locks: Record<string, ZoneUse>;
  setResult: (result: SitingResult, elapsedMs: number) => void;
  setActive: (index: number) => void;
  setRunning: (running: boolean) => void;
  setError: (error: string | null) => void;
  toggleLock: (zoneId: string, use: ZoneUse) => void;
  clearLocks: () => void;
  clear: () => void;
}

export const useSiting = create<SitingState>((set) => ({
  result: null,
  activeIndex: 0,
  running: false,
  error: null,
  elapsedMs: 0,
  locks: {},

  setResult: (result, elapsedMs) => set({ result, activeIndex: 0, elapsedMs, running: false, error: null }),
  setActive: (activeIndex) => set({ activeIndex }),
  setRunning: (running) => set({ running, error: running ? null : undefined }),
  setError: (error) => set({ error, running: false }),

  toggleLock: (zoneId, use) =>
    set((s) => {
      const next = { ...s.locks };
      if (next[zoneId] === use) delete next[zoneId];
      else next[zoneId] = use;
      return { locks: next };
    }),

  clearLocks: () => set({ locks: {} }),
  clear: () => set({ result: null, activeIndex: 0, running: false, error: null, elapsedMs: 0 }),
}));

/** The use each zone takes under the active alternative, for the rest of the app. */
export function activeZoneUses(state: {
  result: SitingResult | null;
  activeIndex: number;
}): Record<string, ZoneUse> {
  const alt = state.result?.alternatives[state.activeIndex];
  if (!alt) return {};
  return Object.fromEntries(alt.allocations.map((a) => [a.zoneId, a.use]));
}
